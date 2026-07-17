/* ============================================
   NEXUS · dashboard.js
   Tablero de indicadores.

   Los gráficos son SVG construido a mano. Sin librerías:
   el prompt maestro las prohíbe, y una barra es un
   rectángulo. Una dependencia externa que se abandone
   en tres años obligaría a reescribir todo esto.

   El tablero no calcula: lee vistas. La agregación vive
   en la base, donde se resuelve una vez y no diverge
   entre módulos.
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar, formatearFecha } from './utils.js';

/* --- Estado --- */
const estado = {
  perfil: null,
  empresaId: null,
  empresa: null,
  anio: new Date().getFullYear(),
  comparar: null,
  resumen: null,
  resumenComp: null,
  serie: [],
  serieComp: [],
  indices: null,
  indicesComp: null,
  morbilidad: [],
  capacitacion: []
};

const MESES_CORTOS = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
                      'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/* Paleta: coherente con el resto del sistema */
const COLOR = {
  acento:  'var(--color-acento)',
  verde:   '#7ee2a8',
  ambar:   '#f5d76e',
  naranja: '#f5a05e',
  rojo:    '#f57373',
  azul:    '#7cc4f5',
  tenue:   'var(--color-texto-tenue)'
};

const $empresa = document.getElementById('empresa-activa');
const $tablero = document.getElementById('tablero');
const $aviso = document.getElementById('aviso-inicial');

iniciar();

/* ============================================
   Arranque
   ============================================ */

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  estado.perfil = perfil;
  montarNavegacion(perfil, 'dashboard');

  prepararAnios();
  await cargarEmpresas();
  conectarEventos();
}

function prepararAnios() {
  const actual = new Date().getFullYear();
  const $anio = document.getElementById('tablero-anio');
  const $comp = document.getElementById('tablero-comparar');

  for (let a = actual; a >= actual - 5; a--) {
    const o1 = document.createElement('option');
    o1.value = a; o1.textContent = a;
    $anio.appendChild(o1);

    const o2 = document.createElement('option');
    o2.value = a; o2.textContent = a;
    $comp.appendChild(o2);
  }

  $anio.value = actual;
}

async function cargarEmpresas() {
  const { data, error } = await supabase
    .from('empresas')
    .select('id, razon_social, num_trabajadores')
    .eq('activo', true)
    .order('razon_social');

  if (error) { alert('No fue posible cargar las empresas: ' + error.message); return; }

  (data || []).forEach((e) => {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.razon_social;
    o.dataset.trabajadores = e.num_trabajadores ?? 0;
    $empresa.appendChild(o);
  });

  const guardada = sessionStorage.getItem('nexus_empresa');
  if (guardada && (data || []).some((e) => e.id === guardada)) {
    $empresa.value = guardada;
    await seleccionarEmpresa();
  }
}

/* ============================================
   Datos
   ============================================ */

async function cargarTodo() {
  const [resumen, serie, indices, morbilidad, capac] = await Promise.all([
    supabase.from('v_tablero_anual').select('*')
      .eq('empresa_id', estado.empresaId).eq('anio', estado.anio).maybeSingle(),
    supabase.from('v_serie_mensual').select('*')
      .eq('empresa_id', estado.empresaId).eq('anio', estado.anio).order('mes'),
    supabase.from('v_indices_siniestralidad').select('*')
      .eq('empresa_id', estado.empresaId).eq('anio', estado.anio).maybeSingle(),
    supabase.from('v_top_diagnosticos').select('*')
      .eq('empresa_id', estado.empresaId).eq('anio', estado.anio)
      .order('casos', { ascending: false }).limit(10),
    supabase.from('v_indicadores_capacitacion').select('*')
      .eq('empresa_id', estado.empresaId).eq('anio', estado.anio)
  ]);

  estado.resumen = resumen.data;
  estado.serie = serie.data || [];
  estado.indices = indices.data;
  estado.morbilidad = morbilidad.data || [];
  estado.capacitacion = capac.data || [];

  /* Año de comparación */
  if (estado.comparar) {
    const [rc, sc, ic] = await Promise.all([
      supabase.from('v_tablero_anual').select('*')
        .eq('empresa_id', estado.empresaId).eq('anio', estado.comparar).maybeSingle(),
      supabase.from('v_serie_mensual').select('*')
        .eq('empresa_id', estado.empresaId).eq('anio', estado.comparar).order('mes'),
      supabase.from('v_indices_siniestralidad').select('*')
        .eq('empresa_id', estado.empresaId).eq('anio', estado.comparar).maybeSingle()
    ]);
    estado.resumenComp = rc.data;
    estado.serieComp = sc.data || [];
    estado.indicesComp = ic.data;
  } else {
    estado.resumenComp = null;
    estado.serieComp = [];
    estado.indicesComp = null;
  }
}

/* ============================================
   Pintado
   ============================================ */

function pintarTodo() {
  pintarCabeceraImpresion();
  pintarMedidores();
  pintarCifras();
  pintarIndices();
  pintarGraficoEventos();
  pintarGraficoSalud();
  pintarGraficoExamenes();
  pintarMorbilidad();
  pintarCapacitacion();
}

function pintarCabeceraImpresion() {
  document.getElementById('imp-empresa').textContent =
    estado.empresa?.razon_social ?? '—';

  const periodo = estado.comparar
    ? `Período ${estado.anio} · comparado con ${estado.comparar}`
    : `Período ${estado.anio}`;
  document.getElementById('imp-periodo').textContent = periodo;

  document.getElementById('imp-fecha').textContent =
    'Generado el ' + formatearFecha(new Date().toISOString().slice(0, 10));
}

/* --- Medidores --- */

function pintarMedidores() {
  const r = estado.resumen;

  medidor('med-salud', 'val-salud', r?.cumpl_salud);
  medidor('med-seguridad', 'val-seguridad', r?.cumpl_seguridad);
  medidor('med-total', 'val-total', r?.cumpl_total);

  document.getElementById('det-salud').textContent = leyendaCumplimiento(r?.cumpl_salud);
  document.getElementById('det-seguridad').textContent = leyendaCumplimiento(r?.cumpl_seguridad);
  document.getElementById('det-total').textContent =
    r?.num_trabajadores != null ? `${r.num_trabajadores} trabajadores` : '—';
}

function medidor(idTrazo, idValor, pct) {
  const valor = pct != null ? Number(pct) : null;
  document.getElementById(idValor).textContent = valor != null ? `${valor}%` : '—';

  const circunferencia = 2 * Math.PI * 52;
  const $t = document.getElementById(idTrazo);
  $t.style.strokeDasharray = circunferencia;
  $t.style.strokeDashoffset = valor != null
    ? circunferencia * (1 - valor / 100)
    : circunferencia;

  $t.classList.remove('trazo-bajo', 'trazo-medio', 'trazo-alto');
  if (valor != null) {
    $t.classList.add(valor < 50 ? 'trazo-bajo' : valor < 85 ? 'trazo-medio' : 'trazo-alto');
  }
}

function leyendaCumplimiento(pct) {
  if (pct == null) return 'Sin datos';
  const v = Number(pct);
  if (v < 50) return 'Cumplimiento crítico';
  if (v < 85) return 'Cumplimiento parcial';
  return 'Cumplimiento satisfactorio';
}

/* --- Cifras --- */

function pintarCifras() {
  const r = estado.resumen;
  const c = estado.resumenComp;

  const cifras = [
    { etiqueta: 'Incidentes',            valor: r?.incidentes ?? 0,       previo: c?.incidentes },
    { etiqueta: 'Accidentes',            valor: r?.accidentes ?? 0,       previo: c?.accidentes, malo: true },
    { etiqueta: 'Días perdidos',         valor: r?.dias_perdidos_at ?? 0, previo: c?.dias_perdidos_at, malo: true },
    { etiqueta: 'Enfermedad profesional', valor: r?.ep_total ?? 0,        previo: c?.ep_total, malo: true },
    { etiqueta: 'Atenciones médicas',    valor: r?.atenciones ?? 0,       previo: c?.atenciones },
    { etiqueta: 'Días de reposo',        valor: r?.dias_reposo ?? 0,      previo: c?.dias_reposo, malo: true },
    { etiqueta: 'Exámenes ocupacionales', valor: r?.examenes ?? 0,        previo: c?.examenes },
    { etiqueta: 'Capacitaciones',        valor: r?.capac_ejecutadas ?? 0, previo: c?.capac_ejecutadas }
  ];

  document.getElementById('cifras').innerHTML = cifras.map((f) => `
    <article class="cifra">
      <span class="cifra-etiqueta">${f.etiqueta}</span>
      <span class="cifra-valor">${f.valor}</span>
      ${pintarVariacion(f)}
    </article>
  `).join('');
}

/**
 * La variación solo se muestra si hay año de comparación.
 * El color depende del significado: más accidentes es malo,
 * más capacitaciones es bueno.
 */
function pintarVariacion(f) {
  if (f.previo == null) return '';

  const delta = f.valor - f.previo;
  if (delta === 0) return '<span class="cifra-delta cifra-igual">Sin cambio</span>';

  const subio = delta > 0;
  const bueno = f.malo ? !subio : subio;
  const flecha = subio ? '▲' : '▼';

  return `<span class="cifra-delta ${bueno ? 'delta-bueno' : 'delta-malo'}">
            ${flecha} ${Math.abs(delta)} vs ${estado.comparar}
          </span>`;
}

/* --- Índices --- */

function pintarIndices() {
  const i = estado.indices;
  const c = estado.indicesComp;

  const items = [
    {
      etiqueta: 'Índice de frecuencia',
      valor: i?.indice_frecuencia ?? 0,
      previo: c?.indice_frecuencia,
      nota: 'Accidentes por cada 100 trabajadores a tiempo completo'
    },
    {
      etiqueta: 'Índice de gravedad',
      valor: i?.indice_gravedad ?? 0,
      previo: c?.indice_gravedad,
      nota: 'Días perdidos por cada 100 trabajadores a tiempo completo'
    },
    {
      etiqueta: 'Tasa de riesgo',
      valor: i?.tasa_riesgo ?? 0,
      previo: c?.tasa_riesgo,
      nota: 'Días perdidos por cada accidente'
    }
  ];

  document.getElementById('indices').innerHTML = items.map((x) => {
    let variacion = '';
    if (x.previo != null) {
      const delta = Number(x.valor) - Number(x.previo);
      if (delta !== 0) {
        variacion = `<span class="indice-delta ${delta < 0 ? 'delta-bueno' : 'delta-malo'}">
                       ${delta < 0 ? '▼' : '▲'} ${Math.abs(delta).toFixed(2)}
                     </span>`;
      }
    }
    return `
      <article class="indice-caja">
        <div class="indice-cabecera">
          <span class="indice-etiqueta">${x.etiqueta}</span>
          ${variacion}
        </div>
        <span class="indice-valor">${Number(x.valor).toFixed(2)}</span>
        <span class="indice-nota">${x.nota}</span>
      </article>
    `;
  }).join('');
}

/* ============================================
   Gráficos · SVG construido a mano
   ============================================ */

/**
 * Gráfico de barras agrupadas.
 * @param {string} destino - id del contenedor
 * @param {string[]} etiquetas - eje X
 * @param {Array} series - [{nombre, color, datos:[]}]
 */
function barrasAgrupadas(destino, etiquetas, series) {
  const $c = document.getElementById(destino);

  const maximo = Math.max(1, ...series.flatMap((s) => s.datos));
  const todoCero = series.every((s) => s.datos.every((d) => d === 0));

  if (todoCero) {
    $c.innerHTML = '<p class="grafico-vacio">Sin registros en el período</p>';
    return;
  }

  /* Geometría */
  const ancho = 720, alto = 240;
  const margen = { arriba: 16, derecha: 12, abajo: 30, izquierda: 38 };
  const util = {
    ancho: ancho - margen.izquierda - margen.derecha,
    alto: alto - margen.arriba - margen.abajo
  };

  const paso = util.ancho / etiquetas.length;
  const anchoGrupo = paso * 0.68;
  const anchoBarra = anchoGrupo / series.length;

  const escala = (v) => util.alto * (1 - v / maximo);

  /* Rejilla y eje Y: cinco marcas */
  let rejilla = '';
  for (let i = 0; i <= 4; i++) {
    const v = maximo * i / 4;
    const y = margen.arriba + escala(v);
    rejilla += `
      <line class="rejilla" x1="${margen.izquierda}" y1="${y}"
            x2="${ancho - margen.derecha}" y2="${y}"></line>
      <text class="eje-texto" x="${margen.izquierda - 6}" y="${y + 3}"
            text-anchor="end">${redondear(v)}</text>
    `;
  }

  /* Barras */
  let barras = '';
  etiquetas.forEach((et, idx) => {
    const x0 = margen.izquierda + paso * idx + (paso - anchoGrupo) / 2;

    series.forEach((s, si) => {
      const v = s.datos[idx] || 0;
      const h = util.alto - escala(v);
      const x = x0 + anchoBarra * si;
      const y = margen.arriba + escala(v);

      if (v > 0) {
        barras += `
          <rect class="barra-svg" x="${x}" y="${y}"
                width="${anchoBarra - 1.5}" height="${h}"
                fill="${s.color}" rx="2">
            <title>${escapar(s.nombre)} · ${et}: ${v}</title>
          </rect>
        `;
      }
    });

    barras += `
      <text class="eje-texto" x="${margen.izquierda + paso * idx + paso / 2}"
            y="${alto - margen.abajo + 16}" text-anchor="middle">${et}</text>
    `;
  });

  $c.innerHTML = `
    <svg class="grafico" viewBox="0 0 ${ancho} ${alto}"
         preserveAspectRatio="xMidYMid meet" role="img">
      ${rejilla}
      <line class="eje" x1="${margen.izquierda}" y1="${margen.arriba + util.alto}"
            x2="${ancho - margen.derecha}" y2="${margen.arriba + util.alto}"></line>
      ${barras}
    </svg>
  `;
}

/** Gráfico de líneas: para magnitudes que evolucionan */
function lineas(destino, etiquetas, series) {
  const $c = document.getElementById(destino);

  const maximo = Math.max(1, ...series.flatMap((s) => s.datos));
  const todoCero = series.every((s) => s.datos.every((d) => d === 0));

  if (todoCero) {
    $c.innerHTML = '<p class="grafico-vacio">Sin registros en el período</p>';
    return;
  }

  const ancho = 720, alto = 240;
  const margen = { arriba: 16, derecha: 12, abajo: 30, izquierda: 38 };
  const util = {
    ancho: ancho - margen.izquierda - margen.derecha,
    alto: alto - margen.arriba - margen.abajo
  };

  const paso = util.ancho / (etiquetas.length - 1 || 1);
  const escalaY = (v) => margen.arriba + util.alto * (1 - v / maximo);
  const escalaX = (i) => margen.izquierda + paso * i;

  let rejilla = '';
  for (let i = 0; i <= 4; i++) {
    const v = maximo * i / 4;
    const y = escalaY(v);
    rejilla += `
      <line class="rejilla" x1="${margen.izquierda}" y1="${y}"
            x2="${ancho - margen.derecha}" y2="${y}"></line>
      <text class="eje-texto" x="${margen.izquierda - 6}" y="${y + 3}"
            text-anchor="end">${redondear(v)}</text>
    `;
  }

  let trazos = '';
  series.forEach((s) => {
    const puntos = s.datos.map((v, i) => `${escalaX(i)},${escalaY(v)}`).join(' ');
    trazos += `<polyline class="linea-svg" points="${puntos}"
                 fill="none" stroke="${s.color}" stroke-width="2"
                 stroke-linejoin="round" stroke-linecap="round"></polyline>`;

    s.datos.forEach((v, i) => {
      trazos += `<circle class="punto-svg" cx="${escalaX(i)}" cy="${escalaY(v)}"
                   r="3" fill="${s.color}">
                   <title>${escapar(s.nombre)} · ${etiquetas[i]}: ${v}</title>
                 </circle>`;
    });
  });

  let ejeX = '';
  etiquetas.forEach((et, i) => {
    ejeX += `<text class="eje-texto" x="${escalaX(i)}" y="${alto - margen.abajo + 16}"
               text-anchor="middle">${et}</text>`;
  });

  $c.innerHTML = `
    <svg class="grafico" viewBox="0 0 ${ancho} ${alto}"
         preserveAspectRatio="xMidYMid meet" role="img">
      ${rejilla}
      <line class="eje" x1="${margen.izquierda}" y1="${margen.arriba + util.alto}"
            x2="${ancho - margen.derecha}" y2="${margen.arriba + util.alto}"></line>
      ${trazos}
      ${ejeX}
    </svg>
  `;
}

/** Escala del eje: enteros si el rango lo permite */
function redondear(v) {
  if (v >= 10) return Math.round(v);
  if (v >= 1) return v.toFixed(0);
  return v.toFixed(1);
}

function pintarLeyenda(destino, series) {
  document.getElementById(destino).innerHTML = series.map((s) => `
    <span class="leyenda-item">
      <span class="leyenda-punto" style="background:${s.color}"></span>
      ${escapar(s.nombre)}
    </span>
  `).join('');
}

/* --- Gráficos concretos --- */

function pintarGraficoEventos() {
  const etiquetas = MESES_CORTOS.slice(1);
  const dato = (serie, campo) =>
    Array.from({ length: 12 }, (_, i) =>
      serie.find((s) => s.mes === i + 1)?.[campo] ?? 0);

  const series = [
    { nombre: 'Incidentes', color: COLOR.azul, datos: dato(estado.serie, 'incidentes') },
    { nombre: 'Accidentes', color: COLOR.naranja, datos: dato(estado.serie, 'accidentes') },
    { nombre: 'Enfermedad profesional', color: COLOR.rojo, datos: dato(estado.serie, 'enfermedades') }
  ];

  if (estado.comparar) {
    series.push({
      nombre: `Accidentes ${estado.comparar}`,
      color: COLOR.tenue,
      datos: dato(estado.serieComp, 'accidentes')
    });
  }

  barrasAgrupadas('grafico-eventos', etiquetas, series);
  pintarLeyenda('leyenda-eventos', series);
}

function pintarGraficoSalud() {
  const etiquetas = MESES_CORTOS.slice(1);
  const dato = (campo) =>
    Array.from({ length: 12 }, (_, i) =>
      estado.serie.find((s) => s.mes === i + 1)?.[campo] ?? 0);

  const series = [
    { nombre: 'Atenciones', color: COLOR.acento, datos: dato('atenciones') },
    { nombre: 'Días de reposo', color: COLOR.ambar, datos: dato('dias_reposo') }
  ];

  lineas('grafico-salud', etiquetas, series);
  pintarLeyenda('leyenda-salud', series);
}

function pintarGraficoExamenes() {
  const etiquetas = MESES_CORTOS.slice(1);
  const datos = Array.from({ length: 12 }, (_, i) =>
    estado.serie.find((s) => s.mes === i + 1)?.examenes ?? 0);

  barrasAgrupadas('grafico-examenes', etiquetas, [
    { nombre: 'Exámenes', color: COLOR.verde, datos }
  ]);
}

/* --- Morbilidad --- */

function pintarMorbilidad() {
  const $cuerpo = document.getElementById('cuerpo-morbilidad');
  document.getElementById('vacio-morbilidad').hidden = estado.morbilidad.length > 0;

  if (estado.morbilidad.length === 0) { $cuerpo.innerHTML = ''; return; }

  const maximo = Math.max(...estado.morbilidad.map((m) => m.casos));

  $cuerpo.innerHTML = estado.morbilidad.map((m) => {
    const pct = Math.round(m.casos / maximo * 100);
    return `
      <tr>
        <td class="celda-centro">
          <span class="cie-chip">${escapar(m.codigo_cie10 || '—')}</span>
        </td>
        <td>${escapar(m.descripcion || 'Sin descripción')}</td>
        <td class="celda-centro celda-numero">${m.casos}</td>
        <td class="celda-centro celda-tenue">${m.hombres}</td>
        <td class="celda-centro celda-tenue">${m.mujeres}</td>
        <td class="columna-distribucion">
          <div class="barra-pista barra-tabla">
            <div class="barra-relleno" style="width:${pct}%"></div>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

/* --- Capacitación --- */

function pintarCapacitacion() {
  const salud = estado.capacitacion.find((c) => c.ambito === 'salud');
  const seg = estado.capacitacion.find((c) => c.ambito === 'seguridad');

  barrasAgrupadas('grafico-capac', ['Salud', 'Seguridad'], [
    {
      nombre: 'Programadas',
      color: COLOR.tenue,
      datos: [salud?.programadas ?? 0, seg?.programadas ?? 0]
    },
    {
      nombre: 'Ejecutadas',
      color: COLOR.acento,
      datos: [salud?.ejecutadas ?? 0, seg?.ejecutadas ?? 0]
    },
    {
      nombre: 'Con registro',
      color: COLOR.verde,
      datos: [salud?.documentadas ?? 0, seg?.documentadas ?? 0]
    }
  ]);

  const r = estado.resumen;
  const prog = r?.capac_programadas ?? 0;
  const ejec = r?.capac_ejecutadas ?? 0;

  const barras = [
    { etiqueta: 'Ejecutadas', valor: ejec, total: prog },
    { etiqueta: 'Asistentes', valor: r?.capac_asistentes ?? 0, total: null }
  ];

  document.getElementById('capac-barras').innerHTML = barras.map((b) => {
    const pct = b.total ? Math.round(b.valor / b.total * 100) : null;
    return `
      <div class="barra-fila">
        <span class="barra-etiqueta">${b.etiqueta}</span>
        ${pct != null ? `
          <div class="barra-pista">
            <div class="barra-relleno" style="width:${pct}%"></div>
          </div>
          <span class="barra-valor">${b.valor}/${b.total}</span>
          <span class="barra-pct">${pct}%</span>
        ` : `
          <div class="barra-pista"><div class="barra-relleno" style="width:100%"></div></div>
          <span class="barra-valor">${b.valor}</span>
          <span class="barra-pct"></span>
        `}
      </div>
    `;
  }).join('');
}

/* ============================================
   Selección
   ============================================ */

async function seleccionarEmpresa() {
  estado.empresaId = $empresa.value || null;

  if (!estado.empresaId) {
    sessionStorage.removeItem('nexus_empresa');
    $tablero.hidden = true;
    $aviso.hidden = false;
    return;
  }

  sessionStorage.setItem('nexus_empresa', estado.empresaId);

  const opcion = $empresa.selectedOptions[0];
  estado.empresa = {
    razon_social: opcion.textContent,
    num_trabajadores: parseInt(opcion.dataset.trabajadores, 10) || 0
  };

  $tablero.hidden = false;
  $aviso.hidden = true;

  await cargarTodo();
  pintarTodo();
}

async function cambiarAnio() {
  estado.anio = parseInt(document.getElementById('tablero-anio').value, 10);

  /* El año de comparación no puede ser el mismo */
  const $comp = document.getElementById('tablero-comparar');
  if ($comp.value === String(estado.anio)) {
    $comp.value = '';
    estado.comparar = null;
  }

  if (!estado.empresaId) return;
  await cargarTodo();
  pintarTodo();
}

async function cambiarComparacion() {
  const valor = document.getElementById('tablero-comparar').value;
  estado.comparar = valor ? parseInt(valor, 10) : null;

  if (estado.comparar === estado.anio) {
    document.getElementById('tablero-comparar').value = '';
    estado.comparar = null;
    return;
  }

  if (!estado.empresaId) return;
  await cargarTodo();
  pintarTodo();
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  $empresa.addEventListener('change', seleccionarEmpresa);
  document.getElementById('tablero-anio').addEventListener('change', cambiarAnio);
  document.getElementById('tablero-comparar').addEventListener('change', cambiarComparacion);
  document.getElementById('btn-imprimir').addEventListener('click', () => window.print());
}

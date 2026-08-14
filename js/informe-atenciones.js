/* ============================================
   NEXUS · informe-atenciones.js

   Informe mensual, trimestral y anual de atenciones médicas
   a trabajadores, para cumplir con la normativa de SST.

   Hermano de informe-farmacia.js: mismo membrete, misma
   estructura de portada/secciones/firmas (.if-*, ya cargadas
   en atenciones.html vía farmacia.css), mismo patrón de
   textos editables que se guardan CON el informe.

   Diferencias a propósito:
    · No usa IA. El análisis sale redactado con las cifras
      reales (sin costo, sin depender de un tercero) y queda
      abierto para que el profesional lo amplíe. El plan de
      acción es un campo en blanco: eso sí requiere criterio
      clínico, no algo que deba simularse.
    · Nunca toca atenciones externas (ADAE, pasantes,
      comunidad): las cifras salen únicamente de la tabla
      `atenciones`, que es exclusiva de trabajadores.
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { sesionActual } from './auth.js?v=11';
import { escapar, formatearFecha } from './utils.js?v=12';
import { alCrear } from './autoria.js?v=1';
import { imprimirHoja } from './impresion.js?v=11';

const VERSION = 'v1';
console.info('NEXUS · informe-atenciones', VERSION);

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_ABREV = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
                      'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const inf = { empresaId: null, empresaNombre: '', ultimo: null };

/* ============================================
   Textos del informe — editables, se guardan CON cada
   informe (ver la razón en informe-farmacia.js: si la
   normativa cambia, el informe firmado no se reescribe solo).
   ============================================ */

const TEXTOS = {
  objetivo:
    'Presentar el registro de atenciones médicas brindadas a los trabajadores '
  + 'de la empresa durante el periodo informado, con el detalle de los '
  + 'diagnósticos más frecuentes, a fin de sustentar la vigilancia de la '
  + 'salud del personal y orientar las acciones de prevención pertinentes.',

  alcance:
    'Comprende la totalidad de atenciones médicas registradas a trabajadores '
  + 'de la empresa durante el periodo informado. No incluye atenciones '
  + 'brindadas a personas externas (contratistas de seguridad, pasantes o '
  + 'comunidad), que se registran y controlan por separado.',

  normativa:
    'Código del Trabajo, artículo 430, sobre la asistencia médica y '
  + 'farmacéutica a cargo del empleador.\n'
  + 'Decreto Ejecutivo 255, Reglamento de Seguridad y Salud en el Trabajo.\n'
  + 'Acuerdo Ministerial N.° 00004-2026, Ministerio de Salud Pública, '
  + 'Reglamento de los Servicios Integrales de Salud en el Trabajo (SISAT), '
  + 'que deroga el Acuerdo Ministerial N.° 1404 (Reglamento para el '
  + 'Funcionamiento de los Servicios Médicos de Empresa).\n'
  + 'Resolución CD 513, Reglamento del Seguro General de Riesgos del Trabajo.',

  metodologia:
    'La información se obtiene del registro de atenciones del sistema NEXUS. '
  + 'Se contabiliza el total de atenciones del periodo y se clasifican por '
  + 'diagnóstico principal según codificación CIE-10, expresando cada uno en '
  + 'número de casos y porcentaje sobre el total.',

  conclusion:
    'El registro de atenciones médicas se mantiene actualizado y disponible '
  + 'para consulta. Las acciones derivadas del análisis del periodo se '
  + 'detallan en el plan de acción de este informe.'
};

/* ============================================
   Arranque
   ============================================ */

export function iniciarInformeAtenciones(empresaId, empresaNombre) {
  inf.empresaId = empresaId;
  inf.empresaNombre = empresaNombre || '';
  llenarAnios();
  pintarTextosPorDefecto();
  cambiarTipoPeriodo();
  cargarPlanesAccion();
}

function llenarAnios() {
  const $anio = document.getElementById('inat-anio');
  if (!$anio || $anio.options.length > 0) return;
  const actual = new Date().getFullYear();
  for (let a = actual; a >= actual - 5; a--) {
    const o = document.createElement('option');
    o.value = String(a);
    o.textContent = String(a);
    $anio.appendChild(o);
  }
}

function pintarTextosPorDefecto() {
  const poner = (id, valor) => {
    const $t = document.getElementById(id);
    if ($t && !$t.value.trim()) $t.value = valor;
  };
  poner('inat-objetivo', TEXTOS.objetivo);
  poner('inat-alcance', TEXTOS.alcance);
  poner('inat-normativa', TEXTOS.normativa);
  poner('inat-metodologia', TEXTOS.metodologia);
  poner('inat-conclusion', TEXTOS.conclusion);

  /* Punto de partida desde la sesión, pero el campo queda
     libre para escribir el nombre y cargo tal como deben
     salir firmados —no siempre coincide con lo que hay
     guardado en el usuario del sistema. */
  const { quien, cargo } = sesionParaFirma();
  poner('inat-firma-nombre', quien || '');
  poner('inat-firma-cargo', cargo || '');
}

/** Muestra el campo de mes o el de trimestre según el tipo elegido. */
export function cambiarTipoPeriodo() {
  const tipo = document.getElementById('inat-tipo').value;
  document.getElementById('inat-campo-mes').hidden = tipo !== 'mensual';
  document.getElementById('inat-campo-trimestre').hidden = tipo !== 'trimestral';
}

/* ============================================
   Biblioteca de planes de acción

   Compartida entre empresas, igual que el catálogo CIE-10:
   son campañas de salud genéricas (pancartas, afiches,
   charlas), reutilizables sin importar la empresa. Se elige
   una según el diagnóstico más prevalente del periodo, y si
   no hay ninguna que se ajuste, se agrega nueva y queda
   guardada para el próximo informe —de cualquier empresa.
   ============================================ */

let planesAccion = [];

async function cargarPlanesAccion() {
  const { data, error } = await supabase
    .from('planes_accion')
    .select('id, nombre, texto')
    .eq('activo', true)
    .order('nombre');

  planesAccion = error ? [] : (data || []);
  pintarSelectPlanes();
}

function pintarSelectPlanes() {
  const $sel = document.getElementById('inat-plan-elegir');
  if (!$sel) return;
  const actual = $sel.value;
  $sel.innerHTML = '<option value="">— Elegir de la biblioteca de planes —</option>'
    + planesAccion.map((p) => `<option value="${p.id}">${escapar(p.nombre)}</option>`).join('');
  $sel.value = actual;
}

export function usarPlanDeAccion() {
  const id = document.getElementById('inat-plan-elegir').value;
  if (!id) return;
  const plan = planesAccion.find((p) => p.id === id);
  if (!plan) return;

  const $txt = document.getElementById('inat-plan-accion');
  /* Si ya hay algo escrito, se agrega debajo en vez de
     reemplazar: así se pueden combinar varios planes cuando
     hay más de un diagnóstico prevalente en el periodo. */
  $txt.value = $txt.value.trim()
    ? `${$txt.value.trim()}\n\n${plan.texto}`
    : plan.texto;

  document.getElementById('inat-plan-elegir').value = '';
}

export function abrirNuevoPlan() {
  document.getElementById('inat-plan-nombre').value = '';
  document.getElementById('inat-plan-texto').value = '';
  document.getElementById('inat-plan-error').textContent = '';
  document.getElementById('inat-plan-form').hidden = false;
  document.getElementById('inat-plan-nombre').focus();
}

export function cancelarNuevoPlan() {
  document.getElementById('inat-plan-form').hidden = true;
}

export async function guardarNuevoPlan() {
  const $error = document.getElementById('inat-plan-error');
  $error.textContent = '';

  const nombre = document.getElementById('inat-plan-nombre').value.trim();
  const texto = document.getElementById('inat-plan-texto').value.trim();

  if (!nombre) return $error.textContent = 'Indique un nombre corto para el plan';
  if (!texto) return $error.textContent = 'Escriba el texto del plan de acción';

  const { data, error } = await supabase
    .from('planes_accion')
    .insert(alCrear({ nombre, texto }))
    .select()
    .single();

  if (error) {
    $error.textContent = error.code === '23505'
      ? 'Ya existe un plan con ese nombre en la biblioteca.'
      : 'No se pudo guardar: ' + error.message;
    return;
  }

  planesAccion.push(data);
  planesAccion.sort((a, b) => a.nombre.localeCompare(b.nombre));
  pintarSelectPlanes();

  const $txt = document.getElementById('inat-plan-accion');
  $txt.value = $txt.value.trim() ? `${$txt.value.trim()}\n\n${texto}` : texto;

  document.getElementById('inat-plan-form').hidden = true;
}

/* ============================================
   Cálculo del periodo
   ============================================ */

function limitesPeriodo() {
  const tipo = document.getElementById('inat-tipo').value;
  const anio = parseInt(document.getElementById('inat-anio').value, 10);

  if (tipo === 'mensual') {
    const mes = parseInt(document.getElementById('inat-mes').value, 10);
    const fin = new Date(Date.UTC(anio, mes, 0));
    return {
      tipo, anio, periodo: mes,
      mesesIncluidos: [mes],
      inicio: `${anio}-${String(mes).padStart(2, '0')}-01`,
      fin: fin.toISOString().slice(0, 10),
      nombre: `${MESES[mes - 1][0].toUpperCase()}${MESES[mes - 1].slice(1)} de ${anio}`
    };
  }

  if (tipo === 'trimestral') {
    const trimestre = parseInt(document.getElementById('inat-trimestre').value, 10);
    const mesInicio = (trimestre - 1) * 3 + 1;
    const meses = [mesInicio, mesInicio + 1, mesInicio + 2];
    const fin = new Date(Date.UTC(anio, mesInicio + 2, 0));
    return {
      tipo, anio, periodo: trimestre,
      mesesIncluidos: meses,
      inicio: `${anio}-${String(mesInicio).padStart(2, '0')}-01`,
      fin: fin.toISOString().slice(0, 10),
      nombre: `${trimestre}.º trimestre de ${anio} `
            + `(${MESES[meses[0] - 1]} a ${MESES[meses[2] - 1]})`
    };
  }

  // anual
  return {
    tipo, anio, periodo: 0,
    mesesIncluidos: Array.from({ length: 12 }, (_, i) => i + 1),
    inicio: `${anio}-01-01`,
    fin: `${anio}-12-31`,
    nombre: `Año ${anio}`
  };
}

/* ============================================
   Generación
   ============================================ */

export async function generarInformeAtenciones() {
  const $btn = document.getElementById('inat-btn-generar');
  $btn.disabled = true;
  $btn.textContent = 'Generando…';

  const periodo = limitesPeriodo();

  /* Dos consultas independientes: el total de atenciones sale
     de la tabla real (nunca de personas externas, que viven
     en otra tabla aparte); los diagnósticos, de la vista de
     morbilidad —ya viene agregada por año/mes/código/sexo, no
     hay que sumar fila por fila desde cero. */
  const [atRes, morbRes] = await Promise.all([
    supabase.from('atenciones')
      .select('id, fecha')
      .eq('empresa_id', inf.empresaId)
      .gte('fecha', periodo.inicio)
      .lte('fecha', periodo.fin),
    supabase.from('v_morbilidad')
      .select('*')
      .eq('empresa_id', inf.empresaId)
      .eq('anio', periodo.anio)
      .eq('es_principal', true)
  ]);

  $btn.disabled = false;
  $btn.textContent = 'Generar informe';

  if (atRes.error || morbRes.error) {
    avisar('No se pudo generar el informe: '
         + (atRes.error || morbRes.error).message);
    return;
  }

  const atenciones = atRes.data || [];
  const morbilidad = (morbRes.data || [])
    .filter((m) => periodo.mesesIncluidos.includes(m.mes));

  /* Diagnósticos: número y porcentaje. Se recorta a los 10
     más frecuentes —con más, la tabla ya no cabe en el
     espacio disponible sin sacrificar el resto del informe. */
  const mapa = new Map();
  morbilidad.forEach((m) => {
    if (!mapa.has(m.codigo_cie10)) {
      mapa.set(m.codigo_cie10, { codigo: m.codigo_cie10, descripcion: m.descripcion, casos: 0 });
    }
    mapa.get(m.codigo_cie10).casos += m.casos;
  });
  const totalCasos = [...mapa.values()].reduce((s, d) => s + d.casos, 0);
  const diagnosticos = [...mapa.values()]
    .map((d) => ({ ...d, porcentaje: totalCasos > 0 ? (d.casos / totalCasos * 100) : 0 }))
    .sort((a, b) => b.casos - a.casos)
    .slice(0, 10);

  /* Comparativo mes a mes: solo tiene sentido si el periodo
     abarca más de un mes. Un mensual no se compara consigo
     mismo. */
  let comparativo = null;
  if (periodo.tipo !== 'mensual') {
    comparativo = periodo.mesesIncluidos.map((mes) => {
      const casosDelMes = morbilidad
        .filter((m) => m.mes === mes)
        .reduce((s, m) => s + m.casos, 0);
      const atencionesDelMes = atenciones
        .filter((a) => (new Date(a.fecha + 'T00:00:00').getMonth() + 1) === mes)
        .length;
      return { mes, etiqueta: MESES_ABREV[mes - 1], atenciones: atencionesDelMes, casos: casosDelMes };
    });
  }

  inf.ultimo = {
    periodo,
    totalAtenciones: atenciones.length,
    diagnosticos,
    totalCasos,
    comparativo
  };

  const $analisis = document.getElementById('inat-analisis');
  if (!$analisis.value.trim() || $analisis.dataset.autogenerado === 'si') {
    $analisis.value = analisisAutomatico(inf.ultimo);
    $analisis.dataset.autogenerado = 'si';
  }

  pintarPrevia(inf.ultimo);
  document.getElementById('inat-btn-descargar').hidden = false;
  document.getElementById('inat-btn-guardar').hidden = false;
}

/* Redacción automática, sin IA: son las mismas cifras del
   informe, solo puestas en prosa. Sirve de borrador — el
   profesional lo revisa y lo completa, igual que si lo
   hubiera escrito un asistente, pero sin depender de un
   servicio de pago ni de conexión externa. */
function analisisAutomatico(datos) {
  const { periodo, totalAtenciones, diagnosticos, comparativo } = datos;

  if (totalAtenciones === 0) {
    return `Durante ${periodo.nombre} no se registraron atenciones médicas a trabajadores de la empresa.`;
  }
  if (diagnosticos.length === 0) {
    return `Durante ${periodo.nombre} se registraron ${totalAtenciones} atenciones médicas, `
         + 'sin diagnóstico principal codificado en el sistema para el periodo.';
  }

  const principal = diagnosticos[0];
  let texto = `Durante ${periodo.nombre} se registraron ${totalAtenciones} atenciones médicas a `
    + `trabajadores de la empresa, con ${diagnosticos.length} diagnóstico`
    + `${diagnosticos.length === 1 ? '' : 's'} principal${diagnosticos.length === 1 ? '' : 'es'} `
    + `identificado${diagnosticos.length === 1 ? '' : 's'}. El diagnóstico más frecuente fue `
    + `${principal.descripcion} (${principal.codigo}), con ${principal.casos} caso`
    + `${principal.casos === 1 ? '' : 's'}, equivalente${principal.casos === 1 ? '' : 's'} al `
    + `${principal.porcentaje.toFixed(1)}% del total registrado.`;

  if (comparativo && comparativo.length > 1) {
    const primero = comparativo[0].casos;
    const ultimo = comparativo[comparativo.length - 1].casos;
    if (ultimo > primero) {
      texto += ` Se observa una tendencia al incremento de casos entre `
             + `${comparativo[0].etiqueta} y ${comparativo[comparativo.length - 1].etiqueta}, `
             + 'que conviene revisar con más detalle.';
    } else if (ultimo < primero) {
      texto += ` Se observa una tendencia a la disminución de casos entre `
             + `${comparativo[0].etiqueta} y ${comparativo[comparativo.length - 1].etiqueta}.`;
    } else {
      texto += ' El número de casos se mantuvo relativamente estable a lo largo del periodo.';
    }
  }

  return texto;
}

/* ============================================
   Gráfico de barras · SVG simple, sin librerías
   Se usa igual para el ranking de diagnósticos que para el
   comparativo mensual: recibe una lista de {etiqueta, valor}.
   ============================================ */

function graficoBarras(items, opciones = {}) {
  const ancho = opciones.ancho || 480;
  const alto = opciones.alto || 190;
  const color = opciones.color || '#1F4E79';

  if (items.length === 0) return '<p class="if-nota">Sin datos para graficar.</p>';

  const margenIzq = 8;
  const margenInf = 26;
  const margenSup = 16;
  const anchoUtil = ancho - margenIzq - 8;
  const altoUtil = alto - margenInf - margenSup;
  const max = Math.max(...items.map((i) => i.valor), 1);
  const espacio = anchoUtil / items.length;
  const anchoBarra = Math.min(espacio * 0.6, 46);

  const barras = items.map((item, i) => {
    const h = max > 0 ? (item.valor / max) * altoUtil : 0;
    const x = margenIzq + i * espacio + (espacio - anchoBarra) / 2;
    const y = margenSup + (altoUtil - h);
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${anchoBarra.toFixed(1)}"
            height="${h.toFixed(1)}" fill="${color}" rx="1"/>
      <text x="${(x + anchoBarra / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}"
            font-size="8" text-anchor="middle" fill="#1F2937">${item.valor}</text>
      <text x="${(x + anchoBarra / 2).toFixed(1)}" y="${alto - margenInf + 11}"
            font-size="7" text-anchor="middle" fill="#444">${escapar(String(item.etiqueta))}</text>
    `;
  }).join('');

  return `
    <svg viewBox="0 0 ${ancho} ${alto}" width="100%" style="max-width:${ancho}px; display:block; margin:0 auto;">
      <line x1="${margenIzq}" y1="${alto - margenInf}" x2="${ancho - 8}" y2="${alto - margenInf}"
            stroke="#B0BEC9" stroke-width="0.6"/>
      ${barras}
    </svg>`;
}

/* ============================================
   Previsualización en pantalla
   ============================================ */

function pintarPrevia(datos) {
  const $p = document.getElementById('inat-previa');
  $p.hidden = false;

  document.getElementById('inat-previa-titulo').textContent =
    `Informe de atenciones · ${datos.periodo.nombre}`;
  document.getElementById('inat-resumen').textContent =
    `${datos.totalAtenciones} atenciones · ${datos.diagnosticos.length} diagnósticos distintos`;

  pintarTablaDiagnosticos('inat-cuerpo-dx', datos.diagnosticos);

  document.getElementById('inat-grafico-dx').innerHTML = graficoBarras(
    datos.diagnosticos.slice(0, 8).map((d) => ({ etiqueta: d.codigo, valor: d.casos }))
  );

  const $comp = document.getElementById('inat-bloque-comparativo');
  if (datos.comparativo) {
    $comp.hidden = false;
    document.getElementById('inat-grafico-comparativo').innerHTML = graficoBarras(
      datos.comparativo.map((c) => ({ etiqueta: c.etiqueta, valor: c.casos })),
      { color: '#1b5e20' }
    );
  } else {
    $comp.hidden = true;
  }
}

function pintarTablaDiagnosticos(idCuerpo, diagnosticos) {
  const $cuerpo = document.getElementById(idCuerpo);
  $cuerpo.innerHTML = diagnosticos.map((d, i) => `
    <tr>
      <td class="celda-centro celda-tenue">${i + 1}</td>
      <td class="celda-centro"><span class="cie-chip">${escapar(d.codigo)}</span></td>
      <td>${escapar(d.descripcion)}</td>
      <td class="celda-centro">${d.casos}</td>
      <td class="celda-centro">${d.porcentaje.toFixed(1)}%</td>
    </tr>
  `).join('');
}

/* ============================================
   Documento imprimible
   ============================================ */

function construirDocumento(datos, textos, quien, cargo) {
  const t = textos || TEXTOS;

  const parrafos = (texto) => String(texto || '')
    .split(/\n+/).map((x) => x.trim()).filter(Boolean)
    .map((x) => `<p>${escapar(x)}</p>`).join('');

  const listaNormativa = String(t.normativa || '')
    .split(/\n+/).map((x) => x.trim()).filter(Boolean)
    .map((x) => `<li>${escapar(x)}</li>`).join('');

  const filasDx = datos.diagnosticos.map((d, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapar(d.codigo)}</td>
      <td class="if-izq">${escapar(d.descripcion)}</td>
      <td>${d.casos}</td>
      <td>${d.porcentaje.toFixed(1)}%</td>
    </tr>`).join('');

  const tablaDx = datos.diagnosticos.length === 0
    ? '<p class="if-nota">No se registraron diagnósticos en el periodo.</p>'
    : `<table class="if-tabla">
        <colgroup>
          <col style="width:6%"><col style="width:14%"><col style="width:56%">
          <col style="width:12%"><col style="width:12%">
        </colgroup>
        <thead>
          <tr><th>N°</th><th>CIE-10</th><th class="if-izq">Diagnóstico</th><th>Casos</th><th>%</th></tr>
        </thead>
        <tbody>${filasDx}</tbody>
      </table>`;

  const graficoDx = graficoBarras(
    datos.diagnosticos.slice(0, 8).map((d) => ({ etiqueta: d.codigo, valor: d.casos })),
    { ancho: 460, alto: 150 }
  );

  const bloqueComparativo = datos.comparativo ? `
      <h2 class="if-seccion">6. Comparativo del periodo</h2>
      <p>Casos registrados por mes dentro de ${escapar(datos.periodo.nombre)}:</p>
      ${graficoBarras(
        datos.comparativo.map((c) => ({ etiqueta: c.etiqueta, valor: c.casos })),
        { ancho: 460, alto: 150, color: '#1b5e20' }
      )}
  ` : '';

  const numeroSiguiente = datos.comparativo ? 7 : 6;
  const anio = String(datos.periodo.anio);

  return `
    <!-- ===== Portada ===== -->
    <section class="if-portada">
      <div class="if-portada-banda"></div>
      <div class="if-portada-marca"><img src="logo.png" class="if-portada-logo" alt=""></div>
      <div class="if-portada-centro">
        <p class="if-portada-unidad">Unidad de Seguridad y Salud Ocupacional</p>
        <p class="if-portada-servicio">Servicios Médicos de la Empresa</p>
        <div class="if-portada-regla"></div>
        <h1 class="if-portada-titulo">Informe de atenciones médicas<br>a trabajadores</h1>
        <p class="if-portada-mes">${escapar(datos.periodo.nombre)}</p>
        <div class="if-portada-regla"></div>
        <p class="if-portada-empresa">${escapar(inf.empresaNombre || 'Empresa')}</p>
      </div>
      <div class="if-portada-pie">
        <table class="if-portada-datos">
          <tr><th>Elaborado por</th><td>${escapar(quien || 'No identificado')}</td></tr>
          ${cargo ? `<tr><th>Cargo</th><td>${escapar(cargo)}</td></tr>` : ''}
          <tr><th>Fecha de elaboración</th><td>${escapar(formatearFecha(new Date().toISOString().slice(0, 10)))}</td></tr>
          <tr><th>Periodo informado</th><td>${escapar(datos.periodo.nombre)}</td></tr>
        </table>
        <p class="if-portada-ref">SG-SST · ${escapar(anio)}</p>
      </div>
      <div class="if-portada-banda if-portada-banda-baja"></div>
    </section>

    <!-- ===== Contenido ===== -->
    <section class="if-contenido">
      <header class="if-membrete">
        <img src="logo.png" class="if-membrete-logo" alt="">
        <div class="if-membrete-texto">
          <strong>${escapar(inf.empresaNombre || 'Empresa')}</strong><br>
          Unidad de Seguridad y Salud Ocupacional · Servicios Médicos
        </div>
        <div class="if-membrete-ref">Informe de atenciones<br>${escapar(datos.periodo.nombre)}</div>
      </header>

      <h2 class="if-seccion">1. Objetivo</h2>
      ${parrafos(t.objetivo)}

      <h2 class="if-seccion">2. Alcance</h2>
      ${parrafos(t.alcance)}

      <h2 class="if-seccion">3. Marco normativo</h2>
      <ul class="if-lista">${listaNormativa}</ul>

      <h2 class="if-seccion">4. Metodología</h2>
      ${parrafos(t.metodologia)}

      <h2 class="if-seccion">5. Diagnósticos más frecuentes</h2>
      <p>Total de atenciones en el periodo: <strong>${datos.totalAtenciones}</strong>.</p>
      ${tablaDx}
      ${graficoDx}

      ${bloqueComparativo}

      <h2 class="if-seccion">${numeroSiguiente}. Análisis del periodo</h2>
      ${parrafos(t.analisis)}

      <h2 class="if-seccion">${numeroSiguiente + 1}. Plan de acción</h2>
      ${t.plan_accion && t.plan_accion.trim()
        ? parrafos(t.plan_accion)
        : '<p class="if-nota">Sin plan de acción registrado para este periodo.</p>'}

      <h2 class="if-seccion">${numeroSiguiente + 2}. Conclusión</h2>
      ${parrafos(t.conclusion)}

      <div class="if-firmas">
        <div class="if-firma">
          <div class="if-firma-linea"></div>
          <p class="if-firma-rotulo">Elaborado por</p>
          <p class="if-firma-nombre">${escapar(quien || 'No identificado')}</p>
          ${cargo ? `<p class="if-firma-cargo">${escapar(cargo)}</p>` : ''}
        </div>
      </div>
    </section>`;
}

/* Solo para el prellenado inicial del formulario. Una vez que
   la persona edita el campo, esta función ya no se vuelve a
   consultar: pintarTextosPorDefecto() no sobrescribe lo que
   ya tiene contenido. */
function sesionParaFirma() {
  const p = sesionActual();
  if (!p) return { quien: null, cargo: null };
  const quien = [p.titulo, p.nombres, p.apellidos].filter(Boolean).join(' ').trim();
  return { quien: quien || null, cargo: p.cargo || null };
}

/* Lo que de verdad se imprime y se guarda: siempre lo que hay
   escrito en el formulario, nunca la sesión directamente —el
   nombre y cargo de firma no siempre coinciden con lo que
   quedó guardado en el usuario del sistema. */
function datosDeFirma() {
  const quien = document.getElementById('inat-firma-nombre').value.trim();
  const cargo = document.getElementById('inat-firma-cargo').value.trim();
  return { quien: quien || null, cargo: cargo || null };
}

function textosDesdeFormulario() {
  return {
    objetivo: document.getElementById('inat-objetivo').value,
    alcance: document.getElementById('inat-alcance').value,
    normativa: document.getElementById('inat-normativa').value,
    metodologia: document.getElementById('inat-metodologia').value,
    analisis: document.getElementById('inat-analisis').value,
    plan_accion: document.getElementById('inat-plan-accion').value,
    conclusion: document.getElementById('inat-conclusion').value
  };
}

export async function descargarInformeAtenciones() {
  if (!inf.ultimo) return avisar('Genere primero el informe.');

  const $z = document.getElementById('inat-impresion');
  if (!$z) return avisar('Falta actualizar la página para poder imprimir.');

  const { quien, cargo } = datosDeFirma();
  $z.innerHTML = construirDocumento(inf.ultimo, textosDesdeFormulario(), quien, cargo);

  avisar('En el diálogo de impresión: active «Gráficos de fondo» para que salgan '
       + 'los colores y las barras, y desactive «Encabezado y pie de página».', true);

  /* certificados.css también define @page en esta misma
     página (para oficios y certificados, que sí necesitan ser
     horizontales) y se carga DESPUÉS de farmacia.css, así que
     gana su tamaño y su margen —incluso para este informe,
     que nada tiene que ver con eso.

     La única forma de que este informe imprima vertical sin
     tocar ni farmacia.css ni certificados.css —y sin romper
     la impresión de oficios, que sigue necesitando ser
     horizontal en esta misma página— es declarar la regla acá
     mismo, justo antes de imprimir, y quitarla apenas termina:
     así nunca queda pisando la próxima impresión de un
     certificado. */
  const $paginaTmp = document.createElement('style');
  $paginaTmp.id = 'inat-pagina-tmp';
  $paginaTmp.textContent =
    '@media print { @page { size: A4 portrait !important; '
  + 'margin: 16mm 15mm 18mm 20mm !important; } }';
  document.head.appendChild($paginaTmp);

  await imprimirHoja('inat-impresion', 'imprimiendo-informe',
    `Informe atenciones · ${inf.ultimo.periodo.nombre}`);

  setTimeout(() => { $paginaTmp.remove(); }, 800);
}

/* ============================================
   Guardar (para poder reimprimir después sin recalcular)
   ============================================ */

export async function guardarInformeAtenciones() {
  if (!inf.ultimo) return avisar('Genere primero el informe.');

  const { quien, cargo } = datosDeFirma();
  const textos = textosDesdeFormulario();
  const { periodo } = inf.ultimo;

  const $btn = document.getElementById('inat-btn-guardar');
  $btn.disabled = true;

  const fila = alCrear({
    empresa_id: inf.empresaId,
    tipo: periodo.tipo,
    anio: periodo.anio,
    periodo: periodo.periodo,
    nombre_periodo: periodo.nombre,
    detalle: {
      totalAtenciones: inf.ultimo.totalAtenciones,
      diagnosticos: inf.ultimo.diagnosticos,
      comparativo: inf.ultimo.comparativo
    },
    analisis: textos.analisis,
    plan_accion: textos.plan_accion,
    elaborado_por: quien,
    cargo
  });

  /* upsert por periodo: rehacer el informe de un mes debe
     sustituir al anterior, no acumular duplicados. */
  const { error } = await supabase.from('informes_atenciones')
    .upsert(fila, { onConflict: 'empresa_id,tipo,anio,periodo' });

  $btn.disabled = false;

  if (error) return avisar('No se pudo guardar: ' + error.message);
  avisar('Informe guardado.', true);
}

/* ============================================
   Avisos
   ============================================ */

function avisar(texto, exito = false) {
  const $a = document.getElementById('inat-alerta');
  if (!$a) return alert(texto);
  $a.textContent = texto;
  $a.className = exito ? 'alerta alerta-ok' : 'alerta';
  $a.hidden = false;
  setTimeout(() => { $a.hidden = true; }, 6000);
}

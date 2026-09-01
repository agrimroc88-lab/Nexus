/* ============================================
   NEXUS · psicologia.js
   Lógica exclusiva de psicologia.html

   Reglas de negocio:
    · Cada ficha psicológica queda como historial: hacer una
      ficha nueva al mismo trabajador no borra la anterior.
    · La "Nueva ficha" precarga la última para no reescribir;
      al guardar se crea SIEMPRE un registro nuevo con su fecha.
    · La pestaña Atenciones es un conteo por tipo y mes (producción),
      derivado de las fichas guardadas. No se llena a mano.
    · El primero que atiende puede registrar al trabajador.
    · Dato reservado: solo psicologo, psico_social y admin.
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { protegerPagina, puedeVerPsicologia, empresasPermitidas, resolverEmpresaActiva, modulosActivosEmpresa } from './auth.js?v=11';
import { montarNavegacion } from './nav.js?v=11';
import { escapar, textoOGuion, retrasar, formatearFecha } from './utils.js?v=11';
import { alCrear } from './autoria.js?v=1';

/* --- Estado --- */
const estado = {
  perfil: null,
  empresaId: null,
  empresaNombre: '',
  fichas: [],          // fichas de la empresa (v_fichas_psicologicas)
  manual: [],          // registro manual de atenciones (atenciones_manual_salud)
  manualActual: null,  // { mes, datosMes } del modal abierto
  paciente: null,      // trabajador localizado en la pestaña Fichas
  altaPendiente: null, // { codigo } cuando se va a registrar un trabajador nuevo
  histAbierto: false,
  vista: 'fichas',
  verId: null,          // ficha mostrada en el modal de detalle
  editandoId: null      // id de la ficha que se está editando (null = ficha nueva)
};

const HOY = () => new Date().toISOString().slice(0, 10);

const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const TIPOS = {
  ingreso: 'Ingreso',
  periodica: 'Periódica',
  asistencial: 'Asistencial',
  seguimiento: 'Seguimiento'
};

/* --- Referencias --- */
const $nombreEmpresa = document.getElementById('empresa-activa-nombre');
const $area     = document.getElementById('area-trabajo');
const $avisoIni = document.getElementById('aviso-inicial');

iniciar();

/* ============================================
   Arranque
   ============================================ */

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  if (!puedeVerPsicologia(perfil.rol)) {
    window.location.href = '/Nexus/dashboard.html';
    return;
  }

  estado.perfil = perfil;
  montarNavegacion(perfil, 'psicologia');

  prepararAnios();

  const permitidas = await empresasPermitidas(perfil);
  if (permitidas.length === 0) {
    $avisoIni.textContent = 'No tienes ninguna empresa asignada. Contacta al administrador.';
    return;
  }
  const empresa = resolverEmpresaActiva(permitidas);
  if (!empresa) return; // está redirigiendo a seleccionar-empresa.html

  const activos = await modulosActivosEmpresa(empresa.id);
  if (!activos.has('psicologia')) {
    document.querySelector('.contenido').innerHTML =
      '<p class="aviso-inicial">Este módulo no está activo para esta empresa.</p>';
    return;
  }

  if ($nombreEmpresa) $nombreEmpresa.textContent = empresa.razon_social;

  await seleccionarEmpresa(empresa);
  conectarEventos();
}

function prepararAnios() {
  const actual = new Date().getFullYear();
  const $sel = document.getElementById('at-anio');
  for (let a = actual; a >= actual - 5; a--) {
    const opcion = document.createElement('option');
    opcion.value = a;
    opcion.textContent = a;
    $sel.appendChild(opcion);
  }
}

/* ============================================
   Datos
   ============================================ */

async function cargarFichas() {
  const { data, error } = await supabase
    .from('v_fichas_psicologicas')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .order('fecha', { ascending: false })
    .order('creado_en', { ascending: false })
    .limit(1000);

  estado.fichas = error ? [] : (data || []);
}

/** Registro manual: mismo patrón que ya usa "Atenciones
    ocupacionales" en Salud Ocupacional — una fila por
    mes + tipo, con hombres/mujeres, editable por mes.
    Se suma a lo que ya cuenten las fichas reales. */
async function cargarManual() {
  const { data, error } = await supabase
    .from('atenciones_manual_salud')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('modulo', 'psicologia');

  if (error) {
    console.warn('NEXUS · falta ejecutar sql_atenciones_manual_salud_v2.sql', error.message);
    estado.manual = [];
    return;
  }
  estado.manual = data || [];
}

/* ============================================
   Resumen
   ============================================ */

function pintarResumen() {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth() + 1;

  const delAnio = estado.fichas.filter((f) => new Date(f.fecha + 'T00:00').getFullYear() === anio);
  const delMes = delAnio.filter((f) => new Date(f.fecha + 'T00:00').getMonth() + 1 === mes);

  document.getElementById('kpi-mes').textContent = delMes.length;
  document.getElementById('kpi-anio').textContent = delAnio.length;
  document.getElementById('kpi-personas').textContent =
    new Set(delAnio.map((f) => f.trabajador_id)).size;
  document.getElementById('kpi-abiertos').textContent =
    estado.fichas.filter((f) => f.estado === 'abierto').length;
}

/* ============================================
   Vista · Atenciones (conteo de producción)
   ============================================ */

/* ============================================
   Gráfico de tendencia mensual · tipos de atención
   Cuatro series por mes. SVG a mano, sin librerías.
   ============================================ */

const COLORES_TIPO = {
  ingreso:     '#1b5e20',
  periodica:   '#2e86c1',
  asistencial: '#e07b39',
  seguimiento: '#7d3c98'
};

function pintarTendenciaAtenciones(fichasDelAnio, manualDelAnio) {
  const $g = document.getElementById('at-grafico');
  const $l = document.getElementById('at-leyenda');
  if (!$g) return;

  const ids = ['ingreso', 'periodica', 'asistencial', 'seguimiento'];
  const porTipo = {};
  ids.forEach((id) => { porTipo[id] = new Array(12).fill(0); });

  (fichasDelAnio || []).forEach((f) => {
    const m = new Date(f.fecha + 'T00:00').getMonth();
    if (porTipo[f.tipo]) porTipo[f.tipo][m]++;
  });

  (manualDelAnio || []).forEach((r) => {
    if (porTipo[r.tipo]) porTipo[r.tipo][r.mes - 1] += (r.hombres || 0) + (r.mujeres || 0);
  });

  const series = ids.map((id) => ({
    nombre: TIPOS[id] || id,
    color: COLORES_TIPO[id],
    datos: porTipo[id]
  }));

  if ($l) {
    $l.innerHTML = series.map((s) =>
      `<span class="leyenda-item">
         <span class="leyenda-color" style="background:${s.color}"></span>${escapar(s.nombre)}
       </span>`).join('');
  }

  const todoCero = series.every((s) => s.datos.every((d) => d === 0));
  if (todoCero) {
    $g.innerHTML = '<p class="grafico-vacio">Sin fichas en el año seleccionado</p>';
    return;
  }

  const etiquetas = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
                     'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const maximo = Math.max(1, ...series.flatMap((s) => s.datos));

  const ancho = 760, alto = 260;
  const margen = { arriba: 18, derecha: 14, abajo: 32, izquierda: 40 };
  const util = {
    ancho: ancho - margen.izquierda - margen.derecha,
    alto: alto - margen.arriba - margen.abajo
  };
  const paso = util.ancho / (etiquetas.length - 1);
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
            text-anchor="end">${Math.round(v)}</text>`;
  }

  let trazos = '';
  series.forEach((s) => {
    const puntos = s.datos.map((v, i) => `${escalaX(i)},${escalaY(v)}`).join(' ');
    trazos += `<polyline points="${puntos}" fill="none" stroke="${s.color}"
                 stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></polyline>`;
    s.datos.forEach((v, i) => {
      if (v === 0) return;
      trazos += `<circle cx="${escalaX(i)}" cy="${escalaY(v)}" r="3.5"
                   fill="#fff" stroke="${s.color}" stroke-width="2">
                   <title>${escapar(s.nombre)} · ${etiquetas[i]}: ${v}</title>
                 </circle>`;
    });
  });

  let ejeX = '';
  etiquetas.forEach((et, i) => {
    ejeX += `<text class="eje-texto" x="${escalaX(i)}" y="${alto - margen.abajo + 18}"
               text-anchor="middle">${et}</text>`;
  });

  $g.innerHTML = `
    <svg class="grafico" viewBox="0 0 ${ancho} ${alto}"
         preserveAspectRatio="xMidYMid meet" role="img">
      ${rejilla}
      <line class="eje" x1="${margen.izquierda}" y1="${margen.arriba + util.alto}"
            x2="${ancho - margen.derecha}" y2="${margen.arriba + util.alto}"></line>
      ${trazos}
      ${ejeX}
    </svg>`;
}

function pintarAtenciones() {
  const anio = parseInt(document.getElementById('at-anio').value, 10);
  const $cuerpo = document.getElementById('cuerpo-atenciones');
  const $pie = document.getElementById('pie-atenciones');

  const delAnio = estado.fichas.filter(
    (f) => new Date(f.fecha + 'T00:00').getFullYear() === anio
  );
  const manualDelAnio = estado.manual.filter((m) => m.anio === anio);

  $cuerpo.innerHTML = '';
  $pie.innerHTML = '';

  pintarTendenciaAtenciones(delAnio, manualDelAnio);

  const IDS = ['ingreso', 'periodica', 'asistencial', 'seguimiento'];

  /* Combinar: cada ficha real cuenta 1 por mes+tipo+sexo; el
     registro manual ya trae hombres/mujeres agregados por
     mes+tipo, y se suma encima. */
  const filas = {};
  for (let m = 1; m <= 12; m++) {
    filas[m] = {};
    IDS.forEach((id) => { filas[m][id] = { h: 0, m: 0 }; });
  }

  delAnio.forEach((f) => {
    const m = new Date(f.fecha + 'T00:00').getMonth() + 1;
    if (!filas[m][f.tipo]) return;
    if (f.sexo === 'M') filas[m][f.tipo].h++;
    if (f.sexo === 'F') filas[m][f.tipo].m++;
  });

  manualDelAnio.forEach((r) => {
    if (!filas[r.mes] || !filas[r.mes][r.tipo]) return;
    filas[r.mes][r.tipo].h += r.hombres || 0;
    filas[r.mes][r.tipo].m += r.mujeres || 0;
  });

  const frag = document.createDocumentFragment();
  const tot = { ingreso: 0, periodica: 0, asistencial: 0, seguimiento: 0, total: 0 };

  for (let m = 1; m <= 12; m++) {
    const datosMes = filas[m];
    let celdas = `<td class="celda-mes">${MESES[m]}</td>`;
    let totalMes = 0;

    IDS.forEach((id) => {
      const h = datosMes[id].h;
      const mVal = datosMes[id].m;
      const sub = h + mVal;
      totalMes += sub;
      tot[id] += sub;
      celdas += `
        <td class="celda-centro ${h ? '' : 'celda-cero'}">${h}</td>
        <td class="celda-centro ${mVal ? '' : 'celda-cero'}">${mVal}</td>
        <td class="celda-centro celda-subtotal">${sub || '—'}</td>
      `;
    });

    tot.total += totalMes;
    celdas += `<td class="celda-centro celda-total">${totalMes || '—'}</td>`;

    const tr = document.createElement('tr');
    tr.className = 'fila-mes fila-editable';
    tr.innerHTML = celdas;
    tr.addEventListener('click', () => abrirManual(m, datosMes));
    frag.appendChild(tr);
  }
  $cuerpo.appendChild(frag);

  let pie = '<tr class="fila-totales"><td class="celda-mes">Total</td>';
  IDS.forEach((id) => {
    // El desglose H/M del total no se lleva aparte; solo el subtotal por tipo.
    pie += `<td class="celda-centro" colspan="2"></td>
            <td class="celda-centro celda-subtotal">${tot[id]}</td>`;
  });
  pie += `<td class="celda-centro celda-total">${tot.total}</td></tr>`;
  $pie.innerHTML = pie;

  document.getElementById('vacio-atenciones').hidden = true;
  pintarKpiAtenciones(tot);
}

function pintarKpiAtenciones(tot) {
  document.getElementById('at-kpi-ingreso').textContent = tot.ingreso;
  document.getElementById('at-kpi-periodica').textContent = tot.periodica;
  document.getElementById('at-kpi-asistencial').textContent = tot.asistencial;
  document.getElementById('at-kpi-seguimiento').textContent = tot.seguimiento;
  document.getElementById('at-kpi-total').textContent = tot.total;
}

/* ============================================
   Registro manual de atenciones

   Mismo patrón que "Atenciones ocupacionales": clic en el mes,
   se abre un modal con hombres/mujeres por tipo, y se guarda.
   Lo que ya cuentan las fichas reales no se toca aquí — esto
   solo ajusta o completa lo que falte ese mes.
   ============================================ */

const IDS_TIPO = ['ingreso', 'periodica', 'asistencial', 'seguimiento'];

function abrirManual(mes, datosMes) {
  estado.manualActual = { mes, datosMes };

  document.getElementById('man-titulo').textContent = MESES[mes];
  document.getElementById('man-marca').textContent = document.getElementById('at-anio').value;

  const existentes = new Map(
    estado.manual
      .filter((r) => r.anio === parseInt(document.getElementById('at-anio').value, 10) && r.mes === mes)
      .map((r) => [r.tipo, r]));

  const $campos = document.getElementById('man-campos');
  $campos.innerHTML = IDS_TIPO.map((id) => {
    const r = existentes.get(id);
    return `
      <div class="man-grupo">
        <span class="man-tipo">${TIPOS[id]}</span>
        <div class="man-entradas">
          <div class="campo campo-mini">
            <label class="etiqueta" for="man_${id}_h">Hombres</label>
            <input class="entrada" id="man_${id}_h" type="number" min="0"
                   value="${r?.hombres ?? 0}">
          </div>
          <div class="campo campo-mini">
            <label class="etiqueta" for="man_${id}_m">Mujeres</label>
            <input class="entrada" id="man_${id}_m" type="number" min="0"
                   value="${r?.mujeres ?? 0}">
          </div>
        </div>
      </div>
    `;
  }).join('');

  const primero = existentes.get(IDS_TIPO[0]);
  document.getElementById('man_observacion').value = primero?.observacion ?? '';

  document.getElementById('alerta-manual').hidden = true;
  document.getElementById('modal-manual').hidden = false;
}

async function guardarManual() {
  const { mes } = estado.manualActual || {};
  if (!mes) return;

  const anio = parseInt(document.getElementById('at-anio').value, 10);
  const observacion = document.getElementById('man_observacion').value.trim() || null;

  const $btn = document.getElementById('btn-guardar-manual');
  $btn.disabled = true;

  const filas = IDS_TIPO.map((id) => alCrear({
    modulo: 'psicologia',
    empresa_id: estado.empresaId,
    anio,
    mes,
    tipo: id,
    hombres: parseInt(document.getElementById(`man_${id}_h`).value, 10) || 0,
    mujeres: parseInt(document.getElementById(`man_${id}_m`).value, 10) || 0,
    observacion
  }));

  const { error } = await supabase
    .from('atenciones_manual_salud')
    .upsert(filas, { onConflict: 'modulo,empresa_id,anio,mes,tipo' });

  $btn.disabled = false;

  if (error) {
    const $a = document.getElementById('alerta-manual');
    $a.textContent = 'No se pudo guardar: ' + error.message;
    $a.hidden = false;
    return;
  }

  document.getElementById('modal-manual').hidden = true;
  await cargarManual();
  pintarAtenciones();
}

/* ============================================
   Buscador de trabajador (pestaña Fichas)
   ============================================ */

async function buscarPaciente() {
  const codigo = parseInt(document.getElementById('busca_codigo').value, 10);
  const $ayuda = document.getElementById('ayuda-busca');

  if (!codigo) { $ayuda.textContent = 'Escriba un código de trabajador.'; return; }

  const { data, error } = await supabase
    .from('v_trabajadores')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('codigo', codigo)
    .maybeSingle();

  if (error) { $ayuda.textContent = 'Error: ' + error.message; return; }

  if (!data) {
    // No existe: ofrecer alta
    $ayuda.textContent = '';
    ofrecerAlta(codigo);
    return;
  }

  $ayuda.textContent = '';
  mostrarPaciente(data);
}

async function buscarPorNombre() {
  const texto = document.getElementById('busca_nombre').value.trim();
  const $cont = document.getElementById('busca_sugerencias');

  if (texto.length < 2) { ocultarSugerencias(); return; }

  const { data, error } = await supabase
    .from('v_trabajadores')
    .select('id, codigo, cedula, nombre_completo, cargo')
    .eq('empresa_id', estado.empresaId)
    .or(`nombre_completo.ilike.%${texto}%,cedula.ilike.%${texto}%`)
    .order('nombre_completo')
    .limit(8);

  if (error || !data || data.length === 0) { ocultarSugerencias(); return; }

  $cont.innerHTML = data.map((t) => `
    <button class="sugerencia" type="button" data-codigo="${t.codigo}">
      <span class="sugerencia-nombre">${escapar(t.nombre_completo)}</span>
      <span class="sugerencia-meta">Cód. ${t.codigo} · ${escapar(t.cedula)} · ${escapar(textoOGuion(t.cargo))}</span>
    </button>`).join('');
  $cont.hidden = false;

  $cont.querySelectorAll('.sugerencia').forEach((b) => {
    b.addEventListener('click', () => {
      document.getElementById('busca_codigo').value = b.dataset.codigo;
      document.getElementById('busca_nombre').value = '';
      ocultarSugerencias();
      buscarPaciente();
    });
  });
}

function ocultarSugerencias() {
  const $c = document.getElementById('busca_sugerencias');
  $c.hidden = true;
  $c.innerHTML = '';
}

function mostrarPaciente(t) {
  estado.paciente = t;
  estado.histAbierto = false;

  document.getElementById('aviso-fichas').hidden = true;
  document.getElementById('paciente').hidden = false;
  document.getElementById('p-historial').hidden = true;

  document.getElementById('p-nombre').textContent = t.nombre_completo;
  document.getElementById('p-meta').textContent =
    `${t.activo ? 'Activo' : 'Inactivo'} · ${textoOGuion(t.area)}`;
  document.getElementById('p-codigo').textContent = t.codigo;
  document.getElementById('p-cedula').textContent = t.cedula;
  document.getElementById('p-edad').textContent = t.edad != null ? `${t.edad} años` : '—';
  document.getElementById('p-sexo').textContent = t.sexo === 'M' ? 'Masculino' : t.sexo === 'F' ? 'Femenino' : '—';
  document.getElementById('p-cargo').textContent = textoOGuion(t.cargo);

  const propias = estado.fichas.filter((f) => f.trabajador_id === t.id);
  document.getElementById('p-total').textContent = propias.length;
}

/* ============================================
   Alta de trabajador
   ============================================ */

async function ofrecerAlta(codigo) {
  estado.altaPendiente = { codigo };
  document.getElementById('alerta-alta').hidden = true;

  // Sugerir el código escrito, o el siguiente libre si estaba vacío
  const $cod = document.getElementById('al_codigo');
  $cod.value = codigo || '';
  document.getElementById('al_cedula').value = '';
  document.getElementById('al_apellidos').value = '';
  document.getElementById('al_nombres').value = '';
  document.getElementById('al_sexo').value = '';
  document.getElementById('al_nacimiento').value = '';

  const { data } = await supabase.rpc('siguiente_codigo', { p_empresa: estado.empresaId });
  document.getElementById('ayuda-alta-codigo').textContent =
    data ? `Sugerencia de código libre: ${data}` : '';

  document.getElementById('modal-alta').hidden = false;
  document.getElementById('al_cedula').focus();
}

async function guardarAlta() {
  const $alerta = document.getElementById('alerta-alta');
  const codigo = parseInt(document.getElementById('al_codigo').value, 10);
  const cedula = document.getElementById('al_cedula').value.trim();
  const apellidos = document.getElementById('al_apellidos').value.trim();
  const nombres = document.getElementById('al_nombres').value.trim();
  const sexo = document.getElementById('al_sexo').value || null;
  const nacimiento = document.getElementById('al_nacimiento').value || null;

  if (!codigo || codigo < 1 || codigo > 3000) { return errorAlta('El código debe estar entre 1 y 3000.'); }
  if (!/^[0-9]{10}$/.test(cedula)) { return errorAlta('La cédula debe tener 10 dígitos.'); }
  if (!apellidos || !nombres) { return errorAlta('Apellidos y nombres son obligatorios.'); }

  const { data, error } = await supabase
    .from('trabajadores')
    .insert({
      empresa_id: estado.empresaId,
      codigo, cedula, apellidos, nombres,
      sexo, fecha_nacimiento: nacimiento
    })
    .select('id')
    .single();

  if (error) {
    if (error.message.includes('uq_trabajador_codigo')) return errorAlta('Ese código ya está en uso en esta empresa.');
    if (error.message.includes('uq_trabajador_cedula')) return errorAlta('Esa cédula ya está registrada en esta empresa.');
    return errorAlta('No fue posible registrar: ' + error.message);
  }

  $alerta.hidden = true;
  document.getElementById('modal-alta').hidden = true;

  // Traer el trabajador recién creado desde la vista y mostrarlo
  const { data: t } = await supabase
    .from('v_trabajadores')
    .select('*')
    .eq('id', data.id)
    .single();

  document.getElementById('busca_codigo').value = t.codigo;
  mostrarPaciente(t);
  // Abrir directamente la ficha nueva para ese trabajador
  abrirFichaNueva();
}

function errorAlta(msg) {
  const $a = document.getElementById('alerta-alta');
  $a.textContent = msg;
  $a.hidden = false;
}

/* ============================================
   Historial embebido
   ============================================ */

async function alternarHistorial() {
  const $panel = document.getElementById('p-historial');
  estado.histAbierto = !estado.histAbierto;
  $panel.hidden = !estado.histAbierto;
  if (estado.histAbierto) pintarHistorial();
}

function pintarHistorial() {
  const $lista = document.getElementById('p-lista');
  const propias = estado.fichas
    .filter((f) => f.trabajador_id === estado.paciente.id)
    .sort((a, b) => (a.fecha < b.fecha ? 1 : -1));

  if (propias.length === 0) {
    $lista.innerHTML = '<p class="vacio">Sin fichas previas. Cree la primera con “+ Nueva ficha”.</p>';
    return;
  }

  $lista.innerHTML = propias.map((f) => `
    <article class="evento">
      <div class="evento-fecha">
        <span class="evento-dia">${formatearFecha(f.fecha)}</span>
        <span class="etiqueta-tipo">${TIPOS[f.tipo] || f.tipo}</span>
      </div>
      <div class="evento-cuerpo">
        ${f.motivo_consulta ? `<p class="evento-motivo">${escapar(f.motivo_consulta)}</p>` : ''}
        ${f.impresion_dx ? `<p class="evento-obs"><strong>Impresión:</strong> ${escapar(f.impresion_dx)}</p>` : ''}
        <p class="evento-estado">Estado: ${escapar(f.estado)}${f.proxima_cita ? ` · Próxima cita: ${formatearFecha(f.proxima_cita)}` : ''}</p>
        <button class="boton-secundario boton-compacto" type="button" data-ver="${f.id}">Ver / imprimir</button>
      </div>
    </article>`).join('');

  $lista.querySelectorAll('[data-ver]').forEach((b) => {
    b.addEventListener('click', () => verFicha(b.dataset.ver));
  });
}

/* ============================================
   Modal de ficha (crear)
   ============================================ */

function abrirFichaNueva() {
  if (!estado.paciente) return;
  estado.editandoId = null;
  limpiarFormulario();

  document.getElementById('ficha-modal-titulo').textContent = 'Nueva ficha psicológica';
  document.getElementById('fp_codigo').value = estado.paciente.codigo;
  document.getElementById('fp_fecha').value = HOY();

  // Precargar la última ficha del trabajador para no reescribir
  const previa = estado.fichas
    .filter((f) => f.trabajador_id === estado.paciente.id)
    .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))[0];

  if (previa) {
    document.getElementById('fp_tipo').value = 'seguimiento';
    document.getElementById('fp_modalidad').value = previa.modalidad || 'individual';
    document.getElementById('fp_remision').value = previa.motivo_remision || '';
    document.getElementById('fp_impresion').value = previa.impresion_dx || '';
  }

  mostrarFichaTrabajador(estado.paciente);
  document.getElementById('modal-ficha').hidden = false;
}

function mostrarFichaTrabajador(t) {
  document.getElementById('ficha').hidden = false;
  document.getElementById('bloque-tipo').hidden = false;
  document.getElementById('bloque-clinico').hidden = false;
  document.getElementById('f-nombre').textContent = t.nombre_completo;
  document.getElementById('f-cedula').textContent = t.cedula;
  document.getElementById('f-edad').textContent = t.edad != null ? `${t.edad} años` : '—';
  document.getElementById('f-sexo').textContent = t.sexo === 'M' ? 'Masculino' : t.sexo === 'F' ? 'Femenino' : '—';
  document.getElementById('f-cargo').textContent = textoOGuion(t.cargo);

  // Autocompletar campos de la ficha con datos del trabajador (si están vacíos)
  const setSiVacio = (id, val) => {
    const el = document.getElementById(id);
    if (el && !el.value && val) el.value = val;
  };
  setSiVacio('fp_nacionalidad', 'Ecuatoriano');
  if (t.correo) setSiVacio('fp_correo', t.correo);
}

async function buscarTrabajadorFormulario() {
  const codigo = parseInt(document.getElementById('fp_codigo').value, 10);
  const $ayuda = document.getElementById('ayuda-codigo');
  if (!codigo) { ocultarFichaTrabajador(); return; }

  const { data } = await supabase
    .from('v_trabajadores')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('codigo', codigo)
    .maybeSingle();

  if (!data) {
    $ayuda.textContent = 'No existe un trabajador con ese código.';
    ocultarFichaTrabajador();
    return;
  }
  $ayuda.textContent = '';
  estado.paciente = data;
  mostrarFichaTrabajador(data);
}

function ocultarFichaTrabajador() {
  document.getElementById('ficha').hidden = true;
  document.getElementById('bloque-tipo').hidden = true;
  document.getElementById('bloque-clinico').hidden = true;
}

/* Mismo orden de campos que usa guardarFicha() —se reutiliza
   para precargar el formulario al editar una ficha existente. */
const MAPA_CAMPOS_FICHA = [
  ['fp_fecha', 'fecha'], ['fp_tipo', 'tipo'], ['fp_modalidad', 'modalidad'],
  ['fp_remision', 'motivo_remision'], ['fp_nacionalidad', 'nacionalidad'],
  ['fp_lugar_nac', 'lugar_nacimiento'], ['fp_correo', 'correo'],
  ['fp_domicilio', 'domicilio'], ['fp_hijos', 'num_hijos'],
  ['fp_instruccion', 'nivel_instruccion'], ['fp_titulo', 'titulo_obtenido'],
  ['fp_etnico', 'grupo_etnico'], ['fp_religion', 'religion'],
  ['fp_app', 'app'], ['fp_apf', 'apf'], ['fp_aqt', 'aqt'], ['fp_apq', 'apq'],
  ['fp_discapacidad', 'tipo_discapacidad'], ['fp_porcentaje', 'porcentaje_discapacidad'],
  ['fp_alcohol', 'habito_alcohol'], ['fp_cigarrillo', 'habito_cigarrillo'],
  ['fp_drogas', 'habito_drogas'], ['fp_juegos', 'habito_juegos'],
  ['fp_motivo', 'motivo_consulta'], ['fp_entrevista', 'entrevista'],
  ['fp_orientacion', 'em_orientacion'], ['fp_pensamiento', 'em_pensamiento'],
  ['fp_lenguaje', 'em_lenguaje'], ['fp_sensopercepciones', 'em_sensopercepciones'],
  ['fp_memoria', 'em_memoria'], ['fp_emociones', 'em_emociones'],
  ['fp_sueno', 'em_sueno'], ['fp_apetito', 'em_apetito'],
  ['fp_deseo_sexual', 'em_deseo_sexual'], ['fp_tests', 'test_aplicados'],
  ['fp_observaciones', 'observaciones'], ['fp_impresion', 'impresion_dx'],
  ['fp_recomendaciones', 'recomendaciones'], ['fp_proxima', 'proxima_cita'],
  ['fp_estado', 'estado']
];

/** Reabrir una ficha ya guardada para corregirla —por ejemplo,
    una que se guardó de prueba o con un dato mal escrito—. */
async function editarFicha() {
  const f = estado.fichas.find((x) => x.id === estado.verId);
  if (!f) return;
  if (!puedeEditarFicha(f)) {
    return alert('Este caso está cerrado. Solo un administrador puede reabrirlo.');
  }

  estado.editandoId = f.id;
  limpiarFormulario();

  document.getElementById('ficha-modal-titulo').textContent = 'Editar ficha psicológica';
  document.getElementById('fp_codigo').value = f.codigo_trabajador ?? '';

  MAPA_CAMPOS_FICHA.forEach(([id, col]) => {
    const el = document.getElementById(id);
    if (el && f[col] != null) el.value = f[col];
  });

  const { data: t } = await supabase
    .from('v_trabajadores').select('*')
    .eq('empresa_id', estado.empresaId).eq('id', f.trabajador_id).maybeSingle();

  if (t) {
    estado.paciente = t;
    mostrarFichaTrabajador(t);
  }

  document.getElementById('modal-ver').hidden = true;
  document.getElementById('modal-ficha').hidden = false;
}

/** Para una ficha mal guardada o puesta de ejemplo. */
async function eliminarFicha() {
  const f = estado.fichas.find((x) => x.id === estado.verId);
  if (!f) return;
  if (!puedeEliminarFicha()) {
    return alert('Solo un administrador puede eliminar una ficha psicológica.');
  }

  if (!confirm(`¿Eliminar la ficha de ${f.nombre_completo} del ${formatearFecha(f.fecha)}?\n\n`
    + 'Esta acción no se puede deshacer.')) return;

  const { error } = await supabase.from('fichas_psicologicas').delete().eq('id', f.id);
  if (error) return alert('No se pudo eliminar: ' + error.message);

  document.getElementById('modal-ver').hidden = true;
  await recargar();
}

async function guardarFicha() {
  const $alerta = document.getElementById('alerta-ficha');
  const codigo = parseInt(document.getElementById('fp_codigo').value, 10);

  if (!estado.paciente || estado.paciente.codigo !== codigo) {
    $alerta.textContent = 'Busque y confirme un trabajador válido.';
    $alerta.hidden = false;
    return;
  }

  const fila = {
    empresa_id: estado.empresaId,
    trabajador_id: estado.paciente.id,
    fecha: document.getElementById('fp_fecha').value || HOY(),
    tipo: document.getElementById('fp_tipo').value,
    modalidad: document.getElementById('fp_modalidad').value || null,
    motivo_remision: valor('fp_remision'),
    // Datos complementarios
    nacionalidad: valor('fp_nacionalidad'),
    lugar_nacimiento: valor('fp_lugar_nac'),
    correo: valor('fp_correo'),
    domicilio: valor('fp_domicilio'),
    num_hijos: parseInt(document.getElementById('fp_hijos').value, 10) || null,
    nivel_instruccion: valor('fp_instruccion'),
    titulo_obtenido: valor('fp_titulo'),
    grupo_etnico: valor('fp_etnico'),
    religion: valor('fp_religion'),
    // Antecedentes
    app: valor('fp_app'),
    apf: valor('fp_apf'),
    aqt: valor('fp_aqt'),
    apq: valor('fp_apq'),
    tipo_discapacidad: valor('fp_discapacidad'),
    porcentaje_discapacidad: valor('fp_porcentaje'),
    // Hábitos
    habito_alcohol: valor('fp_alcohol'),
    habito_cigarrillo: valor('fp_cigarrillo'),
    habito_drogas: valor('fp_drogas'),
    habito_juegos: valor('fp_juegos'),
    // Clínico
    motivo_consulta: valor('fp_motivo'),
    entrevista: valor('fp_entrevista'),
    // Evaluación mental
    em_orientacion: valor('fp_orientacion'),
    em_pensamiento: valor('fp_pensamiento'),
    em_lenguaje: valor('fp_lenguaje'),
    em_sensopercepciones: valor('fp_sensopercepciones'),
    em_memoria: valor('fp_memoria'),
    em_emociones: valor('fp_emociones'),
    em_sueno: valor('fp_sueno'),
    em_apetito: valor('fp_apetito'),
    em_deseo_sexual: valor('fp_deseo_sexual'),
    // Cierre
    test_aplicados: valor('fp_tests'),
    observaciones: valor('fp_observaciones'),
    impresion_dx: valor('fp_impresion'),
    recomendaciones: valor('fp_recomendaciones'),
    proxima_cita: document.getElementById('fp_proxima').value || null,
    estado: document.getElementById('fp_estado').value,
    registrado_por: nombrePsicologo()
  };

  const editando = estado.editandoId;
  const { data: creada, error } = editando
    ? await supabase.from('fichas_psicologicas').update(fila).eq('id', editando).select('id').single()
    : await supabase.from('fichas_psicologicas').insert(fila).select('id').single();

  if (error) {
    $alerta.textContent = 'No fue posible guardar: ' + error.message;
    $alerta.hidden = false;
    return null;
  }

  estado.editandoId = null;
  document.getElementById('modal-ficha').hidden = true;
  await recargar();
  return creada ? creada.id : null;
}

/* Guarda la ficha y abre directamente su impresión */
async function guardarEImprimir() {
  const id = await guardarFicha();
  if (!id) return;
  estado.verId = id;
  await imprimirFicha();
}

function valor(id) {
  const v = document.getElementById(id).value.trim();
  return v === '' ? null : v;
}

function limpiarFormulario() {
  ['fp_motivo', 'fp_entrevista', 'fp_impresion', 'fp_proxima',
   'fp_nacionalidad', 'fp_lugar_nac', 'fp_correo', 'fp_hijos', 'fp_instruccion',
   'fp_titulo', 'fp_etnico', 'fp_religion', 'fp_domicilio',
   'fp_app', 'fp_apf', 'fp_aqt', 'fp_apq', 'fp_discapacidad', 'fp_porcentaje',
   'fp_alcohol', 'fp_cigarrillo', 'fp_drogas', 'fp_juegos',
   'fp_orientacion', 'fp_pensamiento', 'fp_lenguaje', 'fp_sensopercepciones',
   'fp_memoria', 'fp_emociones', 'fp_sueno', 'fp_apetito', 'fp_deseo_sexual',
   'fp_tests', 'fp_observaciones', 'fp_recomendaciones'].forEach((id) => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('fp_tipo').value = 'asistencial';
  document.getElementById('fp_modalidad').value = 'individual';
  document.getElementById('fp_remision').value = '';
  document.getElementById('fp_estado').value = 'abierto';
  document.getElementById('alerta-ficha').hidden = true;
  document.getElementById('ayuda-codigo').textContent = '';
}

/* ============================================
   Ver ficha + impresión
   ============================================ */

/* Pestaña "Registros": listado plano de todas las fichas de la
   empresa (no hace falta buscar trabajador por trabajador), con
   las mismas reglas de admin+cerrado que el modal "Ver ficha". */
function pintarRegistros() {
  const $cuerpo = document.getElementById('cuerpo-registros');
  const $vacio = document.getElementById('vacio-registros');
  $cuerpo.innerHTML = '';
  if (estado.fichas.length === 0) { $vacio.hidden = false; return; }
  $vacio.hidden = true;

  estado.fichas.forEach((f) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${formatearFecha(f.fecha)}</td>` +
      `<td>${escapar(f.nombre_completo)}</td>` +
      `<td class="celda-mono">${escapar(f.cedula || '')}</td>` +
      `<td>${escapar(TIPOS[f.tipo] || f.tipo || '—')}</td>` +
      `<td>${escapar(f.estado || '—')}</td>` +
      `<td class="celda-derecha"></td>`;

    const acc = tr.querySelector('td:last-child');

    const ver = document.createElement('button');
    ver.className = 'boton-icono'; ver.textContent = 'Ver / imprimir';
    ver.addEventListener('click', () => verFicha(f.id));
    acc.appendChild(ver);

    if (puedeEditarFicha(f)) {
      const ed = document.createElement('button');
      ed.className = 'boton-icono'; ed.textContent = 'Editar';
      ed.addEventListener('click', () => { estado.verId = f.id; editarFicha(); });
      acc.appendChild(ed);
    }

    if (puedeEliminarFicha()) {
      const el = document.createElement('button');
      el.className = 'boton-icono'; el.textContent = 'Eliminar';
      el.addEventListener('click', () => { estado.verId = f.id; eliminarFicha(); });
      acc.appendChild(el);
    }

    $cuerpo.appendChild(tr);
  });
}

function verFicha(id) {
  const f = estado.fichas.find((x) => x.id === id);
  if (!f) return;
  estado.verId = id;

  document.getElementById('ver-titulo').textContent =
    `Ficha psicológica · ${formatearFecha(f.fecha)}`;

  document.getElementById('ver-cuerpo').innerHTML = cuerpoFicha(f);
  document.getElementById('btn-editar-ficha').hidden = !puedeEditarFicha(f);
  document.getElementById('btn-eliminar-ficha').hidden = !puedeEliminarFicha();
  document.getElementById('modal-ver').hidden = false;
}

function campo(etq, val) {
  if (!val) return '';
  return `<div class="ver-campo"><span class="ver-etiqueta">${etq}</span><p class="ver-texto">${escapar(val)}</p></div>`;
}

function cuerpoFicha(f) {
  return `
    <div class="ver-datos">
      <div><span class="ver-etiqueta">Trabajador</span> ${escapar(f.nombre_completo)}</div>
      <div><span class="ver-etiqueta">Código</span> ${f.codigo_trabajador}</div>
      <div><span class="ver-etiqueta">Cédula</span> ${escapar(f.cedula)}</div>
      <div><span class="ver-etiqueta">Edad</span> ${f.edad_ficha != null ? f.edad_ficha + ' años' : '—'}</div>
      <div><span class="ver-etiqueta">Cargo</span> ${escapar(textoOGuion(f.cargo))}</div>
      <div><span class="ver-etiqueta">Fecha</span> ${formatearFecha(f.fecha)}</div>
      <div><span class="ver-etiqueta">Tipo</span> ${TIPOS[f.tipo] || f.tipo}</div>
      <div><span class="ver-etiqueta">Modalidad</span> ${escapar(textoOGuion(f.modalidad))}</div>
    </div>
    ${campo('Motivo de remisión', f.motivo_remision)}
    ${campo('Motivo de consulta', f.motivo_consulta)}
    ${campo('Antecedentes', f.antecedentes)}
    ${campo('Evaluación / observaciones', f.evaluacion)}
    ${campo('Impresión diagnóstica', f.impresion_dx)}
    ${campo('Plan / intervención', f.plan_intervencion)}
    <div class="ver-datos">
      <div><span class="ver-etiqueta">Estado</span> ${escapar(f.estado)}</div>
      ${f.proxima_cita ? `<div><span class="ver-etiqueta">Próxima cita</span> ${formatearFecha(f.proxima_cita)}</div>` : ''}
      ${f.registrado_por ? `<div><span class="ver-etiqueta">Registró</span> ${escapar(f.registrado_por)}</div>` : ''}
    </div>

    <!-- Certificado de Aptitud Ocupacional Psicológica: la
         aptitud, la vigencia y la conclusión son una decisión
         clínica de cada emisión —no del registro de la ficha—,
         por eso se piden aquí mismo, listas para cuando se le
         dé clic a "Imprimir Certificado de Aptitud". -->
    <div class="cap-panel">
      <p class="cap-titulo">Datos para el Certificado de Aptitud Ocupacional Psicológica</p>
      <div class="cap-campos">
        <div class="campo">
          <label class="etiqueta" for="cap_aptitud">Aptitud</label>
          <select class="entrada" id="cap_aptitud">
            <option value="ES APTO">Es apto</option>
            <option value="NO ES APTO">No es apto</option>
            <option value="ES APTO CON RESTRICCIONES">Es apto con restricciones</option>
          </select>
        </div>
        <div class="campo">
          <label class="etiqueta" for="cap_cargo">Cargo evaluado</label>
          <input class="entrada" id="cap_cargo" type="text" value="${escapar(textoOGuion(f.cargo))}">
        </div>
        <div class="campo">
          <label class="etiqueta" for="cap_vigencia">Vigencia</label>
          <input class="entrada" id="cap_vigencia" type="text" value="1 año" placeholder="Ej: 1 año">
        </div>
        <div class="campo">
          <label class="etiqueta" for="cap_solicitud">A solicitud de</label>
          <select class="entrada" id="cap_solicitud">
            <option value="personal">Solicitud personal</option>
            <option value="institucional">Solicitud institucional</option>
            <option value="empresarial">Solicitud empresarial</option>
          </select>
        </div>
        <div class="campo">
          <label class="etiqueta" for="cap_ciudad">Ciudad</label>
          <input class="entrada" id="cap_ciudad" type="text" value="Machala">
        </div>
        <div class="campo campo-crece">
          <label class="etiqueta" for="cap_conclusion">Conclusión de la entrevista</label>
          <textarea class="entrada" id="cap_conclusion" rows="3">${escapar(TEXTO_CONCLUSION_CERTIFICADO)}</textarea>
        </div>
      </div>
    </div>`;
}

const TEXTO_CONCLUSION_CERTIFICADO =
  'Como resultado de la entrevista clínica, se concluye que el evaluado no presenta indicadores de ' +
  'alteraciones psicopatológicas. Las funciones mentales superiores (orientación, afectividad, área ' +
  'emocional e intelectual) se encuentran dentro de los rangos esperados para su edad y contexto.';

function nombrePsicologo() {
  const p = estado.perfil || {};
  const nombre = [p.nombres, p.apellidos].filter(Boolean).join(' ').trim();
  if (!nombre) return 'Psicólogo/a Clínico';
  return p.registro_msp ? `${nombre} · Reg. ${p.registro_msp}` : nombre;
}

/* Una vez que el caso queda "cerrado", solo el administrador
   puede reabrirlo (editar) o eliminarlo — cualquier psicólogo
   puede seguir haciendo ambas cosas mientras el caso siga
   abierto o derivado. Eliminar, en cualquier estado, siempre es
   cosa del administrador (igual que ya rige en Trabajo Social). */
function puedeEditarFicha(f) {
  return f.estado !== 'cerrado' || estado.perfil.rol === 'admin';
}
function puedeEliminarFicha() {
  return estado.perfil.rol === 'admin';
}

async function imprimirFicha() {
  const ficha = estado.fichas.find((x) => x.id === estado.verId);
  if (!ficha) return;

  /* v_fichas_psicologicas no trae fecha de nacimiento, fecha de
     ingreso ni código del trabajador —viven en la ficha del
     trabajador, no en la ficha psicológica—. Se completan aquí
     con una consulta aparte por trabajador_id, mismo patrón que
     ya usa editarFicha(), en vez de dejarlos en blanco. */
  const { data: t } = await supabase
    .from('v_trabajadores').select('fecha_nacimiento, primer_ingreso, codigo')
    .eq('empresa_id', estado.empresaId).eq('id', ficha.trabajador_id).maybeSingle();

  const f = {
    ...ficha,
    fecha_nacimiento: ficha.fecha_nacimiento ?? t?.fecha_nacimiento,
    fecha_ingreso: ficha.fecha_ingreso ?? t?.primer_ingreso,
    codigo: ficha.codigo ?? t?.codigo
  };

  const v = (x) => escapar(x != null && x !== '' ? String(x) : '');
  const sexo = f.sexo === 'M' ? 'M' : (f.sexo === 'F' ? 'F' : '');

  /* Cuadrícula de 28 columnas (A a AB del Excel real), con los
     mismos anchos relativos: A y AB son angostas (2.66), Z es
     algo más ancha (3.66), el resto comparte el ancho por
     defecto (11.43). Reproducirla así es lo que permite que
     Grupo Étnico (izquierda) y "Antecedentes de alguna
     enfermedad" (derecha) queden exactamente en paralelo, como
     en el original. */
  const anchoAngosto = 0.94, anchoNormal = 4.03, anchoZ = 1.29;
  const anchosPsico = [anchoAngosto, ...Array(24).fill(anchoNormal), anchoZ, anchoNormal, anchoAngosto];
  const colgroupPsico = `<colgroup>${anchosPsico.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>`;

  const $zona = document.getElementById('zona-impresion');
  $zona.innerHTML = `
    <div class="fp-hoja">
      <div class="fp-encabezado">
        <img src="logo.png" class="fp-logo" alt="">
        <div class="fp-titulo-empresa">
          <strong>AGRIMROC S.A</strong>
          <span>Departamento de Salud Mental y Apoyo Psicosocial</span>
          <h1>FICHA PSICOLÓGICA</h1>
        </div>
      </div>

      <div class="fp-seccion-h">Datos de Identificacion del Trabajador</div>
      <table class="fp-grid">
        ${colgroupPsico}
        <tr>
          <td class="fp-et" colspan="6">APELLIDOS Y NOMBRES</td><td colspan="9"></td>
          <td class="fp-et fp-et-centro" colspan="6">Nacionalidad:</td><td colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="6">Cedula de Ident N/.</td>
        </tr>
        <tr>
          <td class="fp-va" colspan="14">${v(f.nombre_completo)}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="6">${v(f.nacionalidad)}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="6">${v(f.cedula)}</td>
        </tr>
        <tr>
          <td class="fp-et" colspan="6">Lugar de Nacimiento:</td><td colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="7">F/Nacimiento:</td><td colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="6">N° de Celular</td><td colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="6">FECHA DE INGRESO</td>
        </tr>
        <tr>
          <td class="fp-va" colspan="6">${v(f.lugar_nacimiento)}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="7">${f.fecha_nacimiento ? formatearFecha(f.fecha_nacimiento) : ''}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="6">${v(f.telefono)}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="6">${f.fecha_ingreso ? formatearFecha(f.fecha_ingreso) : ''}</td>
        </tr>
        <tr>
          <td class="fp-et" colspan="6">Correo Electronico</td><td colspan="14"></td>
          <td class="fp-et fp-et-centro" colspan="3">Edad:</td><td colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="4">Sexo:</td>
        </tr>
        <tr>
          <td class="fp-va" colspan="19">${v(f.correo)}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="3">${f.edad != null ? f.edad : ''}</td><td colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="1">M</td><td class="fp-va" colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="1">F</td><td class="fp-va" colspan="1"></td>
        </tr>
        <tr>
          <td class="fp-et" colspan="9">Domicilio&nbsp; Actual&nbsp; en:</td>
          <td class="fp-et" colspan="5">N° de hijos</td><td colspan="1"></td>
          <td class="fp-et fp-et-derecha" colspan="13">Código</td>
        </tr>
        <tr>
          <td class="fp-va" colspan="9">${v(f.domicilio)}</td>
          <td class="fp-va fp-va-centro" colspan="5">${f.num_hijos != null ? f.num_hijos : '0'}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="13">${v(f.codigo)}</td>
        </tr>
        <tr>
          <td class="fp-et" colspan="8">Nivel de Instrucción:</td><td colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="10">Titulo o Grado Superior Obtenido:</td><td colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="8">Puesto de Trabajo:</td>
        </tr>
        <tr>
          <td class="fp-va" colspan="8">${v(f.nivel_instruccion)}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="10">${v(f.titulo_obtenido)}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="8">${v(f.cargo)}</td>
        </tr>
        <tr>
          <td class="fp-et" colspan="8">Grupo Etnico:</td><td colspan="20"></td>
        </tr>
        <tr>
          <td class="fp-va" colspan="8">${v(f.grupo_etnico)}</td><td colspan="1"></td>
          <td class="fp-banner" colspan="19">Antecedentes de alguna enfermedad</td>
        </tr>
        <tr>
          <td class="fp-et" colspan="9">Religion:</td><td colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="13">Tipo de Discapacidad:</td><td colspan="1"></td>
          <td class="fp-et fp-et-centro" colspan="4">Porcentaje:</td>
        </tr>
        <tr>
          <td class="fp-va" colspan="9">${v(f.religion)}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="13">${v(f.tipo_discapacidad)}</td><td colspan="1"></td>
          <td class="fp-va fp-va-centro" colspan="4">${v(f.porcentaje_discapacidad)}</td>
        </tr>
        <!-- APP/APF/AQT/APQ: en el Excel comparten fila con
             Religión/Tipo de Discapacidad y les toca apenas 2
             columnas de 28 —casi nada para escribir texto libre—.
             Se bajan a dos filas propias, dos campos por fila,
             cada uno con la mitad del ancho, para que se pueda
             escribir con comodidad. -->
        <tr>
          <td class="fp-et" colspan="13">APP:</td><td colspan="2"></td>
          <td class="fp-et" colspan="13">APF:</td>
        </tr>
        <tr>
          <td class="fp-va" colspan="13">${v(f.app)}</td><td colspan="2"></td>
          <td class="fp-va" colspan="13">${v(f.apf)}</td>
        </tr>
        <tr>
          <td class="fp-et" colspan="13">AQT:</td><td colspan="2"></td>
          <td class="fp-et" colspan="13">APQ:</td>
        </tr>
        <tr>
          <td class="fp-va" colspan="13">${v(f.aqt)}</td><td colspan="2"></td>
          <td class="fp-va" colspan="13">${v(f.apq)}</td>
        </tr>
      </table>

      <div class="fp-seccion-h">Hábitos</div>
      <table class="fp-tabla">
        <tr><td class="fp-lbl">ALCOHOL</td><td>${v(f.habito_alcohol)}</td></tr>
        <tr><td class="fp-lbl">CIGARRILLO</td><td>${v(f.habito_cigarrillo)}</td></tr>
        <tr><td class="fp-lbl">DROGAS</td><td>${v(f.habito_drogas)}</td></tr>
        <tr><td class="fp-lbl">JUEGOS DE AZAR ETC</td><td>${v(f.habito_juegos)}</td></tr>
      </table>

      <div class="fp-campo-largo"><strong>Motivo de consulta:</strong><p>${v(f.motivo_consulta)}</p></div>
      <div class="fp-campo-largo"><strong>Entrevista Psicologica:</strong><p>${v(f.entrevista)}</p></div>

      <div class="fp-seccion-h">Evaluación Mental</div>
      <table class="fp-tabla">
        <tr><td class="fp-lbl">Orientacion</td><td>${v(f.em_orientacion)}</td></tr>
        <tr><td class="fp-lbl">Pensamiento</td><td>${v(f.em_pensamiento)}</td></tr>
        <tr><td class="fp-lbl">Lenguaje</td><td>${v(f.em_lenguaje)}</td></tr>
        <tr><td class="fp-lbl">Sensopercepciones</td><td>${v(f.em_sensopercepciones)}</td></tr>
        <tr><td class="fp-lbl">Memoria</td><td>${v(f.em_memoria)}</td></tr>
        <tr><td class="fp-lbl">Emociones</td><td>${v(f.em_emociones)}</td></tr>
        <tr><td class="fp-lbl">Sueño</td><td>${v(f.em_sueno)}</td></tr>
        <tr><td class="fp-lbl">Apetito</td><td>${v(f.em_apetito)}</td></tr>
        <tr><td class="fp-lbl">Deseo Sexual</td><td>${v(f.em_deseo_sexual)}</td></tr>
      </table>

      <!-- En el Excel, "Test Aplicados" y "Diagnóstico Presuntivo"
           van en la columna izquierda, con "Observaciones" en una
           columna paralela a la derecha —no apilados uno tras
           otro como estaba antes. -->
      <div class="fp-seccion-h">Test Aplicados</div>
      <table class="fp-tabla" style="table-layout:auto;">
        <tr>
          <td style="width:65%; text-align:left; vertical-align:top;"><p style="white-space:pre-wrap;margin:0 0 0.4rem;">${v(f.test_aplicados)}</p>
            <strong>Diagnostico Presuntivo:</strong><p style="white-space:pre-wrap;margin:0;">${v(f.impresion_dx)}</p>
          </td>
          <td style="text-align:left; vertical-align:top;"><strong style="display:block;text-align:center;">Observaciones</strong><p style="white-space:pre-wrap;margin:0;">${v(f.observaciones)}</p></td>
        </tr>
      </table>

      <div class="fp-campo-largo"><strong>Recomendaciones:</strong><p>${v(f.recomendaciones)}</p></div>

      <div class="fp-firma">
        <div class="fp-firma-linea"></div>
        <p>${v(f.registrado_por || nombrePsicologo())}</p>
        <p style="font-size:8.5pt; margin-top:2px;">Psicólogo/a Clínico</p>
      </div>
    </div>`;
  window.print();
}

/* Certificado de Aptitud Ocupacional Psicológica: botón e
   impresión propios, igual que "Imprimir Ficha Social" e
   "Imprimir Registro de Personal" en Trabajo Social. La aptitud,
   la vigencia y la conclusión se piden en el panel de la ficha
   porque son una decisión clínica de cada emisión, no un dato
   guardado permanentemente en la ficha. */
function imprimirCertificado() {
  const f = estado.fichas.find((x) => x.id === estado.verId);
  if (!f) return;

  const $zona = document.getElementById('zona-impresion');
  $zona.innerHTML = htmlCertificadoAptitud(f);
  window.print();
}

const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function fechaLargaEs(fecha) {
  const d = fecha ? new Date(`${fecha}T00:00`) : new Date();
  return `${DIAS_ES[d.getDay()]}, ${d.getDate()} de ${MESES_ES[d.getMonth()]} de ${d.getFullYear()}`;
}

function htmlCertificadoAptitud(f) {
  const v = (x) => escapar(x != null && x !== '' ? String(x) : '');
  const p = estado.perfil || {};
  const firmante = [p.nombres, p.apellidos].filter(Boolean).join(' ').trim() || 'Psicólogo/a Clínico';
  const registro = p.registro_msp || '';

  const ciudad = v(document.getElementById('cap_ciudad').value || 'Machala');
  const aptitud = document.getElementById('cap_aptitud').value;
  const cargoEvaluado = v(document.getElementById('cap_cargo').value);
  const vigencia = v(document.getElementById('cap_vigencia').value || '1 año');
  const solicitud = document.getElementById('cap_solicitud').value === 'institucional' ? 'solicitud institucional'
    : document.getElementById('cap_solicitud').value === 'empresarial' ? 'solicitud empresarial'
    : 'solicitud personal';
  const conclusion = v(document.getElementById('cap_conclusion').value);
  const tratamiento = f.sexo === 'F' ? 'la señora' : f.sexo === 'M' ? 'el señor' : 'el/la trabajador(a)';

  return `
  <div class="fp-hoja cert-hoja">
    <div class="fp-encabezado">
      <img src="logo.png" class="fp-logo" alt="">
      <div class="fp-titulo-empresa">
        <strong>SERVICIO MÉDICO DE EMPRESA AGRIMROC S.A</strong>
        <span>San Antonio – Camilo Ponce Enríquez · Azuay</span>
        <span>Departamento de Salud Mental</span>
      </div>
    </div>

    <p class="cert-fecha">${ciudad}, ${fechaLargaEs(f.fecha)}</p>

    <h1 class="cert-titulo">Certificado de Aptitud<br>Ocupacional Psicológica</h1>

    <p class="cert-parrafo">
      Quien suscribe, <strong>${escapar(firmante)}</strong>, Psicólogo/a Clínico de AGRIMROC S.A., certifica que
      ${tratamiento} <strong>${v(f.nombre_completo)}</strong>, portador(a) de la cédula de identidad
      N° <strong>${v(f.cedula)}</strong>, código <strong>${v(f.codigo_trabajador ?? f.codigo)}</strong>,
      fue evaluado(a) en las instalaciones de la empresa el día <strong>${fechaLargaEs(f.fecha)}</strong>,
      a ${solicitud}.
    </p>

    <p class="cert-parrafo">${conclusion}</p>

    <p class="cert-parrafo">
      Con base en los hallazgos obtenidos, se determina que el/la evaluado(a) <strong>${aptitud}</strong>
      para desempeñarse como <strong>${cargoEvaluado}</strong>, con una vigencia de
      <strong>${vigencia}</strong> a partir de la presente fecha.
    </p>

    <p class="cert-parrafo">
      Este certificado se expide en honor a la verdad, conforme a los principios éticos de la práctica
      profesional y dentro del alcance de mis competencias.
    </p>

    <div class="fp-firma">
      <div class="fp-firma-linea"></div>
      <p><strong>${escapar(firmante)}</strong></p>
      <p style="font-size:9pt; margin-top:2px;">Psicólogo/a Clínico</p>
      ${registro ? `<p style="font-size:9pt;">N° de Registro: ${escapar(registro)}</p>` : ''}
    </div>
  </div>`;
}

function bloqueImpr(etq, val) {
  if (!val) return '';
  return `<section class="hoja-bloque"><h2>${etq}</h2><p>${escapar(val)}</p></section>`;
}

/* ============================================
   Pestañas y empresa
   ============================================ */

function cambiarVista(vista) {
  estado.vista = vista;
  document.querySelectorAll('.pestana').forEach((p) => {
    p.classList.toggle('activa', p.dataset.vista === vista);
  });
  ['fichas', 'registros', 'atenciones'].forEach((v) => {
    document.getElementById('vista-' + v).hidden = v !== vista;
  });
  if (vista === 'atenciones') pintarAtenciones();
  if (vista === 'registros') pintarRegistros();
  if (vista === 'fichas') document.getElementById('busca_codigo').focus();
}

async function seleccionarEmpresa(empresa) {
  estado.empresaId = empresa.id;
  estado.empresaNombre = empresa.razon_social;
  $area.hidden = false;
  $avisoIni.hidden = true;

  await recargar();
}

async function recargar() {
  await Promise.all([cargarFichas(), cargarManual()]);
  pintarResumen();

  if (estado.vista === 'atenciones') pintarAtenciones();
  if (estado.vista === 'registros') pintarRegistros();

  // Si hay un trabajador en pantalla, refrescar su ficha y su historial
  if (estado.paciente) {
    const abierto = estado.histAbierto;
    document.getElementById('p-total').textContent =
      estado.fichas.filter((f) => f.trabajador_id === estado.paciente.id).length;
    if (abierto) { estado.histAbierto = false; await alternarHistorial(); }
  }
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  document.querySelectorAll('.pestana').forEach((p) => {
    p.addEventListener('click', () => cambiarVista(p.dataset.vista));
  });

  document.querySelectorAll('[data-cierra]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.cierra).hidden = true;
    });
  });

  /* --- Buscador --- */
  document.getElementById('btn-buscar').addEventListener('click', buscarPaciente);
  document.getElementById('busca_codigo').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); buscarPaciente(); }
  });
  document.getElementById('busca_nombre').addEventListener('input', retrasar(buscarPorNombre, 200));
  document.getElementById('btn-nueva-ficha').addEventListener('click', abrirFichaNueva);
  document.getElementById('btn-historial').addEventListener('click', alternarHistorial);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#busca_nombre') && !e.target.closest('#busca_sugerencias')) {
      ocultarSugerencias();
    }
  });

  /* --- Formulario de ficha --- */
  document.getElementById('btn-guardar-ficha').addEventListener('click', guardarFicha);
  document.getElementById('btn-guardar-imprimir').addEventListener('click', guardarEImprimir);
  document.getElementById('fp_codigo').addEventListener('input', retrasar(buscarTrabajadorFormulario, 300));

  /* --- Alta de trabajador --- */
  document.getElementById('btn-guardar-alta').addEventListener('click', guardarAlta);

  /* --- Ver / imprimir --- */
  document.getElementById('btn-imprimir-ficha').addEventListener('click', imprimirFicha);
  document.getElementById('btn-imprimir-certificado').addEventListener('click', imprimirCertificado);
  document.getElementById('btn-editar-ficha').addEventListener('click', editarFicha);
  document.getElementById('btn-eliminar-ficha').addEventListener('click', eliminarFicha);

  /* --- Atenciones --- */
  document.getElementById('at-anio').addEventListener('change', pintarAtenciones);
  document.getElementById('btn-guardar-manual').addEventListener('click', guardarManual);

  /* Escape cierra el modal superior */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const orden = ['modal-ver', 'modal-alta', 'modal-ficha'];
    for (const id of orden) {
      const $m = document.getElementById(id);
      if (!$m.hidden) { $m.hidden = true; return; }
    }
  });
}

/* ============================================
   NEXUS · atenciones.js
   Lógica exclusiva de atenciones.html

   Reglas de negocio:
    · La atención es el hecho clínico; el descuento de
      farmacia es su consecuencia. Si falta existencia,
      la atención se registra y el medicamento queda
      como no entregado.
    · El primer diagnóstico es el principal y sostiene
      los indicadores de morbilidad.
    · Las alergias pertenecen al trabajador, no a la
      atención: se capturan aquí y persisten en su ficha.
    · Morbilidad común. Lo ocupacional tendrá módulo propio.
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { protegerPagina, puedeVerClinica, empresasPermitidas, resolverEmpresaActiva, modulosActivosEmpresa } from './auth.js?v=11';
import { montarNavegacion } from './nav.js?v=11';
import { escapar, textoOGuion, retrasar, formatearFecha, resumenReposo, validarCedula }
  from './utils.js?v=12';
import { montarEmergencia, fijarEmpresaEmergencia, pintarPanelClinico }
  from './emergencia.js?v=12';
import { sesionActual } from './auth.js?v=11';
import {
  cargarDatosOficio, llenarDestinatarios, destinatarioPorId,
  mostrarCiePorDefecto, rangoDias, imprimirOficio, destinatariosLista
} from './oficio-certificado.js?v=10';
import { alCrear, marcarAntesDeBorrar, autorId, alEditar } from './autoria.js?v=1';
import {
  iniciarInformeAtenciones, cambiarTipoPeriodo, generarInformeAtenciones,
  descargarInformeAtenciones, guardarInformeAtenciones,
  usarPlanDeAccion, abrirNuevoPlan, cancelarNuevoPlan, guardarNuevoPlan
} from './informe-atenciones.js?v=8';

/* --- Estado --- */
const estado = {
  perfil: null,
  empresaId: null,
  empresaNombre: '',
  atenciones: [],
  medicamentos: [],
  insumos: [],
  morbilidad: [],
  trabajador: null,     // trabajador de la atención en curso
  diagnosticos: [],     // [{codigo, descripcion, observacion}]
  detalle: null,        // atención abierta en el modal de detalle
  detalleDiagnosticos: [],  // diagnósticos de esa atención, para poder emitir certificado después
  certDetalle: null,    // su certificado, si lo tuvo
  medicamentoElegidoDetalle: null,  // medicamento elegido para agregar a una atención ya concluida
  consumos: [],         // [{tipo:'medicamento'|'insumo', item_id, cantidad, indicacion, buscar, abierto}]
  cieDestino: null,     // índice del diagnóstico que abrió el buscador
  paciente: null,       // trabajador localizado en la pestaña Atenciones
  histAbierto: false,   // historial embebido desplegado
  modoAtencion: 'trabajador',  // 'trabajador' | 'externo'
  personaExterna: null, // persona externa de la atención en curso
  externos: [],         // catálogo de personas externas (ADAE, pasantes, comunidad)
  informeIniciado: false,
  vista: 'atenciones'
};

const HOY = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

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

  if (!puedeVerClinica(perfil.rol)) {
    window.location.href = '/Nexus/dashboard.html';
    return;
  }

  estado.perfil = perfil;
  estado.esAdmin = perfil.rol === 'admin';
  montarNavegacion(perfil, 'atenciones');

  prepararAnios();

  /* La empresa ya no se elige aquí: viene resuelta desde el
     login (una sola asignada) o desde la pantalla de selección
     (varias asignadas). Este módulo solo la muestra y trabaja
     con ella. */
  const permitidas = await empresasPermitidas(perfil);
  if (permitidas.length === 0) {
    $avisoIni.textContent = 'No tienes ninguna empresa asignada. Contacta al administrador.';
    return;
  }
  const empresa = resolverEmpresaActiva(permitidas);
  if (!empresa) return; // está redirigiendo a seleccionar-empresa.html

  const activos = await modulosActivosEmpresa(empresa.id);
  if (!activos.has('atenciones')) {
    document.querySelector('.contenido').innerHTML =
      '<p class="aviso-inicial">Este módulo no está activo para esta empresa.</p>';
    return;
  }

  if ($nombreEmpresa) $nombreEmpresa.textContent = empresa.razon_social;

  await seleccionarEmpresa(empresa);
  conectarEventos();
  montarEmergencia(perfil, estado.empresaId);
}

function prepararAnios() {
  const actual = new Date().getFullYear();
  ['morb-anio', 'cons-anio'].forEach((id) => {
    const $sel = document.getElementById(id);
    for (let a = actual; a >= actual - 5; a--) {
      const opcion = document.createElement('option');
      opcion.value = a;
      opcion.textContent = a;
      $sel.appendChild(opcion);
    }
  });
}

/* ============================================
   Datos
   ============================================ */

async function cargarAtenciones() {
  const { data, error } = await supabase
    .from('v_atenciones')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .order('fecha', { ascending: false })
    .order('creado_en', { ascending: false })
    .limit(500);

  estado.atenciones = error ? [] : (data || []);
}

async function cargarMedicamentos() {
  const { data, error } = await supabase
    .from('v_stock_medicamentos')
    .select('id, nombre_generico, nombre_comercial, concentracion, forma, presentacion, stock_disponible')
    .eq('empresa_id', estado.empresaId)
    .eq('activo', true)
    .order('nombre_generico');

  estado.medicamentos = error ? [] : (data || []);
}

async function cargarInsumos() {
  const { data, error } = await supabase
    .from('insumos')
    .select('id, nombre, unidad, stock_disponible')
    .eq('empresa_id', estado.empresaId)
    .eq('activo', true)
    .order('nombre');

  estado.insumos = error ? [] : (data || []);
}

async function cargarExternos() {
  const { data, error } = await supabase
    .from('personas_externas')
    .select('id, cedula, nombres, apellidos, fecha_nacimiento, procedencia, alergias, activo, migrado_a_trabajador_id, migrado_en')
    .eq('empresa_id', estado.empresaId)
    .eq('activo', true)
    .order('apellidos');

  estado.externos = error ? [] : (data || []);
}

async function cargarMorbilidad() {
  const { data, error } = await supabase
    .from('v_morbilidad')
    .select('*')
    .eq('empresa_id', estado.empresaId);

  estado.morbilidad = error ? [] : (data || []);
}

/* ============================================
   Resumen
   ============================================ */

function pintarResumen() {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth() + 1;

  const delAnio = estado.atenciones.filter((a) => new Date(a.fecha + 'T00:00').getFullYear() === anio);
  const delMes = delAnio.filter((a) => new Date(a.fecha + 'T00:00').getMonth() + 1 === mes);

  document.getElementById('kpi-mes').textContent = delMes.length;
  document.getElementById('kpi-anio').textContent = delAnio.length;
  document.getElementById('kpi-personas').textContent =
    new Set(delAnio.map((a) => a.trabajador_id)).size;
  document.getElementById('kpi-reposo').textContent =
    delAnio.reduce((s, a) => s + (a.dias_reposo || 0), 0);
}

/* ============================================
   Vista · Atenciones de hoy
   ============================================ */

function pintarHoy() {
  const hoy = HOY();
  const $cuerpo = document.getElementById('cuerpo-hoy');

  document.getElementById('dia-fecha').textContent =
    new Date().toLocaleDateString('es-EC', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

  const visibles = estado.atenciones.filter((a) => a.fecha === hoy);
  document.getElementById('dia-contador').textContent = visibles.length;

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-hoy').hidden = visibles.length > 0;

  const frag = document.createDocumentFragment();
  visibles.forEach((a) => frag.appendChild(filaAtencion(a, true)));
  $cuerpo.appendChild(frag);
}

/* ============================================
   Vista · Consolidado
   ============================================ */

/** Alimenta el filtro de diagnósticos con los realmente usados */
function llenarFiltroDx() {
  const $sel = document.getElementById('cons-dx');
  const previo = $sel.value;

  const mapa = new Map();
  estado.atenciones.forEach((a) => {
    if (a.cie10_principal && !mapa.has(a.cie10_principal)) {
      mapa.set(a.cie10_principal, a.diagnostico_principal);
    }
  });

  const items = [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  $sel.innerHTML = '<option value="">Todos los diagnósticos</option>';
  items.forEach(([codigo, descripcion]) => {
    const opcion = document.createElement('option');
    opcion.value = codigo;
    opcion.textContent = `${codigo} · ${descripcion || ''}`.trim();
    $sel.appendChild(opcion);
  });

  if (previo && mapa.has(previo)) $sel.value = previo;
}

function pintarConsolidado() {
  const anio = parseInt(document.getElementById('cons-anio').value, 10);
  const mes = parseInt(document.getElementById('cons-mes').value, 10);
  const dx = document.getElementById('cons-dx').value;
  const texto = document.getElementById('cons-busqueda').value.trim().toLowerCase();
  const $cuerpo = document.getElementById('cuerpo-consolidado');

  const visibles = estado.atenciones.filter((a) => {
    const f = new Date(a.fecha + 'T00:00');
    if (f.getFullYear() !== anio) return false;
    if (mes !== 0 && f.getMonth() + 1 !== mes) return false;
    if (dx && a.cie10_principal !== dx) return false;

    if (!texto) return true;
    return [String(a.codigo_trabajador), a.nombre_completo, a.cedula]
      .filter(Boolean).some((c) => String(c).toLowerCase().includes(texto));
  });

  /* Resumen del filtro aplicado */
  const $resumen = document.getElementById('cons-resumen');
  if (dx || mes !== 0 || texto) {
    const partes = [`${visibles.length} atención${visibles.length === 1 ? '' : 'es'}`];
    if (mes !== 0) partes.push(`en ${MESES[mes]} ${anio}`);
    else partes.push(`en ${anio}`);
    if (dx) {
      const desc = estado.atenciones.find((a) => a.cie10_principal === dx)?.diagnostico_principal;
      partes.push(`por ${dx}${desc ? ' · ' + desc : ''}`);
    }
    const personas = new Set(visibles.map((a) => a.trabajador_id)).size;
    partes.push(`· ${personas} trabajador${personas === 1 ? '' : 'es'}`);

    document.getElementById('cons-resumen-texto').textContent = partes.join(' ');
    $resumen.hidden = false;
  } else {
    $resumen.hidden = true;
  }

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-consolidado').hidden = visibles.length > 0;

  const frag = document.createDocumentFragment();
  visibles.forEach((a) => frag.appendChild(filaAtencion(a, false)));
  $cuerpo.appendChild(frag);
}

function limpiarFiltrosConsolidado() {
  document.getElementById('cons-mes').value = '0';
  document.getElementById('cons-dx').value = '';
  document.getElementById('cons-busqueda').value = '';
  pintarConsolidado();
}

/* ============================================
   Fila de atención · compartida
   ============================================ */

/**
 * @param {object} a - atención
 * @param {boolean} esHoy - muestra hora en vez de fecha
 */
function filaAtencion(a, esHoy) {
  const fila = document.createElement('tr');

  const primeraColumna = esHoy
    ? new Date(a.creado_en).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
    : formatearFecha(a.fecha);

  fila.innerHTML = `
    <td class="celda-centro celda-mono">${primeraColumna}</td>
    <td class="celda-centro"><span class="codigo">${a.codigo_trabajador}</span></td>
    <td>
      <span class="principal">${escapar(a.nombre_completo)}</span>
      ${a.cargo ? `<span class="secundario">${escapar(a.cargo)}</span>` : ''}
    </td>
    <td class="celda-centro">${a.edad_atencion ?? '—'}</td>
    <td>
      ${a.cie10_principal
        ? `<span class="cie-chip">${escapar(a.cie10_principal)}</span>
           <span class="secundario">${escapar(a.diagnostico_principal || '')}</span>`
        : '<span class="celda-tenue">Sin diagnóstico</span>'}
    </td>
    <td class="celda-centro celda-tenue">${a.total_diagnosticos}</td>
    <td class="celda-centro">
      ${a.total_medicamentos > 0
        ? `<span class="${a.medicamentos_no_entregados > 0 ? 'rx-parcial' : 'celda-tenue'}">
             ${a.total_medicamentos}${a.medicamentos_no_entregados > 0 ? ' ⚠' : ''}
           </span>`
        : '—'}
    </td>
    <td class="celda-centro">${a.dias_reposo > 0 ? `<span class="reposo">${a.dias_reposo}</span>` : '—'}</td>
    <td class="celda-derecha"></td>
  `;

  const ver = document.createElement('button');
  ver.className = 'boton-icono';
  ver.textContent = 'Ver';
  ver.addEventListener('click', () => abrirDetalle(a));
  fila.querySelector('td:last-child').appendChild(ver);

  return fila;
}

/* ============================================
   Vista · Morbilidad
   ============================================ */

function pintarMorbilidad() {
  const anio = parseInt(document.getElementById('morb-anio').value, 10);
  const mes = parseInt(document.getElementById('morb-mes').value, 10);
  const tipo = document.getElementById('morb-tipo').value;
  const $cuerpo = document.getElementById('cuerpo-morbilidad');

  /* Agrupar por código sumando por sexo */
  const mapa = new Map();

  estado.morbilidad
    .filter((m) => m.anio === anio)
    .filter((m) => mes === 0 || m.mes === mes)
    .filter((m) => tipo === 'todos' || m.es_principal)
    .forEach((m) => {
      if (!mapa.has(m.codigo_cie10)) {
        mapa.set(m.codigo_cie10, {
          codigo: m.codigo_cie10,
          descripcion: m.descripcion,
          hombres: 0, mujeres: 0, total: 0
        });
      }
      const item = mapa.get(m.codigo_cie10);
      if (m.sexo === 'M') item.hombres += m.casos;
      else if (m.sexo === 'F') item.mujeres += m.casos;
      item.total += m.casos;
    });

  const filas = [...mapa.values()].sort((a, b) => b.total - a.total);
  const granTotal = filas.reduce((s, f) => s + f.total, 0);

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-morbilidad').hidden = filas.length > 0;

  const frag = document.createDocumentFragment();

  filas.forEach((f, i) => {
    const porcentaje = granTotal > 0 ? (f.total / granTotal * 100) : 0;
    const fila = document.createElement('tr');

    fila.innerHTML = `
      <td class="celda-centro celda-tenue">${i + 1}</td>
      <td class="celda-centro"><span class="cie-chip">${escapar(f.codigo)}</span></td>
      <td>${escapar(f.descripcion)}</td>
      <td class="celda-centro celda-tenue">${f.hombres}</td>
      <td class="celda-centro celda-tenue">${f.mujeres}</td>
      <td class="celda-centro"><span class="saldo">${f.total}</span></td>
      <td>
        <div class="barra">
          <div class="barra-relleno" style="width:${porcentaje.toFixed(1)}%"></div>
          <span class="barra-texto">${porcentaje.toFixed(1)}%</span>
        </div>
      </td>
    `;
    frag.appendChild(fila);
  });

  $cuerpo.appendChild(frag);
}

/* ============================================
   Atención · Apertura
   ============================================ */

function abrirAtencion() {
  estado.trabajador = null;
  estado.diagnosticos = [];
  estado.consumos = [];
  estado.modoAtencion = 'trabajador';
  estado.personaExterna = null;

  document.getElementById('bloque-identificacion-trabajador').hidden = false;
  document.getElementById('bloque-identificacion-externo').hidden = true;

  document.getElementById('at_codigo').value = '';
  document.getElementById('at_fecha').value = HOY();
  document.getElementById('at_motivo').value = '';
  document.getElementById('at_observacion').value = '';
  document.getElementById('at_reposo').value = '0';

  /* El certificado empieza desmarcado en cada atención: es la
     excepción, no la norma, y dejarlo marcado de la consulta
     anterior generaría justificativos que nadie pidió. */
  document.getElementById('at_certificado').checked = false;
  document.getElementById('at_cert_rotacion').checked = false;
  document.getElementById('at_cert_motivo').value = '';
  document.getElementById('at_cert_rot_detalle').value = '';
  document.getElementById('at_cert_rot_dias').value = '0';
  document.getElementById('at_cert_cie').checked = mostrarCiePorDefecto();
  alternarCertificado();
  document.getElementById('at_alergias').value = '';
  const $pc = document.getElementById('panel-clinico');
  if ($pc) { $pc.hidden = true; $pc.innerHTML = ''; }
  document.getElementById('ayuda-codigo').textContent = '';
  document.getElementById('ayuda-imc').textContent = '';

  ['at_sistolica', 'at_diastolica', 'at_fc', 'at_fr',
   'at_temp', 'at_sat', 'at_peso', 'at_talla'].forEach((id) => {
    document.getElementById(id).value = '';
  });

  ocultarBloques();
  document.getElementById('alerta-atencion').hidden = true;
  document.getElementById('modal-atencion').hidden = false;
  document.getElementById('at_codigo').focus();
}

function ocultarBloques() {
  ['ficha', 'antecedente', 'bloque-motivo', 'bloque-vitales', 'bloque-diagnosticos',
   'bloque-medicamentos', 'bloque-cierre', 'bloque-certificado'].forEach((id) => {
    document.getElementById(id).hidden = true;
  });
}

function mostrarBloques() {
  ['ficha', 'bloque-motivo', 'bloque-vitales', 'bloque-diagnosticos',
   'bloque-medicamentos', 'bloque-cierre', 'bloque-certificado'].forEach((id) => {
    document.getElementById(id).hidden = false;
  });
}

/* ============================================
   Atención · Búsqueda del trabajador
   ============================================ */

const buscarTrabajador = retrasar(async () => {
  const codigo = parseInt(document.getElementById('at_codigo').value, 10);
  const $ayuda = document.getElementById('ayuda-codigo');

  if (!codigo) {
    $ayuda.textContent = '';
    estado.trabajador = null;
    ocultarBloques();
    return;
  }

  const { data, error } = await supabase
    .from('v_trabajadores')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('codigo', codigo)
    .maybeSingle();

  if (error || !data) {
    $ayuda.textContent = 'No existe un trabajador con ese código en esta empresa';
    $ayuda.className = 'ayuda ayuda-error';
    estado.trabajador = null;
    ocultarBloques();
    return;
  }

  if (!data.activo) {
    $ayuda.textContent = `${data.nombre_completo} · inactivo`;
    $ayuda.className = 'ayuda ayuda-aviso';
  } else {
    $ayuda.textContent = 'Trabajador identificado';
    $ayuda.className = 'ayuda ayuda-ok';
  }

  estado.trabajador = data;
  pintarFicha(data);
  pintarAntecedente(data);
  mostrarBloques();

  /* Primer diagnóstico listo para capturar */
  if (estado.diagnosticos.length === 0) agregarDiagnostico();
}, 400);

/**
 * Contexto clínico inmediato: última atención y frecuencia.
 * Evita que el médico tenga que salir del formulario para
 * saber si el trabajador ya consultó por lo mismo.
 */
function pintarAntecedente(t) {
  const $ant = document.getElementById('antecedente');
  const propias = estado.atenciones.filter((a) => a.trabajador_id === t.id);

  if (propias.length === 0) {
    $ant.innerHTML = '<span class="antecedente-vacio">Primera atención registrada</span>';
    $ant.className = 'antecedente';
    $ant.hidden = false;
    return;
  }

  const ultima = propias[0];
  const dias = Math.round((new Date() - new Date(ultima.fecha + 'T00:00')) / 86400000);

  const anio = new Date().getFullYear();
  const delAnio = propias.filter((a) => new Date(a.fecha + 'T00:00').getFullYear() === anio).length;

  /* Reincidencia sobre el mismo diagnóstico */
  const mismoDx = ultima.cie10_principal
    ? propias.filter((a) => a.cie10_principal === ultima.cie10_principal).length
    : 0;

  const alerta = dias <= 30 || mismoDx >= 3;

  $ant.className = 'antecedente' + (alerta ? ' antecedente-alerta' : '');
  $ant.innerHTML = `
    <div class="antecedente-linea">
      <span class="antecedente-etiqueta">Última atención</span>
      <span class="antecedente-valor">
        ${formatearFecha(ultima.fecha)} · hace ${dias} día${dias === 1 ? '' : 's'}
      </span>
      ${ultima.cie10_principal
        ? `<span class="cie-chip">${escapar(ultima.cie10_principal)}</span>
           <span class="antecedente-dx">${escapar(ultima.diagnostico_principal || '')}</span>`
        : ''}
    </div>
    <div class="antecedente-linea antecedente-meta">
      <span>${propias.length} atención${propias.length === 1 ? '' : 'es'} en total</span>
      <span>${delAnio} este año</span>
      ${mismoDx >= 3
        ? `<span class="antecedente-flag">${mismoDx} veces por ${escapar(ultima.cie10_principal)}</span>`
        : ''}
    </div>
  `;
  $ant.hidden = false;
}

function pintarFicha(t) {
  document.getElementById('f-nombre').textContent = t.nombre_completo;
  document.getElementById('f-cedula').textContent = t.cedula;
  document.getElementById('f-edad').textContent = t.edad != null ? `${t.edad} años` : '—';
  document.getElementById('f-sexo').textContent =
    t.sexo === 'M' ? 'Masculino' : t.sexo === 'F' ? 'Femenino' : '—';
  document.getElementById('f-cargo').textContent = textoOGuion(t.cargo);
  document.getElementById('f-sangre').textContent = textoOGuion(t.tipo_sangre);

  const $alergias = document.getElementById('at_alergias');
  $alergias.value = t.alergias || '';
  $alergias.classList.toggle('con-alergia', Boolean(t.alergias));

  /* Condiciones y medicación habitual. Se resuelve aparte
     porque consulta otra vista; no debe retrasar el pintado
     de la ficha. */
  pintarPanelClinico(t.id);
}

/* ============================================
   Diagnósticos
   ============================================ */

function agregarDiagnostico() {
  estado.diagnosticos.push({
    codigo: '', descripcion: '', observacion: '',
    buscar: '', abierto: false, resultados: [], buscando: false, error: '',
    creandoCie: false, nuevoCodigoTmp: '', nuevoDescTmp: '', errorNuevoCie: '',
    tipoCaso: 'nuevo', origenId: null, origenFecha: null
  });
  pintarDiagnosticos();
}

function quitarDiagnostico(indice) {
  estado.diagnosticos.splice(indice, 1);
  if (estado.diagnosticos.length === 0) agregarDiagnostico();
  else pintarDiagnosticos();
}

function pintarDiagnosticos() {
  const $lista = document.getElementById('lista-diagnosticos');
  $lista.innerHTML = '';

  estado.diagnosticos.forEach((d, i) => {
    const item = document.createElement('article');
    item.className = 'renglon' + (i === 0 ? ' renglon-principal' : '');

    const sinCoincidencias = !d.buscando && d.buscar.trim().length >= 2 && d.resultados.length === 0;

    const listaResultados = d.resultados.map((c) => `
      <button type="button" class="resultado" data-elegir-cie="${i}" data-codigo="${escapar(c.codigo)}">
        <span class="cie-chip">${escapar(c.codigo)}</span>
        <span class="resultado-desc">${escapar(c.descripcion)}</span>
        ${c.capitulo ? `<span class="resultado-cap">${escapar(c.capitulo)}</span>` : ''}
      </button>
    `).join('');

    const panelVacio = d.buscando
      ? '<p class="pista">Buscando…</p>'
      : sinCoincidencias
        ? `<div class="pista">
             Sin coincidencias.<br>
             <button type="button" class="enlace-inline" data-nuevo-cie="${i}">+ Registrar código nuevo</button>
           </div>`
        : (d.buscar.trim().length < 2 ? '<p class="pista">Escriba al menos dos caracteres.</p>' : '');

    const formNuevoCie = d.creandoCie ? `
      <div class="agregar-cie-inline">
        <input class="entrada entrada-mini" type="text" placeholder="Código · ej. M54.5"
               value="${escapar(d.nuevoCodigoTmp)}" data-nuevo-codigo="${i}">
        <input class="entrada entrada-mini" type="text" placeholder="Descripción"
               value="${escapar(d.nuevoDescTmp)}" data-nuevo-desc="${i}">
        <button type="button" class="boton-primario boton-compacto" data-guardar-cie="${i}">
          Registrar código
        </button>
        ${d.errorNuevoCie ? `<p class="ayuda ayuda-error">${escapar(d.errorNuevoCie)}</p>` : ''}
      </div>
    ` : '';

    const mostrarPanel = Boolean(d.abierto && (listaResultados || panelVacio || formNuevoCie));

    const insigniaTipo = d.codigo ? (
      d.tipoCaso === 'seguimiento'
        ? `<span class="insignia-seguimiento" title="Seguimiento de la atención del ${escapar(d.origenFecha || '')}">
             Seguimiento ${d.origenFecha ? `· ${escapar(d.origenFecha)}` : ''}
             <button type="button" class="insignia-quitar" data-quitar-seguimiento="${i}" aria-label="Marcar como caso nuevo">×</button>
           </span>`
        : `<button type="button" class="insignia-marcar" data-marcar-seguimiento="${i}">
             ¿Es seguimiento de otra atención?
           </button>`
    ) : '';

    item.innerHTML = `
      <div class="renglon-orden">
        ${i === 0 ? '<span class="etiqueta-principal">Principal</span>' : `<span class="orden-num">${i + 1}</span>`}
      </div>
      <div class="renglon-cuerpo">
        <div class="campo-crece campo-cie">
          <input class="entrada entrada-mini" type="text" autocomplete="off"
                 placeholder="Buscar diagnóstico CIE-10 por código o descripción…"
                 value="${escapar(d.buscar)}" data-buscar-cie="${i}">
          <div class="sugerencias" data-sugerencias-cie="${i}" ${mostrarPanel ? '' : 'hidden'}>
            ${listaResultados}${panelVacio}${formNuevoCie}
          </div>
        </div>
        <input class="entrada entrada-mini" type="text" placeholder="Observación"
               value="${escapar(d.observacion)}" data-obs="${i}">
        ${insigniaTipo}
      </div>
      <button class="boton-quitar" type="button" data-quitar="${i}" aria-label="Quitar">×</button>
    `;

    $lista.appendChild(item);

    if (d.error) {
      const aviso = document.createElement('p');
      aviso.className = 'ayuda ayuda-error';
      aviso.textContent = d.error;
      $lista.appendChild(aviso);
    }
  });

  /* Eventos por renglón */
  $lista.querySelectorAll('[data-buscar-cie]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const n = parseInt(e.target.dataset.buscarCie, 10);
      const pos = e.target.selectionStart;
      const valor = e.target.value;
      const d = estado.diagnosticos[n];
      d.buscar = valor;
      d.abierto = true;
      d.error = '';
      /* Campo vacío = ningún diagnóstico elegido todavía */
      if (!valor.trim()) { d.codigo = ''; d.descripcion = ''; d.resultados = []; }
      pintarDiagnosticos();
      const $nuevo = document.querySelector(`[data-buscar-cie="${n}"]`);
      if ($nuevo) {
        $nuevo.focus();
        $nuevo.setSelectionRange(pos, pos);
      }
      buscarCieInline(n, valor.trim());
    });

    inp.addEventListener('focus', (e) => {
      const n = parseInt(e.target.dataset.buscarCie, 10);
      const d = estado.diagnosticos[n];
      /* Igual que en medicamentos: si ya está abierto —por
         ejemplo, porque el propio evento "input" lo acaba de
         abrir y enfocar— no se repinta otra vez. Repintar aquí
         encima de eso creaba un campo nuevo a mitad de tecla y
         desordenaba lo que se estaba escribiendo. */
      if (!d || !d.buscar || d.abierto) return;
      d.abierto = true;
      pintarDiagnosticos();
      const $nuevo = document.querySelector(`[data-buscar-cie="${n}"]`);
      if ($nuevo) $nuevo.focus();
    });
  });

  $lista.querySelectorAll('[data-elegir-cie]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.dataset.elegirCie, 10);
      const d = estado.diagnosticos[n];
      const c = (d.resultados || []).find((x) => x.codigo === btn.dataset.codigo);
      if (!c) return;

      const yaEsta = estado.diagnosticos.some((x, j) => j !== n && x.codigo === c.codigo);
      if (yaEsta) {
        d.error = 'Ese diagnóstico ya está registrado en esta atención';
        pintarDiagnosticos();
        return;
      }

      d.codigo = c.codigo;
      d.descripcion = c.descripcion;
      d.buscar = `${c.codigo} · ${c.descripcion}`;
      d.abierto = false;
      d.error = '';
      pintarDiagnosticos();
      const $obs = document.querySelector(`[data-obs="${n}"]`);
      if ($obs) $obs.focus();

      sugerirSeguimiento(n, c.codigo);
    });
  });

  $lista.querySelectorAll('[data-nuevo-cie]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.dataset.nuevoCie, 10);
      const d = estado.diagnosticos[n];
      const texto = d.buscar.trim();
      /* Adivinar si lo escrito parece un código o una
         descripción, igual que hacía el formulario del modal. */
      const pareceCodigo = /^[A-Za-z][0-9]/.test(texto);
      d.creandoCie = true;
      d.nuevoCodigoTmp = pareceCodigo ? texto.toUpperCase() : '';
      d.nuevoDescTmp = pareceCodigo ? '' : texto;
      d.errorNuevoCie = '';
      pintarDiagnosticos();
      const $c = document.querySelector(`[data-nuevo-codigo="${n}"]`);
      if ($c) $c.focus();
    });
  });

  $lista.querySelectorAll('[data-nuevo-codigo]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      estado.diagnosticos[parseInt(e.target.dataset.nuevoCodigo, 10)].nuevoCodigoTmp = e.target.value;
    });
  });
  $lista.querySelectorAll('[data-nuevo-desc]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      estado.diagnosticos[parseInt(e.target.dataset.nuevoDesc, 10)].nuevoDescTmp = e.target.value;
    });
  });
  $lista.querySelectorAll('[data-guardar-cie]').forEach((btn) => {
    btn.addEventListener('click', () => guardarCieInline(parseInt(btn.dataset.guardarCie, 10)));
  });

  $lista.querySelectorAll('[data-obs]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      estado.diagnosticos[parseInt(e.target.dataset.obs, 10)].observacion = e.target.value;
    });
  });
  $lista.querySelectorAll('[data-quitar]').forEach((btn) => {
    btn.addEventListener('click', () => quitarDiagnostico(parseInt(btn.dataset.quitar, 10)));
  });

  $lista.querySelectorAll('[data-quitar-seguimiento]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = estado.diagnosticos[parseInt(btn.dataset.quitarSeguimiento, 10)];
      d.tipoCaso = 'nuevo';
      d.origenId = null;
      d.origenFecha = null;
      pintarDiagnosticos();
    });
  });

  $lista.querySelectorAll('[data-marcar-seguimiento]').forEach((btn) => {
    btn.addEventListener('click', () => abrirSelectorOrigen(parseInt(btn.dataset.marcarSeguimiento, 10)));
  });
}

/* Selector manual de "de cuál atención viene esto", para
   cuando el médico sabe que es seguimiento pero el código
   CIE-10 de hoy no coincide exactamente con el de la vez
   pasada (ej. de "Lumbalgia" a "Hernia discal confirmada"). */
async function abrirSelectorOrigen(indice) {
  if (!estado.trabajador) return;

  const hace365 = new Date();
  hace365.setDate(hace365.getDate() - 365);

  const { data, error } = await supabase
    .from('atencion_diagnosticos')
    .select('id, codigo_cie10, cie10(descripcion), atenciones!inner(fecha, trabajador_id)')
    .eq('atenciones.trabajador_id', estado.trabajador.id)
    .gte('atenciones.fecha', hace365.toISOString().slice(0, 10))
    .order('atenciones(fecha)', { ascending: false })
    .limit(15);

  if (error || !data || data.length === 0) {
    alert('Este trabajador no tiene atenciones registradas en el último año.');
    return;
  }

  const opciones = data.map((r, i) =>
    `${i + 1}. ${formatearFecha(r.atenciones.fecha)} — ${r.codigo_cie10} · ${r.cie10?.descripcion || ''}`
  ).join('\n');

  const elegido = prompt(
    `¿De cuál atención anterior da seguimiento esta consulta?\n\n${opciones}\n\nEscriba el número:`
  );
  const n = parseInt(elegido, 10);
  if (!n || n < 1 || n > data.length) return;

  const previo = data[n - 1];
  const d = estado.diagnosticos[indice];
  d.tipoCaso = 'seguimiento';
  d.origenId = previo.id;
  d.origenFecha = formatearFecha(previo.atenciones.fecha);
  pintarDiagnosticos();
}

/* Búsqueda en el catálogo CIE-10. Va a la base (son miles de
   códigos, no se cargan todos en memoria como los
   medicamentos), pero solo una fila busca a la vez —igual que
   antes solo un modal podía estar abierto— así que un único
   temporizador de espera basta. */
const buscarCieInline = retrasar(async (indice, texto) => {
  const d = estado.diagnosticos[indice];
  if (!d) return;

  if (texto.length < 2) {
    d.resultados = [];
    d.buscando = false;
    pintarDiagnosticos();
    enfocarBuscadorCie(indice);
    return;
  }

  d.buscando = true;
  pintarDiagnosticos();
  enfocarBuscadorCie(indice);

  const { data, error } = await supabase
    .from('cie10')
    .select('codigo, descripcion, capitulo')
    .eq('activo', true)
    .or(`codigo.ilike.${texto}%,descripcion.ilike.%${texto}%`)
    .order('codigo')
    .limit(8);

  /* La respuesta puede llegar tarde, después de que ya se
     siguió escribiendo: si el texto ya no coincide con lo que
     se pidió, se descarta en vez de pintar un resultado que ya
     no corresponde. */
  if ((estado.diagnosticos[indice]?.buscar || '').trim() !== texto) return;

  d.buscando = false;
  d.resultados = error ? [] : (data || []);
  pintarDiagnosticos();
  enfocarBuscadorCie(indice);
}, 250);

/* El campo se recrea entero en cada pintarDiagnosticos(), así
   que el navegador no conserva el foco por sí solo. Como esta
   función se llama después de una espera (el debounce y la
   consulta a la base), nadie sigue escribiendo en ese momento:
   el cursor va al final del texto, que es donde estaba. */
function enfocarBuscadorCie(indice) {
  const $campo = document.querySelector(`[data-buscar-cie="${indice}"]`);
  if (!$campo) return;
  $campo.focus();
  const fin = $campo.value.length;
  $campo.setSelectionRange(fin, fin);
}

async function guardarCieInline(indice) {
  const d = estado.diagnosticos[indice];
  if (!d) return;

  const codigo = (d.nuevoCodigoTmp || '').trim().toUpperCase();
  const descripcion = (d.nuevoDescTmp || '').trim();

  if (!codigo) { d.errorNuevoCie = 'Indique el código'; pintarDiagnosticos(); return; }
  if (!descripcion) { d.errorNuevoCie = 'Indique la descripción'; pintarDiagnosticos(); return; }
  if (!/^[A-Z][0-9]{2}(\.[0-9X]{1,2})?$/.test(codigo)) {
    d.errorNuevoCie = 'Formato inválido. Ejemplos válidos: M54, M54.5, Z57.0';
    pintarDiagnosticos();
    return;
  }

  const { error } = await supabase
    .from('cie10')
    .insert({ codigo, descripcion, capitulo: 'Añadido por el usuario', personalizado: true });

  if (error) {
    if (error.code === '23505') {
      /* Ya existía: recuperarlo y usarlo igual */
      const { data } = await supabase
        .from('cie10').select('codigo, descripcion').eq('codigo', codigo).single();
      if (data) {
        d.codigo = data.codigo;
        d.descripcion = data.descripcion;
        d.buscar = `${data.codigo} · ${data.descripcion}`;
        d.creandoCie = false;
        d.abierto = false;
        pintarDiagnosticos();
        return;
      }
    }
    d.errorNuevoCie = 'No fue posible registrar el código: ' + error.message;
    pintarDiagnosticos();
    return;
  }

  d.codigo = codigo;
  d.descripcion = descripcion;
  d.buscar = `${codigo} · ${descripcion}`;
  d.creandoCie = false;
  d.abierto = false;
  pintarDiagnosticos();
}



/* ============================================
   Buscador CIE-10
   ============================================ */

function abrirBuscadorCie(indice) {
  estado.cieDestino = indice;
  document.getElementById('cie-busqueda').value = '';
  document.getElementById('cie-resultados').innerHTML =
    '<p class="pista">Escriba al menos dos caracteres para buscar.</p>';
  document.getElementById('agregar-cie').hidden = true;
  document.getElementById('nuevo_cie_codigo').value = '';
  document.getElementById('nuevo_cie_desc').value = '';
  document.getElementById('alerta-cie').hidden = true;
  document.getElementById('modal-cie').hidden = false;
  document.getElementById('cie-busqueda').focus();
}

const buscarCie = retrasar(async () => {
  const texto = document.getElementById('cie-busqueda').value.trim();
  const $res = document.getElementById('cie-resultados');

  if (texto.length < 2) {
    $res.innerHTML = '<p class="pista">Escriba al menos dos caracteres para buscar.</p>';
    return;
  }

  /* Búsqueda por código o descripción, indistintamente */
  const { data, error } = await supabase
    .from('cie10')
    .select('codigo, descripcion, capitulo')
    .eq('activo', true)
    .or(`codigo.ilike.${texto}%,descripcion.ilike.%${texto}%`)
    .order('codigo')
    .limit(40);

  if (error) {
    $res.innerHTML = '<p class="pista">Error en la búsqueda.</p>';
    return;
  }

  if (!data || data.length === 0) {
    $res.innerHTML = `
      <p class="pista">
        Sin coincidencias para «${escapar(texto)}».<br>
        Use «+ Código no listado» para registrarlo.
      </p>`;
    /* Precargar lo escrito en el formulario de alta */
    const pareceCodigo = /^[A-Za-z][0-9]/.test(texto);
    document.getElementById(pareceCodigo ? 'nuevo_cie_codigo' : 'nuevo_cie_desc').value =
      pareceCodigo ? texto.toUpperCase() : texto;
    return;
  }

  $res.innerHTML = '';
  const frag = document.createDocumentFragment();

  data.forEach((c) => {
    const item = document.createElement('button');
    item.className = 'resultado';
    item.type = 'button';
    item.innerHTML = `
      <span class="cie-chip">${escapar(c.codigo)}</span>
      <span class="resultado-desc">${escapar(c.descripcion)}</span>
      ${c.capitulo ? `<span class="resultado-cap">${escapar(c.capitulo)}</span>` : ''}
    `;
    item.addEventListener('click', () => elegirCie(c));
    frag.appendChild(item);
  });

  $res.appendChild(frag);
}, 250);

function elegirCie(c) {
  const i = estado.cieDestino;
  if (i == null) return;

  /* Evitar duplicados en la misma atención */
  const yaEsta = estado.diagnosticos.some((d, j) => j !== i && d.codigo === c.codigo);
  if (yaEsta) {
    alertaCie('Ese diagnóstico ya está registrado en esta atención');
    return;
  }

  estado.diagnosticos[i].codigo = c.codigo;
  estado.diagnosticos[i].descripcion = c.descripcion;
  pintarDiagnosticos();
  document.getElementById('modal-cie').hidden = true;
}

async function crearCie() {
  const codigo = document.getElementById('nuevo_cie_codigo').value.trim().toUpperCase();
  const descripcion = document.getElementById('nuevo_cie_desc').value.trim();

  if (!codigo) return alertaCie('Indique el código');
  if (!descripcion) return alertaCie('Indique la descripción');
  if (!/^[A-Z][0-9]{2}(\.[0-9X]{1,2})?$/.test(codigo)) {
    return alertaCie('Formato inválido. Ejemplos válidos: M54, M54.5, Z57.0');
  }

  const $btn = document.getElementById('btn-crear-cie');
  $btn.disabled = true;

  const { error } = await supabase
    .from('cie10')
    .insert({ codigo, descripcion, capitulo: 'Añadido por el usuario', personalizado: true });

  $btn.disabled = false;

  if (error) {
    if (error.code === '23505') {
      /* Ya existía: recuperarlo y usarlo */
      const { data } = await supabase
        .from('cie10').select('codigo, descripcion').eq('codigo', codigo).single();
      if (data) { elegirCie(data); return; }
    }
    return alertaCie('No fue posible registrar el código: ' + error.message);
  }

  elegirCie({ codigo, descripcion });
}

/* Si el trabajador ya tuvo el mismo código CIE-10 en una
   atención anterior reciente (180 días), se pregunta si esta
   consulta es continuación de esa. El médico decide con un
   Sí/No; nunca se marca solo. */
async function sugerirSeguimiento(indice, codigo) {
  if (!estado.trabajador) return;

  const hace180 = new Date();
  hace180.setDate(hace180.getDate() - 180);

  const { data, error } = await supabase
    .from('atencion_diagnosticos')
    .select('id, codigo_cie10, atencion_id, atenciones!inner(id, fecha, trabajador_id)')
    .eq('codigo_cie10', codigo)
    .eq('atenciones.trabajador_id', estado.trabajador.id)
    .gte('atenciones.fecha', hace180.toISOString().slice(0, 10))
    .order('atenciones(fecha)', { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return;

  const previo = data[0];
  const d = estado.diagnosticos[indice];
  if (!d || d.codigo !== codigo) return; // pudo cambiar mientras se consultaba

  const fecha = formatearFecha(previo.atenciones.fecha);
  const esSeguimiento = confirm(
    `${estado.trabajador.nombres} ${estado.trabajador.apellidos} tuvo una atención el ${fecha} `
    + `por el mismo diagnóstico (${codigo}).\n\n¿Esta consulta es seguimiento de esa atención?`
  );

  if (esSeguimiento) {
    d.tipoCaso = 'seguimiento';
    d.origenId = previo.id;
    d.origenFecha = fecha;
    pintarDiagnosticos();
  }
}

function alertaCie(texto) {
  const $a = document.getElementById('alerta-cie');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Medicamentos e insumos
   Un solo buscador para ambos: la persona que atiende no
   tiene por qué saber si "gasas" vive en la tabla de insumos
   y "paracetamol" en la de medicamentos —para ella es lo mismo
   que se le entrega al paciente. Cada fila recuerda de cuál
   de las dos vino (tipo), porque el descuento de existencia y
   los campos que hacen falta son distintos:
    · Medicamento: cantidad + indicación/posología.
    · Insumo: solo cantidad. No lleva posología porque no se
      prescribe, se usa (ej. una inyectadora, un par de guantes).
   ============================================ */

function agregarConsumo() {
  if (estado.medicamentos.length === 0 && estado.insumos.length === 0) {
    alert('Esta empresa aún no tiene medicamentos ni insumos en el catálogo de farmacia.');
    return;
  }
  estado.consumos.push({ tipo: '', item_id: '', cantidad: 1, indicacion: '', buscar: '', abierto: false });
  pintarConsumos();
}

function quitarConsumo(indice) {
  estado.consumos.splice(indice, 1);
  pintarConsumos();
}

/* El comercial delante: es el nombre de la caja que se tiene
   en la mano. El genérico va detrás porque es el que
   identifica el principio activo y el que consta en la receta. */
function etiquetaMedicamento(m) {
  const detalle = `${m.nombre_generico} ${m.concentracion || ''} · ${m.forma}`.trim();
  return m.nombre_comercial ? `${m.nombre_comercial} · ${detalle}` : detalle;
}

function etiquetaInsumo(ins) {
  return `${ins.nombre} · ${ins.unidad || 'unidad'}`;
}

/** Encuentra el medicamento o insumo elegido en esta fila, sea cual sea su tipo. */
function itemDeConsumo(p) {
  if (p.tipo === 'medicamento') return estado.medicamentos.find((m) => m.id === p.item_id);
  if (p.tipo === 'insumo') return estado.insumos.find((x) => x.id === p.item_id);
  return null;
}

function pintarConsumos() {
  const $lista = document.getElementById('lista-medicamentos');
  $lista.innerHTML = '';

  estado.consumos.forEach((p, i) => {
    const item = itemDeConsumo(p);
    const insuficiente = item && p.cantidad > item.stock_disponible;

    const fila = document.createElement('article');
    fila.className = 'renglon';

    /* Autocompletado de un solo paso: cada letra filtra la
       lista de abajo (medicamentos e insumos juntos), y un
       clic sobre una fila elige uno y llena el campo con su
       nombre completo. */
    const texto = (p.buscar || '').trim().toLowerCase();

    const candidatosMed = texto
      ? estado.medicamentos.filter((m) =>
          [m.nombre_comercial, m.nombre_generico, m.concentracion, m.forma]
            .filter(Boolean).some((c) => c.toLowerCase().includes(texto))
        ).map((m) => ({ tipo: 'medicamento', id: m.id, etiqueta: etiquetaMedicamento(m), stock: m.stock_disponible }))
      : [];

    const candidatosIns = texto
      ? estado.insumos.filter((x) => x.nombre.toLowerCase().includes(texto))
          .map((x) => ({ tipo: 'insumo', id: x.id, etiqueta: etiquetaInsumo(x), stock: x.stock_disponible }))
      : [];

    /* Se recorta cada tipo POR SEPARADO antes de juntarlos.
       Si se juntara todo primero y se recortara después, una
       búsqueda como «inyec» —que también coincide con la forma
       "Inyectable" de muchos medicamentos— llenaría las diez
       posiciones solo con medicamentos, y el insumo
       "Inyectadoras" nunca llegaría a aparecer. Reservando un
       cupo fijo para cada tipo, ninguno tapa al otro. */
    const candidatos = [...candidatosMed.slice(0, 6), ...candidatosIns.slice(0, 6)];

    const sugerenciasHtml = candidatos.length > 0
      ? candidatos.map((c) => {
          const stock = c.stock > 0 ? `${c.stock} disp.` : 'sin stock';
          const rotulo = c.tipo === 'medicamento' ? 'Medicamento' : 'Insumo';
          return `
            <button type="button" class="sugerencia" data-elegir-consumo="${i}" data-tipo="${c.tipo}" data-id="${c.id}">
              <span class="sugerencia-nombre">${escapar(c.etiqueta)}</span>
              <span class="sugerencia-meta">${escapar(rotulo)} · ${escapar(stock)}</span>
            </button>
          `;
        }).join('')
      : '<p class="sugerencia-vacia">Sin coincidencias</p>';

    const mostrarPanel = Boolean(p.abierto && texto);

    /* El campo de indicación/posología solo tiene sentido
       para un medicamento: un insumo no se prescribe, se usa.
       Pedirlo igual solo confundiría —por eso no aparece en
       absoluto cuando la fila es un insumo. */
    const campoIndicacion = p.tipo === 'insumo' ? '' : `
        <input class="entrada campo-indicacion" type="text" placeholder="Indicación · posología"
               value="${escapar(p.indicacion)}" data-ind="${i}">`;

    fila.innerHTML = `
      <div class="renglon-orden"><span class="orden-num">${i + 1}</span></div>
      <div class="renglon-cuerpo renglon-medicamento">
        <div class="campo-crece campo-medicamento">
          <input class="entrada entrada-mini entrada-buscar-med" type="text"
                 placeholder="Buscar medicamento o insumo…" autocomplete="off"
                 value="${escapar(p.buscar || '')}" data-buscar="${i}">
          <div class="sugerencias" data-sugerencias-med="${i}" ${mostrarPanel ? '' : 'hidden'}>
            ${sugerenciasHtml}
          </div>
        </div>
        <input class="entrada entrada-cantidad ${insuficiente ? 'entrada-alerta' : ''}"
               type="number" min="1" value="${p.cantidad}" data-cant="${i}" placeholder="Cant.">
        ${campoIndicacion}
      </div>
      <button class="boton-quitar" type="button" data-quitar-med="${i}" aria-label="Quitar">×</button>
    `;

    $lista.appendChild(fila);

    if (!p.item_id && p.buscar) {
      const aviso = document.createElement('p');
      aviso.className = 'ayuda';
      aviso.textContent = 'Aún no ha elegido nada de la lista.';
      $lista.appendChild(aviso);
    }

    if (insuficiente) {
      const aviso = document.createElement('p');
      aviso.className = 'aviso-stock';
      aviso.textContent = `Existencia disponible: ${item.stock_disponible}. Se registrará como no entregado.`;
      $lista.appendChild(aviso);
    }
  });

  /* Eventos */
  /* Se repinta la lista al teclear, así que hay que devolver
     el foco y el cursor al campo: sin esto, la segunda letra
     se escribiría fuera del cuadro. */
  $lista.querySelectorAll('[data-buscar]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const n = parseInt(e.target.dataset.buscar, 10);
      const pos = e.target.selectionStart;
      const valor = e.target.value;
      const p = estado.consumos[n];
      p.buscar = valor;
      p.abierto = true;
      /* Campo vacío = nada elegido: evita dejar una selección
         "fantasma" detrás de un cuadro que se ve en blanco. */
      if (!valor.trim()) { p.tipo = ''; p.item_id = ''; }
      pintarConsumos();
      const $nuevo = document.querySelector(`[data-buscar="${n}"]`);
      if ($nuevo) {
        $nuevo.focus();
        $nuevo.setSelectionRange(pos, pos);
      }
    });

    inp.addEventListener('focus', (e) => {
      const n = parseInt(e.target.dataset.buscar, 10);
      const p = estado.consumos[n];
      /* Si ya está abierto —por ejemplo, porque el propio
         evento "input" lo acaba de abrir y enfocar— no hay
         que repintar otra vez: eso creaba un campo nuevo a
         mitad de la tecla y el cursor se perdía, mezclando
         el orden de las letras. Solo se repinta al refocar
         un campo que ya tenía texto pero el panel estaba
         cerrado. */
      if (!p || !p.buscar || p.abierto) return;
      p.abierto = true;
      pintarConsumos();
      const $nuevo = document.querySelector(`[data-buscar="${n}"]`);
      if ($nuevo) $nuevo.focus();
    });
  });

  $lista.querySelectorAll('[data-elegir-consumo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.dataset.elegirConsumo, 10);
      const p = estado.consumos[n];
      const tipo = btn.dataset.tipo;
      const id = btn.dataset.id;

      const etiqueta = tipo === 'medicamento'
        ? etiquetaMedicamento(estado.medicamentos.find((m) => m.id === id))
        : etiquetaInsumo(estado.insumos.find((x) => x.id === id));

      p.tipo = tipo;
      p.item_id = id;
      p.buscar = etiqueta;
      p.abierto = false;
      /* Un insumo no lleva indicación: si la fila cambió de
         medicamento a insumo, se limpia lo que hubiera quedado
         escrito, para no arrastrar un dato que ya no se pide. */
      if (tipo === 'insumo') p.indicacion = '';
      pintarConsumos();
      const $cant = document.querySelector(`[data-cant="${n}"]`);
      if ($cant) { $cant.focus(); $cant.select(); }
    });
  });

  $lista.querySelectorAll('[data-cant]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      estado.consumos[parseInt(e.target.dataset.cant, 10)].cantidad =
        parseInt(e.target.value, 10) || 1;
      pintarConsumos();
    });
  });
  $lista.querySelectorAll('[data-ind]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      estado.consumos[parseInt(e.target.dataset.ind, 10)].indicacion = e.target.value;
    });
  });
  $lista.querySelectorAll('[data-quitar-med]').forEach((btn) => {
    btn.addEventListener('click', () => quitarConsumo(parseInt(btn.dataset.quitarMed, 10)));
  });
}

/* ============================================
   Personas externas
   ADAE, pasantes, comunidad: se atienden y se descuenta
   farmacia igual que a un trabajador, pero no viven en la
   tabla de trabajadores. Si alguien de aquí llega a entrar a
   trabajar formalmente, se vincula en vez de duplicar —ver
   la migración en trabajadores.js.
   ============================================ */

function edadDeFecha(fecha) {
  if (!fecha) return null;
  const hoy = new Date();
  const nac = new Date(fecha + 'T00:00:00');
  let edad = hoy.getFullYear() - nac.getFullYear();
  const aunNoCumple = (hoy.getMonth() < nac.getMonth())
    || (hoy.getMonth() === nac.getMonth() && hoy.getDate() < nac.getDate());
  if (aunNoCumple) edad -= 1;
  return edad;
}

const PROCEDENCIA_TEXTO = { adae: 'ADAE', pasante: 'Pasante', comunidad: 'Comunidad', otro: 'Otro' };

function pintarExternos() {
  const $cuerpo = document.getElementById('cuerpo-externos');
  const $vacio = document.getElementById('vacio-externos');
  if (!$cuerpo) return;

  const texto = (document.getElementById('ext_busqueda')?.value || '').trim().toLowerCase();
  const lista = estado.externos.filter((p) => {
    if (!texto) return true;
    const campo = `${p.nombres} ${p.apellidos} ${p.cedula}`.toLowerCase();
    return campo.includes(texto);
  });

  $cuerpo.innerHTML = '';

  if (lista.length === 0) {
    if ($vacio) {
      $vacio.hidden = false;
      $vacio.textContent = estado.externos.length === 0
        ? 'Todavía no hay personas externas registradas para esta empresa.'
        : 'Ninguna coincide con la búsqueda.';
    }
    return;
  }
  if ($vacio) $vacio.hidden = true;

  lista.forEach((p) => {
    const tr = document.createElement('tr');
    const edad = edadDeFecha(p.fecha_nacimiento);

    tr.innerHTML = `
      <td>${escapar(p.apellidos)} ${escapar(p.nombres)}</td>
      <td class="celda-mono">${escapar(p.cedula)}</td>
      <td class="celda-centro">${edad ?? '—'}</td>
      <td>${escapar(PROCEDENCIA_TEXTO[p.procedencia] || p.procedencia)}</td>
      <td class="celda-centro">
        ${p.migrado_a_trabajador_id
          ? `<span class="insignia insignia-activa" title="Ya es trabajador desde ${formatearFecha(p.migrado_en)}">Migrado</span>`
          : '<span class="insignia insignia-inactiva">Externo</span>'}
      </td>
      <td class="celda-centro"></td>
    `;

    const btn = document.createElement('button');
    btn.className = 'boton-icono';
    btn.type = 'button';
    btn.textContent = 'Nueva atención';
    btn.addEventListener('click', () => abrirAtencionExterna(p));
    tr.lastElementChild.appendChild(btn);

    $cuerpo.appendChild(tr);
  });
}

function abrirNuevaPersonaExterna() {
  document.getElementById('pe_cedula').value = '';
  document.getElementById('pe_nombres').value = '';
  document.getElementById('pe_apellidos').value = '';
  document.getElementById('pe_nacimiento').value = '';
  document.getElementById('pe_procedencia').value = 'adae';
  document.getElementById('pe_alergias').value = '';
  document.getElementById('pe-error').textContent = '';
  document.getElementById('modal-persona-externa').hidden = false;
  document.getElementById('pe_cedula').focus();
}

async function guardarPersonaExterna() {
  const $error = document.getElementById('pe-error');
  $error.textContent = '';

  const cedula = document.getElementById('pe_cedula').value.trim();
  const nombres = document.getElementById('pe_nombres').value.trim();
  const apellidos = document.getElementById('pe_apellidos').value.trim();
  const nacimiento = document.getElementById('pe_nacimiento').value || null;
  const procedencia = document.getElementById('pe_procedencia').value;
  const alergias = document.getElementById('pe_alergias').value.trim();

  if (!cedula) return $error.textContent = 'La cédula es obligatoria';
  if (!validarCedula(cedula)) return $error.textContent = 'Cédula inválida';
  if (!nombres) return $error.textContent = 'Los nombres son obligatorios';
  if (!apellidos) return $error.textContent = 'Los apellidos son obligatorios';

  const datos = alCrear({
    empresa_id: estado.empresaId, cedula, nombres, apellidos,
    fecha_nacimiento: nacimiento, procedencia,
    alergias: alergias || null
  });

  const { data, error } = await supabase.from('personas_externas').insert(datos).select().single();

  if (error) {
    $error.textContent = error.code === '23505'
      ? 'Esta cédula ya está registrada como persona externa en esta empresa.'
      : 'No se pudo guardar: ' + error.message;
    return;
  }

  estado.externos.push(data);
  document.getElementById('modal-persona-externa').hidden = true;
  pintarExternos();
  abrirAtencionExterna(data);
}

function abrirAtencionExterna(persona) {
  estado.modoAtencion = 'externo';
  estado.personaExterna = persona;
  estado.diagnosticos = [];
  estado.consumos = [];
  agregarDiagnostico();

  document.getElementById('bloque-identificacion-trabajador').hidden = true;
  document.getElementById('bloque-identificacion-externo').hidden = false;
  document.getElementById('bloque-cierre').hidden = true;
  document.getElementById('bloque-certificado').hidden = true;

  const edad = edadDeFecha(persona.fecha_nacimiento);
  document.getElementById('ext-f-nombre').textContent =
    `${persona.apellidos} ${persona.nombres} · Cédula ${persona.cedula}`
    + (edad != null ? ` · ${edad} años` : '')
    + ` · ${PROCEDENCIA_TEXTO[persona.procedencia] || persona.procedencia}`;

  document.getElementById('at_fecha_ext').value = HOY();
  document.getElementById('at_alergias_ext').value = persona.alergias || '';
  document.getElementById('at_motivo').value = '';
  document.getElementById('at_observacion').value = '';

  pintarDiagnosticos();
  pintarConsumos();

  document.getElementById('bloque-motivo').hidden = false;
  document.getElementById('bloque-vitales').hidden = true;
  document.getElementById('bloque-diagnosticos').hidden = false;
  document.getElementById('bloque-medicamentos').hidden = false;

  document.getElementById('modal-atencion').hidden = false;
}

/* ============================================
   Índice de masa corporal
   ============================================ */

function calcularImc() {
  const peso = parseFloat(document.getElementById('at_peso').value);
  const talla = parseFloat(document.getElementById('at_talla').value);
  const $ayuda = document.getElementById('ayuda-imc');

  if (!peso || !talla) { $ayuda.textContent = ''; return; }

  const imc = peso / (talla * talla);
  let clase = 'ayuda';
  let texto;

  if (imc < 18.5) { texto = 'Bajo peso'; clase = 'ayuda ayuda-aviso'; }
  else if (imc < 25) { texto = 'Normal'; clase = 'ayuda ayuda-ok'; }
  else if (imc < 30) { texto = 'Sobrepeso'; clase = 'ayuda ayuda-aviso'; }
  else { texto = 'Obesidad'; clase = 'ayuda ayuda-critico'; }

  $ayuda.textContent = `IMC ${imc.toFixed(1)} · ${texto}`;
  $ayuda.className = clase;
}

/* ============================================
   Guardar
   ============================================ */

/* ============================================
   Certificado de justificación

   Nace aquí, en la consulta, y no en el módulo de
   certificados: el diagnóstico, los días de reposo y el
   trabajador ya están en pantalla. Registrarlo aparte
   obligaría a teclear dos veces lo mismo, y donde se teclea
   dos veces aparecen dos versiones distintas.

   Queda guardado como certificado interno, así que aparece
   solo en el listado de certificados y en sus estadísticas
   sin ningún paso más.
   ============================================ */

function alternarCertificado() {
  const activo = document.getElementById('at_certificado').checked;
  document.getElementById('cert-detalle').hidden = !activo;

  const rota = document.getElementById('at_cert_rotacion').checked;
  document.getElementById('cert-rotacion').hidden = !rota;

  /* El reposo suele empezar el día de la atención; se propone
     esa fecha para no teclearla, y se puede cambiar cuando el
     trabajador viene a justificar días ya transcurridos. */
  const $ini = document.getElementById('at_cert_inicio');
  if (activo && !$ini.value) {
    $ini.value = document.getElementById('at_fecha').value || HOY();
  }

  pintarFechasCert();
}

/* Fecha de fin y de reintegro, mientras se escribe.

   El cálculo vive en utils.js y lo comparte con el registro
   manual de certificados: contar los días en dos sitios
   distintos es como aparecen dos fechas distintas para el
   mismo reposo. */
function pintarFechasCert() {
  const poner = (idSalida, texto) => {
    const $s = document.getElementById(idSalida);
    if (!$s) return;
    $s.innerHTML = texto;
    $s.hidden = !texto;
  };

  poner('cert-fechas-reposo', resumenReposo(
    document.getElementById('at_cert_inicio').value,
    parseInt(document.getElementById('at_reposo').value, 10) || 0,
    'Reposo'));

  poner('cert-fechas-rotacion', resumenReposo(
    document.getElementById('at_cert_rot_inicio').value,
    document.getElementById('at_cert_rotacion').checked
      ? (parseInt(document.getElementById('at_cert_rot_dias').value, 10) || 0) : 0,
    'Rotación'));
}

async function emitirCertificadoInterno(diagnosticos) {
  const t = estado.trabajador;
  if (!t) return;

  /* El primero de la lista. Con varios diagnósticos, imprimir
     todos llenaría el oficio y expondría más de lo que hace
     falta para justificar una inasistencia. */
  const dx = diagnosticos[0];
  if (!dx) {
    alert('No se emitió el certificado: la atención no tiene diagnóstico.');
    return;
  }

  const dest = destinatarioPorId(document.getElementById('at_cert_dest').value);
  if (!dest) {
    alert('No se emitió el certificado: falta elegir a quién va dirigido.\n\n'
        + 'La atención sí quedó registrada.');
    return;
  }

  const perfil = sesionActual();
  const firmante = perfil
    ? [perfil.titulo, perfil.nombres, perfil.apellidos].filter(Boolean).join(' ').trim()
    : '';

  const fecha = document.getElementById('at_fecha').value || HOY();
  const dias = parseInt(document.getElementById('at_reposo').value, 10) || 0;
  const inicio = document.getElementById('at_cert_inicio').value || fecha;

  const rota = document.getElementById('at_cert_rotacion').checked;
  const rotDias = rota
    ? (parseInt(document.getElementById('at_cert_rot_dias').value, 10) || 0) : 0;
  const rotInicio = document.getElementById('at_cert_rot_inicio').value || null;
  const rotDetalle = document.getElementById('at_cert_rot_detalle').value.trim() || null;

  /* --- Se registra --- */
  const { error } = await supabase.from('certificados_medicos').insert(alCrear({
    empresa_id: estado.empresaId,
    trabajador_id: t.id,
    origen: 'interno',
    beneficiario: 'trabajador',
    fecha_emision: fecha,
    codigo_cie10: dx.codigo || null,
    diagnostico: dx.descripcion || dx.observacion || null,
    reposo_inicio: dias > 0 ? inicio : null,
    reposo_dias: dias,
    amerita_reubicacion: rota,
    rotacion_inicio: rota && rotDias > 0 ? (rotInicio || inicio) : null,
    rotacion_dias: rotDias,
    rotacion_detalle: rotDetalle,
    medico_emisor: firmante || null,
    observacion: document.getElementById('at_cert_motivo').value.trim() || null
  }));

  if (error) {
    alert('La atención quedó registrada, pero no se pudo crear el certificado:\n\n'
        + error.message);
    return;
  }

  /* --- Se imprime --- */
  const rotacion = rota
    ? (rangoDias(rotInicio || inicio, rotDias) || rotDetalle || '')
    : '';

  await imprimirOficio({
    clase: 'justificacion',
    destinatario: dest,
    trabajador: {
      nombre_completo: t.nombre_completo,
      cargo: t.cargo,
      codigo: t.codigo
    },
    firmante,
    cargoFirmante: perfil?.cargo || '',
    fecha,
    diagnostico: dx.descripcion || dx.observacion || '',
    cie10: dx.codigo || '',
    mostrarCie: document.getElementById('at_cert_cie').checked,
    motivo: document.getElementById('at_cert_motivo').value.trim(),
    reposoInicio: inicio,
    reposoDias: dias,
    rotacion
  });
}

async function guardarAtencion() {
  if (estado.modoAtencion === 'externo') return guardarAtencionExterna();

  if (!estado.trabajador) return alertaAtencion('Identifique al trabajador');

  const diagnosticos = estado.diagnosticos.filter((d) => d.codigo);
  if (diagnosticos.length === 0) return alertaAtencion('Registre al menos un diagnóstico');

  const consumosValidos = estado.consumos.filter((p) => p.tipo && p.item_id && p.cantidad > 0);
  const prescripciones = consumosValidos.filter((p) => p.tipo === 'medicamento');
  const consumosInsumos = consumosValidos.filter((p) => p.tipo === 'insumo');

  const $btn = document.getElementById('btn-guardar-atencion');
  $btn.disabled = true;
  $btn.textContent = 'Registrando…';

  const vitales = {
    presion_sistolica: valorNumerico('at_sistolica'),
    presion_diastolica: valorNumerico('at_diastolica'),
    frecuencia_cardiaca: valorNumerico('at_fc'),
    frecuencia_resp: valorNumerico('at_fr'),
    temperatura: valorNumerico('at_temp'),
    saturacion: valorNumerico('at_sat'),
    peso: valorNumerico('at_peso'),
    talla: valorNumerico('at_talla')
  };

  const { data, error } = await supabase.rpc('registrar_atencion', {
    p_empresa: estado.empresaId,
    p_trabajador: estado.trabajador.id,
    p_fecha: document.getElementById('at_fecha').value,
    p_motivo: document.getElementById('at_motivo').value,
    p_observacion: document.getElementById('at_observacion').value,
    p_dias_reposo: parseInt(document.getElementById('at_reposo').value, 10) || 0,
    p_vitales: vitales,
    p_alergias: document.getElementById('at_alergias').value,
    p_diagnosticos: diagnosticos.map((d) => ({
      codigo: d.codigo, observacion: d.observacion,
      tipo_caso: d.tipoCaso || 'nuevo',
      diagnostico_origen_id: d.tipoCaso === 'seguimiento' ? d.origenId : null
    })),
    p_medicamentos: prescripciones.map((p) => ({
      medicamento_id: p.item_id,
      cantidad: p.cantidad,
      indicacion: p.indicacion
    })),
    p_insumos: consumosInsumos.map((p) => ({
      insumo_id: p.item_id,
      cantidad: p.cantidad,
      indicacion: p.indicacion
    })),
    p_usuario_id: autorId()
  });

  $btn.disabled = false;
  $btn.textContent = 'Registrar atención';

  if (error) return alertaAtencion('No fue posible registrar: ' + error.message);

  /* Informar lo que no se pudo entregar, medicamentos e insumos juntos */
  const noEntregados = data?.no_entregados || [];
  const insumosNoEntregados = data?.insumos_no_entregados || [];
  if (noEntregados.length > 0 || insumosNoEntregados.length > 0) {
    const detalle = [
      ...noEntregados.map((n) => `· ${n.medicamento} (${n.solicitado} solicitadas)`),
      ...insumosNoEntregados.map((n) => `· ${n.insumo} (${n.solicitado} solicitadas)`)
    ].join('\n');
    alert('Atención registrada.\n\nSin existencia suficiente para entregar:\n\n' +
          detalle + '\n\nQuedaron registrados como no entregados.');
  }

  /* El certificado se crea DESPUÉS de que la atención quedó
     registrada. Si se creara antes y el registro fallara,
     habría un justificativo firmado de una consulta que no
     existe. */
  if (document.getElementById('at_certificado').checked) {
    await emitirCertificadoInterno(diagnosticos);
  }

  document.getElementById('modal-atencion').hidden = true;
  await recargar();
}

/* Misma idea que guardarAtencion(), pero para ADAE, pasantes
   o comunidad: sin vitales, sin reposo, sin certificado —esos
   conceptos son de relación laboral y no aplican aquí. Las
   alergias se guardan en personas_externas en vez de
   trabajadores, con la misma regla: un campo vacío no borra
   lo que ya estaba escrito. */
async function guardarAtencionExterna() {
  const persona = estado.personaExterna;
  if (!persona) return alertaAtencion('Identifique a la persona externa');

  const diagnosticos = estado.diagnosticos.filter((d) => d.codigo);
  if (diagnosticos.length === 0) return alertaAtencion('Registre al menos un diagnóstico');

  const consumosValidos = estado.consumos.filter((p) => p.tipo && p.item_id && p.cantidad > 0);
  const prescripciones = consumosValidos.filter((p) => p.tipo === 'medicamento');
  const consumosInsumos = consumosValidos.filter((p) => p.tipo === 'insumo');

  const $btn = document.getElementById('btn-guardar-atencion');
  $btn.disabled = true;
  $btn.textContent = 'Registrando…';

  const alergias = document.getElementById('at_alergias_ext').value.trim();
  if (alergias) {
    await supabase.from('personas_externas')
      .update(alEditar({ alergias })).eq('id', persona.id);
  }

  const { data, error } = await supabase.rpc('registrar_atencion_externa', {
    p_empresa: estado.empresaId,
    p_persona_externa: persona.id,
    p_fecha: document.getElementById('at_fecha_ext').value,
    p_motivo: document.getElementById('at_motivo').value,
    p_observacion: document.getElementById('at_observacion').value,
    p_diagnosticos: diagnosticos.map((d) => ({ codigo: d.codigo, observacion: d.observacion })),
    p_medicamentos: prescripciones.map((p) => ({
      medicamento_id: p.item_id,
      cantidad: p.cantidad,
      indicacion: p.indicacion
    })),
    p_insumos: consumosInsumos.map((p) => ({
      insumo_id: p.item_id,
      cantidad: p.cantidad,
      indicacion: p.indicacion
    })),
    p_usuario_id: autorId()
  });

  $btn.disabled = false;
  $btn.textContent = 'Registrar atención';

  if (error) return alertaAtencion('No fue posible registrar: ' + error.message);

  const noEntregados = data?.no_entregados || [];
  const insumosNoEntregados = data?.insumos_no_entregados || [];
  if (noEntregados.length > 0 || insumosNoEntregados.length > 0) {
    const detalle = [
      ...noEntregados.map((n) => `· ${n.medicamento} (${n.solicitado} solicitadas)`),
      ...insumosNoEntregados.map((n) => `· ${n.insumo} (${n.solicitado} solicitadas)`)
    ].join('\n');
    alert('Atención registrada.\n\nSin existencia suficiente para entregar:\n\n' +
          detalle + '\n\nQuedaron registrados como no entregados.');
  }

  document.getElementById('modal-atencion').hidden = true;
  await recargar();
}

/* ============================================
   Reimpresión del certificado

   El oficio se traspapela, se moja o lo pide otra área. Se
   rehace desde la atención que lo originó, con las mismas
   cifras: rehacerlo a mano produciría un segundo justificativo
   con fechas que no coinciden con el primero.

   El certificado se localiza por trabajador y fecha, porque
   la atención y el certificado no guardan un vínculo directo.
   Es suficiente: no se emiten dos justificativos internos al
   mismo trabajador el mismo día. La búsqueda misma vive ahora
   dentro de abrirDetalle(), en el mismo Promise.all: así se
   conoce el resultado ANTES de construir el HTML del detalle,
   y la sección de certificado puede decidir qué mostrar.
   ============================================ */


/* Eliminar una atención registrada por error. Solo administrador
   (el botón ya viene oculto para cualquier otro rol). Pide
   escribir "ELIMINAR" a propósito —un solo confirm() se puede
   aceptar sin leer, esto obliga a detenerse un segundo. Si se
   entregó medicación, el RPC la devuelve al inventario antes
   de borrar; nunca queda un descuadre de stock sin explicación. */
async function eliminarAtencion() {
  const a = estado.detalle;
  if (!a) return;

  const escrito = prompt(
    `Vas a eliminar por completo la atención del ${formatearFecha(a.fecha)} de `
    + `${a.nombre_completo}.\n\n`
    + 'Si se entregó medicación o insumos, esa cantidad se devuelve sola al '
    + 'inventario. Esta acción no se puede deshacer.\n\n'
    + 'Para confirmar, escriba ELIMINAR:'
  );
  if (escrito !== 'ELIMINAR') return;

  const $btn = document.getElementById('btn-eliminar-atencion');
  $btn.disabled = true;
  $btn.textContent = 'Eliminando…';

  const { data, error } = await supabase.rpc('eliminar_atencion', { p_atencion_id: a.id });

  $btn.disabled = false;
  $btn.textContent = 'Eliminar atención';

  if (error || !data?.ok) {
    alert('No se pudo eliminar: ' + (error?.message || data?.motivo || 'error desconocido'));
    return;
  }

  document.getElementById('modal-detalle').hidden = true;
  alert('Atención eliminada. El inventario ya quedó actualizado.');
  await recargar();
}

async function reimprimirCertificado() {
  const c = estado.certDetalle;
  const a = estado.detalle;
  if (!c || !a) return;

  /* Se pregunta a quién va, porque una reimpresión suele ser
     para dirigirla a otra área: si se reutilizara el
     destinatario original, habría que rehacerlo a mano de
     todos modos. */
  const opciones = destinatariosLista();
  if (opciones.length === 0) {
    alert('No hay destinatarios configurados.');
    return;
  }

  const menu = opciones.map((d, i) => `${i + 1}. ${d.nombre} — ${d.cargo}`).join('\n');
  const eleccion = prompt(`¿A quién va dirigido?\n\n${menu}`, '1');
  if (eleccion === null) return;

  const elegido = opciones[parseInt(eleccion, 10) - 1];
  if (!elegido) return;

  await imprimirOficio({
    clase: 'justificacion',
    destinatario: elegido,
    trabajador: {
      nombre_completo: a.nombre_completo,
      cargo: a.cargo,
      codigo: a.codigo_trabajador
    },
    firmante: c.medico_emisor || '',
    cargoFirmante: '',
    fecha: c.fecha_emision,
    diagnostico: c.diagnostico || '',
    cie10: c.codigo_cie10 || '',
    mostrarCie: mostrarCiePorDefecto(),
    motivo: c.observacion || '',
    reposoInicio: c.reposo_inicio,
    reposoDias: c.reposo_dias,
    rotacion: c.amerita_reubicacion
      ? (rangoDias(c.rotacion_inicio, c.rotacion_dias) || c.rotacion_detalle || '')
      : ''
  });
}

function valorNumerico(id) {
  const v = document.getElementById(id).value;
  return v === '' ? null : parseFloat(v);
}

function alertaAtencion(texto) {
  const $a = document.getElementById('alerta-atencion');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Detalle
   ============================================ */

async function abrirDetalle(a) {
  const $cuerpo = document.getElementById('detalle-cuerpo');
  estado.detalle = a;

  /* El botón de reimprimir se oculta y solo reaparece si esta
     atención llegó a emitir un certificado. Dejarlo siempre
     visible llevaría a pulsarlo y encontrarse un aviso de que
     no hay nada que imprimir. */
  document.getElementById('btn-reimprimir-cert').hidden = true;
  document.getElementById('btn-anular-cert').hidden = true;
  document.getElementById('btn-eliminar-atencion').hidden = !estado.esAdmin;
  document.getElementById('detalle-titulo').textContent =
    `${formatearFecha(a.fecha)} · ${a.nombre_completo}`;
  $cuerpo.innerHTML = '<p class="pista">Cargando…</p>';
  document.getElementById('modal-detalle').hidden = false;

  const [dx, rx, ri, at, cert] = await Promise.all([
    supabase.from('atencion_diagnosticos')
      .select('codigo_cie10, orden, observacion, cie10(descripcion)')
      .eq('atencion_id', a.id).order('orden'),
    supabase.from('atencion_medicamentos')
      .select('id, cantidad, indicacion, entregado, motivo_no_entrega, medicamentos(nombre_generico, nombre_comercial, concentracion, forma)')
      .eq('atencion_id', a.id),
    supabase.from('insumos_kardex')
      .select('cantidad, nota, insumos(nombre, unidad)')
      .eq('atencion_id', a.id),
    supabase.from('atenciones')
      .select('motivo_consulta, presion_sistolica, presion_diastolica, frecuencia_cardiaca, frecuencia_resp, temperatura, saturacion, peso, talla')
      .eq('id', a.id).single(),
    supabase.from('certificados_medicos')
      .select('*')
      .eq('trabajador_id', a.trabajador_id)
      .eq('fecha_emision', a.fecha)
      .eq('origen', 'interno')
      .order('creado_en', { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  estado.detalleDiagnosticos = dx.data || [];
  estado.medicamentoElegidoDetalle = null;
  estado.certDetalle = cert.data || null;

  if (estado.certDetalle) {
    document.getElementById('btn-reimprimir-cert').hidden = false;
    if (estado.esAdmin) document.getElementById('btn-anular-cert').hidden = false;
  }

  const vitales = at.data || {};
  const hayVitales = ['presion_sistolica', 'frecuencia_cardiaca', 'temperatura',

                      'saturacion', 'peso'].some((k) => vitales[k] != null);

  $cuerpo.innerHTML = `
    <div class="detalle-encabezado">
      <div class="ficha-item">
        <span class="ficha-etiqueta">Código</span>
        <span class="ficha-valor">${a.codigo_trabajador}</span>
      </div>
      <div class="ficha-item">
        <span class="ficha-etiqueta">Cédula</span>
        <span class="ficha-valor celda-mono">${escapar(a.cedula)}</span>
      </div>
      <div class="ficha-item">
        <span class="ficha-etiqueta">Edad</span>
        <span class="ficha-valor">${a.edad_atencion ?? '—'}</span>
      </div>
      <div class="ficha-item">
        <span class="ficha-etiqueta">Cargo</span>
        <span class="ficha-valor">${escapar(textoOGuion(a.cargo))}</span>
      </div>
    </div>

    ${a.alergias ? `<p class="detalle-alergia">⚠ Alergias: ${escapar(a.alergias)}</p>` : ''}

    ${vitales.motivo_consulta ? `
      <h4 class="detalle-titulo">Motivo de consulta</h4>
      <p class="detalle-texto">${escapar(vitales.motivo_consulta)}</p>` : ''}

    ${hayVitales ? `
      <h4 class="detalle-titulo">Signos vitales</h4>
      <div class="vitales-tira">
        ${vitales.presion_sistolica ? `<span class="vital">PA ${vitales.presion_sistolica}/${vitales.presion_diastolica ?? '—'}</span>` : ''}
        ${vitales.frecuencia_cardiaca ? `<span class="vital">FC ${vitales.frecuencia_cardiaca}</span>` : ''}
        ${vitales.frecuencia_resp ? `<span class="vital">FR ${vitales.frecuencia_resp}</span>` : ''}
        ${vitales.temperatura ? `<span class="vital">T° ${vitales.temperatura}</span>` : ''}
        ${vitales.saturacion ? `<span class="vital">SatO₂ ${vitales.saturacion}%</span>` : ''}
        ${vitales.peso ? `<span class="vital">${vitales.peso} kg</span>` : ''}
        ${vitales.talla ? `<span class="vital">${vitales.talla} m</span>` : ''}
      </div>` : ''}

    <h4 class="detalle-titulo">Diagnósticos</h4>
    ${(dx.data || []).map((d) => `
      <div class="detalle-linea">
        <span class="cie-chip">${escapar(d.codigo_cie10)}</span>
        <span>${escapar(d.cie10?.descripcion || '')}</span>
        ${d.orden === 1 ? '<span class="etiqueta-principal">Principal</span>' : ''}
        ${d.observacion ? `<span class="secundario">${escapar(d.observacion)}</span>` : ''}
      </div>
    `).join('') || '<p class="pista">Sin diagnósticos.</p>'}

    <h4 class="detalle-titulo">Medicamentos</h4>
    ${(rx.data || []).map((m) => {
      const med = m.medicamentos || {};
      const generico = `${med.nombre_generico || ''} ${med.concentracion || ''}`.trim();
      return `
      <div class="detalle-linea">
        <span class="${m.entregado ? 'insignia insignia-activa' : 'insignia insignia-critica'}">
          ${m.entregado ? 'Entregado' : 'No entregado'}
        </span>
        <span class="detalle-medicamento">
          ${med.nombre_comercial ? `<strong>${escapar(med.nombre_comercial)}</strong><br>` : ''}
          ${escapar(generico)}
        </span>
        <span class="celda-mono">× ${m.cantidad}</span>
        ${m.indicacion ? `<span class="secundario">${escapar(m.indicacion)}</span>` : ''}
        ${estado.esAdmin ? `
          <button type="button" class="boton-secundario boton-critico boton-mini boton-quitar-medicamento"
                  data-id="${m.id}" data-nombre="${escapar(generico)}">
            Quitar
          </button>` : ''}
      </div>
    `;}).join('') || '<p class="pista">Sin prescripción.</p>'}

    ${estado.esAdmin ? `
      <div class="detalle-agregar-medicamento">
        <input type="text" id="det-buscar-medicamento" class="entrada"
               placeholder="Buscar medicamento para agregar…" autocomplete="off">
        <div id="det-sugerencias-medicamento" class="sugerencias" hidden></div>
        <div id="det-medicamento-elegido" hidden>
          <span id="det-medicamento-elegido-nombre"></span>
          <input type="number" id="det-medicamento-cantidad" class="entrada entrada-mini"
                 min="1" step="1" value="1" placeholder="Cant.">
          <input type="text" id="det-medicamento-indicacion" class="entrada"
                 placeholder="Indicación (opcional)">
          <button type="button" class="boton-secundario" id="btn-agregar-medicamento-detalle">
            Agregar
          </button>
          <button type="button" class="boton-secundario" id="btn-cancelar-medicamento-detalle">
            Cancelar
          </button>
        </div>
      </div>` : ''}

    <h4 class="detalle-titulo">Certificado interno</h4>
    ${estado.certDetalle ? `
      <div class="detalle-linea">
        <span class="insignia insignia-activa">Emitido</span>
        <span class="detalle-medicamento">${escapar(estado.certDetalle.diagnostico || '')}</span>
        ${estado.certDetalle.reposo_dias > 0
          ? `<span class="secundario">${resumenReposo(estado.certDetalle.reposo_inicio, estado.certDetalle.reposo_dias)}</span>`
          : ''}
      </div>`
    : (estado.esAdmin ? `
      <div class="detalle-emitir-certificado">
        <div class="rejilla">
          <div class="campo">
            <label class="etiqueta" for="det-cert-dest">Dirigido a</label>
            <select class="entrada" id="det-cert-dest"></select>
          </div>
          <div class="campo">
            <label class="etiqueta" for="det-cert-inicio">Inicio del reposo</label>
            <input class="entrada" id="det-cert-inicio" type="date" value="${HOY()}">
          </div>
          <div class="campo">
            <label class="etiqueta" for="det-cert-dias">Días de reposo</label>
            <input class="entrada" id="det-cert-dias" type="number" min="0" value="${a.dias_reposo || 0}">
          </div>
        </div>
        <p class="cert-fechas" id="det-cert-fechas-reposo" hidden></p>

        <label class="alternador">
          <input type="checkbox" id="det-cert-rotacion">
          <span>Amerita rotación de área</span>
        </label>

        <div class="rejilla" id="det-cert-rotacion-bloque" hidden>
          <div class="campo">
            <label class="etiqueta" for="det-cert-rot-inicio">Inicio de la rotación</label>
            <input class="entrada" id="det-cert-rot-inicio" type="date">
          </div>
          <div class="campo">
            <label class="etiqueta" for="det-cert-rot-dias">Días de rotación</label>
            <input class="entrada" id="det-cert-rot-dias" type="number" min="0" value="0">
          </div>
          <div class="campo campo-ancho">
            <label class="etiqueta" for="det-cert-rot-detalle">Detalle de la rotación</label>
            <input class="entrada" id="det-cert-rot-detalle" type="text">
          </div>
        </div>
        <p class="cert-fechas" id="det-cert-fechas-rotacion" hidden></p>

        <div class="campo">
          <label class="etiqueta" for="det-cert-motivo">Motivo</label>
          <textarea class="entrada area" id="det-cert-motivo" rows="2"
                    placeholder="el trabajador no asistió a sus labores... / el trabajador se presentó a laborar pero fue retirado por..."></textarea>
          <span class="ayuda">Completa la frase «…por medio de la presente, indico que ___».</span>
        </div>

        <button type="button" class="boton-secundario" id="btn-emitir-cert-post">
          Emitir certificado interno
        </button>
      </div>`
    : '<p class="pista">Esta atención no tiene certificado interno.</p>')}

    <h4 class="detalle-titulo">Insumos</h4>
    ${(ri.data || []).map((r) => `
      <div class="detalle-linea">
        <span>${escapar(r.insumos?.nombre || '')}</span>
        <span class="celda-mono">× ${r.cantidad} ${escapar(r.insumos?.unidad || '')}</span>
        ${r.nota ? `<span class="secundario">${escapar(r.nota)}</span>` : ''}
      </div>
    `).join('') || '<p class="pista">Sin insumos registrados.</p>'}

    ${a.observacion ? `
      <h4 class="detalle-titulo">Observación</h4>
      <p class="detalle-texto">${escapar(a.observacion)}</p>` : ''}

    ${a.dias_reposo > 0 ? `<p class="detalle-reposo">Reposo: ${a.dias_reposo} días</p>` : ''}

    <p class="detalle-pie">
      Registró: ${escapar(textoOGuion(a.atendido_por_nombre))}
    </p>
  `;

  if (estado.esAdmin) {
    conectarBuscadorMedicamentoDetalle();
    if (!estado.certDetalle) conectarCertificadoPost();
  }
}

/* ============================================
   Editar atención concluida: medicamentos
   Botón "Quitar" por línea y buscador para agregar uno nuevo.
   Solo admin —igual que eliminar la atención completa—, porque
   ambas cosas mueven inventario después de que la consulta ya
   se dio por cerrada.
   ============================================ */

function conectarBuscadorMedicamentoDetalle() {
  const $buscar = document.getElementById('det-buscar-medicamento');
  const $sug = document.getElementById('det-sugerencias-medicamento');
  const $elegido = document.getElementById('det-medicamento-elegido');
  const $nombreElegido = document.getElementById('det-medicamento-elegido-nombre');
  if (!$buscar) return;

  $buscar.addEventListener('input', () => {
    const texto = $buscar.value.trim().toLowerCase();
    if (texto.length < 2) { $sug.hidden = true; return; }

    const hallados = estado.medicamentos.filter((m) => {
      const campo = `${m.nombre_generico ?? ''} ${m.nombre_comercial ?? ''} ${m.concentracion ?? ''}`.toLowerCase();
      return campo.includes(texto);
    }).slice(0, 10);

    if (hallados.length === 0) {
      $sug.innerHTML = '<p class="sugerencia-vacia">Sin coincidencias</p>';
      $sug.hidden = false;
      return;
    }

    $sug.innerHTML = '';
    hallados.forEach((m) => {
      const etiqueta = etiquetaMedicamento(m);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sugerencia';
      b.innerHTML = `<span class="sugerencia-nombre">${escapar(etiqueta)}</span>
                     <span class="sugerencia-meta">Stock: ${m.stock_disponible ?? 0}</span>`;
      b.addEventListener('click', () => {
        estado.medicamentoElegidoDetalle = m;
        $nombreElegido.textContent = etiqueta;
        $elegido.hidden = false;
        $buscar.value = '';
        $sug.hidden = true;
      });
      $sug.appendChild(b);
    });
    $sug.hidden = false;
  });

  document.getElementById('btn-cancelar-medicamento-detalle')?.addEventListener('click', () => {
    estado.medicamentoElegidoDetalle = null;
    $elegido.hidden = true;
    document.getElementById('det-medicamento-cantidad').value = '1';
    document.getElementById('det-medicamento-indicacion').value = '';
  });

  document.getElementById('btn-agregar-medicamento-detalle')?.addEventListener('click', agregarMedicamentoDetalle);
}

async function agregarMedicamentoDetalle() {
  const m = estado.medicamentoElegidoDetalle;
  const a = estado.detalle;
  if (!m || !a) return;

  const cantidad = parseInt(document.getElementById('det-medicamento-cantidad').value, 10);
  if (!cantidad || cantidad <= 0) return alert('Indique una cantidad válida.');

  const indicacion = document.getElementById('det-medicamento-indicacion').value.trim() || null;

  const $btn = document.getElementById('btn-agregar-medicamento-detalle');
  $btn.disabled = true;
  $btn.textContent = 'Agregando…';

  const { data, error } = await supabase.rpc('agregar_medicamento_atencion', {
    p_atencion_id: a.id,
    p_medicamento_id: m.id,
    p_cantidad: cantidad,
    p_indicacion: indicacion
  });

  $btn.disabled = false;
  $btn.textContent = 'Agregar';

  if (error || !data?.ok) {
    return alert('No se pudo agregar: ' + (error?.message || data?.motivo || 'error desconocido'));
  }

  if (!data.entregado) {
    alert(`Se agregó ${data.medicamento}, pero sin existencia suficiente: quedó como no entregado.`);
  }

  await cargarMedicamentos();
  await abrirDetalle(a);
}

async function quitarMedicamentoDetalle(id, nombre) {
  if (!confirm(`¿Quitar ${nombre} de esta atención?\n\n`
    + 'Si estaba entregado, la cantidad se devuelve sola al inventario.')) return;

  const { data, error } = await supabase.rpc('quitar_medicamento_atencion', {
    p_atencion_medicamento_id: id
  });

  if (error || !data?.ok) {
    return alert('No se pudo quitar: ' + (error?.message || data?.motivo || 'error desconocido'));
  }

  await cargarMedicamentos();
  await abrirDetalle(estado.detalle);
}

/* ============================================
   Editar atención concluida: certificado interno
   Formulario completo (destinatario, inicio, días, rotación
   de área), igual de expresivo que el de la atención en curso
   —no un prompt() de una sola línea— porque emitirlo días
   después implica elegir un inicio de reposo que ya no es
   necesariamente el de la atención original. */

function conectarCertificadoPost() {
  const $dias = document.getElementById('det-cert-dias');
  const $inicio = document.getElementById('det-cert-inicio');
  if (!$dias) return;

  llenarDestinatarios('det-cert-dest');

  const $rot = document.getElementById('det-cert-rotacion');
  const $rotBloque = document.getElementById('det-cert-rotacion-bloque');
  const $rotInicio = document.getElementById('det-cert-rot-inicio');

  const pintarFechas = () => {
    const poner = (idSalida, texto) => {
      const $s = document.getElementById(idSalida);
      if (!$s) return;
      $s.innerHTML = texto;
      $s.hidden = !texto;
    };

    poner('det-cert-fechas-reposo', resumenReposo(
      $inicio.value, parseInt($dias.value, 10) || 0, 'Reposo'));

    poner('det-cert-fechas-rotacion', resumenReposo(
      $rotInicio.value,
      $rot.checked ? (parseInt(document.getElementById('det-cert-rot-dias').value, 10) || 0) : 0,
      'Rotación'));
  };

  $rot.addEventListener('change', () => {
    $rotBloque.hidden = !$rot.checked;
    if ($rot.checked && !$rotInicio.value) $rotInicio.value = $inicio.value;
    pintarFechas();
  });

  ['det-cert-inicio', 'det-cert-dias', 'det-cert-rot-inicio', 'det-cert-rot-dias']
    .forEach((id) => document.getElementById(id).addEventListener('input', pintarFechas));

  pintarFechas();

  document.getElementById('btn-emitir-cert-post').addEventListener('click', emitirCertificadoPost);
}

async function emitirCertificadoPost() {
  const a = estado.detalle;
  if (!a) return;

  const dx = (estado.detalleDiagnosticos || [])[0];
  if (!dx) return alert('No se puede emitir: esta atención no tiene diagnóstico.');

  const destId = document.getElementById('det-cert-dest').value;
  const elegido = destinatarioPorId(destId);
  if (!elegido) return alert('Elija a quién va dirigido el certificado.');

  const inicio = document.getElementById('det-cert-inicio').value;
  const dias = parseInt(document.getElementById('det-cert-dias').value, 10) || 0;
  if (!inicio) return alert('Indique la fecha de inicio del reposo.');
  if (dias <= 0) return alert('Indique el número de días de reposo.');

  const rota = document.getElementById('det-cert-rotacion').checked;
  const rotInicio = document.getElementById('det-cert-rot-inicio').value || null;
  const rotDias = rota
    ? (parseInt(document.getElementById('det-cert-rot-dias').value, 10) || 0) : 0;
  const rotDetalle = document.getElementById('det-cert-rot-detalle').value.trim() || null;
  const motivo = document.getElementById('det-cert-motivo').value.trim() || null;

  const perfil = sesionActual();
  const firmante = perfil
    ? [perfil.titulo, perfil.nombres, perfil.apellidos].filter(Boolean).join(' ').trim()
    : '';

  const $btn = document.getElementById('btn-emitir-cert-post');
  $btn.disabled = true;
  $btn.textContent = 'Emitiendo…';

  const { error } = await supabase.from('certificados_medicos').insert(alCrear({
    empresa_id: estado.empresaId,
    trabajador_id: a.trabajador_id,
    origen: 'interno',
    beneficiario: 'trabajador',
    fecha_emision: a.fecha,
    codigo_cie10: dx.codigo_cie10 || null,
    diagnostico: dx.cie10?.descripcion || dx.observacion || null,
    reposo_inicio: inicio,
    reposo_dias: dias,
    amerita_reubicacion: rota,
    rotacion_inicio: rota && rotDias > 0 ? (rotInicio || inicio) : null,
    rotacion_dias: rotDias,
    rotacion_detalle: rotDetalle,
    medico_emisor: firmante || null,
    observacion: motivo
  }));

  $btn.disabled = false;
  $btn.textContent = 'Emitir certificado interno';

  if (error) return alert('No se pudo emitir el certificado: ' + error.message);

  const rotacion = rota
    ? (rangoDias(rotInicio || inicio, rotDias) || rotDetalle || '')
    : '';

  await imprimirOficio({
    clase: 'justificacion',
    destinatario: elegido,
    trabajador: { nombre_completo: a.nombre_completo, cargo: a.cargo, codigo: a.codigo_trabajador },
    firmante,
    cargoFirmante: perfil?.cargo || '',
    fecha: a.fecha,
    diagnostico: dx.cie10?.descripcion || dx.observacion || '',
    cie10: dx.codigo_cie10 || '',
    mostrarCie: mostrarCiePorDefecto(),
    motivo: motivo || '',
    reposoInicio: inicio,
    reposoDias: dias,
    rotacion
  });

  await abrirDetalle(a);
}

async function anularCertificado() {
  const c = estado.certDetalle;
  if (!c) return;

  if (!confirm('¿Anular este certificado interno? Esta acción no se puede deshacer.')) return;

  await marcarAntesDeBorrar(supabase, 'certificados_medicos', c.id);
  const { error } = await supabase.from('certificados_medicos').delete().eq('id', c.id);

  if (error) return alert('No se pudo anular: ' + error.message);

  await abrirDetalle(estado.detalle);
}

/* ============================================
   Buscador de paciente · pestaña Atenciones
   ============================================ */

/** Búsqueda por código. Se dispara con Enter o con el botón. */
async function buscarPaciente() {
  const codigo = parseInt(document.getElementById('busca_codigo').value, 10);
  const $ayuda = document.getElementById('ayuda-busca');

  if (!codigo) {
    $ayuda.textContent = 'Indique un código de trabajador';
    $ayuda.className = 'ayuda ayuda-error';
    return;
  }

  const { data, error } = await supabase
    .from('v_trabajadores')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('codigo', codigo)
    .maybeSingle();

  if (error || !data) {
    $ayuda.textContent = 'No existe un trabajador con ese código en esta empresa';
    $ayuda.className = 'ayuda ayuda-error';
    limpiarPaciente();
    return;
  }

  $ayuda.textContent = '';
  document.getElementById('busca_nombre').value = '';
  ocultarSugerencias();
  mostrarPaciente(data);
}

/** Búsqueda por nombre o cédula: devuelve sugerencias */
const buscarPorNombre = retrasar(async () => {
  const texto = document.getElementById('busca_nombre').value.trim();
  const $sug = document.getElementById('busca_sugerencias');

  if (texto.length < 2) { ocultarSugerencias(); return; }

  const { data, error } = await supabase
    .from('v_trabajadores')
    .select('id, codigo, cedula, nombre_completo, activo')
    .eq('empresa_id', estado.empresaId)
    .or(`nombre_completo.ilike.%${texto}%,cedula.ilike.${texto}%`)
    .order('apellidos')
    .limit(12);

  if (error || !data || data.length === 0) {
    $sug.innerHTML = '<p class="sugerencia-vacia">Sin coincidencias</p>';
    $sug.hidden = false;
    return;
  }

  $sug.innerHTML = '';
  const frag = document.createDocumentFragment();

  data.forEach((t) => {
    const item = document.createElement('button');
    item.className = 'sugerencia';
    item.type = 'button';
    item.innerHTML = `
      <span class="codigo">${t.codigo}</span>
      <span class="sugerencia-nombre">${escapar(t.nombre_completo)}</span>
      <span class="sugerencia-meta">${escapar(t.cedula)}</span>
      ${!t.activo ? '<span class="insignia insignia-inactiva">Inactivo</span>' : ''}
    `;
    item.addEventListener('click', () => {
      document.getElementById('busca_codigo').value = t.codigo;
      document.getElementById('busca_nombre').value = '';
      ocultarSugerencias();
      buscarPaciente();
    });
    frag.appendChild(item);
  });

  $sug.appendChild(frag);
  $sug.hidden = false;
}, 300);

function ocultarSugerencias() {
  document.getElementById('busca_sugerencias').hidden = true;
}

function limpiarPaciente() {
  estado.paciente = null;
  estado.histAbierto = false;
  document.getElementById('paciente').hidden = true;
}

/** Pinta la ficha del paciente localizado */
function mostrarPaciente(t) {
  estado.paciente = t;
  estado.histAbierto = false;

  document.getElementById('paciente').hidden = false;
  document.getElementById('p-historial').hidden = true;
  document.getElementById('btn-historial').textContent = 'Historial';

  document.getElementById('p-nombre').textContent = t.nombre_completo;
  document.getElementById('p-meta').textContent =
    [t.cargo, t.area, t.sucursal].filter(Boolean).join(' · ') || 'Sin cargo asignado';
  document.getElementById('p-codigo').textContent = t.codigo;
  document.getElementById('p-cedula').textContent = t.cedula;
  document.getElementById('p-edad').textContent = t.edad != null ? `${t.edad} años` : '—';
  document.getElementById('p-sexo').textContent =
    t.sexo === 'M' ? 'Masculino' : t.sexo === 'F' ? 'Femenino' : '—';
  document.getElementById('p-cargo').textContent = textoOGuion(t.cargo);
  document.getElementById('p-sangre').textContent = textoOGuion(t.tipo_sangre);

  document.getElementById('p-estado').innerHTML = t.activo
    ? '<span class="insignia insignia-activa">Activo</span>'
    : '<span class="insignia insignia-inactiva">Inactivo</span>';

  const propias = estado.atenciones.filter((a) => a.trabajador_id === t.id);
  document.getElementById('p-total').textContent = propias.length;

  const $alergias = document.getElementById('p-alergias');
  if (t.alergias) {
    $alergias.textContent = `⚠ Alergias: ${t.alergias}`;
    $alergias.hidden = false;
  } else {
    $alergias.hidden = true;
  }
}

/* ============================================
   Historial embebido
   ============================================ */

async function alternarHistorial() {
  const $hist = document.getElementById('p-historial');
  const $btn = document.getElementById('btn-historial');

  if (estado.histAbierto) {
    $hist.hidden = true;
    $btn.textContent = 'Historial';
    estado.histAbierto = false;
    return;
  }

  const t = estado.paciente;
  if (!t) return;

  const $lista = document.getElementById('p-lista');
  $lista.innerHTML = '<p class="pista">Cargando…</p>';
  $hist.hidden = false;
  $btn.textContent = 'Ocultar historial';
  estado.histAbierto = true;

  const propias = estado.atenciones.filter((a) => a.trabajador_id === t.id);

  pintarRecurrencia(propias);

  if (propias.length === 0) {
    $lista.innerHTML = '<p class="pista">Este trabajador no registra atenciones.</p>';
    return;
  }

  const ids = propias.map((a) => a.id);

  const [dx, rx] = await Promise.all([
    supabase.from('atencion_diagnosticos')
      .select('atencion_id, codigo_cie10, orden, observacion, tipo_caso, diagnostico_origen_id, cie10(descripcion)')
      .in('atencion_id', ids).order('orden'),
    supabase.from('atencion_medicamentos')
      .select('atencion_id, cantidad, indicacion, entregado, medicamentos(nombre_generico, concentracion)')
      .in('atencion_id', ids)
  ]);

  const porDx = agrupar(dx.data || [], 'atencion_id');
  const porRx = agrupar(rx.data || [], 'atencion_id');

  /* Agrupar por año */
  const porAnio = new Map();
  propias.forEach((a) => {
    const anio = new Date(a.fecha + 'T00:00').getFullYear();
    if (!porAnio.has(anio)) porAnio.set(anio, []);
    porAnio.get(anio).push(a);
  });

  const anios = [...porAnio.keys()].sort((a, b) => b - a);

  $lista.innerHTML = anios.map((anio) => `
    <div class="anio-bloque">
      <div class="anio-marca">
        <span class="anio-numero">${anio}</span>
        <span class="anio-conteo">${porAnio.get(anio).length} atención${porAnio.get(anio).length === 1 ? '' : 'es'}</span>
      </div>
      ${porAnio.get(anio).map((a) => pintarEventoTimeline(a, porDx, porRx)).join('')}
    </div>
  `).join('');
}

/**
 * Detecta diagnósticos repetidos.
 * La reincidencia sobre un mismo código es señal de vigilancia:
 * puede indicar exposición no controlada o enfermedad ocupacional.
 */
function pintarRecurrencia(atenciones) {
  const $panel = document.getElementById('p-recurrencia');
  const $chips = document.getElementById('p-chips');
  const $nota = document.getElementById('p-nota-recurrencia');

  if (atenciones.length === 0) { $panel.hidden = true; return; }

  const conteo = new Map();
  atenciones.forEach((a) => {
    if (!a.cie10_principal) return;
    if (!conteo.has(a.cie10_principal)) {
      conteo.set(a.cie10_principal, {
        codigo: a.cie10_principal, descripcion: a.diagnostico_principal, veces: 0
      });
    }
    conteo.get(a.cie10_principal).veces++;
  });

  const items = [...conteo.values()].sort((a, b) => b.veces - a.veces);
  if (items.length === 0) { $panel.hidden = true; return; }

  $chips.innerHTML = items.map((i) => `
    <span class="chip ${i.veces >= 3 ? 'chip-alerta' : ''}">
      <span class="cie-chip">${escapar(i.codigo)}</span>
      <span class="chip-desc">${escapar(i.descripcion || '')}</span>
      <span class="chip-conteo">${i.veces}</span>
    </span>
  `).join('');

  const reincidentes = items.filter((i) => i.veces >= 3);
  if (reincidentes.length > 0) {
    $nota.textContent = 'Diagnóstico repetido tres o más veces. Considere evaluar exposición ' +
                        'laboral y pertinencia de vigilancia específica.';
    $nota.className = 'nota nota-alerta';
  } else {
    $nota.textContent = 'Conteo por diagnóstico principal.';
    $nota.className = 'nota';
  }

  $panel.hidden = false;
}

function pintarEventoTimeline(a, porDx, porRx) {
  const diagnosticos = porDx[a.id] || [];
  const medicamentos = porRx[a.id] || [];

  return `
    <article class="evento">
      <div class="evento-fecha">
        <span class="evento-dia">${formatearFecha(a.fecha)}</span>
        ${a.dias_reposo > 0 ? `<span class="reposo">${a.dias_reposo} d</span>` : ''}
      </div>

      <div class="evento-cuerpo">
        ${a.motivo_consulta
          ? `<p class="evento-motivo">${escapar(a.motivo_consulta)}</p>`
          : ''}

        ${diagnosticos.map((d) => `
          <div class="evento-dx">
            <span class="cie-chip">${escapar(d.codigo_cie10)}</span>
            <span>${escapar(d.cie10?.descripcion || '')}</span>
            ${d.orden === 1 ? '<span class="etiqueta-principal">Principal</span>' : ''}
            ${d.tipo_caso === 'seguimiento'
              ? '<span class="insignia-seguimiento" title="Da continuidad a una atención anterior">Seguimiento</span>'
              : ''}
          </div>
        `).join('')}

        ${medicamentos.length > 0 ? `
          <div class="evento-rx">
            ${medicamentos.map((m) => `
              <span class="rx-item ${m.entregado ? '' : 'rx-no-entregado'}">
                ${escapar(m.medicamentos?.nombre_generico || '')} ${escapar(m.medicamentos?.concentracion || '')}
                × ${m.cantidad}${m.entregado ? '' : ' · no entregado'}
              </span>
            `).join('')}
          </div>` : ''}

        ${a.observacion ? `<p class="evento-obs">${escapar(a.observacion)}</p>` : ''}
      </div>
    </article>
  `;
}

function agrupar(lista, clave) {
  return lista.reduce((acc, item) => {
    (acc[item[clave]] ||= []).push(item);
    return acc;
  }, {});
}

/** Abre el formulario con el paciente ya cargado */
function nuevaAtencionDesdeFicha() {
  const t = estado.paciente;
  if (!t) return;

  abrirAtencion();
  document.getElementById('at_codigo').value = t.codigo;
  buscarTrabajador();
}

/* Atención subsecuente: en vez de partir de cero, se elige de
   cuál atención anterior viene esta consulta, y el diagnóstico
   más la medicación de esa vez quedan ya escritos —el médico
   solo revisa y confirma, en vez de repetir todo el trabajo de
   una atención nueva. */
async function abrirSubsecuente() {
  const t = estado.paciente;
  if (!t) return;

  const { data: previas, error } = await supabase
    .from('atenciones')
    .select(`id, fecha, atencion_diagnosticos(
      id, codigo_cie10, orden, observacion, tipo_caso, diagnostico_origen_id,
      cie10(descripcion)
    )`)
    .eq('trabajador_id', t.id)
    .order('fecha', { ascending: false })
    .limit(10);

  if (error) {
    console.error('NEXUS · abrirSubsecuente', error);
    alert('No se pudo consultar el historial: ' + error.message);
    return;
  }
  if (!previas || previas.length === 0) {
    alert('Este trabajador no tiene atenciones anteriores registradas.');
    return;
  }

  /* Etiqueta PRIMERA / SUBSECUENTE N: se resuelve siguiendo la
     cadena real de diagnostico_origen_id, no por fecha —dos
     atenciones seguidas pueden ser por motivos distintos y no
     tener nada que ver entre sí. Solo cuenta como una misma
     "cadena" lo que el sistema ya enlazó como seguimiento. */
  const todosPorId = new Map();
  previas.forEach((a) => {
    (a.atencion_diagnosticos || []).forEach((d) => todosPorId.set(d.id, d));
  });

  function resolverRaiz(d, visto = new Set()) {
    if (!d || visto.has(d.id)) return d?.id ?? null;
    visto.add(d.id);
    if (d.tipo_caso !== 'seguimiento' || !d.diagnostico_origen_id) return d.id;
    const origen = todosPorId.get(d.diagnostico_origen_id);
    // Si el origen no vino en estas últimas 10 atenciones, la
    // cadena sigue más atrás de lo que se consultó: se corta
    // aquí y esta queda como si fuera la raíz visible.
    return origen ? resolverRaiz(origen, visto) : d.id;
  }

  /* Un mismo caso puede aparecer varias veces en las últimas 10
     atenciones (día 1, día 2, día 3...). En vez de mostrar las
     tres y obligar a calcular cuál es la más reciente, se
     muestra el caso UNA sola vez —con los datos de su última
     visita— y el enlace se hace siempre con esa última,
     siguiendo la conversación de recién: nunca hace falta
     pensarlo, el sistema ya elige bien. */
  const gruposPorAtencion = new Map(); // raízId -> [{ atencion, principal }]
  previas.forEach((a) => {
    const dxs = [...(a.atencion_diagnosticos || [])].sort((x, y) => x.orden - y.orden);
    const principal = dxs[0];
    if (!principal) return;
    const raiz = resolverRaiz(principal);
    if (!gruposPorAtencion.has(raiz)) gruposPorAtencion.set(raiz, []);
    gruposPorAtencion.get(raiz).push({ atencion: a, principal });
  });

  const casos = [...gruposPorAtencion.values()].map((items) => {
    items.sort((a, b) => a.atencion.fecha.localeCompare(b.atencion.fecha)); // vieja → nueva
    const ultima = items[items.length - 1];
    return {
      atencion: ultima.atencion,
      principal: ultima.principal,
      visitas: items.length,
      etiqueta: items.length === 1 ? 'PRIMERA' : `SUBSECUENTE ${items.length - 1}`
    };
  }).sort((a, b) => b.atencion.fecha.localeCompare(a.atencion.fecha)); // caso más reciente primero

  const opciones = casos.map((c, i) => {
    const desc = `${c.principal.codigo_cie10} · ${c.principal.cie10?.descripcion || ''}`;
    const conteo = c.visitas > 1 ? ` — ${c.visitas} consultas de este caso` : '';
    return `${i + 1}. ${formatearFecha(c.atencion.fecha)} — ${desc} [${c.etiqueta}]${conteo}`;
  }).join('\n');

  const elegido = prompt(
    `¿De cuál caso da seguimiento esta consulta?\n\n${opciones}\n\nEscriba el número:`
  );
  const n = parseInt(elegido, 10);
  if (!n || n < 1 || n > casos.length) return;

  const origen = casos[n - 1].atencion;
  const fechaOrigen = formatearFecha(origen.fecha);

  const [medRes, insRes] = await Promise.all([
    supabase.from('atencion_medicamentos')
      .select('medicamento_id, cantidad, indicacion, medicamentos(nombre_generico, concentracion)')
      .eq('atencion_id', origen.id),
    supabase.from('insumos_kardex')
      .select('insumo_id, cantidad, nota, insumos(nombre)')
      .eq('atencion_id', origen.id).eq('tipo', 'salida_consumo')
  ]);

  /* Se abre el formulario limpio y se identifica al trabajador
     directamente —sin pasar por la búsqueda con espera, para
     no tener que sincronizar el llenado con ese retraso. */
  abrirAtencion();
  document.getElementById('at_codigo').value = t.codigo;

  const { data: datosTrabajador } = await supabase
    .from('v_trabajadores').select('*')
    .eq('empresa_id', estado.empresaId).eq('codigo', t.codigo).maybeSingle();

  if (!datosTrabajador) return;

  estado.trabajador = datosTrabajador;
  const $ayuda = document.getElementById('ayuda-codigo');
  $ayuda.textContent = 'Trabajador identificado';
  $ayuda.className = 'ayuda ayuda-ok';
  pintarFicha(datosTrabajador);
  pintarAntecedente(datosTrabajador);
  mostrarBloques();

  /* Diagnósticos de la atención elegida, todos marcados como
     seguimiento de sus contrapartes originales. */
  estado.diagnosticos = (origen.atencion_diagnosticos || [])
    .sort((a, b) => a.orden - b.orden)
    .map((d) => ({
      codigo: d.codigo_cie10,
      descripcion: d.cie10?.descripcion || '',
      observacion: '',
      buscar: `${d.codigo_cie10} · ${d.cie10?.descripcion || ''}`,
      abierto: false, resultados: [], buscando: false, error: '',
      creandoCie: false, nuevoCodigoTmp: '', nuevoDescTmp: '', errorNuevoCie: '',
      tipoCaso: 'seguimiento', origenId: d.id, origenFecha: fechaOrigen
    }));

  if (estado.diagnosticos.length === 0) agregarDiagnostico();
  else pintarDiagnosticos();

  /* Medicamentos e insumos de esa misma atención, listos para
     revisar cantidades antes de confirmar —no hay que
     volver a buscarlos uno por uno. */
  const consumosMed = (medRes.data || []).map((m) => ({
    tipo: 'medicamento', item_id: m.medicamento_id, cantidad: m.cantidad,
    indicacion: m.indicacion || '',
    buscar: `${m.medicamentos?.nombre_generico || ''} ${m.medicamentos?.concentracion || ''}`.trim(),
    abierto: false
  }));
  const consumosIns = (insRes.data || []).map((x) => ({
    tipo: 'insumo', item_id: x.insumo_id, cantidad: x.cantidad,
    indicacion: x.nota || '',
    buscar: x.insumos?.nombre || '',
    abierto: false
  }));

  estado.consumos = [...consumosMed, ...consumosIns];
  if (estado.consumos.length === 0) agregarConsumo();
  else pintarConsumos();

  alert(
    `Se cargó el diagnóstico y la medicación de la atención del ${fechaOrigen}.\n\n`
    + 'Revise los datos, ajuste lo que corresponda (peso, presión, cantidades) '
    + 'y agregue cualquier diagnóstico nuevo antes de guardar.'
  );
}

/* ============================================
   Pestañas y empresa
   ============================================ */

function cambiarVista(vista) {
  estado.vista = vista;
  document.querySelectorAll('.pestana').forEach((p) => {
    p.classList.toggle('activa', p.dataset.vista === vista);
  });
  ['atenciones', 'consolidado', 'morbilidad', 'externos', 'informe'].forEach((v) => {
    document.getElementById('vista-' + v).hidden = v !== vista;
  });
  if (vista === 'morbilidad') pintarMorbilidad();
  if (vista === 'consolidado') pintarConsolidado();
  if (vista === 'externos') pintarExternos();
  if (vista === 'informe' && !estado.informeIniciado) {
    estado.informeIniciado = true;
    iniciarInformeAtenciones(estado.empresaId, estado.empresaNombre || '');
  }
  if (vista === 'atenciones') document.getElementById('busca_codigo').focus();
}

/**
 * Ya no elige nada: recibe la empresa ya resuelta (una sola
 * asignada, o la elegida en seleccionar-empresa.html) y carga
 * todo lo que antes disparaba el cambio del selector.
 */
async function seleccionarEmpresa(empresa) {
  estado.empresaId = empresa.id;
  estado.empresaNombre = empresa.razon_social;
  estado.informeIniciado = false;
  fijarEmpresaEmergencia(estado.empresaId);

  /* Destinatarios y membrete del oficio: se leen una vez al
     entrar al módulo, no en cada certificado. Antes esto se
     disparaba sin esperar (fire-and-forget): si el usuario
     atendía y emitía el certificado muy rápido, el logo y el
     nombre de la empresa todavía no habían llegado y el oficio
     salía sin encabezado. Certificados médicos sí lo esperaba
     (dentro de cargarConfig); aquí faltaba ese mismo await. */
  await cargarDatosOficio(estado.empresaId, estado.empresaNombre);
  llenarDestinatarios('at_cert_dest');
  $area.hidden = false;
  $avisoIni.hidden = true;

  await recargar();
}

async function recargar() {
  await Promise.all([cargarAtenciones(), cargarMedicamentos(), cargarInsumos(), cargarMorbilidad(), cargarExternos()]);
  pintarResumen();
  pintarHoy();
  llenarFiltroDx();

  if (estado.vista === 'consolidado') pintarConsolidado();
  if (estado.vista === 'externos') pintarExternos();
  if (estado.vista === 'morbilidad') pintarMorbilidad();

  /* Si hay una ficha abierta, reflejar la nueva atención */
  if (estado.paciente) {
    const abierto = estado.histAbierto;
    mostrarPaciente(estado.paciente);
    if (abierto) await alternarHistorial();
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

  /* --- Buscador de paciente --- */
  document.getElementById('btn-buscar').addEventListener('click', buscarPaciente);
  document.getElementById('busca_codigo').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); buscarPaciente(); }
  });
  document.getElementById('busca_nombre').addEventListener('input', buscarPorNombre);
  document.getElementById('btn-nueva-atencion').addEventListener('click', nuevaAtencionDesdeFicha);
  document.getElementById('btn-subsecuente').addEventListener('click', abrirSubsecuente);
  document.getElementById('btn-historial').addEventListener('click', alternarHistorial);

  /* Cerrar sugerencias al hacer clic fuera */
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#busca_nombre') && !e.target.closest('#busca_sugerencias')) {
      ocultarSugerencias();
    }
    /* Medicamentos e insumos: cada renglón tiene su propio
       panel, así que se cierra cualquiera que haya quedado
       abierto sin clic sobre su propio campo o su propia lista. */
    if (!e.target.closest('.campo-medicamento')) {
      const habiaAlguno = estado.consumos.some((p) => p.abierto);
      if (habiaAlguno) {
        estado.consumos.forEach((p) => { p.abierto = false; });
        pintarConsumos();
      }
    }
    /* Lo mismo para el buscador de diagnósticos CIE-10. */
    if (!e.target.closest('.campo-cie')) {
      const habiaAlgunoCie = estado.diagnosticos.some((d) => d.abierto);
      if (habiaAlgunoCie) {
        estado.diagnosticos.forEach((d) => { d.abierto = false; d.creandoCie = false; });
        pintarDiagnosticos();
      }
    }
  });

  /* --- Formulario de atención --- */
  document.getElementById('btn-guardar-atencion').addEventListener('click', guardarAtencion);
  document.getElementById('at_certificado').addEventListener('change', alternarCertificado);
  document.getElementById('at_cert_rotacion').addEventListener('change', alternarCertificado);

  document.getElementById('btn-reimprimir-cert')
    .addEventListener('click', reimprimirCertificado);
  document.getElementById('btn-eliminar-atencion')
    .addEventListener('click', eliminarAtencion);
  document.getElementById('btn-anular-cert')
    .addEventListener('click', anularCertificado);

  /* Delegado porque el botón "Quitar" de cada medicamento se
     crea de nuevo cada vez que se pinta el detalle. */
  document.getElementById('detalle-cuerpo').addEventListener('click', (e) => {
    const btn = e.target.closest('.boton-quitar-medicamento');
    if (btn) quitarMedicamentoDetalle(btn.dataset.id, btn.dataset.nombre);
  });

  ['at_reposo', 'at_cert_inicio', 'at_cert_rot_inicio', 'at_cert_rot_dias']
    .forEach((id) => document.getElementById(id)
      .addEventListener('input', pintarFechasCert));
  document.getElementById('at_codigo').addEventListener('input', buscarTrabajador);
  document.getElementById('btn-add-diagnostico').addEventListener('click', agregarDiagnostico);
  document.getElementById('btn-nueva-persona-externa').addEventListener('click', abrirNuevaPersonaExterna);
  document.getElementById('btn-guardar-persona-externa').addEventListener('click', guardarPersonaExterna);
  document.getElementById('ext_busqueda').addEventListener('input', pintarExternos);
  document.getElementById('inat-tipo').addEventListener('change', cambiarTipoPeriodo);
  document.getElementById('inat-btn-generar').addEventListener('click', generarInformeAtenciones);
  document.getElementById('inat-btn-descargar').addEventListener('click', descargarInformeAtenciones);
  document.getElementById('inat-btn-guardar').addEventListener('click', guardarInformeAtenciones);
  document.getElementById('inat-plan-usar').addEventListener('click', usarPlanDeAccion);
  document.getElementById('inat-plan-nuevo').addEventListener('click', abrirNuevoPlan);
  document.getElementById('inat-plan-cancelar').addEventListener('click', cancelarNuevoPlan);
  document.getElementById('inat-plan-guardar').addEventListener('click', guardarNuevoPlan);
  document.getElementById('btn-add-medicamento').addEventListener('click', agregarConsumo);
  document.getElementById('at_peso').addEventListener('input', calcularImc);
  document.getElementById('at_talla').addEventListener('input', calcularImc);

  /* --- Buscador CIE-10 --- */
  document.getElementById('cie-busqueda').addEventListener('input', buscarCie);
  document.getElementById('btn-crear-cie').addEventListener('click', crearCie);
  document.getElementById('btn-mostrar-agregar').addEventListener('click', () => {
    const $a = document.getElementById('agregar-cie');
    $a.hidden = !$a.hidden;
    if (!$a.hidden) document.getElementById('nuevo_cie_codigo').focus();
  });

  /* --- Consolidado --- */
  document.getElementById('cons-anio').addEventListener('change', pintarConsolidado);
  document.getElementById('cons-mes').addEventListener('change', pintarConsolidado);
  document.getElementById('cons-dx').addEventListener('change', pintarConsolidado);
  document.getElementById('cons-busqueda').addEventListener('input', retrasar(pintarConsolidado, 200));
  document.getElementById('cons-limpiar').addEventListener('click', limpiarFiltrosConsolidado);

  /* --- Morbilidad --- */
  document.getElementById('morb-anio').addEventListener('change', pintarMorbilidad);
  document.getElementById('morb-mes').addEventListener('change', pintarMorbilidad);
  document.getElementById('morb-tipo').addEventListener('change', pintarMorbilidad);

  /* Escape cierra el modal superior */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const orden = ['modal-cie', 'modal-detalle', 'modal-atencion'];
    for (const id of orden) {
      const $m = document.getElementById(id);
      if (!$m.hidden) { $m.hidden = true; return; }
    }
  });
}

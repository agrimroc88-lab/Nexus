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

import { supabase } from './supabase.js';
import { protegerPagina, puedeVerPsicologia } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar, textoOGuion, retrasar, formatearFecha } from './utils.js';

/* --- Estado --- */
const estado = {
  perfil: null,
  empresaId: null,
  fichas: [],          // fichas de la empresa (v_fichas_psicologicas)
  paciente: null,      // trabajador localizado en la pestaña Fichas
  altaPendiente: null, // { codigo } cuando se va a registrar un trabajador nuevo
  histAbierto: false,
  vista: 'fichas',
  verId: null          // ficha mostrada en el modal de detalle
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
const $empresa  = document.getElementById('empresa-activa');
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
  await cargarEmpresas();
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

async function cargarEmpresas() {
  const { data, error } = await supabase
    .from('empresas')
    .select('id, razon_social')
    .eq('activo', true)
    .order('razon_social');

  if (error) { alert('No fue posible cargar las empresas: ' + error.message); return; }

  (data || []).forEach((e) => {
    const opcion = document.createElement('option');
    opcion.value = e.id;
    opcion.textContent = e.razon_social;
    $empresa.appendChild(opcion);
  });

  const guardada = sessionStorage.getItem('nexus_empresa');
  if (guardada && (data || []).some((e) => e.id === guardada)) {
    $empresa.value = guardada;
    await seleccionarEmpresa();
  }
}

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

function pintarAtenciones() {
  const anio = parseInt(document.getElementById('at-anio').value, 10);
  const $cuerpo = document.getElementById('cuerpo-atenciones');
  const $pie = document.getElementById('pie-atenciones');

  const delAnio = estado.fichas.filter(
    (f) => new Date(f.fecha + 'T00:00').getFullYear() === anio
  );

  document.getElementById('vacio-atenciones').hidden = delAnio.length > 0;
  $cuerpo.innerHTML = '';
  $pie.innerHTML = '';

  if (delAnio.length === 0) return;

  // Acumular por mes
  const filas = {};
  for (let m = 1; m <= 12; m++) {
    filas[m] = { ingreso: 0, periodica: 0, asistencial: 0, seguimiento: 0, M: 0, F: 0, total: 0 };
  }

  delAnio.forEach((f) => {
    const m = new Date(f.fecha + 'T00:00').getMonth() + 1;
    if (filas[m][f.tipo] !== undefined) filas[m][f.tipo]++;
    if (f.sexo === 'M') filas[m].M++;
    if (f.sexo === 'F') filas[m].F++;
    filas[m].total++;
  });

  const tot = { ingreso: 0, periodica: 0, asistencial: 0, seguimiento: 0, M: 0, F: 0, total: 0 };
  const frag = document.createDocumentFragment();

  for (let m = 1; m <= 12; m++) {
    const r = filas[m];
    if (r.total === 0) continue;

    Object.keys(tot).forEach((k) => { tot[k] += r[k]; });

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${MESES[m]}</td>
      <td class="celda-centro">${r.ingreso || ''}</td>
      <td class="celda-centro">${r.periodica || ''}</td>
      <td class="celda-centro">${r.asistencial || ''}</td>
      <td class="celda-centro">${r.seguimiento || ''}</td>
      <td class="celda-centro">${r.M || ''}</td>
      <td class="celda-centro">${r.F || ''}</td>
      <td class="celda-centro"><strong>${r.total}</strong></td>`;
    frag.appendChild(tr);
  }
  $cuerpo.appendChild(frag);

  $pie.innerHTML = `
    <tr class="fila-total">
      <td><strong>Total ${anio}</strong></td>
      <td class="celda-centro"><strong>${tot.ingreso}</strong></td>
      <td class="celda-centro"><strong>${tot.periodica}</strong></td>
      <td class="celda-centro"><strong>${tot.asistencial}</strong></td>
      <td class="celda-centro"><strong>${tot.seguimiento}</strong></td>
      <td class="celda-centro"><strong>${tot.M}</strong></td>
      <td class="celda-centro"><strong>${tot.F}</strong></td>
      <td class="celda-centro"><strong>${tot.total}</strong></td>
    </tr>`;
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
    document.getElementById('fp_antecedentes').value = previa.antecedentes || '';
    document.getElementById('fp_impresion').value = previa.impresion_dx || '';
    document.getElementById('fp_plan').value = previa.plan_intervencion || '';
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
    motivo_consulta: valor('fp_motivo'),
    antecedentes: valor('fp_antecedentes'),
    evaluacion: valor('fp_evaluacion'),
    impresion_dx: valor('fp_impresion'),
    plan_intervencion: valor('fp_plan'),
    proxima_cita: document.getElementById('fp_proxima').value || null,
    estado: document.getElementById('fp_estado').value
  };

  const { error } = await supabase.from('fichas_psicologicas').insert(fila);

  if (error) {
    $alerta.textContent = 'No fue posible guardar: ' + error.message;
    $alerta.hidden = false;
    return;
  }

  document.getElementById('modal-ficha').hidden = true;
  await recargar();
}

function valor(id) {
  const v = document.getElementById(id).value.trim();
  return v === '' ? null : v;
}

function limpiarFormulario() {
  ['fp_motivo', 'fp_antecedentes', 'fp_evaluacion', 'fp_impresion', 'fp_plan',
   'fp_proxima'].forEach((id) => { document.getElementById(id).value = ''; });
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

function verFicha(id) {
  const f = estado.fichas.find((x) => x.id === id);
  if (!f) return;
  estado.verId = id;

  document.getElementById('ver-titulo').textContent =
    `Ficha psicológica · ${formatearFecha(f.fecha)}`;

  document.getElementById('ver-cuerpo').innerHTML = cuerpoFicha(f);
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
    </div>`;
}

function imprimirFicha() {
  const f = estado.fichas.find((x) => x.id === estado.verId);
  if (!f) return;

  const $zona = document.getElementById('zona-impresion');
  $zona.innerHTML = `
    <div class="hoja">
      <div class="membrete">
        <img src="logo.png" class="membrete-logo" alt="">
        <div class="membrete-datos">
          <strong>${escapar(f.empresa || 'AGRIMROC S.A.')}</strong>
          <span>Unidad de Seguridad y Salud Ocupacional</span>
        </div>
      </div>
      <header class="hoja-cabecera">
        <h1>Ficha de Evaluación Psicológica Ocupacional</h1>
        <p>${escapar(f.nombre_completo)} · Código ${f.codigo_trabajador} · Cédula ${escapar(f.cedula)}</p>
        <p>Fecha: ${formatearFecha(f.fecha)} · Tipo: ${TIPOS[f.tipo] || f.tipo} · Modalidad: ${escapar(textoOGuion(f.modalidad))}</p>
      </header>
      ${bloqueImpr('Cargo', textoOGuion(f.cargo))}
      ${bloqueImpr('Motivo de remisión', f.motivo_remision)}
      ${bloqueImpr('Motivo de consulta', f.motivo_consulta)}
      ${bloqueImpr('Antecedentes', f.antecedentes)}
      ${bloqueImpr('Evaluación / observaciones', f.evaluacion)}
      ${bloqueImpr('Impresión diagnóstica', f.impresion_dx)}
      ${bloqueImpr('Plan / intervención', f.plan_intervencion)}
      ${bloqueImpr('Estado del caso', f.estado)}
      ${f.proxima_cita ? bloqueImpr('Próxima cita', formatearFecha(f.proxima_cita)) : ''}
      <div class="hoja-firma">
        <div class="firma-linea"></div>
        <p>${escapar(f.registrado_por || 'Profesional de Psicología')}</p>
      </div>
    </div>`;
  window.print();
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
  ['fichas', 'atenciones'].forEach((v) => {
    document.getElementById('vista-' + v).hidden = v !== vista;
  });
  if (vista === 'atenciones') pintarAtenciones();
  if (vista === 'fichas') document.getElementById('busca_codigo').focus();
}

async function seleccionarEmpresa() {
  estado.empresaId = $empresa.value || null;

  if (!estado.empresaId) {
    sessionStorage.removeItem('nexus_empresa');
    $area.hidden = true;
    $avisoIni.hidden = false;
    return;
  }

  sessionStorage.setItem('nexus_empresa', estado.empresaId);
  $area.hidden = false;
  $avisoIni.hidden = true;

  await recargar();
}

async function recargar() {
  await cargarFichas();
  pintarResumen();

  if (estado.vista === 'atenciones') pintarAtenciones();

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
  $empresa.addEventListener('change', seleccionarEmpresa);

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
  document.getElementById('fp_codigo').addEventListener('input', retrasar(buscarTrabajadorFormulario, 300));

  /* --- Alta de trabajador --- */
  document.getElementById('btn-guardar-alta').addEventListener('click', guardarAlta);

  /* --- Ver / imprimir --- */
  document.getElementById('btn-imprimir').addEventListener('click', imprimirFicha);

  /* --- Atenciones --- */
  document.getElementById('at-anio').addEventListener('change', pintarAtenciones);

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

/* ============================================
   NEXUS · trabajo-social.js
   Módulo de Trabajo Social: ficha socioeconómica + registro de personal.
   Un solo registro guarda ambos documentos (comparten datos).
   Dos botones de impresión: cada documento con su formato y color.
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { protegerPagina, empresasPermitidas, resolverEmpresaActiva } from './auth.js?v=11';
import { montarNavegacion } from './nav.js?v=11';
import { escapar, textoOGuion, retrasar, formatearFecha } from './utils.js?v=11';
import { alCrear } from './autoria.js?v=1';

const ROLES_TS = ['admin', 'trabajo_social', 'psico_social'];

const TIPOS = {
  ingreso: 'Ingreso',
  periodica: 'Periódica',
  asistencial: 'Asistencial',
  seguimiento: 'Seguimiento'
};

const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const estado = {
  perfil: null,
  empresaId: null,
  empresaNombre: '',
  fichas: [],
  manual: [],  // registro manual de atenciones (atenciones_manual_salud)
  manualActual: null,  // { mes, datosMes } del modal abierto
  paciente: null,
  verId: null,
  editandoId: null,  // id de la ficha que se está editando (null = ficha nueva)
  vista: 'ficha'
};

const HOY = () => new Date().toISOString().slice(0, 10);

const $nombreEmpresa = document.getElementById('empresa-activa-nombre');

iniciar();

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  if (!ROLES_TS.includes(perfil.rol)) {
    document.querySelector('.contenido').innerHTML =
      '<p class="aviso-inicial">No tiene permisos para ver este módulo.</p>';
    return;
  }
  estado.perfil = perfil;

  prepararAnios();

  const permitidas = await empresasPermitidas(perfil);
  if (permitidas.length === 0) {
    document.querySelector('.contenido').innerHTML =
      '<p class="aviso-inicial">No tienes ninguna empresa asignada. Contacta al administrador.</p>';
    return;
  }
  const empresa = resolverEmpresaActiva(permitidas);
  if (!empresa) return; // está redirigiendo a seleccionar-empresa.html

  if ($nombreEmpresa) $nombreEmpresa.textContent = empresa.razon_social;

  await alCambiarEmpresa(empresa);
  conectarEventos();

  try { montarNavegacion(perfil, 'trabajo_social'); } catch (e) { console.warn('nav:', e); }
}

async function cargarFichas() {
  const { data, error } = await supabase
    .from('v_fichas_sociales').select('*')
    .eq('empresa_id', estado.empresaId)
    .order('creado_en', { ascending: false });
  estado.fichas = error ? [] : (data || []);
}

/** Registro manual: como las fichas de trabajo social no se
    clasifican por tipo, esta es la única fuente de la tabla de
    la pestaña "Atenciones" — mismo patrón que ya usa "Atenciones
    ocupacionales" en Salud Ocupacional (mes + tipo, editable). */
async function cargarManual() {
  const { data, error } = await supabase
    .from('atenciones_manual_salud')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('modulo', 'trabajo_social');

  if (error) {
    console.warn('NEXUS · falta ejecutar sql_atenciones_manual_salud_v2.sql', error.message);
    estado.manual = [];
    return;
  }
  estado.manual = data || [];
}

function prepararAnios() {
  const actual = new Date().getFullYear();
  const $sel = document.getElementById('at-anio');
  if (!$sel) return;
  for (let a = actual; a >= actual - 4; a--) {
    const o = document.createElement('option');
    o.value = a; o.textContent = a;
    $sel.appendChild(o);
  }
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  document.querySelectorAll('.pestana').forEach((p) =>
    p.addEventListener('click', () => cambiarVista(p.dataset.vista)));

  document.querySelectorAll('[data-cierra]').forEach((b) =>
    b.addEventListener('click', () => document.getElementById(b.dataset.cierra).hidden = true));

  document.getElementById('btn-buscar').addEventListener('click', buscarPaciente);
  document.getElementById('busca_codigo').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') buscarPaciente();
  });
  document.getElementById('busca_nombre').addEventListener('input', retrasar(buscarPorNombre, 200));
  document.getElementById('btn-nueva-ficha').addEventListener('click', abrirFichaNueva);
  document.getElementById('btn-historial').addEventListener('click', alternarHistorial);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#busca_nombre') && !e.target.closest('#busca_sugerencias')) {
      document.getElementById('busca_sugerencias').hidden = true;
    }
  });

  document.getElementById('guardar-ficha').addEventListener('click', guardarFicha);
  document.getElementById('btn-guardar-imprimir').addEventListener('click', guardarEImprimir);
  document.getElementById('op-social').addEventListener('click', () => {
    document.getElementById('modal-elegir-doc').hidden = true;
    imprimirDocumento('social');
  });
  document.getElementById('op-registro').addEventListener('click', () => {
    document.getElementById('modal-elegir-doc').hidden = true;
    imprimirDocumento('registro');
  });
  document.getElementById('btn-add-familiar').addEventListener('click', () => agregarFilaFamiliar());
  document.getElementById('btn-add-discapacidad')?.addEventListener('click', () => agregarFilaDiscapacidad());
  document.getElementById('btn-imprimir-social').addEventListener('click', () => imprimirDocumento('social'));
  document.getElementById('btn-imprimir-registro').addEventListener('click', () => imprimirDocumento('registro'));
  document.getElementById('btn-editar-ficha')?.addEventListener('click', editarFicha);
  document.getElementById('btn-eliminar-ficha')?.addEventListener('click', async () => {
    await eliminarFicha(estado.verId);
    document.getElementById('modal-ver').hidden = true;
  });
  document.getElementById('ts_parentesco_opciones')
    ?.addEventListener('change', sincronizarParentescoCargas);

  document.getElementById('at-anio')?.addEventListener('change', pintarAtenciones);
  document.getElementById('btn-guardar-manual')?.addEventListener('click', guardarManual);
}

async function alCambiarEmpresa(empresa) {
  estado.empresaId = empresa.id;
  estado.empresaNombre = empresa.razon_social;
  document.getElementById('pestanas').hidden = false;
  document.getElementById('vista-ficha').hidden = false;
  await Promise.all([cargarFichas(), cargarManual()]);
  cambiarVista('ficha');
}

function cambiarVista(v) {
  estado.vista = v;
  document.querySelectorAll('.pestana').forEach((p) => p.classList.toggle('activa', p.dataset.vista === v));
  document.getElementById('vista-ficha').hidden = v !== 'ficha';
  document.getElementById('vista-registros').hidden = v !== 'registros';
  document.getElementById('vista-atenciones').hidden = v !== 'atenciones';
  if (v === 'registros') pintarRegistros();
  if (v === 'atenciones') pintarAtenciones();
}

/* ============================================
   Buscar trabajador (igual que psicología)
   ============================================ */

async function buscarPaciente() {
  const codigo = parseInt(document.getElementById('busca_codigo').value, 10);
  const $ayuda = document.getElementById('ayuda-busca');
  if (!codigo) { $ayuda.textContent = 'Escriba un código.'; return; }

  const { data } = await supabase
    .from('v_trabajadores').select('*')
    .eq('empresa_id', estado.empresaId).eq('codigo', codigo).maybeSingle();

  if (!data) { $ayuda.textContent = 'No existe un trabajador con ese código.'; ocultarPaciente(); return; }
  $ayuda.textContent = '';
  mostrarPaciente(data);
}

async function buscarPorNombre() {
  const texto = document.getElementById('busca_nombre').value.trim();
  const $cont = document.getElementById('busca_sugerencias');
  if (texto.length < 2) { $cont.hidden = true; return; }

  const { data } = await supabase
    .from('v_trabajadores').select('id, codigo, nombre_completo, cedula')
    .eq('empresa_id', estado.empresaId)
    .or(`nombres.ilike.%${texto}%,apellidos.ilike.%${texto}%,cedula.ilike.%${texto}%`)
    .limit(8);

  if (!data || data.length === 0) { $cont.hidden = true; return; }
  $cont.innerHTML = '';
  data.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'sugerencia'; b.type = 'button';
    b.dataset.codigo = t.codigo;
    b.innerHTML = `<span class="cie-chip">${t.codigo}</span> ${escapar(t.nombre_completo)} · ${escapar(t.cedula || '')}`;
    b.addEventListener('click', () => {
      document.getElementById('busca_codigo').value = b.dataset.codigo;
      document.getElementById('busca_nombre').value = '';
      $cont.hidden = true;
      buscarPaciente();
    });
    $cont.appendChild(b);
  });
  $cont.hidden = false;
}

function ocultarPaciente() {
  document.getElementById('paciente').hidden = true;
  estado.paciente = null;
}

function mostrarPaciente(t) {
  estado.paciente = t;
  document.getElementById('paciente').hidden = false;
  document.getElementById('aviso-ficha').hidden = true;
  document.getElementById('p-nombre').textContent = t.nombre_completo;
  document.getElementById('p-meta').textContent =
    `Código ${t.codigo} · Cédula ${t.cedula || '—'} · ${t.edad != null ? t.edad + ' años' : ''} · ${textoOGuion(t.cargo)}`;
  document.getElementById('p-historial').hidden = true;
}

function alternarHistorial() {
  const $h = document.getElementById('p-historial');
  $h.hidden = !$h.hidden;
  if (!$h.hidden) pintarHistorial();
}

function pintarHistorial() {
  const $lista = document.getElementById('p-lista');
  const propias = estado.fichas.filter((f) => f.trabajador_id === estado.paciente.id);
  if (propias.length === 0) { $lista.innerHTML = '<p class="ayuda">Sin fichas previas.</p>'; return; }
  $lista.innerHTML = '';
  propias.forEach((f) => {
    const div = document.createElement('div');
    div.className = 'evento-item';
    div.innerHTML = `<span class="evento-dia">${formatearFecha(f.fecha)}</span>
      <button class="boton-secundario boton-compacto" type="button">Ver / imprimir</button>`;
    div.querySelector('button').addEventListener('click', () => verFicha(f.id));
    $lista.appendChild(div);
  });
}

function abrirFichaNueva() {
  if (!estado.paciente) return;
  estado.editandoId = null;
  limpiarFormulario();
  document.getElementById('ts_codigo').value = estado.paciente.codigo;
  document.getElementById('ts_fecha').value = HOY();
  mostrarFichaTrabajador(estado.paciente);
  document.getElementById('titulo-modal').textContent = 'Ficha de Trabajo Social · ' + estado.paciente.nombre_completo;
  document.getElementById('modal-ficha').hidden = false;
}

function mostrarFichaTrabajador(t) {
  document.getElementById('ts-ficha').hidden = false;
  document.getElementById('ts-bloque').hidden = false;
  document.getElementById('tf-nombre').textContent = t.nombre_completo;
  document.getElementById('tf-cedula').textContent = t.cedula;
  document.getElementById('tf-edad').textContent = t.edad != null ? `${t.edad} años` : '—';
  document.getElementById('tf-sexo').textContent = t.sexo === 'M' ? 'Masculino' : t.sexo === 'F' ? 'Femenino' : '—';
  document.getElementById('tf-cargo').textContent = textoOGuion(t.cargo);

  const setSiVacio = (id, val) => { const el = document.getElementById(id); if (el && !el.value && val) el.value = val; };
  setSiVacio('ts_nacionalidad', 'Ecuatoriano');
  if (t.correo) setSiVacio('ts_correo', t.correo);
  if (t.tipo_sangre) setSiVacio('ts_disc_sangre', t.tipo_sangre);
}

/* ============================================
   Familiares (tabla dinámica)
   ============================================ */

function agregarFilaFamiliar(f) {
  f = f || {};
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="fam-nombre" value="${f.nombre ? escapar(f.nombre) : ''}"></td>
    <td><input type="text" class="fam-parentesco" value="${f.parentesco ? escapar(f.parentesco) : ''}"></td>
    <td><select class="fam-sexo"><option value=""></option><option ${f.sexo==='H'?'selected':''}>H</option><option ${f.sexo==='M'?'selected':''}>M</option></select></td>
    <td><input type="text" class="fam-edad" value="${f.edad ? escapar(f.edad) : ''}" style="width:40px"></td>
    <td><select class="fam-estudia"><option value=""></option><option ${f.estudia==='Sí'?'selected':''}>Sí</option><option ${f.estudia==='No'?'selected':''}>No</option></select></td>
    <td><input type="text" class="fam-nivel" value="${f.nivel ? escapar(f.nivel) : ''}"></td>
    <td><input type="text" class="fam-grado" value="${f.grado ? escapar(f.grado) : ''}"></td>
    <td><select class="fam-trabaja"><option value=""></option><option ${f.trabaja==='Sí'?'selected':''}>Sí</option><option ${f.trabaja==='No'?'selected':''}>No</option></select></td>
    <td><button type="button" class="boton-icono-critico fam-quitar">×</button></td>`;
  tr.querySelector('.fam-quitar').addEventListener('click', () => tr.remove());
  document.getElementById('cuerpo-familiares').appendChild(tr);
}

function leerFamiliares() {
  const filas = [];
  document.querySelectorAll('#cuerpo-familiares tr').forEach((tr) => {
    const nombre = tr.querySelector('.fam-nombre').value.trim();
    if (!nombre) return;
    filas.push({
      nombre,
      parentesco: tr.querySelector('.fam-parentesco').value.trim(),
      sexo: tr.querySelector('.fam-sexo').value,
      edad: tr.querySelector('.fam-edad').value.trim(),
      estudia: tr.querySelector('.fam-estudia').value,
      nivel: tr.querySelector('.fam-nivel').value.trim(),
      grado: tr.querySelector('.fam-grado').value.trim(),
      trabaja: tr.querySelector('.fam-trabaja').value
    });
  });
  return filas;
}

/** Igual que los familiares en general, pero para el bloque de
    "familiares con discapacidad" —se puede agregar más de uno,
    en vez del campo único de antes. */
function agregarFilaDiscapacidad(d) {
  d = d || {};
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="disc-familiar" value="${d.familiar ? escapar(d.familiar) : ''}"></td>
    <td><input type="text" class="disc-codigo" value="${d.codigo ? escapar(d.codigo) : ''}" style="width:70px"></td>
    <td><input type="text" class="disc-tipo" value="${d.tipo ? escapar(d.tipo) : ''}"></td>
    <td><input type="text" class="disc-porcentaje" value="${d.porcentaje ? escapar(d.porcentaje) : ''}" style="width:60px"></td>
    <td><input type="text" class="disc-telefono" value="${d.telefono ? escapar(d.telefono) : ''}"></td>
    <td><input type="text" class="disc-convencional" value="${d.convencional ? escapar(d.convencional) : ''}"></td>
    <td><button type="button" class="boton-icono-critico disc-quitar">×</button></td>`;
  tr.querySelector('.disc-quitar').addEventListener('click', () => tr.remove());
  document.getElementById('cuerpo-discapacidades').appendChild(tr);
}

function leerDiscapacidades() {
  const filas = [];
  document.querySelectorAll('#cuerpo-discapacidades tr').forEach((tr) => {
    const familiar = tr.querySelector('.disc-familiar').value.trim();
    if (!familiar) return;
    filas.push({
      familiar,
      codigo: tr.querySelector('.disc-codigo').value.trim(),
      tipo: tr.querySelector('.disc-tipo').value.trim(),
      porcentaje: tr.querySelector('.disc-porcentaje').value.trim(),
      telefono: tr.querySelector('.disc-telefono').value.trim(),
      convencional: tr.querySelector('.disc-convencional').value.trim()
    });
  });
  return filas;
}

/* ============================================
   Guardar
   ============================================ */

function valor(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const v = el.value.trim();
  return v === '' ? null : v;
}

/** Lee el radio marcado de un grupo (ej. "ts_cargas": Sí/No). */
function valorRadio(nombre) {
  const el = document.querySelector(`input[name="${nombre}"]:checked`);
  return el ? el.value : null;
}

/** Las casillas de parentesco de cargas familiares se guardan
    como texto separado por comas —mismo campo de siempre
    (rp_parentesco_cargas)—, solo que ahora se arma solo. */
function sincronizarParentescoCargas() {
  const marcados = [...document.querySelectorAll('#ts_parentesco_opciones input:checked')]
    .map((c) => c.value);
  document.getElementById('ts_parentesco_cargas').value = marcados.join(', ');
}

/* Mismo orden de campos que usa guardarFicha() —se reutiliza
   para precargar el formulario al editar una ficha existente. */
const MAPA_CAMPOS_FICHA_TS = [
  ['ts_nacionalidad', 'nacionalidad'], ['ts_lugar_nac', 'lugar_nacimiento'],
  ['ts_estado_civil', 'estado_civil'], ['ts_experiencia', 'experiencia'],
  ['ts_correo', 'correo'], ['ts_domicilio', 'domicilio'],
  ['ts_instruccion', 'nivel_instruccion'], ['ts_titulo', 'titulo_obtenido'],
  ['ts_etnico', 'grupo_etnico'], ['ts_religion', 'religion'],
  ['ts_estatura', 'estatura'], ['ts_provincia', 'provincia'],
  ['ts_canton', 'canton'], ['ts_parroquia', 'parroquia'],
  ['ts_convencional', 'telefono_convencional'],
  ['ts_disc_sangre', 'disc_tipo_sanguineo'],
  ['ts_resp_nombre', 'resp_nombre'], ['ts_resp_parentesco', 'resp_parentesco'],
  ['ts_resp_telefono', 'resp_telefono'], ['ts_resp_lugar', 'resp_lugar'],
  ['ts_mapa_nombre', 'mapa_nombre'], ['ts_mapa_parentesco', 'mapa_parentesco'],
  ['ts_mapa_telefono2', 'mapa_telefono2'], ['ts_mapa_lugar', 'mapa_lugar'],
  ['ts_mapa_descripcion', 'mapa_descripcion'], ['ts_mapa_sitios', 'mapa_sitios'],
  ['ts_dom_descripcion', 'domicilio_descripcion'], ['ts_dom_referencias', 'domicilio_referencias'],
  ['ts_viv_tenencia', 'vivienda_tenencia'], ['ts_viv_construccion', 'vivienda_construccion'],
  ['ts_viv_obs', 'vivienda_observaciones'],
  ['ts_ingreso', 'ingreso_mensual'], ['ts_otros_ingresos', 'otros_ingresos'],
  ['ts_movilizacion', 'movilizacion'], ['ts_observacion', 'observacion'],
  ['ts_fam1_nombre', 'rp_familiar1_nombre'], ['ts_fam1_conv', 'rp_familiar1_convencional'],
  ['ts_fam1_cel', 'rp_familiar1_celular'],
  ['ts_fam2_nombre', 'rp_familiar2_nombre'], ['ts_fam2_conv', 'rp_familiar2_convencional'],
  ['ts_fam2_cel', 'rp_familiar2_celular'],
  ['ts_contacto_nombre', 'rp_contacto_nombre'], ['ts_contacto_correo', 'rp_contacto_correo'],
  ['ts_contacto_cel', 'rp_contacto_celular'],
  ['ts_num_cargas', 'rp_num_cargas'],
  ['ts_parentesco_cargas', 'rp_parentesco_cargas'], ['ts_sueldo', 'rp_sueldo'],
  ['ts_exp_empresa', 'rp_exp_empresa'], ['ts_exp_cargo', 'rp_exp_cargo']
];

/** Reabrir una ficha ya guardada para corregirla. */
async function editarFicha() {
  const f = estado.fichas.find((x) => x.id === estado.verId);
  if (!f) return;

  estado.editandoId = f.id;
  limpiarFormulario();

  document.getElementById('titulo-modal').textContent = 'Editar ficha · ' + f.nombre_completo;
  document.getElementById('ts_codigo').value = f.codigo_trabajador ?? '';
  document.getElementById('ts_fecha').value = f.fecha ?? '';
  document.getElementById('ts_fecha_salida').value = f.rp_fecha_salida ?? '';

  MAPA_CAMPOS_FICHA_TS.forEach(([id, col]) => {
    const el = document.getElementById(id);
    if (el && f[col] != null) el.value = f[col];
  });

  document.getElementById('ts_viv_luz').checked = !!f.vivienda_luz;
  document.getElementById('ts_viv_agua').checked = !!f.vivienda_agua;
  document.getElementById('ts_viv_alcantarillado').checked = !!f.vivienda_alcantarillado;

  const radioCargas = document.querySelector(`input[name="ts_cargas"][value="${f.rp_cargas_familiares}"]`);
  if (radioCargas) radioCargas.checked = true;

  const parentescosGuardados = (f.rp_parentesco_cargas || '').split(',').map((s) => s.trim());
  document.querySelectorAll('#ts_parentesco_opciones input').forEach((c) => {
    c.checked = parentescosGuardados.includes(c.value);
  });
  sincronizarParentescoCargas();

  document.getElementById('cuerpo-discapacidades').innerHTML = '';
  (Array.isArray(f.discapacidades) ? f.discapacidades : []).forEach((d) => agregarFilaDiscapacidad(d));

  document.getElementById('cuerpo-familiares').innerHTML = '';
  (Array.isArray(f.familiares) ? f.familiares : []).forEach((fam) => agregarFilaFamiliar(fam));

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

async function guardarFicha() {
  const $alerta = document.getElementById('alerta-ficha');
  if (!estado.paciente) { $alerta.textContent = 'Primero busque un trabajador.'; $alerta.hidden = false; return; }

  const fila = {
    empresa_id: estado.empresaId,
    trabajador_id: estado.paciente.id,
    fecha: document.getElementById('ts_fecha').value || HOY(),
    nacionalidad: valor('ts_nacionalidad'),
    lugar_nacimiento: valor('ts_lugar_nac'),
    estado_civil: valor('ts_estado_civil'),
    experiencia: valor('ts_experiencia'),
    correo: valor('ts_correo'),
    domicilio: valor('ts_domicilio'),
    nivel_instruccion: valor('ts_instruccion'),
    titulo_obtenido: valor('ts_titulo'),
    grupo_etnico: valor('ts_etnico'),
    religion: valor('ts_religion'),
    estatura: valor('ts_estatura'),
    provincia: valor('ts_provincia'),
    canton: valor('ts_canton'),
    parroquia: valor('ts_parroquia'),
    telefono_convencional: valor('ts_convencional'),
    discapacidades: leerDiscapacidades(),
    disc_tipo_sanguineo: valor('ts_disc_sangre'),
    resp_nombre: valor('ts_resp_nombre'),
    resp_parentesco: valor('ts_resp_parentesco'),
    resp_telefono: valor('ts_resp_telefono'),
    resp_lugar: valor('ts_resp_lugar'),
    mapa_nombre: valor('ts_mapa_nombre'),
    mapa_parentesco: valor('ts_mapa_parentesco'),
    mapa_telefono2: valor('ts_mapa_telefono2'),
    mapa_lugar: valor('ts_mapa_lugar'),
    mapa_descripcion: valor('ts_mapa_descripcion'),
    mapa_sitios: valor('ts_mapa_sitios'),
    domicilio_descripcion: valor('ts_dom_descripcion'),
    domicilio_referencias: valor('ts_dom_referencias'),
    familiares: leerFamiliares(),
    vivienda_tenencia: valor('ts_viv_tenencia'),
    vivienda_construccion: valor('ts_viv_construccion'),
    vivienda_luz: document.getElementById('ts_viv_luz').checked,
    vivienda_agua: document.getElementById('ts_viv_agua').checked,
    vivienda_alcantarillado: document.getElementById('ts_viv_alcantarillado').checked,
    vivienda_observaciones: valor('ts_viv_obs'),
    ingreso_mensual: valor('ts_ingreso'),
    otros_ingresos: valor('ts_otros_ingresos'),
    movilizacion: valor('ts_movilizacion'),
    observacion: valor('ts_observacion'),
    rp_familiar1_nombre: valor('ts_fam1_nombre'),
    rp_familiar1_convencional: valor('ts_fam1_conv'),
    rp_familiar1_celular: valor('ts_fam1_cel'),
    rp_familiar2_nombre: valor('ts_fam2_nombre'),
    rp_familiar2_convencional: valor('ts_fam2_conv'),
    rp_familiar2_celular: valor('ts_fam2_cel'),
    rp_contacto_nombre: valor('ts_contacto_nombre'),
    rp_contacto_correo: valor('ts_contacto_correo'),
    rp_contacto_celular: valor('ts_contacto_cel'),
    rp_cargas_familiares: valorRadio('ts_cargas'),
    rp_num_cargas: valor('ts_num_cargas'),
    rp_parentesco_cargas: valor('ts_parentesco_cargas'),
    rp_sueldo: valor('ts_sueldo'),
    rp_fecha_salida: document.getElementById('ts_fecha_salida').value || null,
    rp_exp_empresa: valor('ts_exp_empresa'),
    rp_exp_cargo: valor('ts_exp_cargo'),
    registrado_por: nombreTS()
  };

  const editando = estado.editandoId;
  const { data: creada, error } = editando
    ? await supabase.from('fichas_sociales').update(fila).eq('id', editando).select('id').single()
    : await supabase.from('fichas_sociales').insert(fila).select('id').single();

  if (error) {
    $alerta.textContent = 'No fue posible guardar: ' + error.message;
    $alerta.hidden = false;
    return null;
  }
  estado.editandoId = null;
  document.getElementById('modal-ficha').hidden = true;
  await cargarFichas();
  cambiarVista('registros');
  return creada ? creada.id : null;
}

/* Guarda y luego pregunta qué documento imprimir */
async function guardarEImprimir() {
  const id = await guardarFicha();
  if (!id) return;
  estado.verId = id;
  document.getElementById('modal-elegir-doc').hidden = false;
}

function nombreTS() {
  const p = estado.perfil || {};
  const nombre = [p.nombres, p.apellidos].filter(Boolean).join(' ').trim();
  if (!nombre) return 'Trabajador/a Social';
  return p.registro_msp ? `${nombre} · Reg. ${p.registro_msp}` : nombre;
}

function limpiarFormulario() {
  document.querySelectorAll('#ts-bloque input, #ts-bloque textarea, #ts-bloque select').forEach((el) => {
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = false; else el.value = '';
  });
  document.getElementById('cuerpo-familiares').innerHTML = '';
  document.getElementById('cuerpo-discapacidades').innerHTML = '';
  document.getElementById('alerta-ficha').hidden = true;
}

/* ============================================
   Atenciones (registro manual)

   Las fichas de trabajo social no se clasifican por tipo, así
   que esta tabla se alimenta únicamente del registro manual —
   es la forma de dejar constancia de "atendí a alguien" sin
   necesidad de armar la ficha socioeconómica completa cada vez.
   ============================================ */

const COLORES_TIPO = {
  ingreso:     '#1b5e20',
  periodica:   '#2e86c1',
  asistencial: '#e07b39',
  seguimiento: '#7d3c98'
};

/** Mismo gráfico que ya usa Psicología —aquí solo con el
    registro manual, ya que las fichas de trabajo social no
    llevan tipo. */
function pintarTendenciaAtenciones(manualDelAnio) {
  const $g = document.getElementById('at-grafico');
  const $l = document.getElementById('at-leyenda');
  if (!$g) return;

  const ids = ['ingreso', 'periodica', 'asistencial', 'seguimiento'];
  const porTipo = {};
  ids.forEach((id) => { porTipo[id] = new Array(12).fill(0); });

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
    $g.innerHTML = '<p class="grafico-vacio">Sin registros en el año seleccionado</p>';
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

  const manualDelAnio = estado.manual.filter((m) => m.anio === anio);

  pintarTendenciaAtenciones(manualDelAnio);

  $cuerpo.innerHTML = '';
  $pie.innerHTML = '';

  const IDS = ['ingreso', 'periodica', 'asistencial', 'seguimiento'];

  const filas = {};
  for (let m = 1; m <= 12; m++) {
    filas[m] = {};
    IDS.forEach((id) => { filas[m][id] = { h: 0, m: 0 }; });
  }

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
    modulo: 'trabajo_social',
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
   Registros (listado)
   ============================================ */

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
      `<td class="celda-derecha"></td>`;
    const acc = tr.querySelector('td:last-child');
    const ver = document.createElement('button');
    ver.className = 'boton-icono'; ver.textContent = 'Ver / imprimir';
    ver.addEventListener('click', () => verFicha(f.id));
    acc.appendChild(ver);
    if (estado.perfil.rol === 'admin') {
      const el = document.createElement('button');
      el.className = 'boton-icono'; el.textContent = 'Eliminar';
      el.addEventListener('click', () => eliminarFicha(f.id));
      acc.appendChild(el);
    }
    $cuerpo.appendChild(tr);
  });
}

async function eliminarFicha(id) {
  if (!confirm('¿Eliminar esta ficha? Esta acción no se puede deshacer.')) return;
  await supabase.from('fichas_sociales').delete().eq('id', id);
  await cargarFichas();
  pintarRegistros();
}

function verFicha(id) {
  estado.verId = id;
  const f = estado.fichas.find((x) => x.id === id);
  if (!f) return;
  document.getElementById('ver-titulo').textContent = 'Ficha · ' + f.nombre_completo;
  document.getElementById('ver-cuerpo').innerHTML = `
    <div class="ver-datos">
      <div><span class="ver-etiqueta">Trabajador</span> ${escapar(f.nombre_completo)}</div>
      <div><span class="ver-etiqueta">Cédula</span> ${escapar(f.cedula || '')}</div>
      <div><span class="ver-etiqueta">Fecha</span> ${formatearFecha(f.fecha)}</div>
      <div><span class="ver-etiqueta">Registró</span> ${escapar(f.registrado_por || '—')}</div>
    </div>
    <p class="ayuda">Use los botones de abajo para imprimir cada documento con su formato.</p>`;
  document.getElementById('modal-ver').hidden = false;
}

/* ============================================
   Impresión de los dos documentos
   ============================================ */

function imprimirDocumento(cual) {
  const f = estado.fichas.find((x) => x.id === estado.verId);
  if (!f) return;
  const $zona = document.getElementById('zona-impresion');
  $zona.innerHTML = cual === 'social' ? htmlFichaSocial(f) : htmlRegistroPersonal(f);
  window.print();
}

const V = (x) => escapar(x != null && x !== '' ? String(x) : '');
const SN = (b) => b ? 'Sí' : 'No';

/** 'X' si el valor coincide con lo esperado (para las casillas
    de las tablas impresas: Propia/Arriendo, H/M, Sí/No…). */
const MARCA = (valor, esperado) =>
  (valor != null && String(valor).trim().toLowerCase() === esperado.toLowerCase()) ? 'X' : '';

function htmlFichaSocial(f) {
  const fams = Array.isArray(f.familiares) ? f.familiares : [];
  const filasFam = fams.length ? fams.map((x) => `
    <tr>
      <td>${V(x.nombre)}</td><td>${V(x.parentesco)}</td>
      <td class="doc-centro">${MARCA(x.sexo, 'H')}</td><td class="doc-centro">${MARCA(x.sexo, 'M')}</td>
      <td class="doc-centro">${V(x.edad)}</td>
      <td class="doc-centro">${MARCA(x.estudia, 'Sí')}</td><td class="doc-centro">${MARCA(x.estudia, 'No')}</td>
      <td>${V(x.nivel)}</td><td>${V(x.grado)}</td>
      <td class="doc-centro">${MARCA(x.trabaja, 'Sí')}</td><td class="doc-centro">${MARCA(x.trabaja, 'No')}</td>
    </tr>`).join('') : '<tr><td colspan="11">Sin datos familiares</td></tr>';

  /* El Excel solo tiene espacio fijo para UN familiar con
     discapacidad (es un formulario en papel). El sistema sí
     permite registrar varios [agregarFilaDiscapacidad()]: el
     primero ocupa la fila exacta del Excel, y si hay más se
     agregan debajo para no perder información que sí se
     capturó. El tipo sanguíneo es un campo propio del
     trabajador (f.disc_tipo_sanguineo), no de cada discapacidad. */
  const discs = Array.isArray(f.discapacidades) ? f.discapacidades : [];
  const disc = discs[0] || {};
  const discsExtra = discs.slice(1);
  const filasDiscExtra = discsExtra.length ? `
    <table class="doc-tabla doc-tabla-chica" style="margin-top:0.1rem;">
      <tr><td class="doc-lbl">Familiar con Discapacidad</td><td class="doc-lbl">Código</td><td class="doc-lbl">Tipo de Discapacidad</td><td class="doc-lbl">Porcentaje</td><td class="doc-lbl">Teléfono</td><td class="doc-lbl">Convencional</td></tr>
      ${discsExtra.map((d) => `<tr><td>${V(d.familiar)}</td><td class="doc-centro">${V(d.codigo)}</td><td>${V(d.tipo)}</td><td class="doc-centro">${V(d.porcentaje)}</td><td>${V(d.telefono)}</td><td>${V(d.convencional)}</td></tr>`).join('')}
    </table>` : '';

  /* Cuadrícula de 30 columnas (A a AD del Excel real), con los
     mismos anchos relativos: A/AB/AD son columnas angostas
     (2.7 / 3.7 / 2.7), el resto comparten el ancho por defecto
     (11.42). Reproducirla como <colgroup> es lo que permite que
     el bloque de la izquierda (Grupo Étnico, Religión, Familiar
     con Discapacidad) y el bloque de la derecha (la caja de
     discapacidad) queden exactamente en paralelo, como en el
     original, en vez de uno debajo del otro. */
  const anchoAngosto = 0.85, anchoNormal = 3.6, anchoAB = 1.17;
  const anchos = [anchoAngosto, ...Array(26).fill(anchoNormal), anchoAB, anchoNormal, anchoAngosto];
  const colgroup = `<colgroup>${anchos.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>`;

  return `
  <div class="doc-hoja doc-social">
    <div class="doc-encabezado">
      <div class="doc-titulo-empresa">
        <strong>AGRIMROC S.A</strong>
        <span>Departamento de Trabajo Social</span>
      </div>
    </div>

    <div class="doc-social-banda"></div>
    <div class="doc-seccion-h"><h1 style="display:inline;font-size:12pt;">FICHA SOCIAL</h1></div>
    <div class="doc-seccion-h">Datos de Identificación del Trabajador</div>
    <div class="doc-social-banda"></div>

    <table class="doc-social-grid">
      ${colgroup}
      <tr>
        <td class="et" colspan="6">APELLIDOS Y NOMBRES</td><td colspan="11"></td>
        <td class="et et-centro" colspan="6">Nacionalidad:</td><td colspan="1"></td>
        <td class="et et-centro" colspan="6">Cedula de Ident N/.</td>
      </tr>
      <tr>
        <td class="va" colspan="16">${V(f.nombre_completo)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="6">${V(f.nacionalidad)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="6">${V(f.cedula)}</td>
      </tr>
      <tr>
        <td class="et" colspan="6">Lugar de Nacimiento:</td><td colspan="1"></td>
        <td class="et et-centro" colspan="4">F/Nacimiento:</td><td colspan="1"></td>
        <td class="et et-centro" colspan="4">Estado Civil:</td><td colspan="1"></td>
        <td class="et et-centro" colspan="6">EXPERIENCIA</td><td colspan="1"></td>
        <td class="et et-centro" colspan="6">FECHA DE INGRESO</td>
      </tr>
      <tr>
        <td class="va" colspan="6">${V(f.lugar_nacimiento)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="4">${f.fecha_nacimiento ? formatearFecha(f.fecha_nacimiento) : ''}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="4">${V(f.estado_civil)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="6">${V(f.experiencia)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="6">${f.fecha_ingreso ? formatearFecha(f.fecha_ingreso) : ''}</td>
      </tr>
      <tr>
        <td class="et" colspan="6">Correo Electronico</td><td colspan="16"></td>
        <td class="et et-centro" colspan="3">Edad:</td><td colspan="1"></td>
        <td class="et et-centro" colspan="4">Sexo:</td>
      </tr>
      <tr>
        <td class="va" colspan="21">${V(f.correo)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="3">${f.edad != null ? f.edad : ''}</td><td colspan="1"></td>
        <td class="et et-centro" colspan="1">M</td><td class="va" colspan="1"></td>
        <td class="et et-centro" colspan="1">F</td><td class="va" colspan="1"></td>
      </tr>
      <tr>
        <td class="et" colspan="16">Domicilio Actual en:</td><td colspan="14"></td>
      </tr>
      <tr>
        <td class="va" colspan="30">${V(f.domicilio)}</td>
      </tr>
      <tr>
        <td class="et" colspan="8">Nivel de Instrucción:</td><td colspan="1"></td>
        <td class="et et-centro" colspan="12">Titulo o Grado Superior Obtenido:</td><td colspan="1"></td>
        <td class="et et-centro" colspan="8">Puesto de Trabajo:</td>
      </tr>
      <tr>
        <td class="va" colspan="8">${V(f.nivel_instruccion)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="12">${V(f.titulo_obtenido)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="8">${V(f.cargo)}</td>
      </tr>
      <tr>
        <td class="et" colspan="8">Grupo Etnico:</td><td colspan="22"></td>
      </tr>
      <tr>
        <td class="va" colspan="8">${V(f.grupo_etnico)}</td><td colspan="1"></td>
        <td class="doc-social-caja-gris" colspan="21">DATOS DE FAMILIARES CON DISCAPACIDAD</td>
      </tr>
      <tr>
        <td class="et" colspan="8">Religion:</td><td colspan="1"></td>
        <td class="et et-centro" colspan="4">CODIGO</td><td colspan="1"></td>
        <td class="et et-centro" colspan="11">Tipo de Discapacidad:</td><td colspan="1"></td>
        <td class="et et-centro" colspan="4">Porcentaje:</td>
      </tr>
      <tr>
        <td class="va" colspan="8">${V(f.religion)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="4">${V(disc.codigo)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="11">${V(disc.tipo)}</td><td colspan="1"></td>
        <td class="va va-centro" colspan="4">${V(disc.porcentaje)}</td>
      </tr>
      <tr>
        <td class="et" colspan="4">FAMILIAR CON DISCAPACIDAD</td><td colspan="5"></td>
        <td class="et" colspan="4">Telefono:</td><td colspan="5"></td>
        <td class="et" colspan="4">Convencional</td><td colspan="4"></td>
        <td class="et et-centro" colspan="4">Tipo Sanguineo</td>
      </tr>
      <tr>
        <td class="va" colspan="6">${V(disc.familiar)}</td><td colspan="3"></td>
        <td class="va" colspan="6">${V(disc.telefono)}</td><td colspan="3"></td>
        <td class="va" colspan="6">${V(disc.convencional)}</td><td colspan="2"></td>
        <td class="va va-centro" colspan="4">${V(f.disc_tipo_sanguineo)}</td>
      </tr>
    </table>
    ${filasDiscExtra}

    <div class="doc-social-banda"></div>
    <div class="doc-seccion-h">Mapa de Ubicación de Domicilio</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Nombre del Familiar</td><td>${V(f.mapa_nombre)}</td><td class="doc-lbl">Patentezco</td><td>${V(f.mapa_parentesco)}</td><td class="doc-lbl">Telefono 2</td><td>${V(f.mapa_telefono2)}</td></tr>
    </table>
    <div class="doc-campo-largo"><strong>Lugar de Domicilio / Vivienda:</strong><p>${V(f.mapa_lugar)}</p></div>
    <div class="doc-campo-largo"><strong>Descripcion de Domicilio / Vivienda:</strong><p>${V(f.mapa_descripcion)}</p></div>
    <div class="doc-campo-largo"><strong>Sitios de Refenrencia de Domicilio / Vivienda:</strong><p>${V(f.mapa_sitios)}</p></div>

    <div class="doc-social-banda"></div>
    <table class="doc-tabla" style="margin-top:0.3rem;">
      <tr><td class="doc-lbl">Persona Responsable</td><td>${V(f.resp_nombre)}</td><td class="doc-lbl">Parentezco:</td><td>${V(f.resp_parentesco)}</td><td class="doc-lbl">Telefono 1:</td><td>${V(f.resp_telefono)}</td></tr>
    </table>
    <div class="doc-campo-largo"><strong>Lugar de Domicilio / Vivienda:</strong><p>${V(f.resp_lugar)}</p></div>
    <div class="doc-campo-largo"><strong>Descripcion de Domicilio / Vivienda:</strong><p>${V(f.domicilio_descripcion)}</p></div>
    <div class="doc-campo-largo"><strong>Sitios de Refenrencia de Domicilio / Vivienda:</strong><p>${V(f.domicilio_referencias)}</p></div>

    <div class="doc-seccion-h">DATOS FAMILIARES</div>
    <div class="doc-social-banda"></div>
    <table class="doc-tabla doc-tabla-chica">
      <tr>
        <td class="doc-lbl" rowspan="2">APELLIDOS Y NOMBRES</td><td class="doc-lbl" rowspan="2">Parentezco</td>
        <td class="doc-lbl" colspan="2">Sexo</td><td class="doc-lbl" rowspan="2">Edad</td>
        <td class="doc-lbl" colspan="2">Estudian</td><td class="doc-lbl" rowspan="2">Nivel</td>
        <td class="doc-lbl" rowspan="2">Grado</td><td class="doc-lbl" colspan="2">Trabajan</td>
      </tr>
      <tr>
        <td class="doc-lbl doc-centro">H</td><td class="doc-lbl doc-centro">M</td>
        <td class="doc-lbl doc-centro">Si</td><td class="doc-lbl doc-centro">No</td>
        <td class="doc-lbl doc-centro">Si</td><td class="doc-lbl doc-centro">No</td>
      </tr>
      ${filasFam}
    </table>

    <div class="doc-seccion-h">DATOS DE LA VIVIENDA</div>
    <div class="doc-social-banda"></div>
    <table class="doc-tabla doc-tabla-chica">
      <tr>
        <td class="doc-lbl" colspan="2">Vivienda</td><td class="doc-lbl" colspan="2">Construccion</td>
        <td class="doc-lbl" colspan="3">Servicios Basicos</td><td class="doc-lbl">Observaciones</td>
      </tr>
      <tr>
        <td class="doc-lbl doc-centro">PROPIA</td><td class="doc-lbl doc-centro">ARRIENDO</td>
        <td class="doc-lbl doc-centro">MIXTA</td><td class="doc-lbl doc-centro">CEMENTO</td>
        <td class="doc-lbl doc-centro">LUZ</td><td class="doc-lbl doc-centro">AGUA</td><td class="doc-lbl doc-centro">ALCANTARILLADO</td>
        <td class="doc-lbl"></td>
      </tr>
      <tr>
        <td class="doc-centro">${MARCA(f.vivienda_tenencia, 'Propia')}</td>
        <td class="doc-centro">${MARCA(f.vivienda_tenencia, 'Arriendo')}</td>
        <td class="doc-centro">${MARCA(f.vivienda_construccion, 'Mixta')}</td>
        <td class="doc-centro">${MARCA(f.vivienda_construccion, 'Cemento')}</td>
        <td class="doc-centro">${f.vivienda_luz ? 'X' : ''}</td>
        <td class="doc-centro">${f.vivienda_agua ? 'X' : ''}</td>
        <td class="doc-centro">${f.vivienda_alcantarillado ? 'X' : ''}</td>
        <td>${V(f.vivienda_observaciones)}</td>
      </tr>
    </table>

    <div class="doc-seccion-h doc-social-con-texto">SITUACIÓN ECONÓMICA</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">INGRESO MENSUALES FAMILIAR</td><td colspan="3">${V(f.ingreso_mensual)}</td></tr>
      <tr><td class="doc-lbl">OTROS INGRESOS :</td><td colspan="3">${V(f.otros_ingresos)}</td></tr>
      <tr><td class="doc-lbl">COMO SE MOVILIZA PARA LLEGAR A SU LUGAR DE TRABAJO:</td><td colspan="3">${V(f.movilizacion)}</td></tr>
    </table>
    <div class="doc-campo-largo"><strong>OBSERVACION:</strong><p>${V(f.observacion)}</p></div>

    <div class="doc-social-firma-linea"></div>
    <div class="doc-social-firma-roles">
      <span>${V(f.cargo) || 'Trabajador'}</span>
      <span>TRABAJADOR SOCIAL</span>
    </div>
  </div>`;
}
function htmlRegistroPersonal(f) {
  return `
  <div class="doc-hoja doc-registro">
    <div class="doc-encabezado">
      <img src="logo.png" class="doc-logo" alt="">
      <div class="doc-titulo-empresa">
        <strong>AGRIMROC. S.A</strong>
        <h1>REGISTRO DE PERSONAL</h1>
      </div>
      <div class="doc-foto">FOTO<br>tamaño<br>carnet</div>
    </div>

    <div class="doc-seccion-h">DATOS PERSONALES</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Apellidos y Nombres</td><td colspan="5">${V(f.nombre_completo)}</td></tr>
      <tr><td class="doc-lbl">C.I</td><td>${V(f.cedula)}</td><td class="doc-lbl">Sexo</td><td>${V(f.sexo)}</td><td class="doc-lbl">Estatura</td><td>${V(f.estatura)}</td></tr>
      <tr><td class="doc-lbl">Grupo Sanguineo</td><td>${V(f.disc_tipo_sanguineo || f.tipo_sangre)}</td><td class="doc-lbl">Estado Civil</td><td>${V(f.estado_civil)}</td><td class="doc-lbl">Edad</td><td>${f.edad != null ? f.edad : ''}</td></tr>
      <tr><td class="doc-lbl">Lugar y Fecha de Nacimiento</td><td colspan="3">${V(f.lugar_nacimiento)} ${f.fecha_nacimiento ? '· ' + formatearFecha(f.fecha_nacimiento) : ''}</td><td class="doc-lbl">Nacionalidad</td><td>${V(f.nacionalidad)}</td></tr>
    </table>

    <table class="doc-tabla" style="margin-top:0.3rem;">
      <tr><td class="doc-lbl" style="font-weight:normal;">Direccion de residencia</td><td colspan="5">${V(f.domicilio)}</td></tr>
      <tr><td class="doc-lbl">Pronvincia</td><td>${V(f.provincia)}</td><td class="doc-lbl">Canton</td><td>${V(f.canton)}</td><td class="doc-lbl">Parroquia</td><td>${V(f.parroquia)}</td></tr>
      <tr><td class="doc-lbl">Telefono convencional</td><td colspan="2">${V(f.telefono_convencional)}</td><td class="doc-lbl">Celular</td><td colspan="2">${V(f.telefono)}</td></tr>
    </table>

    <div class="doc-seccion-h">Celular Familiares mas cercanos:</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Nombre</td><td colspan="3">${V(f.rp_contacto_nombre)}</td><td class="doc-lbl">Celular</td><td>${V(f.rp_contacto_celular)}</td></tr>
      <tr><td class="doc-lbl">Correo Electronico</td><td colspan="5">${V(f.rp_contacto_correo)}</td></tr>
    </table>

    <div class="doc-seccion-h">Persona o Familiar mas cercano con los que nos podamos comunicar en&nbsp; caso de emergencia:</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Familiar</td><td colspan="3">${V(f.rp_familiar1_nombre)}</td><td class="doc-lbl">Celular</td><td>${V(f.rp_familiar1_celular)}</td></tr>
      <tr><td class="doc-lbl">Telefono convencional</td><td colspan="5">${V(f.rp_familiar1_convencional)}</td></tr>
      <tr><td class="doc-lbl">Familiar</td><td colspan="3">${V(f.rp_familiar2_nombre)}</td><td class="doc-lbl">Celular</td><td>${V(f.rp_familiar2_celular)}</td></tr>
      <tr><td class="doc-lbl">Telefono convencional</td><td colspan="5">${V(f.rp_familiar2_convencional)}</td></tr>
    </table>

    <div class="doc-seccion-h">Cargas Familiares:</div>
    <table class="doc-tabla doc-tabla-chica">
      <tr>
        <td class="doc-lbl doc-centro">Si</td><td class="doc-lbl doc-centro">No</td>
        <td class="doc-lbl doc-centro">Nº</td>
      </tr>
      <tr>
        <td class="doc-centro">${MARCA(f.rp_cargas_familiares, 'Sí')}</td>
        <td class="doc-centro">${MARCA(f.rp_cargas_familiares, 'No')}</td>
        <td class="doc-centro">${V(f.rp_num_cargas)}</td>
      </tr>
    </table>
    <table class="doc-tabla doc-tabla-chica">
      <tr><td class="doc-lbl" style="font-weight:normal;text-align:left;" colspan="7">Parentezco:</td></tr>
      <tr>
        <td class="doc-lbl doc-centro">Esposa</td><td class="doc-lbl doc-centro">Hijo</td>
        <td class="doc-lbl doc-centro">Hija</td><td class="doc-lbl doc-centro">Papá</td>
        <td class="doc-lbl doc-centro">Mamá</td><td class="doc-lbl doc-centro">Abuelo</td>
        <td class="doc-lbl doc-centro">Abuela</td>
      </tr>
      <tr>
        <td class="doc-centro">${(f.rp_parentesco_cargas || '').includes('Esposa') ? 'X' : ''}</td>
        <td class="doc-centro">${(f.rp_parentesco_cargas || '').includes('Hijo') ? 'X' : ''}</td>
        <td class="doc-centro">${(f.rp_parentesco_cargas || '').includes('Hija') ? 'X' : ''}</td>
        <td class="doc-centro">${(f.rp_parentesco_cargas || '').includes('Papá') ? 'X' : ''}</td>
        <td class="doc-centro">${(f.rp_parentesco_cargas || '').includes('Mamá') ? 'X' : ''}</td>
        <td class="doc-centro">${(f.rp_parentesco_cargas || '').includes('Abuelo') ? 'X' : ''}</td>
        <td class="doc-centro">${(f.rp_parentesco_cargas || '').includes('Abuela') ? 'X' : ''}</td>
      </tr>
    </table>

    <div class="doc-seccion-h">Datos Laborales</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Fecha de Ingreso</td><td>${f.fecha_ingreso ? formatearFecha(f.fecha_ingreso) : ''}</td><td class="doc-lbl">Cargo</td><td>${V(f.cargo)}</td></tr>
      <tr><td class="doc-lbl">Sueldo</td><td>${V(f.rp_sueldo)}</td><td class="doc-lbl">Fecha de Salida</td><td>${f.rp_fecha_salida ? formatearFecha(f.rp_fecha_salida) : ''}</td></tr>
    </table>

    <div class="doc-seccion-h">Experiencia Laboral (Ultima)</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Nombre de la Empresa</td><td>${V(f.rp_exp_empresa)}</td><td class="doc-lbl">Cargo Ocupado</td><td>${V(f.rp_exp_cargo)}</td></tr>
    </table>

    <!-- El Excel no imprime el nombre del trabajador en la firma:
         solo la línea y, debajo, "COLABORADOR" y "CI" como dos
         renglones separados —igual que se corrigió en la Ficha
         Social—. Se agrega el número real junto a "CI" porque el
         sistema ya lo tiene, en vez de dejarlo en blanco para
         completar a mano. -->
    <div class="doc-firma">
      <div class="doc-firma-linea"></div>
      <p style="font-weight:bold;">COLABORADOR</p>
      <p style="font-weight:bold;">CI ${V(f.cedula)}</p>
    </div>
  </div>`;
}

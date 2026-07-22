/* ============================================
   NEXUS · trabajo-social.js
   Módulo de Trabajo Social: ficha socioeconómica + registro de personal.
   Un solo registro guarda ambos documentos (comparten datos).
   Dos botones de impresión: cada documento con su formato y color.
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar, textoOGuion, retrasar, formatearFecha } from './utils.js';

const ROLES_TS = ['admin', 'trabajo_social', 'psico_social'];

const estado = {
  perfil: null,
  empresaId: null,
  fichas: [],
  paciente: null,
  verId: null,
  vista: 'ficha'
};

const HOY = () => new Date().toISOString().slice(0, 10);

const $empresa = document.getElementById('empresa-activa');

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

  await cargarEmpresas();
  conectarEventos();

  try { montarNavegacion(perfil, 'trabajo_social'); } catch (e) { console.warn('nav:', e); }
}

async function cargarEmpresas() {
  const { data } = await supabase.from('empresas').select('id, razon_social').order('razon_social');
  const lista = data || [];
  lista.forEach((e) => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.razon_social;
    $empresa.appendChild(o);
  });
  // Si solo hay una empresa, seleccionarla automáticamente
  if (lista.length === 1) {
    $empresa.value = lista[0].id;
    await alCambiarEmpresa();
  }
}

async function cargarFichas() {
  const { data, error } = await supabase
    .from('v_fichas_sociales').select('*')
    .eq('empresa_id', estado.empresaId)
    .order('creado_en', { ascending: false });
  estado.fichas = error ? [] : (data || []);
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  $empresa.addEventListener('change', alCambiarEmpresa);

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
  document.getElementById('btn-imprimir-social').addEventListener('click', () => imprimirDocumento('social'));
  document.getElementById('btn-imprimir-registro').addEventListener('click', () => imprimirDocumento('registro'));
}

async function alCambiarEmpresa() {
  estado.empresaId = $empresa.value || null;
  const hay = !!estado.empresaId;
  document.getElementById('pestanas').hidden = !hay;
  document.getElementById('vista-ficha').hidden = !hay;
  if (!hay) return;
  await cargarFichas();
  cambiarVista('ficha');
}

function cambiarVista(v) {
  estado.vista = v;
  document.querySelectorAll('.pestana').forEach((p) => p.classList.toggle('activa', p.dataset.vista === v));
  document.getElementById('vista-ficha').hidden = v !== 'ficha';
  document.getElementById('vista-registros').hidden = v !== 'registros';
  if (v === 'registros') pintarRegistros();
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

/* ============================================
   Guardar
   ============================================ */

function valor(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const v = el.value.trim();
  return v === '' ? null : v;
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
    disc_codigo: valor('ts_disc_codigo'),
    disc_tipo: valor('ts_disc_tipo'),
    disc_porcentaje: valor('ts_disc_porcentaje'),
    disc_familiar: valor('ts_disc_familiar'),
    disc_telefono: valor('ts_disc_telefono'),
    disc_convencional: valor('ts_disc_convencional'),
    disc_tipo_sanguineo: valor('ts_disc_sangre'),
    resp_nombre: valor('ts_resp_nombre'),
    resp_parentesco: valor('ts_resp_parentesco'),
    resp_telefono: valor('ts_resp_telefono'),
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
    rp_cargas_familiares: valor('ts_cargas'),
    rp_num_cargas: valor('ts_num_cargas'),
    rp_parentesco_cargas: valor('ts_parentesco_cargas'),
    rp_sueldo: valor('ts_sueldo'),
    rp_fecha_salida: document.getElementById('ts_fecha_salida').value || null,
    rp_exp_empresa: valor('ts_exp_empresa'),
    rp_exp_cargo: valor('ts_exp_cargo'),
    registrado_por: nombreTS()
  };

  const { data: creada, error } = await supabase
    .from('fichas_sociales').insert(fila).select('id').single();
  if (error) {
    $alerta.textContent = 'No fue posible guardar: ' + error.message;
    $alerta.hidden = false;
    return null;
  }
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
    if (el.type === 'checkbox') el.checked = false; else el.value = '';
  });
  document.getElementById('cuerpo-familiares').innerHTML = '';
  document.getElementById('alerta-ficha').hidden = true;
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

function htmlFichaSocial(f) {
  const fams = Array.isArray(f.familiares) ? f.familiares : [];
  const filasFam = fams.length ? fams.map((x) => `
    <tr>
      <td>${V(x.nombre)}</td><td>${V(x.parentesco)}</td><td>${V(x.sexo)}</td>
      <td>${V(x.edad)}</td><td>${V(x.estudia)}</td><td>${V(x.nivel)}</td>
      <td>${V(x.grado)}</td><td>${V(x.trabaja)}</td>
    </tr>`).join('') : '<tr><td colspan="8">Sin datos familiares</td></tr>';

  return `
  <div class="doc-hoja doc-social">
    <div class="doc-encabezado">
      <img src="logo.png" class="doc-logo" alt="">
      <div class="doc-titulo-empresa">
        <strong>AGRIMROC S.A.</strong>
        <span>Departamento de Trabajo Social</span>
        <h1>FICHA SOCIAL</h1>
      </div>
    </div>

    <div class="doc-seccion-h">Datos de Identificación del Trabajador</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Apellidos y Nombres</td><td colspan="3">${V(f.nombre_completo)}</td><td class="doc-lbl">Cédula</td><td>${V(f.cedula)}</td></tr>
      <tr><td class="doc-lbl">Nacionalidad</td><td>${V(f.nacionalidad)}</td><td class="doc-lbl">Lugar de Nacimiento</td><td>${V(f.lugar_nacimiento)}</td><td class="doc-lbl">Estado Civil</td><td>${V(f.estado_civil)}</td></tr>
      <tr><td class="doc-lbl">Correo</td><td colspan="3">${V(f.correo)}</td><td class="doc-lbl">Edad</td><td>${f.edad != null ? f.edad : ''}</td></tr>
      <tr><td class="doc-lbl">Sexo</td><td>${V(f.sexo)}</td><td class="doc-lbl">Experiencia</td><td>${V(f.experiencia)}</td><td class="doc-lbl">Puesto</td><td>${V(f.cargo)}</td></tr>
      <tr><td class="doc-lbl">Domicilio Actual</td><td colspan="5">${V(f.domicilio)}</td></tr>
      <tr><td class="doc-lbl">Nivel de Instrucción</td><td>${V(f.nivel_instruccion)}</td><td class="doc-lbl">Título Obtenido</td><td>${V(f.titulo_obtenido)}</td><td class="doc-lbl">Grupo Étnico</td><td>${V(f.grupo_etnico)}</td></tr>
      <tr><td class="doc-lbl">Religión</td><td colspan="5">${V(f.religion)}</td></tr>
    </table>

    <div class="doc-seccion-h">Datos de Familiares con Discapacidad</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Familiar</td><td>${V(f.disc_familiar)}</td><td class="doc-lbl">Tipo</td><td>${V(f.disc_tipo)}</td><td class="doc-lbl">Porcentaje</td><td>${V(f.disc_porcentaje)}</td></tr>
      <tr><td class="doc-lbl">Código</td><td>${V(f.disc_codigo)}</td><td class="doc-lbl">Teléfono</td><td>${V(f.disc_telefono)}</td><td class="doc-lbl">Convencional</td><td>${V(f.disc_convencional)}</td></tr>
      <tr><td class="doc-lbl">Tipo Sanguíneo</td><td colspan="5">${V(f.disc_tipo_sanguineo)}</td></tr>
    </table>

    <div class="doc-seccion-h">Ubicación de Domicilio</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Persona Responsable</td><td>${V(f.resp_nombre)}</td><td class="doc-lbl">Parentesco</td><td>${V(f.resp_parentesco)}</td><td class="doc-lbl">Teléfono</td><td>${V(f.resp_telefono)}</td></tr>
    </table>
    <div class="doc-campo-largo"><strong>Descripción del Domicilio / Vivienda:</strong><p>${V(f.domicilio_descripcion)}</p></div>
    <div class="doc-campo-largo"><strong>Sitios de Referencia:</strong><p>${V(f.domicilio_referencias)}</p></div>

    <div class="doc-seccion-h">Datos Familiares</div>
    <table class="doc-tabla">
      <tr>
        <td class="doc-lbl">Apellidos y Nombres</td><td class="doc-lbl">Parentesco</td><td class="doc-lbl">Sexo</td>
        <td class="doc-lbl">Edad</td><td class="doc-lbl">Estudia</td><td class="doc-lbl">Nivel</td>
        <td class="doc-lbl">Grado</td><td class="doc-lbl">Trabaja</td>
      </tr>
      ${filasFam}
    </table>

    <div class="doc-seccion-h">Datos de la Vivienda</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Tenencia</td><td>${V(f.vivienda_tenencia)}</td><td class="doc-lbl">Construcción</td><td>${V(f.vivienda_construccion)}</td></tr>
      <tr><td class="doc-lbl">Servicios Básicos</td><td colspan="3">Luz: ${SN(f.vivienda_luz)} · Agua: ${SN(f.vivienda_agua)} · Alcantarillado: ${SN(f.vivienda_alcantarillado)}</td></tr>
    </table>
    <div class="doc-campo-largo"><strong>Observaciones de Vivienda:</strong><p>${V(f.vivienda_observaciones)}</p></div>

    <div class="doc-seccion-h">Situación Económica</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Ingreso Mensual Familiar</td><td>${V(f.ingreso_mensual)}</td><td class="doc-lbl">Otros Ingresos</td><td>${V(f.otros_ingresos)}</td></tr>
      <tr><td class="doc-lbl">Movilización al Trabajo</td><td colspan="3">${V(f.movilizacion)}</td></tr>
    </table>
    <div class="doc-campo-largo"><strong>Observación:</strong><p>${V(f.observacion)}</p></div>

    <div class="doc-firma">
      <div class="doc-firma-linea"></div>
      <p>${V(f.registrado_por || 'Trabajador/a Social')}</p>
      <p style="font-size:9pt">Departamento de Trabajo Social</p>
    </div>
  </div>`;
}

function htmlRegistroPersonal(f) {
  return `
  <div class="doc-hoja doc-registro">
    <div class="doc-encabezado">
      <img src="logo.png" class="doc-logo" alt="">
      <div class="doc-titulo-empresa">
        <strong>AGRIMROC S.A.</strong>
        <h1>REGISTRO DE PERSONAL</h1>
      </div>
      <div class="doc-foto">FOTO<br>tamaño<br>carnet</div>
    </div>

    <div class="doc-seccion-h">Datos Personales</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Apellidos y Nombres</td><td colspan="5">${V(f.nombre_completo)}</td></tr>
      <tr><td class="doc-lbl">C.I.</td><td>${V(f.cedula)}</td><td class="doc-lbl">Sexo</td><td>${V(f.sexo)}</td><td class="doc-lbl">Estatura</td><td>${V(f.estatura)}</td></tr>
      <tr><td class="doc-lbl">Grupo Sanguíneo</td><td>${V(f.disc_tipo_sanguineo || f.tipo_sangre)}</td><td class="doc-lbl">Estado Civil</td><td>${V(f.estado_civil)}</td><td class="doc-lbl">Edad</td><td>${f.edad != null ? f.edad : ''}</td></tr>
      <tr><td class="doc-lbl">Lugar y Fecha de Nacimiento</td><td colspan="3">${V(f.lugar_nacimiento)} ${f.fecha_nacimiento ? '· ' + formatearFecha(f.fecha_nacimiento) : ''}</td><td class="doc-lbl">Nacionalidad</td><td>${V(f.nacionalidad)}</td></tr>
    </table>

    <div class="doc-seccion-h">Dirección de Residencia</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Provincia</td><td>${V(f.provincia)}</td><td class="doc-lbl">Cantón</td><td>${V(f.canton)}</td><td class="doc-lbl">Parroquia</td><td>${V(f.parroquia)}</td></tr>
      <tr><td class="doc-lbl">Domicilio</td><td colspan="5">${V(f.domicilio)}</td></tr>
      <tr><td class="doc-lbl">Convencional</td><td>${V(f.telefono_convencional)}</td><td class="doc-lbl">Celular</td><td colspan="3">${V(f.telefono)}</td></tr>
    </table>

    <div class="doc-seccion-h">Familiares más Cercanos</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Familiar 1</td><td>${V(f.rp_familiar1_nombre)}</td><td class="doc-lbl">Convencional</td><td>${V(f.rp_familiar1_convencional)}</td><td class="doc-lbl">Celular</td><td>${V(f.rp_familiar1_celular)}</td></tr>
      <tr><td class="doc-lbl">Familiar 2</td><td>${V(f.rp_familiar2_nombre)}</td><td class="doc-lbl">Convencional</td><td>${V(f.rp_familiar2_convencional)}</td><td class="doc-lbl">Celular</td><td>${V(f.rp_familiar2_celular)}</td></tr>
      <tr><td class="doc-lbl">Contacto</td><td>${V(f.rp_contacto_nombre)}</td><td class="doc-lbl">Correo</td><td>${V(f.rp_contacto_correo)}</td><td class="doc-lbl">Celular</td><td>${V(f.rp_contacto_celular)}</td></tr>
    </table>

    <div class="doc-seccion-h">Cargas Familiares</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">¿Tiene cargas?</td><td>${V(f.rp_cargas_familiares)}</td><td class="doc-lbl">N°</td><td>${V(f.rp_num_cargas)}</td><td class="doc-lbl">Parentesco</td><td>${V(f.rp_parentesco_cargas)}</td></tr>
    </table>

    <div class="doc-seccion-h">Datos Laborales</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Fecha de Ingreso</td><td>${f.fecha_ingreso ? formatearFecha(f.fecha_ingreso) : ''}</td><td class="doc-lbl">Cargo</td><td>${V(f.cargo)}</td></tr>
      <tr><td class="doc-lbl">Sueldo</td><td>${V(f.rp_sueldo)}</td><td class="doc-lbl">Fecha de Salida</td><td>${f.rp_fecha_salida ? formatearFecha(f.rp_fecha_salida) : ''}</td></tr>
    </table>

    <div class="doc-seccion-h">Experiencia Laboral (Última)</div>
    <table class="doc-tabla">
      <tr><td class="doc-lbl">Empresa</td><td>${V(f.rp_exp_empresa)}</td><td class="doc-lbl">Cargo Ocupado</td><td>${V(f.rp_exp_cargo)}</td></tr>
    </table>

    <div class="doc-firma">
      <div class="doc-firma-linea"></div>
      <p>${V(f.nombre_completo)}</p>
      <p style="font-size:9pt">Colaborador · C.I. ${V(f.cedula)}</p>
    </div>
  </div>`;
}

/* ============================================
   NEXUS · learning.js
   Puente con Nexus Learning (plataforma de capacitación).

   Qué hace:
   · Lee de NEXUS la empresa activa (RUC) y su nómina
     (solo código, cédula, nombre y si está activo).
   · Lee de Nexus Learning las capacitaciones de esa empresa
     (buscándola por RUC), sus inscritos y certificados.
   · Compara por cédula EN EL NAVEGADOR y muestra quién falta.

   Qué NO hace:
   · No copia la nómina a Nexus Learning ni lee datos clínicos.
   · No escribe nada en NEXUS.

   Nexus Learning es otro proyecto de Supabase. La sesión se abre
   SIN contraseña mediante el puente (ver puente-learning.js), y
   solo para administradores de Nexus Learning.
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina, empresasPermitidas, resolverEmpresaActiva } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar, formatearFecha } from './utils.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { LEARNING, paseDeEntrada, irALearning } from './puente-learning.js';

/* Cliente de Nexus Learning, anclado al ámbito global (mismo motivo que supabase.js).
   · storageKey propio y sessionStorage: muere al cerrar la pestaña.
   · Sin refresco automático en segundo plano (evita el congelamiento
     descrito en supabase.js). Si el pase vence, se pide otro al puente.
   · La sesión se abre con el pase del puente: sin contraseña. */
const learning = globalThis.__nexus_learning__ ??= createClient(LEARNING.url, LEARNING.clave, {
  auth: {
    storageKey: 'nexus_learning_sesion',
    storage: window.sessionStorage,
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

/* --- Formato del Registro de asistencia (control documental) ---
   Para cambiar el código o la versión del formato, edite solo aquí. */
const FORMATO = {
  codigo: 'SST-REG-001',
  version: '01',
  rucProveedor: '0791865156001',      // VitalWork S.A.S. (logo del pie, desde NEXUS)
  nombreProveedor: 'VitalWork S.A.S.',
  firmas: ['Facilitador', 'Responsable de Seguridad y Salud']
};

const estado = {
  perfil: null,
  empresa: null,          // NEXUS: { id, ruc, razon_social }
  nomina: [],             // NEXUS: trabajadores de la empresa
  porCedula: new Map(),   // cédula normalizada → trabajador
  activos: 0,
  lEmpresa: null,         // Learning: cap_empresas
  convocatorias: [],
  inscripciones: [],
  certificados: [],
  detalle: null,          // { conv, grupos }
  grupo: 'faltan',
  vinculos: new Map(),    // id convocatoria → fila de NEXUS (capacitaciones)
  proveedor: null,        // { razon_social, logo_url } de VitalWork en NEXUS
  leccionesPorCurso: new Map(),
  demografia: new Map(),  // cédula → { sexo, fecha_nacimiento } desde la ficha de NEXUS
  registroDisponible: true,
  docentesPorCurso: new Map(),
  registroConv: null,
  filaDestino: null
};

const $ = (id) => document.getElementById(id);

iniciar();

/* ============================================
   Inicio
   ============================================ */

async function iniciar() {
  const perfil = await protegerPagina(['admin', 'tecnico_sst']);
  if (!perfil) return;
  estado.perfil = perfil;
  montarNavegacion(perfil, 'learning');

  const permitidas = await empresasPermitidas(perfil);
  if (permitidas.length === 0) {
    $('aviso-inicial').textContent = 'No tienes ninguna empresa asignada. Contacta al administrador.';
    return;
  }
  const empresa = resolverEmpresaActiva(permitidas);
  if (!empresa) return; // redirige a seleccionar-empresa.html
  $('empresa-activa-nombre').textContent = empresa.razon_social;

  const ok = await cargarNexus(empresa.id);
  if (!ok) return;

  conectarEventos();
  await conectar();
}

/* ============================================
   Datos de NEXUS (solo lectura)
   ============================================ */

async function cargarNexus(empresaId) {
  const { data: emp, error } = await supabase
    .from('empresas')
    .select('id, ruc, razon_social, logo_url, color_marca')
    .eq('id', empresaId)
    .single();

  if (error || !emp) {
    mostrarGlobal('No fue posible leer la empresa en NEXUS: ' + (error?.message || 'sin datos'));
    $('aviso-inicial').hidden = true;
    return false;
  }
  estado.empresa = emp;

  // Proveedor del servicio (logo del pie del registro)
  const prov = await supabase.from('empresas').select('razon_social, logo_url')
    .eq('ruc', FORMATO.rucProveedor).maybeSingle();
  estado.proveedor = prov.data || null;

  // Nómina: solo los campos necesarios para comparar. Nada clínico.
  const nomina = await traerTodo((desde, hasta) => supabase
    .from('v_trabajadores')
    .select('id, codigo, cedula, nombre_completo, activo')
    .eq('empresa_id', empresaId)
    .order('codigo')
    .range(desde, hasta));

  if (nomina.error) {
    mostrarGlobal('No fue posible leer la nómina: ' + nomina.error.message);
    $('aviso-inicial').hidden = true;
    return false;
  }

  estado.nomina = nomina.data;
  estado.porCedula = new Map();
  estado.nomina.forEach((t) => { if (t.cedula) estado.porCedula.set(normalizar(t.cedula), t); });
  estado.activos = estado.nomina.filter((t) => t.activo).length;

  // Sexo y fecha de nacimiento de la ficha del trabajador: solo como respaldo
  // para quienes se registraron antes de que Learning los pidiera.
  const demo = await traerTodo((desde, hasta) => supabase
    .from('trabajadores')
    .select('cedula, sexo, fecha_nacimiento')
    .eq('empresa_id', empresaId)
    .range(desde, hasta));
  estado.demografia = new Map();
  if (!demo.error) demo.data.forEach((t) => { if (t.cedula) estado.demografia.set(normalizar(t.cedula), t); });
  return true;
}

/* ============================================
   Sesión en Nexus Learning
   ============================================ */

async function sesionLearning() {
  const { data } = await learning.auth.getSession();
  const sesion = data?.session;
  if (!sesion) return null;
  // Si vence en menos de 2 minutos, se considera vencida (se pide otro pase)
  if (sesion.expires_at * 1000 - Date.now() < 120000) return null;
  return sesion;
}

/* Conecta con Nexus Learning usando el puente (sin contraseña) */
async function conectar() {
  const actual = await sesionLearning();
  if (actual) return alConectar(actual);

  mostrarConexion('Conectando con Nexus Learning…', 'Usamos su sesión de NEXUS; no necesita otra contraseña.', false);

  const r = await paseDeEntrada();
  if (r.error || !r.token_hash) {
    return mostrarConexion('No fue posible conectar', r.error || 'Intente de nuevo.', !r.sin_acceso);
  }
  if (r.rol !== 'admin') {
    return mostrarConexion('Solo para administradores',
      'Este módulo muestra datos de todas las empresas y es solo para administradores de Nexus Learning. Como docente, entre desde la pantalla de elegir empresa.', false);
  }

  let v = await learning.auth.verifyOtp({ token_hash: r.token_hash, type: 'email' });
  if (v.error) v = await learning.auth.verifyOtp({ token_hash: r.token_hash, type: 'magiclink' });
  if (v.error || !v.data?.session) {
    console.error(v.error);
    return mostrarConexion('No fue posible conectar', 'El pase de entrada no fue aceptado. Intente de nuevo.', true);
  }
  await alConectar(v.data.session);
}

function mostrarConexion(titulo, texto, reintentar) {
  $('aviso-inicial').hidden = true;
  $('area-trabajo').hidden = true;
  $('panel-conexion').hidden = false;
  $('conexion-titulo').textContent = titulo;
  $('conexion-texto').textContent = texto;
  $('btn-reintentar').hidden = !reintentar;
}

async function abrirPanel() {
  const $btn = $('btn-abrir-learning');
  $btn.disabled = true;
  const r = await paseDeEntrada();
  $btn.disabled = false;
  if (r.error || !r.token_hash) { mostrarGlobal(r.error || 'No fue posible abrir Nexus Learning.'); return; }
  irALearning(r.token_hash, r.rol);
}

async function alConectar(sesion) {
  // ¿Es administrador en Nexus Learning?
  const { data: admin, error } = await learning
    .from('cap_administradores')
    .select('user_id')
    .eq('user_id', sesion.user.id)
    .maybeSingle();

  if (error) {
    return mostrarConexion('No fue posible conectar', 'No se pudo verificar la cuenta en Nexus Learning. Revise su conexión.', true);
  }
  if (!admin) {
    await learning.auth.signOut();
    return mostrarConexion('Solo para administradores', 'Su cuenta no es administradora de Nexus Learning.', false);
  }

  $('panel-conexion').hidden = true;
  $('aviso-inicial').hidden = true;
  $('area-trabajo').hidden = false;
  $('lrn-conectado').textContent = 'Conectado a Nexus Learning como administrador';
  await cargarLearning();
}

/* ============================================
   Datos de Nexus Learning
   ============================================ */

async function cargarLearning() {
  ocultarGlobal();
  $('panel-detalle').hidden = true;

  if (!(await sesionLearning())) { await conectar(); return; }

  const ruc = (estado.empresa.ruc || '').replace(/\D/g, '');
  const { data: lEmp, error } = await learning
    .from('cap_empresas')
    .select('id, nombre, ruc, num_trabajadores, activa')
    .eq('ruc', ruc)
    .maybeSingle();

  if (error) { mostrarGlobal('No fue posible consultar Nexus Learning: ' + error.message); return; }

  estado.lEmpresa = lEmp;
  if (!lEmp) {
    $('bloque-empresa').hidden = true;
    $('panel-sin-empresa').hidden = false;
    $('texto-sin-empresa').textContent =
      'Se registrará con el RUC ' + ruc + ', la razón social «' + estado.empresa.razon_social +
      '» y ' + estado.activos + ' trabajadores activos. Luego podrá crear sus capacitaciones y códigos desde el panel de Nexus Learning.';
    return;
  }

  $('panel-sin-empresa').hidden = true;
  $('bloque-empresa').hidden = false;

  // Aviso si el número de trabajadores difiere
  const desfase = lEmp.num_trabajadores !== estado.activos;
  $('aviso-desfase').hidden = !desfase;
  if (desfase) {
    $('texto-desfase').textContent = 'NEXUS tiene ' + estado.activos + ' trabajadores activos; en Nexus Learning figura ' +
      (lEmp.num_trabajadores ?? 'sin número') + '. ';
  }
  if (!lEmp.activa) mostrarGlobal('Esta empresa está INACTIVA en Nexus Learning: sus códigos no funcionan.');

  // Capacitaciones, inscritos y certificados
  const conv = await learning
    .from('cap_convocatorias')
    .select('id, curso_id, modalidad, evaluacion_presencial, horas, fecha_capacitacion, observaciones, creado_en, ' +
            'cap_cursos(titulo, horas, subtemas), cap_accesos(tipo, codigo, valido_desde, valido_hasta, anulado)')
    .eq('empresa_id', lEmp.id)
    .order('creado_en', { ascending: false });

  if (conv.error) { mostrarGlobal('No fue posible leer las capacitaciones: ' + conv.error.message); return; }
  estado.convocatorias = conv.data || [];
  const ids = estado.convocatorias.map((c) => c.id);

  if (ids.length > 0) {
    const [insc, cert] = await Promise.all([
      traerTodo((d, h) => learning.from('cap_inscripciones')
        .select('convocatoria_id, cedula, nombres, modalidad, creado_en, sexo, fecha_nacimiento, etnia')
        .in('convocatoria_id', ids).order('creado_en').range(d, h)),
      traerTodo((d, h) => learning.from('cap_certificados')
        .select('convocatoria_id, cedula, nombres, codigo, tipo, nota, modalidad, emitido_en')
        .in('convocatoria_id', ids).order('emitido_en').range(d, h))
    ]);
    if (insc.error || cert.error) {
      mostrarGlobal('No fue posible leer las nóminas de Nexus Learning: ' + (insc.error || cert.error).message);
      return;
    }
    estado.inscripciones = insc.data;
    estado.certificados = cert.data;
  } else {
    estado.inscripciones = [];
    estado.certificados = [];
  }

  await Promise.all([cargarVinculos(ids), cargarDocentes(), cargarLecciones()]);
  pintarResumen();
  pintarConvocatorias();
}

async function registrarEmpresa() {
  if (!(await sesionLearning())) { await conectar(); return; }
  const $btn = $('btn-registrar-empresa');
  $btn.disabled = true;

  const { error } = await learning.from('cap_empresas').insert({
    nombre: estado.empresa.razon_social,
    ruc: (estado.empresa.ruc || '').replace(/\D/g, ''),
    num_trabajadores: estado.activos,
    activa: true
  });
  $btn.disabled = false;

  if (error) {
    mostrarGlobal(error.code === '23505'
      ? 'Ya existe en Nexus Learning una empresa con ese RUC.'
      : 'No fue posible registrar la empresa: ' + error.message);
    return;
  }
  await cargarLearning();
}

async function actualizarNumero() {
  if (!(await sesionLearning())) { await conectar(); return; }
  const { error } = await learning.from('cap_empresas')
    .update({ num_trabajadores: estado.activos })
    .eq('id', estado.lEmpresa.id);
  if (error) { mostrarGlobal('No fue posible actualizar: ' + error.message); return; }
  await cargarLearning();
}

/* ============================================
   Comparación por cédula
   ============================================ */

function agrupar(conv) {
  const insc = estado.inscripciones.filter((i) => i.convocatoria_id === conv.id);
  const cert = estado.certificados.filter((c) => c.convocatoria_id === conv.id);
  const certPor = new Map(cert.map((c) => [normalizar(c.cedula), c]));
  const inscPor = new Map(insc.map((i) => [normalizar(i.cedula), i]));

  const grupos = { capacitados: [], pendientes: [], faltan: [], externos: [] };

  estado.nomina.filter((t) => t.activo).forEach((t) => {
    const ced = normalizar(t.cedula);
    if (certPor.has(ced)) grupos.capacitados.push({ t, c: certPor.get(ced), i: inscPor.get(ced) });
    else if (inscPor.has(ced)) grupos.pendientes.push({ t, i: inscPor.get(ced) });
    else grupos.faltan.push({ t });
  });

  // Inscritos que no son trabajadores activos de la nómina
  insc.forEach((i) => {
    const ced = normalizar(i.cedula);
    const t = estado.porCedula.get(ced);
    if (t && t.activo) return;
    grupos.externos.push({
      i, c: certPor.get(ced),
      motivo: t ? 'Inactivo en NEXUS' : 'No figura en la nómina de NEXUS'
    });
  });

  const total = estado.activos;
  const avance = total ? Math.round(grupos.capacitados.length * 100 / total) : null;
  return { grupos, avance };
}

/* ============================================
   Pintado
   ============================================ */

function pintarResumen() {
  $('r-activos').textContent = estado.activos;
  $('r-capacitaciones').textContent = estado.convocatorias.length;
  $('r-certificados').textContent = estado.certificados.length;
}

const MODALIDAD = { presencial: 'Presencial', virtual: 'Virtual', mixta: 'Mixta' };

function pintarConvocatorias() {
  const $lista = $('lista-convocatorias');
  $lista.innerHTML = '';
  $('vacio-convocatorias').hidden = estado.convocatorias.length > 0;

  estado.convocatorias.forEach((c) => {
    const { grupos, avance } = agrupar(c);
    const horas = Number(c.horas || c.cap_cursos.horas);
    const vigentes = (c.cap_accesos || []).filter(accesoVigente);

    const tarjeta = document.createElement('article');
    tarjeta.className = 'lrn-tarjeta';
    tarjeta.innerHTML = `
      <div class="lrn-tarjeta-cabecera">
        <h3>${escapar(c.cap_cursos.titulo)}</h3>
        <div class="lrn-chips">
          <span class="insignia insignia-activa">${MODALIDAD[c.modalidad]}</span>
          <span class="lrn-chip">${horas === 1 ? '1 hora' : horas + ' horas'}</span>
          ${c.fecha_capacitacion ? `<span class="lrn-chip">Charla: ${escapar(formatearFecha(c.fecha_capacitacion))}</span>` : ''}
          ${c.observaciones ? `<span class="lrn-chip">${escapar(c.observaciones)}</span>` : ''}
        </div>
      </div>
      <div class="lrn-avance">
        <div class="lrn-avance-texto">
          <strong>${avance === null ? '—' : avance + ' %'}</strong>
          <span>${grupos.capacitados.length} de ${estado.activos} trabajadores activos capacitados ·
                faltan ${grupos.faltan.length + grupos.pendientes.length}</span>
        </div>
        <div class="lrn-barra-progreso"><span style="width:${avance || 0}%"></span></div>
      </div>
      <p class="lrn-codigos">${vigentes.length
        ? 'Códigos vigentes: ' + vigentes.map((a) => `<strong>${escapar(a.codigo)}</strong> (${a.tipo}, hasta ${escapar(fechaHora(a.valido_hasta))})`).join(' · ')
        : '<span class="celda-tenue">Sin códigos vigentes</span>'}</p>
      <div class="lrn-acciones"></div>
    `;

    const ver = document.createElement('button');
    ver.type = 'button';
    ver.className = 'boton-primario';
    ver.textContent = 'Ver quién falta';
    ver.addEventListener('click', () => abrirDetalle(c));
    tarjeta.querySelector('.lrn-acciones').appendChild(ver);
    tarjeta.appendChild(seccionRegistro(c));

    $lista.appendChild(tarjeta);
  });
}

function abrirDetalle(conv) {
  const { grupos, avance } = agrupar(conv);
  estado.detalle = { conv, grupos };

  $('d-titulo').textContent = conv.cap_cursos.titulo;
  $('d-sub').textContent = estado.empresa.razon_social + ' · ' + MODALIDAD[conv.modalidad] +
    ' · comparado con ' + estado.activos + ' trabajadores activos de NEXUS';
  $('d-capacitados').textContent = grupos.capacitados.length;
  $('d-pendientes').textContent = grupos.pendientes.length;
  $('d-faltan').textContent = grupos.faltan.length;
  $('d-avance').textContent = avance === null ? '—' : avance + ' %';

  document.querySelectorAll('.lrn-pestana').forEach((b) => {
    const n = grupos[b.dataset.grupo].length;
    b.textContent = b.textContent.replace(/\s\(\d+\)$/, '') + ' (' + n + ')';
  });

  $('bloque-empresa').hidden = true;
  $('panel-detalle').hidden = false;
  $('d-buscar').value = '';
  elegirGrupo(grupos.faltan.length ? 'faltan' : 'capacitados');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cerrarDetalle() {
  $('panel-detalle').hidden = true;
  $('bloque-empresa').hidden = false;
}

const EXPLICACION = {
  faltan: 'Trabajadores activos en NEXUS que todavía no se registran en esta capacitación. Es la lista para enviar a talento humano.',
  pendientes: 'Se registraron con el código, pero aún no obtienen su certificado (no terminan el curso o no aprueban la evaluación).',
  capacitados: 'Trabajadores activos que ya obtuvieron su certificado.',
  externos: 'Personas registradas con una cédula que no corresponde a un trabajador activo de NEXUS. Revise si la cédula está mal escrita o si es personal de otra empresa.'
};

const COLUMNAS = {
  faltan: ['Código', 'Cédula', 'Nombre'],
  pendientes: ['Código', 'Cédula', 'Nombre', 'Modalidad', 'Registrado'],
  capacitados: ['Código', 'Cédula', 'Nombre', 'Certificado', 'Tipo', 'Nota', 'Fecha'],
  externos: ['Cédula', 'Nombre registrado', 'Situación', 'Certificado']
};

function filasGrupo(grupo) {
  const lista = estado.detalle.grupos[grupo];
  return lista.map((x) => {
    switch (grupo) {
      case 'faltan':
        return [x.t.codigo ?? 's/c', x.t.cedula, x.t.nombre_completo];
      case 'pendientes':
        return [x.t.codigo ?? 's/c', x.t.cedula, x.t.nombre_completo,
                x.i.modalidad === 'presencial' ? 'Presencial' : 'Virtual', fechaHora(x.i.creado_en)];
      case 'capacitados':
        return [x.t.codigo ?? 's/c', x.t.cedula, x.t.nombre_completo, x.c.codigo,
                x.c.tipo === 'asistencia' ? 'Asistencia' : 'Aprobación',
                x.c.nota == null ? '—' : Number(x.c.nota).toLocaleString('es-EC', { maximumFractionDigits: 1 }) + ' %',
                fechaHora(x.c.emitido_en)];
      default:
        return [x.i.cedula, x.i.nombres, x.motivo, x.c ? x.c.codigo : '—'];
    }
  });
}

function elegirGrupo(grupo) {
  estado.grupo = grupo;
  document.querySelectorAll('.lrn-pestana').forEach((b) => b.classList.toggle('activa', b.dataset.grupo === grupo));
  $('d-explicacion').textContent = EXPLICACION[grupo];
  $('d-cabecera').innerHTML = '<tr>' + COLUMNAS[grupo].map((c) => `<th>${escapar(c)}</th>`).join('') + '</tr>';
  pintarFilas();
}

function pintarFilas() {
  const filtro = $('d-buscar').value.trim().toLowerCase();
  const filas = filasGrupo(estado.grupo).filter((f) =>
    !filtro || f.some((v) => String(v).toLowerCase().includes(filtro)));

  const $cuerpo = $('d-cuerpo');
  $cuerpo.innerHTML = '';
  $('d-vacio').hidden = filas.length > 0;

  const frag = document.createDocumentFragment();
  filas.forEach((f) => {
    const tr = document.createElement('tr');
    tr.innerHTML = f.map((v, i) => `<td class="${i < 2 && estado.grupo !== 'externos' ? 'celda-mono' : ''}">${escapar(String(v))}</td>`).join('');
    frag.appendChild(tr);
  });
  $cuerpo.appendChild(frag);
}

/* Exportar a CSV que Excel abre directamente (UTF-8 con BOM, separador ;) */
function exportar() {
  const { conv } = estado.detalle;
  const grupo = estado.grupo;
  const filas = [COLUMNAS[grupo], ...filasGrupo(grupo)];
  const csv = filas.map((f) => f.map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');

  const nombres = { faltan: 'No_inscritos', pendientes: 'Sin_terminar', capacitados: 'Capacitados', externos: 'Fuera_de_nomina' };
  const archivo = (nombres[grupo] + '_' + estado.empresa.razon_social + '_' + conv.cap_cursos.titulo)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 90) + '.csv';

  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = archivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  $('btn-reintentar').addEventListener('click', conectar);
  $('btn-abrir-learning').addEventListener('click', abrirPanel);
  $('btn-registrar-empresa').addEventListener('click', registrarEmpresa);
  $('btn-actualizar-numero').addEventListener('click', actualizarNumero);
  $('btn-cerrar-detalle').addEventListener('click', cerrarDetalle);
  $('btn-exportar').addEventListener('click', exportar);
  $('d-buscar').addEventListener('input', pintarFilas);
  document.querySelectorAll('.lrn-pestana').forEach((b) =>
    b.addEventListener('click', () => elegirGrupo(b.dataset.grupo)));

  // Registro en Seguridad / Salud
  document.querySelectorAll('[data-cierra]').forEach((b) =>
    b.addEventListener('click', () => { $(b.dataset.cierra).hidden = true; }));
  $('r-ambito').addEventListener('change', cargarTemas);
  $('r-anio').addEventListener('change', revisarFila);
  $('r-tema').addEventListener('change', revisarFila);
  $('btn-guardar-registro').addEventListener('click', guardarRegistro);
}

/* ============================================
   Registro en Seguridad industrial / Salud ocupacional
   Llena la fila de la pestaña Capacitaciones (empresa + tema + año)
   con los datos de Nexus Learning y la deja vinculada.
   ============================================ */

const AMBITOS = { salud: 'Salud ocupacional', seguridad: 'Seguridad industrial' };

async function cargarVinculos(ids) {
  estado.vinculos = new Map();
  estado.registroDisponible = true;
  if (ids.length === 0) return;

  const { data, error } = await supabase
    .from('capacitaciones')
    .select('id, anio, tema_id, asistentes, fecha_inicio, fecha_fin, url_registro, facilitador, observacion, learning_convocatoria_id')
    .eq('empresa_id', estado.empresa.id)
    .in('learning_convocatoria_id', ids);

  if (error) {
    // Lo más probable: falta ejecutar sql/070 en NEXUS
    console.warn('NEXUS · learning: sin vínculos', error);
    estado.registroDisponible = false;
    return;
  }

  const temaIds = [...new Set(data.map((d) => d.tema_id))];
  let temas = [];
  if (temaIds.length) {
    const t = await supabase.from('capacitacion_temas').select('id, nombre, ambito').in('id', temaIds);
    temas = t.data || [];
  }
  data.forEach((d) => estado.vinculos.set(d.learning_convocatoria_id,
    { ...d, tema: temas.find((t) => t.id === d.tema_id) || null }));
}

async function cargarDocentes() {
  estado.docentesPorCurso = new Map();
  const cursos = [...new Set(estado.convocatorias.map((c) => c.curso_id))];
  if (cursos.length === 0) return;
  const { data } = await learning
    .from('cap_docente_cursos')
    .select('curso_id, cap_docentes(nombres, activo)')
    .in('curso_id', cursos);
  (data || []).forEach((r) => {
    if (!r.cap_docentes || !r.cap_docentes.activo) return;
    const lista = estado.docentesPorCurso.get(r.curso_id) || [];
    lista.push(r.cap_docentes.nombres);
    estado.docentesPorCurso.set(r.curso_id, lista);
  });
}

/* Títulos de lecciones: subtemas por defecto si el programa no los define */
async function cargarLecciones() {
  estado.leccionesPorCurso = new Map();
  const cursos = [...new Set(estado.convocatorias.map((c) => c.curso_id))];
  if (cursos.length === 0) return;
  const { data } = await learning.from('cap_lecciones')
    .select('curso_id, titulo, orden').in('curso_id', cursos).order('orden');
  (data || []).forEach((l) => {
    const lista = estado.leccionesPorCurso.get(l.curso_id) || [];
    lista.push(l.titulo);
    estado.leccionesPorCurso.set(l.curso_id, lista);
  });
}

function subtemasDe(conv) {
  const propios = conv.cap_cursos.subtemas || [];
  return propios.length ? propios : (estado.leccionesPorCurso.get(conv.curso_id) || []);
}

/* Datos que se llevan a NEXUS: todos los certificados (presencial y virtual) */
function datosRegistro(conv) {
  const certs = estado.certificados.filter((c) => c.convocatoria_id === conv.id);
  const fechas = certs.map((c) => fechaLocal(c.emitido_en)).sort();
  // Inicio: lo más temprano entre la fecha de la charla y el primer certificado
  const inicio = [conv.fecha_capacitacion, fechas[0]].filter(Boolean).sort()[0] || null;
  const ultimo = fechas[fechas.length - 1] || null;
  const fin = ultimo && inicio && ultimo > inicio ? ultimo : null;
  const presencial = certs.filter((c) => c.modalidad === 'presencial').length;
  const virtual = certs.length - presencial;
  const claves = (conv.cap_accesos || []).map((a) => a.codigo).join(', ');
  return {
    certs, inicio, fin, asistentes: certs.length, presencial, virtual, claves,
    facilitador: (estado.docentesPorCurso.get(conv.curso_id) || []).join(', '),
    observacion: 'Nexus Learning: ' + certs.length + ' certificados (' + presencial + ' presencial, ' +
      virtual + ' virtual)' + (claves ? ' · claves ' + claves : '')
  };
}

/* Conserva lo que haya escrito el usuario y reemplaza solo la parte de Nexus Learning */
function combinarObservacion(previa, nueva) {
  const partes = String(previa || '').split(' | ').filter((p) => p && !p.startsWith('Nexus Learning:'));
  partes.push(nueva);
  return partes.join(' | ');
}

function seccionRegistro(conv) {
  const div = document.createElement('div');
  div.className = 'lrn-registro-nexus';

  if (!estado.registroDisponible) {
    div.innerHTML = '<span>Para registrar en Seguridad o Salud, primero ejecute el archivo <strong>070</strong> en el SQL Editor de NEXUS.</span>';
    return div;
  }

  const v = estado.vinculos.get(conv.id);
  const $texto = document.createElement('span');
  const $botones = document.createElement('div');
  $botones.className = 'lrn-registro-botones';

  if (v) {
    div.classList.add('vinculada');
    $texto.innerHTML = '✓ Registrada en <strong>' + escapar(AMBITOS[v.tema?.ambito] || 'NEXUS') + '</strong> · ' +
      escapar(v.tema?.nombre || 'Tema') + ' · ' + v.anio + ' · ' + (v.asistentes ?? 0) + ' asistentes' +
      (v.url_registro ? '' : ' · <em>falta el enlace de Drive</em>');
    $botones.append(
      botonPequeno('Actualizar', () => actualizarRegistro(conv, v)),
      botonPequeno('Registro de asistencia (PDF)', () => imprimirAsistencia(conv))
    );
  } else {
    $texto.textContent = 'Aún no está registrada en Seguridad industrial ni en Salud ocupacional.';
    $botones.append(
      botonPequeno('Registrar en Seguridad o Salud', () => abrirRegistro(conv), true),
      botonPequeno('Registro de asistencia (PDF)', () => imprimirAsistencia(conv))
    );
  }
  div.append($texto, $botones);
  return div;
}

function botonPequeno(texto, accion, primario) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = (primario ? 'boton-primario' : 'boton-secundario') + ' boton-mini';
  b.textContent = texto;
  b.addEventListener('click', accion);
  return b;
}

async function abrirRegistro(conv) {
  ocultarGlobal();
  const d = datosRegistro(conv);
  if (d.asistentes === 0) {
    mostrarGlobal('Esta capacitación todavía no tiene certificados emitidos. Regístrela cuando haya participantes.');
    return;
  }
  estado.registroConv = conv;
  estado.filaDestino = null;

  $('r-curso').textContent = conv.cap_cursos.titulo + ' · ' + estado.empresa.razon_social;
  $('r-anio').value = (d.inicio || fechaLocal(new Date().toISOString())).slice(0, 4);
  $('r-facilitador').value = d.facilitador ||
    [estado.perfil.nombres, estado.perfil.apellidos].filter(Boolean).join(' ');
  $('r-url').value = '';
  $('alerta-registro').hidden = true;
  $('r-reemplazo').hidden = true;
  $('r-datos').innerHTML =
    '<div><span>Fecha de realización</span><strong>' + escapar(d.inicio ? formatearFecha(d.inicio) : '—') + '</strong></div>' +
    '<div><span>Fecha de cierre</span><strong>' + escapar(d.fin ? formatearFecha(d.fin) : '—') + '</strong></div>' +
    '<div><span>Asistentes</span><strong>' + d.asistentes + ' (' + d.presencial + ' presencial, ' + d.virtual + ' virtual)</strong></div>' +
    '<div><span>Claves</span><strong>' + escapar(d.claves || '—') + '</strong></div>';

  $('modal-registro').hidden = false;
  await cargarTemas();
}

async function cargarTemas() {
  const ambito = $('r-ambito').value;
  const $tema = $('r-tema');
  $tema.innerHTML = '<option value="">Cargando…</option>';

  const { data, error } = await supabase
    .from('capacitacion_temas')
    .select('id, nombre, orden')
    .eq('ambito', ambito)
    .eq('activo', true)
    .order('orden');

  if (error) { return alertaRegistro('No fue posible leer los temas: ' + error.message); }
  const temas = data || [];
  $tema.innerHTML = '';
  if (temas.length === 0) {
    $tema.innerHTML = '<option value="">No hay temas en esta pestaña</option>';
    $('r-tema-ayuda').textContent = 'Cree primero el tema en la pestaña Capacitaciones de ' + AMBITOS[ambito] + '.';
    return;
  }
  $('r-tema-ayuda').textContent = '¿No está el tema? Créelo en la pestaña Capacitaciones de ' + AMBITOS[ambito] + '.';

  // Preseleccionar el tema más parecido al nombre del curso
  const curso = simplificar(estado.registroConv.cap_cursos.titulo);
  let mejor = '';
  temas.forEach((t) => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.nombre;
    $tema.appendChild(o);
    const nombre = simplificar(t.nombre);
    if (!mejor && (curso.includes(nombre) || nombre.includes(curso.split(' ').slice(0, 2).join(' ')))) mejor = t.id;
  });
  if (mejor) $tema.value = mejor;
  await revisarFila();
}

/* Revisa si la fila destino (empresa + tema + año) ya tiene datos */
async function revisarFila() {
  const tema = $('r-tema').value;
  const anio = parseInt($('r-anio').value, 10);
  const $aviso = $('r-reemplazo');
  $aviso.hidden = true;
  $('btn-guardar-registro').disabled = false;
  estado.filaDestino = null;
  if (!tema || !anio) return;

  const { data } = await supabase
    .from('capacitaciones')
    .select('id, fecha_inicio, asistentes, url_registro, facilitador, observacion, learning_convocatoria_id')
    .eq('empresa_id', estado.empresa.id)
    .eq('tema_id', tema)
    .eq('anio', anio)
    .maybeSingle();

  estado.filaDestino = data || null;
  if (!data) return;

  if (data.learning_convocatoria_id && data.learning_convocatoria_id !== estado.registroConv.id) {
    $aviso.textContent = 'Ese tema y año ya están vinculados a otra capacitación de Nexus Learning. Elija otro tema o año.';
    $aviso.hidden = false;
    $('btn-guardar-registro').disabled = true;
    return;
  }
  if (data.url_registro) $('r-url').placeholder = 'Se conserva: ' + data.url_registro;
  if (data.fecha_inicio) {
    $aviso.textContent = 'Este tema ya tiene un registro en ' + anio + ' (' + formatearFecha(data.fecha_inicio) + ', ' +
      (data.asistentes ?? 0) + ' asistentes). Al registrar se reemplazarán la fecha y los asistentes con los de Nexus Learning. ' +
      'El enlace de Drive y su observación se conservan.';
    $aviso.hidden = false;
  }
}

async function guardarRegistro() {
  const conv = estado.registroConv;
  const tema = $('r-tema').value;
  const anio = parseInt($('r-anio').value, 10);
  const url = $('r-url').value.trim();
  if (!tema) return alertaRegistro('Elija el tema de capacitación.');
  if (!(anio >= 2020 && anio <= 2100)) return alertaRegistro('Revise el año.');
  if (url && !/^https?:\/\//i.test(url)) return alertaRegistro('El enlace debe comenzar con http:// o https://');

  const $btn = $('btn-guardar-registro');
  $btn.disabled = true;

  // 1. Asegurar la fila (empresa + tema + año)
  let fila = estado.filaDestino;
  if (!fila) {
    const ins = await supabase.from('capacitaciones')
      .insert({ empresa_id: estado.empresa.id, tema_id: tema, anio })
      .select('id, url_registro, observacion').single();
    if (ins.error) {
      const otra = await supabase.from('capacitaciones').select('id, url_registro, observacion')
        .eq('empresa_id', estado.empresa.id).eq('tema_id', tema).eq('anio', anio).maybeSingle();
      if (!otra.data) { $btn.disabled = false; return alertaRegistro('No fue posible abrir el tema en ' + anio + ': ' + ins.error.message); }
      fila = otra.data;
    } else {
      fila = ins.data;
    }
  }

  // 2. Llenar con los datos de Nexus Learning
  const d = datosRegistro(conv);
  const { error } = await supabase.from('capacitaciones').update({
    fecha_inicio: d.inicio,
    fecha_fin: d.fin,
    asistentes: d.asistentes,
    facilitador: $('r-facilitador').value.trim() || null,
    url_registro: url || fila.url_registro || null,
    observacion: combinarObservacion(fila.observacion, d.observacion),
    learning_convocatoria_id: conv.id
  }).eq('id', fila.id);

  $btn.disabled = false;
  if (error) return alertaRegistro('No fue posible registrar: ' + error.message);

  $('modal-registro').hidden = true;
  await cargarVinculos(estado.convocatorias.map((c) => c.id));
  pintarConvocatorias();
  avisoOk('Registrada en ' + AMBITOS[$('r-ambito').value] + ': ' + d.asistentes + ' asistentes.' +
    (url || fila.url_registro ? '' : ' Recuerde agregar el enlace de Drive en la pestaña Capacitaciones.'));
}

async function actualizarRegistro(conv, v) {
  ocultarGlobal();
  const d = datosRegistro(conv);
  const { error } = await supabase.from('capacitaciones').update({
    fecha_inicio: d.inicio,
    fecha_fin: d.fin,
    asistentes: d.asistentes,
    observacion: combinarObservacion(v.observacion, d.observacion)
  }).eq('id', v.id);
  if (error) { mostrarGlobal('No fue posible actualizar: ' + error.message); return; }
  await cargarVinculos(estado.convocatorias.map((c) => c.id));
  pintarConvocatorias();
  avisoOk('Actualizada: ' + d.asistentes + ' asistentes.');
}

function alertaRegistro(texto) {
  $('alerta-registro').textContent = texto;
  $('alerta-registro').hidden = false;
}

function avisoOk(texto) {
  const $a = $('aviso-ok');
  $a.textContent = texto;
  $a.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  clearTimeout(avisoOk.t);
  avisoOk.t = setTimeout(() => { $a.hidden = true; }, 7000);
}

/* Registro de asistencia: formato fijo (control documental).
   Cambian solo los datos de la empresa y de la capacitación.
   Se abre en una ventana lista para imprimir o "Guardar como PDF". */
function imprimirAsistencia(conv) {
  const d = datosRegistro(conv);
  if (d.asistentes === 0) { mostrarGlobal('Esta capacitación todavía no tiene certificados emitidos.'); return; }

  const e = estado.empresa;
  const v = estado.vinculos.get(conv.id);
  const horas = Number(conv.horas || conv.cap_cursos.horas);
  const color = /^#[0-9a-f]{6}$/i.test(e.color_marca || '') ? e.color_marca : '#1c5c5d';
  const subtemas = subtemasDe(conv);
  const verificar = 'agrimroc88-lab.github.io/nexus-learning/verificar.html';
  const modalidad = d.presencial && d.virtual ? 'Mixta (' + d.presencial + ' presencial, ' + d.virtual + ' virtual)'
    : d.presencial ? 'Presencial' : 'Virtual';

  // Mismo logo que el menú lateral de NEXUS (nav.js): el de la ficha de
  // la empresa o, si no tiene, el logo fijo logo.png. La ventana del
  // registro no tiene dirección propia, así que se usa la dirección completa.
  const urlLogo = direccionCompleta(e.logo_url || 'logo.png');
  const logoEmpresa = urlLogo
    ? '<img src="' + escapar(urlLogo) + '" alt="Logo de ' + escapar(e.razon_social) + '">'
    : '<span class="sin-logo">' + escapar(e.razon_social) + '</span>';
  const urlProveedor = estado.proveedor && estado.proveedor.logo_url ? direccionCompleta(estado.proveedor.logo_url) : null;
  const logoProveedor = urlProveedor
    ? '<img src="' + escapar(urlProveedor) + '" alt="' + escapar(FORMATO.nombreProveedor) + '">'
    : '';

  // Una fila por persona certificada, con sus datos de registro
  const personas = d.certs
    .slice()
    .sort((a, b) => String(a.nombres).localeCompare(String(b.nombres), 'es'))
    .map((c) => {
      const insc = estado.inscripciones.find((i) => i.convocatoria_id === conv.id && normalizar(i.cedula) === normalizar(c.cedula));
      const ficha = estado.demografia.get(normalizar(c.cedula));
      const registro = insc ? insc.creado_en : c.emitido_en;
      const sexo = (insc && insc.sexo) || (ficha && ficha.sexo) || '';
      const nacimiento = (insc && insc.fecha_nacimiento) || (ficha && ficha.fecha_nacimiento) || null;
      return {
        nombres: String(c.nombres).toUpperCase(), cedula: c.cedula, codigo: c.codigo,
        modalidad: c.modalidad === 'presencial' ? 'Presencial' : 'Virtual',
        registro: fechaLocal(registro),
        sexo: sexo === 'M' || sexo === 'F' ? sexo : '',
        edad: nacimiento ? edadEn(nacimiento, fechaLocal(registro)) : null,
        etnia: insc && insc.etnia ? insc.etnia : ''
      };
    });

  const filas = personas.map((x, i) => '<tr><td class="c">' + (i + 1) + '</td><td>' + escapar(x.nombres) +
    '</td><td class="m">' + escapar(x.cedula) + '</td><td class="c">' + (x.sexo || '—') +
    '</td><td class="c">' + (x.edad ?? '—') + '</td><td>' + escapar(ETNIAS[x.etnia] || '—') +
    '</td><td class="m">' + escapar(formatearFecha(x.registro)) + '</td><td>' + x.modalidad +
    '</td><td class="m">' + escapar(x.codigo) + '</td></tr>').join('');

  // Resumen: sexo, edad y etnia
  const hombres = personas.filter((x) => x.sexo === 'M').length;
  const mujeres = personas.filter((x) => x.sexo === 'F').length;
  const edades = personas.map((x) => x.edad).filter((e) => e != null);
  const promedio = edades.length ? Math.round(edades.reduce((a, b) => a + b, 0) / edades.length) : null;
  const porEtnia = {};
  personas.forEach((x) => { const k = ETNIAS[x.etnia] || 'Sin dato'; porEtnia[k] = (porEtnia[k] || 0) + 1; });
  const resumen = '<div class="resumen"><b>Resumen:</b> ' + personas.length + ' participantes · Hombres: ' + hombres +
    ' · Mujeres: ' + mujeres + (personas.length - hombres - mujeres ? ' · Sin dato de sexo: ' + (personas.length - hombres - mujeres) : '') +
    ' · Edad promedio: ' + (promedio ?? '—') + (edades.length ? ' (de ' + Math.min(...edades) + ' a ' + Math.max(...edades) + ' años)' : '') +
    '<br><b>Autoidentificación étnica:</b> ' +
    Object.keys(porEtnia).map((k) => escapar(k) + ': ' + porEtnia[k]).join(' · ') + '</div>';

  const dato = (etiqueta, valor) => '<div><span>' + etiqueta + ':</span> ' + valor + '</div>';

  const html = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">' +
    '<title>Registro de asistencia · ' + escapar(conv.cap_cursos.titulo) + '</title><style>' +
    '@page{size:A4;margin:12mm}' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#1f2937;margin:0;font-size:11px}' +
    '.cab{display:grid;grid-template-columns:34mm 1fr 46mm;border:1px solid #8c97a3}' +
    '.cab>div{padding:6px 8px;border-right:1px solid #8c97a3;display:flex;flex-direction:column;justify-content:center}' +
    '.cab>div:last-child{border-right:0}' +
    '.logo{align-items:center;text-align:center}.logo img{max-width:100%;max-height:22mm;object-fit:contain}' +
    '.sin-logo{font-weight:700;font-size:10px}' +
    '.tit{text-align:center;gap:2px}.tit b{font-size:14px;letter-spacing:.02em}' +
    '.ctl div{padding:2px 0;border-bottom:1px solid #d6dce2;font-size:10px}.ctl div:last-child{border:0}' +
    '.franja{height:5px;background:' + color + ';margin:6px 0 8px;border-radius:2px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.datos{display:grid;grid-template-columns:1fr 1fr;border:1px solid #8c97a3;margin-bottom:8px}' +
    '.datos div{padding:4px 8px;border-bottom:1px solid #d6dce2}.datos span{color:#56655f}' +
    '.sub{grid-column:1/-1}.sub ul{margin:3px 0 0 18px;padding:0;columns:2;column-gap:24px}' +
    'table{width:100%;border-collapse:collapse;font-size:10px}' +
    'th,td{border:1px solid #8c97a3;padding:3px 4px;text-align:left;vertical-align:middle}' +
    'th{background:#eef2f1;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    'thead{display:table-header-group}tr{page-break-inside:avoid}' +
    '.c{text-align:center;width:8mm}.m{font-family:"Courier New",monospace;white-space:nowrap}' +
    '.resumen{margin-top:6px;padding:6px 8px;border:1px solid #8c97a3;font-size:10px;line-height:1.5;page-break-inside:avoid}' +
    '.firmas{display:grid;grid-template-columns:1fr 1fr;gap:20mm;margin:20mm 6mm 0;text-align:center;page-break-inside:avoid}' +
    '.firmas div{border-top:1px solid #1f2937;padding-top:4px}' +
    '.pie{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10mm;font-size:9px;color:#56655f}' +
    '.pie img{max-height:10mm;max-width:40mm;object-fit:contain}' +
    '</style></head><body>' +

    '<div class="cab">' +
      '<div class="logo">' + logoEmpresa + '</div>' +
      '<div class="tit"><b>REGISTRO DE ASISTENCIA A CAPACITACIÓN</b><span>' + escapar(e.razon_social) +
        '</span><span>RUC ' + escapar(e.ruc || '—') + '</span></div>' +
      '<div class="ctl"><div>Código: <b>' + escapar(FORMATO.codigo) + '</b></div><div>Versión: <b>' +
        escapar(FORMATO.version) + '</b></div><div>Fecha de emisión: ' +
        escapar(formatearFecha(fechaLocal(new Date().toISOString()))) + '</div></div>' +
    '</div>' +
    '<div class="franja"></div>' +

    '<div class="datos">' +
      dato('Tema', '<b>' + escapar(conv.cap_cursos.titulo) + '</b>') +
      dato('Ámbito', escapar(v && v.tema ? AMBITOS[v.tema.ambito] || '—' : '—')) +
      dato('Fecha', escapar(d.inicio ? formatearFecha(d.inicio) : '—') + (d.fin ? ' al ' + escapar(formatearFecha(d.fin)) : '')) +
      dato('Duración', horas === 1 ? '1 hora' : escapar(horas.toLocaleString('es-EC')) + ' horas') +
      dato('Modalidad', escapar(modalidad)) +
      dato('Facilitador', escapar((v && v.facilitador) || d.facilitador || '—')) +
      (subtemas.length
        ? '<div class="sub"><span>Subtemas:</span><ul>' + subtemas.map((t) => '<li>' + escapar(t) + '</li>').join('') + '</ul></div>'
        : '') +
    '</div>' +

    '<table><thead><tr><th class="c">N.º</th><th>Nombres y apellidos</th><th>Cédula</th><th class="c">Sexo</th>' +
    '<th class="c">Edad</th><th>Etnia</th><th>Fecha de registro</th><th>Modalidad</th><th>Código de certificado</th></tr></thead>' +
    '<tbody>' + filas + '</tbody></table>' + resumen +

    '<div class="firmas">' + FORMATO.firmas.map((f) => '<div>' + escapar(f) + '</div>').join('') + '</div>' +

    '<div class="pie"><span>Total de participantes: ' + d.asistentes + '. Registro generado electrónicamente desde Nexus Learning el ' +
      escapar(fechaHora(new Date().toISOString())) + '. Cada certificado puede verificarse en ' + verificar + '</span>' +
      logoProveedor + '</div>' +

    '<script>(function(){' +
      // Esperar a que carguen los logos (máx. 8 s) antes de imprimir
      'var imgs=[].slice.call(document.images);' +
      'var listas=imgs.map(function(i){return i.complete?Promise.resolve():new Promise(function(r){i.onload=i.onerror=r;})});' +
      'var tope=new Promise(function(r){setTimeout(r,8000)});' +
      'Promise.race([Promise.all(listas),tope]).then(function(){setTimeout(function(){window.print()},300)});' +
    '})()<\/script></body></html>';

  const ventana = window.open('', '_blank');
  if (!ventana) { mostrarGlobal('El navegador bloqueó la ventana. Permita ventanas emergentes para este sitio.'); return; }
  ventana.document.open();
  ventana.document.write(html);
  ventana.document.close();
}

/* Mismas opciones que el test ATD de NEXUS, más "Prefiero no responder" */
const ETNIAS = {
  mestizo: 'Mestizo', blanco: 'Blanco', indigena: 'Indígena', montubio: 'Montubio',
  afroecuatoriano: 'Afroecuatoriano', otro: 'Otro', no_responde: 'No declara'
};

/* Edad cumplida en una fecha (ambas en formato AAAA-MM-DD) */
function edadEn(nacimiento, fecha) {
  const [an, mn, dn] = String(nacimiento).slice(0, 10).split('-').map(Number);
  const [af, mf, df] = String(fecha).slice(0, 10).split('-').map(Number);
  let edad = af - an;
  if (mf < mn || (mf === mn && df < dn)) edad--;
  return edad >= 0 && edad < 120 ? edad : null;
}

/* Convierte una ruta (absoluta o relativa al sitio de NEXUS) en una
   dirección completa http(s). Cualquier otra cosa se descarta. */
function direccionCompleta(ruta) {
  try {
    const url = new URL(String(ruta || ''), window.location.href);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch (e) {
    return null;
  }
}

function fechaLocal(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(new Date(iso));
}

function simplificar(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ============================================
   Utilidades
   ============================================ */

/* Trae todas las filas en bloques de 1000 (límite de Supabase) */
async function traerTodo(consulta) {
  const bloque = 1000;
  let desde = 0;
  const todo = [];
  for (;;) {
    const { data, error } = await consulta(desde, desde + bloque - 1);
    if (error) return { data: [], error };
    todo.push(...(data || []));
    if (!data || data.length < bloque) break;
    desde += bloque;
  }
  return { data: todo, error: null };
}

function normalizar(cedula) {
  return String(cedula || '').replace(/[\s.-]/g, '').toUpperCase();
}

function accesoVigente(a) {
  const ahora = new Date();
  return !a.anulado && ahora >= new Date(a.valido_desde) && ahora <= new Date(a.valido_hasta);
}

function fechaHora(iso) {
  return new Date(iso).toLocaleString('es-EC', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function mostrarGlobal(texto) {
  $('alerta-global').textContent = texto;
  $('alerta-global').hidden = false;
}

function ocultarGlobal() {
  $('alerta-global').hidden = true;
}

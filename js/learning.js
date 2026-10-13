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

   Nexus Learning es otro proyecto de Supabase, con su propio
   inicio de sesión. Por eso este módulo tiene un segundo cliente,
   separado del cliente único de NEXUS (supabase.js).
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina, empresasPermitidas, resolverEmpresaActiva } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar, formatearFecha } from './utils.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

/* --- Conexión a Nexus Learning ---
   URL y clave publicable: públicas por diseño. La seguridad la
   impone RLS en Nexus Learning: solo sus administradores leen. */
const LEARNING = {
  url: 'https://yfmefiytswvxsqmnmrvg.supabase.co',
  clave: 'sb_publishable_F3cIyhfFGoPurU4D0sNVWQ_jLugMPCO',
  panel: 'https://agrimroc88-lab.github.io/nexus-learning/empresas.html'
};

/* Cliente anclado al ámbito global (mismo motivo que supabase.js).
   · storageKey propio: no choca con nada de NEXUS.
   · sessionStorage: la conexión muere al cerrar la pestaña.
   · Sin refresco automático en segundo plano: evita el
     congelamiento descrito en supabase.js. El pase se renueva a
     mano en sesionLearning() cuando está por vencer. */
const learning = globalThis.__nexus_learning__ ??= createClient(LEARNING.url, LEARNING.clave, {
  auth: {
    storageKey: 'nexus_learning_sesion',
    storage: window.sessionStorage,
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

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
  grupo: 'faltan'
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
  $('btn-abrir-learning').href = LEARNING.panel;

  const sesion = await sesionLearning();
  if (sesion) await alConectar(sesion);
  else mostrarLogin();
}

/* ============================================
   Datos de NEXUS (solo lectura)
   ============================================ */

async function cargarNexus(empresaId) {
  const { data: emp, error } = await supabase
    .from('empresas')
    .select('id, ruc, razon_social')
    .eq('id', empresaId)
    .single();

  if (error || !emp) {
    mostrarGlobal('No fue posible leer la empresa en NEXUS: ' + (error?.message || 'sin datos'));
    $('aviso-inicial').hidden = true;
    return false;
  }
  estado.empresa = emp;

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
  return true;
}

/* ============================================
   Sesión en Nexus Learning
   ============================================ */

async function sesionLearning() {
  const { data } = await learning.auth.getSession();
  const sesion = data?.session;
  if (!sesion) return null;

  // Renovar si vence en menos de 2 minutos
  const restante = sesion.expires_at * 1000 - Date.now();
  if (restante < 120000) {
    const r = await learning.auth.refreshSession();
    return r.data?.session || null;
  }
  return sesion;
}

function mostrarLogin() {
  $('aviso-inicial').hidden = true;
  $('area-trabajo').hidden = true;
  $('panel-login').hidden = false;
  $('lrn-correo').focus();
}

async function conectar() {
  const correo = $('lrn-correo').value.trim();
  const clave = $('lrn-clave').value;
  const $alerta = $('alerta-login');
  $alerta.hidden = true;

  if (!correo || !clave) {
    $alerta.textContent = 'Escriba su correo y contraseña de Nexus Learning.';
    $alerta.hidden = false;
    return;
  }

  const $btn = $('btn-conectar');
  $btn.disabled = true;
  $btn.textContent = 'Conectando…';
  const { data, error } = await learning.auth.signInWithPassword({ email: correo, password: clave });
  $btn.disabled = false;
  $btn.textContent = 'Conectar';

  if (error || !data?.session) {
    $alerta.textContent = error?.status === 429
      ? 'Demasiados intentos. Espere unos minutos.'
      : 'Correo o contraseña incorrectos.';
    $alerta.hidden = false;
    return;
  }

  $('lrn-clave').value = '';
  await alConectar(data.session);
}

async function desconectar() {
  await learning.auth.signOut();
  mostrarLogin();
}

async function alConectar(sesion) {
  // ¿Es administrador en Nexus Learning?
  const { data: admin, error } = await learning
    .from('cap_administradores')
    .select('user_id')
    .eq('user_id', sesion.user.id)
    .maybeSingle();

  if (error) {
    mostrarLogin();
    $('alerta-login').textContent = 'No fue posible verificar la cuenta en Nexus Learning. Revise su conexión e intente de nuevo.';
    $('alerta-login').hidden = false;
    return;
  }
  if (!admin) {
    await learning.auth.signOut();
    mostrarLogin();
    $('alerta-login').textContent = 'Esa cuenta no es administradora de Nexus Learning.';
    $('alerta-login').hidden = false;
    return;
  }

  $('panel-login').hidden = true;
  $('aviso-inicial').hidden = true;
  $('area-trabajo').hidden = false;
  $('lrn-conectado').textContent = 'Conectado a Nexus Learning como ' + sesion.user.email;
  await cargarLearning();
}

/* ============================================
   Datos de Nexus Learning
   ============================================ */

async function cargarLearning() {
  ocultarGlobal();
  $('panel-detalle').hidden = true;

  if (!(await sesionLearning())) { mostrarLogin(); return; }

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
    .select('id, modalidad, evaluacion_presencial, horas, fecha_capacitacion, observaciones, creado_en, ' +
            'cap_cursos(titulo, horas), cap_accesos(tipo, codigo, valido_desde, valido_hasta, anulado)')
    .eq('empresa_id', lEmp.id)
    .order('creado_en', { ascending: false });

  if (conv.error) { mostrarGlobal('No fue posible leer las capacitaciones: ' + conv.error.message); return; }
  estado.convocatorias = conv.data || [];
  const ids = estado.convocatorias.map((c) => c.id);

  if (ids.length > 0) {
    const [insc, cert] = await Promise.all([
      traerTodo((d, h) => learning.from('cap_inscripciones')
        .select('convocatoria_id, cedula, nombres, modalidad, creado_en')
        .in('convocatoria_id', ids).order('creado_en').range(d, h)),
      traerTodo((d, h) => learning.from('cap_certificados')
        .select('convocatoria_id, cedula, nombres, codigo, tipo, nota, emitido_en')
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

  pintarResumen();
  pintarConvocatorias();
}

async function registrarEmpresa() {
  if (!(await sesionLearning())) { mostrarLogin(); return; }
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
  if (!(await sesionLearning())) { mostrarLogin(); return; }
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
  $('btn-conectar').addEventListener('click', conectar);
  $('lrn-clave').addEventListener('keydown', (e) => { if (e.key === 'Enter') conectar(); });
  $('btn-desconectar').addEventListener('click', desconectar);
  $('btn-registrar-empresa').addEventListener('click', registrarEmpresa);
  $('btn-actualizar-numero').addEventListener('click', actualizarNumero);
  $('btn-cerrar-detalle').addEventListener('click', cerrarDetalle);
  $('btn-exportar').addEventListener('click', exportar);
  $('d-buscar').addEventListener('input', pintarFilas);
  document.querySelectorAll('.lrn-pestana').forEach((b) =>
    b.addEventListener('click', () => elegirGrupo(b.dataset.grupo)));
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

/* ============================================
   NEXUS · auth.js
   Sesión, roles y guardia de acceso.
   MÉTODO SIMPLE: login con cédula + contraseña
   comparadas contra la tabla usuarios_app.
   La sesión se guarda en localStorage para
   persistir entre las distintas páginas.
   ARCHIVO COMPARTIDO — no modificar por módulo.
   ============================================ */

import { supabase } from './supabase.js?v=11';

export const ROLES = {
  ADMIN: 'admin',
  MEDICO: 'medico_ocupacional',
  TECNICO: 'tecnico_sst',
  ERGONOMO: 'ergonomo',
  CONSULTA: 'consulta',
  ENFERMERIA: 'enfermeria',
  PSICOLOGO: 'psicologo',
  TRABAJO_SOCIAL: 'trabajo_social',
  PSICO_SOCIAL: 'psico_social'
};

const BASE = '/Nexus/';
const CLAVE_SESION = 'nexus_sesion';
const CLAVE_EMPRESA = 'nexus_empresa_activa';

/* ============================================
   Sesión (localStorage)
   ============================================ */

/** Devuelve el perfil guardado en la sesión local, o null. */
export function sesionActual() {
  try {
    const s = localStorage.getItem(CLAVE_SESION);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function guardarSesion(perfil) {
  localStorage.setItem(CLAVE_SESION, JSON.stringify(perfil));
}

function borrarSesion() {
  localStorage.removeItem(CLAVE_SESION);
}

/* ============================================
   Empresa activa (localStorage)
   La empresa con la que se trabaja queda fija para toda
   la sesión, en vez de elegirse suelta en cada módulo.
   Se guarda en localStorage (no sessionStorage) para que
   no se pierda al cerrar una pestaña por accidente — solo
   se borra al cerrar sesión o al salir de empresa a propósito.
   ============================================ */

/** Id de la empresa activa guardada, o null si no hay ninguna. */
export function empresaActivaId() {
  return localStorage.getItem(CLAVE_EMPRESA);
}

function fijarEmpresaActiva(id) {
  localStorage.setItem(CLAVE_EMPRESA, id);
}

function limpiarEmpresaActiva() {
  localStorage.removeItem(CLAVE_EMPRESA);
}

/**
 * Botón "Salir de empresa": no cierra sesión, solo borra la
 * empresa activa y regresa a elegir otra.
 */
export function salirDeEmpresa() {
  limpiarEmpresaActiva();
  window.location.href = BASE + 'seleccionar-empresa.html';
}

/**
 * Resuelve cuál es la empresa activa a partir de la lista de
 * empresas permitidas para este usuario (ver empresasPermitidas).
 * - Una sola permitida: se fija sola, sin preguntar nada.
 * - Más de una y ya hay una guardada que sigue siendo válida:
 *   se respeta esa.
 * - Más de una y no hay ninguna guardada (o ya no es válida,
 *   p. ej. le quitaron esa empresa): manda a elegir y devuelve
 *   null — quien llama debe detenerse, la página va a cambiar.
 * @param {Array<{id, razon_social}>} permitidas
 * @returns {{id, razon_social}|null}
 */
export function resolverEmpresaActiva(permitidas) {
  if (permitidas.length === 1) {
    fijarEmpresaActiva(permitidas[0].id);
    return permitidas[0];
  }

  const guardada = empresaActivaId();
  const encontrada = permitidas.find((e) => e.id === guardada);
  if (encontrada) return encontrada;

  window.location.href = BASE + 'seleccionar-empresa.html';
  return null;
}

/**
 * Usada solo por seleccionar-empresa.js cuando el usuario elige
 * una empresa a mano entre varias.
 */
export function elegirEmpresaActiva(id) {
  fijarEmpresaActiva(id);
}

/**
 * Perfil del usuario en sesión. Se mantiene por compatibilidad
 * con los módulos que llaman a obtenerPerfil().
 */
export async function obtenerPerfil() {
  return sesionActual();
}

/* ============================================
   Permisos (idénticos a antes)
   ============================================ */

export function puedeVerClinica(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.MEDICO || rol === ROLES.ENFERMERIA;
}
export function esAdministrador(rol) {
  return rol === ROLES.ADMIN;
}
export function puedeGestionarFarmacia(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.ENFERMERIA;
}
export function puedeVerPsicologia(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.PSICOLOGO || rol === ROLES.PSICO_SOCIAL;
}
export function puedeVerTrabajoSocial(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.TRABAJO_SOCIAL ||
         rol === ROLES.PSICO_SOCIAL || rol === ROLES.MEDICO;
}
export function puedeEditarTrabajoSocial(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.TRABAJO_SOCIAL ||
         rol === ROLES.PSICO_SOCIAL;
}
export function puedeVerModulo(rol, modulo) {
  if (!modulo.roles || modulo.roles.length === 0) return true;
  return modulo.roles.includes(rol);
}

/* ============================================
   Autenticación (método simple)
   ============================================ */

/**
 * Inicia sesión comparando cédula + contraseña contra usuarios_app.
 * @param {string} cedula
 * @param {string} clave
 * @returns {Promise<{ok: boolean, mensaje: string}>}
 */
export async function iniciarSesion(cedula, clave) {
  const ced = String(cedula).replace(/\D/g, '');

  const { data, error } = await supabase
    .from('usuarios_app')
    .select('id, cedula, nombres, apellidos, rol, activo, registro_msp, titulo, cargo')
    .eq('cedula', ced)
    .eq('pass', clave)
    .maybeSingle();

  if (error) {
    return { ok: false, mensaje: 'Error de conexión. Intente de nuevo.' };
  }
  if (!data) {
    return { ok: false, mensaje: 'Cédula o contraseña incorrectas' };
  }
  if (!data.activo) {
    return { ok: false, mensaje: 'Usuario desactivado. Contacte al administrador.' };
  }

  guardarSesion(data);
  limpiarEmpresaActiva(); // sesión nueva: se vuelve a elegir la empresa
  return { ok: true, mensaje: 'Sesión iniciada' };
}

/** Cierra la sesión y vuelve al login. */
export async function cerrarSesion() {
  borrarSesion();
  limpiarEmpresaActiva();
  window.location.href = BASE + 'login.html';
}

/* ============================================
   Guardia de rutas
   ============================================ */

/**
 * Protege una página. Sin sesión → login.
 * Con roles indicados, valida el rol.
 * @param {string[]} rolesPermitidos - vacío = cualquiera con sesión
 * @returns {Promise<object|null>} perfil
 */
export async function protegerPagina(rolesPermitidos = []) {
  const perfil = sesionActual();

  if (!perfil) {
    window.location.href = BASE + 'login.html';
    return null;
  }

  // Revalidar contra la base: si lo desactivaron, sacarlo.
  const { data } = await supabase
    .from('usuarios_app')
    .select('id, cedula, nombres, apellidos, rol, activo, registro_msp, titulo, cargo')
    .eq('id', perfil.id)
    .maybeSingle();

  if (!data || data.activo === false) {
    borrarSesion();
    window.location.href = BASE + 'login.html';
    return null;
  }

  // Actualizar la sesión por si cambió el rol
  guardarSesion(data);

  if (rolesPermitidos.length > 0 && !rolesPermitidos.includes(data.rol)) {
    window.location.href = BASE + 'dashboard.html';
    return null;
  }

  return data;
}

/** Si ya hay sesión, va al dashboard. Se usa en login.html. */
export async function redirigirSiAutenticado() {
  if (sesionActual()) window.location.href = BASE + 'seleccionar-empresa.html';
}

/* ============================================
   Empresas permitidas por usuario
   ============================================ */

/**
 * Devuelve las empresas que el usuario puede ver.
 * - Admin: todas las empresas activas.
 * - Otros roles: solo las asignadas en usuario_empresas.
 * Cada módulo la usa para poblar su selector de empresa.
 * @param {object} perfil - perfil en sesión (de protegerPagina)
 * @returns {Promise<Array<{id, razon_social}>>}
 */
export async function empresasPermitidas(perfil) {
  // Admin ve todas
  if (perfil.rol === 'admin') {
    const { data } = await supabase
      .from('empresas')
      .select('id, razon_social')
      .eq('activo', true)
      .order('razon_social');
    return data || [];
  }

  // Otros: solo las asignadas
  const { data: asign } = await supabase
    .from('usuario_empresas')
    .select('empresa_id')
    .eq('usuario_id', perfil.id);

  const ids = (asign || []).map((a) => a.empresa_id);
  if (ids.length === 0) return [];

  const { data } = await supabase
    .from('empresas')
    .select('id, razon_social')
    .in('id', ids)
    .eq('activo', true)
    .order('razon_social');
  return data || [];
}

/* ============================================
   Módulos activables por empresa
   ============================================ */

/**
 * Módulos "opcionales": pueden encenderse o apagarse por empresa
 * desde Configuración. Los que no están en esta lista (Panel,
 * Trabajadores, Empresas, Usuarios, Configuración) son núcleo:
 * siempre están disponibles, no se apagan.
 */
export const MODULOS_OPCIONALES = [
  'salud_ocup', 'seguridad_ind', 'psicologia',
  'trabajo_social', 'atenciones', 'farmacia', 'certificados'
];

/**
 * Módulos opcionales activos para una empresa.
 * Si la empresa no tiene NINGUNA fila en empresa_modulos para un
 * módulo dado, ese módulo se considera ACTIVO por defecto — así
 * ninguna empresa existente (Agrimroc) pierde acceso a nada hasta
 * que un admin apague algo explícitamente desde Configuración.
 * @param {string|null} empresaId
 * @returns {Promise<Set<string>>} ids de módulos opcionales activos
 */
export async function modulosActivosEmpresa(empresaId) {
  if (!empresaId) return new Set(MODULOS_OPCIONALES);

  const { data, error } = await supabase
    .from('empresa_modulos')
    .select('modulo_id, activo')
    .eq('empresa_id', empresaId);

  if (error) {
    // Si la tabla no existe todavía o falla la lectura, no se
    // bloquea a nadie: se comporta como si todo estuviera activo.
    console.warn('NEXUS · empresa_modulos: no se pudo leer (' + error.message + '), se muestran todos los módulos por defecto');
    return new Set(MODULOS_OPCIONALES);
  }

  const apagados = new Set((data || []).filter((r) => r.activo === false).map((r) => r.modulo_id));
  return new Set(MODULOS_OPCIONALES.filter((m) => !apagados.has(m)));
}

/**
 * Enciende/apaga un módulo para una empresa. Usada solo desde la
 * pestaña "Módulos" de Configuración (admin).
 * @param {string} empresaId
 * @param {string} moduloId
 * @param {boolean} activo
 */
export async function fijarModuloEmpresa(empresaId, moduloId, activo) {
  const { error } = await supabase
    .from('empresa_modulos')
    .upsert(
      { empresa_id: empresaId, modulo_id: moduloId, activo, actualizado_en: new Date().toISOString() },
      { onConflict: 'empresa_id,modulo_id' }
    );
  return { ok: !error, mensaje: error?.message || '' };
}

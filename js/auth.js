/* ============================================
   NEXUS · auth.js
   Sesión, roles y guardia de acceso.
   MÉTODO SIMPLE: login con cédula + contraseña
   comparadas contra la tabla usuarios_app.
   La sesión se guarda en localStorage para
   persistir entre las distintas páginas.
   ARCHIVO COMPARTIDO — no modificar por módulo.
   ============================================ */

import { supabase } from './supabase.js';

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
    .select('id, cedula, nombres, apellidos, rol, activo')
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
  return { ok: true, mensaje: 'Sesión iniciada' };
}

/** Cierra la sesión y vuelve al login. */
export async function cerrarSesion() {
  borrarSesion();
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
    .select('id, cedula, nombres, apellidos, rol, activo')
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
  if (sesionActual()) window.location.href = BASE + 'dashboard.html';
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
  const { supabase } = await import('./supabase.js');

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

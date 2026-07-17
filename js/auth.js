/* ============================================
   NEXUS · auth.js
   Sesión, roles y guardia de acceso.
   ARCHIVO COMPARTIDO — no modificar por módulo.
   ============================================ */

import { supabase } from './supabase.js';

/* --- Catálogo de roles ---
   admin  : control total. Hereda permisos clínicos.
   medico_ocupacional : clínica, exámenes, aptitud, vigilancia.
   tecnico_sst : riesgos, inspecciones. Sin acceso clínico.
   ergonomo : evaluaciones ergonómicas.
   consulta : solo lectura, sin datos clínicos.        */

export const ROLES = {
  ADMIN: 'admin',
  MEDICO: 'medico_ocupacional',
  TECNICO: 'tecnico_sst',
  ERGONOMO: 'ergonomo',
  CONSULTA: 'consulta'
};

/* Ruta base del proyecto en GitHub Pages */
const BASE = '/Nexus/';

/* ============================================
   Sesión
   ============================================ */

/**
 * Devuelve la sesión activa o null.
 */
export async function obtenerSesion() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('[auth] Error al obtener sesión:', error.message);
    return null;
  }
  return data.session;
}

/**
 * Devuelve el usuario autenticado o null.
 */
export async function obtenerUsuario() {
  const sesion = await obtenerSesion();
  return sesion ? sesion.user : null;
}

/**
 * Devuelve el perfil extendido del usuario (incluye rol).
 * Consulta la tabla `perfiles`, creada en 001_tablas.sql.
 */
export async function obtenerPerfil() {
  const usuario = await obtenerUsuario();
  if (!usuario) return null;

  const { data, error } = await supabase
    .from('perfiles')
    .select('id, nombres, apellidos, rol, activo')
    .eq('id', usuario.id)
    .single();

  if (error) {
    console.error('[auth] Error al obtener perfil:', error.message);
    return null;
  }
  return data;
}

/* ============================================
   Permisos
   ============================================ */

/**
 * Verdadero si el rol puede acceder a información clínica.
 * Espeja la función tiene_permiso_clinico() de PostgreSQL.
 */
export function puedeVerClinica(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.MEDICO;
}

/**
 * Verdadero si el rol administra el sistema.
 */
export function esAdministrador(rol) {
  return rol === ROLES.ADMIN;
}

/* ============================================
   Autenticación
   ============================================ */

/**
 * Inicia sesión con correo y contraseña.
 * @returns {Promise<{ok: boolean, mensaje: string}>}
 */
export async function iniciarSesion(correo, clave) {
  const { error } = await supabase.auth.signInWithPassword({
    email: correo,
    password: clave
  });

  if (error) {
    return { ok: false, mensaje: traducirError(error.message) };
  }
  return { ok: true, mensaje: 'Sesión iniciada' };
}

/**
 * Cierra la sesión y redirige al login.
 */
export async function cerrarSesion() {
  await supabase.auth.signOut();
  window.location.href = BASE + 'login.html';
}

/* ============================================
   Guardia de rutas
   ============================================ */

/**
 * Protege una página. Si no hay sesión, redirige al login.
 * Si se indican roles permitidos, valida el rol del perfil.
 * @param {string[]} rolesPermitidos - vacío = cualquier autenticado
 * @returns {Promise<object|null>} perfil del usuario
 */
export async function protegerPagina(rolesPermitidos = []) {
  const sesion = await obtenerSesion();

  if (!sesion) {
    window.location.href = BASE + 'login.html';
    return null;
  }

  const perfil = await obtenerPerfil();

  if (!perfil || perfil.activo === false) {
    await supabase.auth.signOut();
    window.location.href = BASE + 'login.html';
    return null;
  }

  if (rolesPermitidos.length > 0 && !rolesPermitidos.includes(perfil.rol)) {
    window.location.href = BASE + 'dashboard.html';
    return null;
  }

  return perfil;
}

/**
 * Si ya hay sesión activa, envía al dashboard.
 * Se usa únicamente en login.html.
 */
export async function redirigirSiAutenticado() {
  const sesion = await obtenerSesion();
  if (sesion) window.location.href = BASE + 'dashboard.html';
}

/* ============================================
   Utilidad interna
   ============================================ */

function traducirError(mensaje) {
  const mapa = {
    'Invalid login credentials': 'Credenciales incorrectas',
    'Email not confirmed': 'Correo no confirmado',
    'User not found': 'Usuario no encontrado'
  };
  return mapa[mensaje] || 'No fue posible iniciar sesión';
}

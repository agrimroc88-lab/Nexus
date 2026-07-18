/* ============================================
   NEXUS · auth.js
   Sesión, roles y guardia de acceso.
   ARCHIVO COMPARTIDO — no modificar por módulo.
   ============================================ */

import { supabase } from './supabase.js';

/* --- Catálogo de roles ---
   admin              : control total. Hereda permisos clínicos.
   medico_ocupacional : clínica, exámenes, aptitud, vigilancia.
   tecnico_sst        : riesgos, inspecciones. Sin acceso clínico.
   ergonomo           : (en desuso) evaluaciones ergonómicas.
   consulta           : solo lectura, sin datos clínicos.
   enfermeria         : farmacia (único rol que registra movimientos).
   psicologo          : atención psicológica.
   trabajo_social     : ficha socioeconómica.
   psico_social       : temporal, une psicología + trabajo social
                        en una sola persona. Al separarse las funciones
                        se le cambia a un rol puro sin tocar código.     */

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
 * Verdadero si el rol puede acceder a información clínica de
 * atenciones médicas y salud ocupacional.
 * Enfermería entra al círculo clínico: registra atenciones y
 * gestiona salud ocupacional junto al médico.
 * Espeja la función tiene_permiso_clinico() de PostgreSQL.
 */
export function puedeVerClinica(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.MEDICO || rol === ROLES.ENFERMERIA;
}

/**
 * Verdadero si el rol administra el sistema.
 */
export function esAdministrador(rol) {
  return rol === ROLES.ADMIN;
}

/**
 * Verdadero si el rol registra movimientos de farmacia.
 * La lectura del módulo se controla en nav.js (campo roles);
 * la escritura real la impone la RLS de PostgreSQL.
 */
export function puedeGestionarFarmacia(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.ENFERMERIA;
}

/**
 * Verdadero si el rol usa el módulo de Psicología.
 */
export function puedeVerPsicologia(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.PSICOLOGO || rol === ROLES.PSICO_SOCIAL;
}

/**
 * Verdadero si el rol usa el módulo de Trabajo Social.
 * El médico entra solo en lectura (dato sensible del hogar).
 */
export function puedeVerTrabajoSocial(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.TRABAJO_SOCIAL ||
         rol === ROLES.PSICO_SOCIAL || rol === ROLES.MEDICO;
}

/**
 * Verdadero si el rol puede ESCRIBIR en Trabajo Social.
 * El médico ve pero no edita.
 */
export function puedeEditarTrabajoSocial(rol) {
  return rol === ROLES.ADMIN || rol === ROLES.TRABAJO_SOCIAL ||
         rol === ROLES.PSICO_SOCIAL;
}

/**
 * Evalúa si un rol puede ver un módulo del catálogo (nav.js).
 * Si el módulo declara una lista `roles`, se exige pertenencia.
 * Si no la declara, el módulo es visible para cualquier rol.
 * @param {string} rol - rol del perfil
 * @param {object} modulo - entrada del catálogo MODULOS
 */
export function puedeVerModulo(rol, modulo) {
  if (!modulo.roles || modulo.roles.length === 0) return true;
  return modulo.roles.includes(rol);
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

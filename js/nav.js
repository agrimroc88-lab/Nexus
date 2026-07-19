/* ============================================
   NEXUS · nav.js
   Barra lateral compartida por todos los módulos.
   ARCHIVO COMPARTIDO — un solo punto de verdad
   para el catálogo de módulos del sistema.
   ============================================ */

import { cerrarSesion, puedeVerModulo } from './auth.js';

/* --- Catálogo de módulos ---
   Orden de aparición en el sidebar = orden de este arreglo.

   listo : habilita el enlace. Cambiar a true al construir el módulo.
           Mientras sea false, el enlace se muestra en gris (inactivo).
   roles : lista de roles que VEN el módulo. Si se omite, lo ven todos.
           La ESCRITURA real la impone siempre la RLS de PostgreSQL;
           esta lista solo controla la visibilidad del enlace.          */

export const MODULOS = [
  { id: 'dashboard',     texto: 'Panel general',        archivo: 'dashboard.html',            listo: true  },
  { id: 'empresas',      texto: 'Empresas',             archivo: 'empresas.html',             listo: true  },
  { id: 'trabajadores',  texto: 'Trabajadores',         archivo: 'trabajadores.html',         listo: true  },
  { id: 'salud_ocup',    texto: 'Salud ocupacional',    archivo: 'salud-ocupacional.html',    listo: true,
    roles: ['admin', 'medico_ocupacional', 'enfermeria'] },
  { id: 'psicologia',    texto: 'Psicología',           archivo: 'psicologia.html',           listo: true,
    roles: ['admin', 'psicologo', 'psico_social'] },
  { id: 'seguridad_ind', texto: 'Seguridad industrial', archivo: 'seguridad-industrial.html', listo: true,
    roles: ['admin', 'tecnico_sst'] },
  { id: 'trabajo_social',texto: 'Trabajo Social',       archivo: 'trabajo-social.html',       listo: false,
    roles: ['admin', 'trabajo_social', 'psico_social', 'medico_ocupacional'] },
  { id: 'atenciones',    texto: 'Atenciones médicas',   archivo: 'atenciones.html',           listo: true,
    roles: ['admin', 'medico_ocupacional', 'enfermeria'] },
  { id: 'farmacia',      texto: 'Farmacia',             archivo: 'farmacia.html',             listo: true,
    roles: ['admin', 'enfermeria'] },
  { id: 'certificados',  texto: 'Certificados médicos', archivo: 'certificados.html',         listo: true }
];

/**
 * Construye la barra lateral y la cabecera de usuario.
 * @param {object} perfil - perfil devuelto por protegerPagina()
 * @param {string} moduloActivo - id del módulo actual
 */
export function montarNavegacion(perfil, moduloActivo) {
  pintarUsuario(perfil);
  pintarEnlaces(perfil, moduloActivo);
  conectarEventos();
}

function pintarUsuario(perfil) {
  const $nombre = document.getElementById('usuario-nombre');
  const $rol = document.getElementById('usuario-rol');
  if ($nombre) $nombre.textContent = `${perfil.nombres} ${perfil.apellidos}`;
  if ($rol) $rol.textContent = perfil.rol.replace(/_/g, ' ');
}

function pintarEnlaces(perfil, moduloActivo) {
  const $nav = document.getElementById('lateral-nav');
  if (!$nav) return;

  const fragmento = document.createDocumentFragment();

  MODULOS.forEach((modulo) => {
    // Filtro de visibilidad por rol. Si el módulo no declara `roles`,
    // puedeVerModulo() devuelve true y lo ven todos.
    if (!puedeVerModulo(perfil.rol, modulo)) return;

    const enlace = document.createElement('a');
    enlace.className = 'nav-enlace';
    enlace.textContent = modulo.texto;

    if (modulo.listo) {
      enlace.href = modulo.archivo;
      if (modulo.id === moduloActivo) enlace.classList.add('activo');
    } else {
      enlace.classList.add('inactivo');
      enlace.title = 'Módulo en construcción';
    }

    fragmento.appendChild(enlace);
  });

  $nav.appendChild(fragmento);
}

function conectarEventos() {
  const $salir = document.getElementById('btn-salir');
  const $menu = document.getElementById('btn-menu');
  const $lateral = document.getElementById('barra-lateral');

  if ($salir) $salir.addEventListener('click', cerrarSesion);
  if ($menu && $lateral) {
    $menu.addEventListener('click', () => $lateral.classList.toggle('abierta'));
  }
}

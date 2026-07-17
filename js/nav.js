/* ============================================
   NEXUS · nav.js
   Barra lateral compartida por todos los módulos.
   ARCHIVO COMPARTIDO — un solo punto de verdad
   para el catálogo de módulos del sistema.
   ============================================ */

import { cerrarSesion, puedeVerClinica } from './auth.js';

/* --- Catálogo de módulos ---
   listo   : habilita el enlace. Cambiar a true al construir el módulo.
   clinico : oculto para roles sin permiso clínico (secreto médico).
   admin   : visible solo para administradores.                        */

export const MODULOS = [
  { id: 'dashboard',    texto: 'Panel general',      archivo: 'dashboard.html',         listo: true,  clinico: false },
  { id: 'empresas',     texto: 'Empresas',           archivo: 'empresas.html',          listo: true,  clinico: false },
  { id: 'trabajadores', texto: 'Trabajadores',       archivo: 'trabajadores.html',      listo: true,  clinico: false },
  { id: 'atenciones',   texto: 'Atenciones médicas', archivo: 'atenciones.html',        listo: true,  clinico: true  },
  { id: 'farmacia',     texto: 'Farmacia',           archivo: 'farmacia.html',          listo: true,  clinico: true  },
  { id: 'salud_ocup',   texto: 'Salud ocupacional',  archivo: 'salud-ocupacional.html', listo: true,  clinico: true  },
  { id: 'ergonomia',    texto: 'Ergonomía',          archivo: 'ergonomia.html',         listo: false, clinico: false },
  { id: 'inspecciones', texto: 'Inspecciones',       archivo: 'inspecciones.html',      listo: false, clinico: false }
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
    if (modulo.clinico && !puedeVerClinica(perfil.rol)) return;

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

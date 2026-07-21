/* ============================================
   NEXUS · nav.js
   Barra lateral compartida por todos los módulos.
   ARCHIVO COMPARTIDO — un solo punto de verdad
   para el catálogo de módulos del sistema.
   ============================================ */

import { cerrarSesion, puedeVerModulo } from './auth.js';
import { supabase } from './supabase.js';

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
  { id: 'trabajo_social',texto: 'Trabajo Social',       archivo: 'trabajo-social.html',       listo: true,
    roles: ['admin', 'trabajo_social', 'psico_social', 'medico_ocupacional'] },
  { id: 'atenciones',    texto: 'Atenciones médicas',   archivo: 'atenciones.html',           listo: true,
    roles: ['admin', 'medico_ocupacional', 'enfermeria'] },
  { id: 'farmacia',      texto: 'Farmacia',             archivo: 'farmacia.html',             listo: true,
    roles: ['admin', 'enfermeria'] },
  { id: 'certificados',  texto: 'Certificados médicos', archivo: 'certificados.html',         listo: true },
  { id: 'usuarios',      texto: 'Usuarios',             archivo: 'usuarios.html',             listo: true,
    roles: ['admin'] },
  { id: 'configuracion', texto: 'Configuración',        archivo: 'configuracion.html',        listo: true,
    roles: ['admin'], abajo: true }
];

/**
 * Construye la barra lateral y la cabecera de usuario.
 * @param {object} perfil - perfil devuelto por protegerPagina()
 * @param {string} moduloActivo - id del módulo actual
 */
export function montarNavegacion(perfil, moduloActivo) {
  pintarMarca();
  pintarTituloEmpresa();
  pintarUsuario(perfil);
  pintarEnlaces(perfil, moduloActivo);
  conectarEventos();
  aplicarConfigVisual();  // lee config_sistema y ajusta tamaños (asíncrono)
}

/* Lee la configuración visual guardada y la aplica al logo
   y al nombre en TODAS las páginas. Si falla, deja los valores
   por defecto del CSS. */
async function aplicarConfigVisual() {
  try {
    const { data } = await supabase
      .from('config_sistema').select('*').eq('id', 1).maybeSingle();
    if (!data) return;

    const $logo = document.querySelector('.lateral-logo');
    if ($logo && data.logo_tam) $logo.style.maxWidth = data.logo_tam + 'px';

    const $nombre = document.querySelector('.empresa-nombre');
    if ($nombre && data.nombre_tam) $nombre.style.fontSize = data.nombre_tam + 'px';

    const $tit = document.querySelector('.empresa-titulo');
    if ($tit && data.nombre_pos) {
      // Reposicionar el título en la cabecera
      if (data.nombre_pos === 'izquierda') {
        $tit.style.left = '4.5rem';
        $tit.style.transform = 'none';
        $tit.style.textAlign = 'left';
        $tit.style.alignItems = 'flex-start';
      } else if (data.nombre_pos === 'derecha') {
        $tit.style.left = 'auto';
        $tit.style.right = '14rem';
        $tit.style.transform = 'none';
        $tit.style.textAlign = 'right';
        $tit.style.alignItems = 'flex-end';
      } else {
        $tit.style.left = '50%';
        $tit.style.transform = 'translateX(-50%)';
        $tit.style.textAlign = 'center';
        $tit.style.alignItems = 'center';
      }
    }
  } catch (_) { /* silencioso: usa defaults */ }
}

/* Logo de Agrimroc en el sidebar (reemplaza el texto NEXUS).
   Ruta relativa: logo.png en la raíz del repo. */
function pintarMarca() {
  const $marca = document.querySelector('.lateral-marca');
  if (!$marca) return;
  $marca.innerHTML =
    '<img src="logo.png" alt="Minera Agrimroc S.A." class="lateral-logo">';
}

/* Título centrado en la cabecera: AGRIMROC S.A + USSO. */
function pintarTituloEmpresa() {
  const $cab = document.querySelector('.cabecera');
  if (!$cab || document.querySelector('.empresa-titulo')) return;

  const div = document.createElement('div');
  div.className = 'empresa-titulo';
  div.innerHTML =
    '<span class="empresa-nombre">AGRIMROC S.A.</span>' +
    '<span class="empresa-sub">USSO · Unidad de Seguridad y Salud Ocupacional</span>';

  // Insertar centrado: después del título del módulo
  const $titulo = $cab.querySelector('.cabecera-titulo');
  if ($titulo) $titulo.after(div);
  else $cab.appendChild(div);
}

function pintarUsuario(perfil) {
  const $nombre = document.getElementById('usuario-nombre');
  const $rol = document.getElementById('usuario-rol');
  if ($nombre) $nombre.textContent = `${perfil.nombres} ${perfil.apellidos}`;
  if ($rol) $rol.textContent = perfil.rol.replace(/_/g, ' ');

  // Botón de cerrar sesión en la cabecera, debajo del nombre
  const $usuario = document.querySelector('.cabecera-usuario');
  if ($usuario && !document.getElementById('btn-salir-cabecera')) {
    const btn = document.createElement('button');
    btn.id = 'btn-salir-cabecera';
    btn.className = 'btn-salir-cabecera';
    btn.type = 'button';
    btn.textContent = 'Cerrar sesión';
    btn.addEventListener('click', cerrarSesion);
    $usuario.appendChild(btn);
  }
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
    // Los que llevan `abajo: true` se empujan al fondo del sidebar
    if (modulo.abajo) enlace.classList.add('nav-abajo');
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

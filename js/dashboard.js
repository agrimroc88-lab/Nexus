/* ============================================
   NEXUS · dashboard.js
   Lógica exclusiva de dashboard.html
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina, cerrarSesion, puedeVerClinica, esAdministrador } from './auth.js';

/* --- Catálogo de módulos ---
   'listo' controla si el enlace está habilitado.
   Al construir cada módulo, cambiar a true. */

const MODULOS = [
  { id: 'dashboard',    texto: 'Panel general',  archivo: 'dashboard.html',    listo: true,  clinico: false },
  { id: 'empresas',     texto: 'Empresas',       archivo: 'empresas.html',     listo: false, clinico: false },
  { id: 'trabajadores', texto: 'Trabajadores',   archivo: 'trabajadores.html', listo: false, clinico: false },
  { id: 'examenes',     texto: 'Exámenes',       archivo: 'examenes.html',     listo: false, clinico: true  },
  { id: 'vigilancia',   texto: 'Vigilancia',     archivo: 'vigilancia.html',   listo: false, clinico: true  },
  { id: 'ergonomia',    texto: 'Ergonomía',      archivo: 'ergonomia.html',    listo: false, clinico: false },
  { id: 'inspecciones', texto: 'Inspecciones',   archivo: 'inspecciones.html', listo: false, clinico: false },
  { id: 'indicadores',  texto: 'Indicadores',    archivo: 'indicadores.html',  listo: false, clinico: false }
];

const $nav = document.getElementById('lateral-nav');
const $nombre = document.getElementById('usuario-nombre');
const $rol = document.getElementById('usuario-rol');
const $salir = document.getElementById('btn-salir');
const $menu = document.getElementById('btn-menu');
const $lateral = document.getElementById('barra-lateral');

iniciar();

/* --- Arranque --- */

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  pintarUsuario(perfil);
  pintarNavegacion(perfil);
  cargarIndicadores();
}

/* --- Interfaz --- */

function pintarUsuario(perfil) {
  $nombre.textContent = `${perfil.nombres} ${perfil.apellidos}`;
  $rol.textContent = perfil.rol.replace(/_/g, ' ');
}

function pintarNavegacion(perfil) {
  const fragmento = document.createDocumentFragment();

  MODULOS.forEach((modulo) => {
    /* Filtro clínico: roles no clínicos no ven módulos clínicos */
    if (modulo.clinico && !puedeVerClinica(perfil.rol)) return;

    const enlace = document.createElement('a');
    enlace.className = 'nav-enlace';
    enlace.textContent = modulo.texto;

    if (modulo.listo) {
      enlace.href = modulo.archivo;
      if (modulo.id === 'dashboard') enlace.classList.add('activo');
    } else {
      enlace.classList.add('inactivo');
      enlace.title = 'Módulo en construcción';
    }

    fragmento.appendChild(enlace);
  });

  $nav.appendChild(fragmento);
}

/* --- Datos --- */

async function cargarIndicadores() {
  const tablas = [
    { tabla: 'empresas',   destino: 'kpi-empresas' },
    { tabla: 'sucursales', destino: 'kpi-sucursales' },
    { tabla: 'areas',      destino: 'kpi-areas' },
    { tabla: 'cargos',     destino: 'kpi-cargos' }
  ];

  for (const item of tablas) {
    const { count, error } = await supabase
      .from(item.tabla)
      .select('*', { count: 'exact', head: true })
      .eq('activo', true);

    document.getElementById(item.destino).textContent = error ? '—' : (count ?? 0);
  }
}

/* --- Eventos --- */

$salir.addEventListener('click', cerrarSesion);

$menu.addEventListener('click', () => {
  $lateral.classList.toggle('abierta');
});

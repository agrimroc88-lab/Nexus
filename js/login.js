/* ============================================
   NEXUS · login.js
   Lógica exclusiva de login.html
   ============================================ */

import { iniciarSesion, redirigirSiAutenticado } from './auth.js';

const BASE = '/Nexus/';

/* ============================================
   Video de fondo según la temporada
   Cada entrada es un rango de fechas (mes, día) y el archivo que
   le corresponde. "hastaMD" puede ser menor que "desdeMD" (p. ej.
   Navidad: del 15 dic al 6 ene) — fechaEnRango() lo entiende como
   un rango que cruza el fin de año.

   Para agregar una temporada nueva: sube el video a img/ y agrega
   una línea aquí con sus fechas. Si dos rangos se llegaran a
   traslapar, gana el primero que aparezca en la lista.
   ============================================ */

const TEMPORADAS = [
  // { nombre: 'Halloween',      desdeMD: [10, 15], hastaMD: [10, 31], archivo: 'img/login-fondo-halloween.mp4' },
  // { nombre: 'Navidad',        desdeMD: [12, 15], hastaMD: [1, 6],   archivo: 'img/login-fondo-navidad.mp4' },
  // { nombre: 'Día del Trabajador', desdeMD: [4, 28], hastaMD: [5, 2], archivo: 'img/login-fondo-trabajador.mp4' },
];

const VIDEO_POR_DEFECTO = 'img/login-fondo.mp4';

function fechaEnRango(hoy, [mesDesde, diaDesde], [mesHasta, diaHasta]) {
  const num = (mes, dia) => mes * 100 + dia; // "1225" = 25 de diciembre, fácil de comparar
  const actual = num(hoy.getMonth() + 1, hoy.getDate());
  const desde = num(mesDesde, diaDesde);
  const hasta = num(mesHasta, diaHasta);

  return desde <= hasta
    ? (actual >= desde && actual <= hasta)      // rango normal, dentro del mismo año
    : (actual >= desde || actual <= hasta);     // rango que cruza el 31 de diciembre
}

function elegirVideoDeTemporada() {
  const hoy = new Date();
  const activa = TEMPORADAS.find((t) => fechaEnRango(hoy, t.desdeMD, t.hastaMD));
  return activa ? activa.archivo : VIDEO_POR_DEFECTO;
}

const $video = document.getElementById('video-fondo');
$video.src = elegirVideoDeTemporada();
$video.load();

const $correo = document.getElementById('correo');
const $clave = document.getElementById('clave');
const $boton = document.getElementById('btn-ingresar');
const $mensaje = document.getElementById('mensaje');

/* Si ya hay sesión activa, no mostrar el login */
redirigirSiAutenticado();

/* Si venimos de un cierre automático por inactividad, avisar */
if (new URLSearchParams(window.location.search).get('motivo') === 'inactividad') {
  mostrarMensaje('Tu sesión se cerró por inactividad. Ingresa de nuevo.');
}

/* --- Eventos --- */

$boton.addEventListener('click', procesarIngreso);

$clave.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') procesarIngreso();
});

$correo.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $clave.focus();
});

/* --- Lógica --- */

async function procesarIngreso() {
  const correo = $correo.value.trim();
  const clave = $clave.value;

  ocultarMensaje();

  if (!correo || !clave) {
    mostrarMensaje('Ingrese su cédula y contraseña');
    return;
  }

  bloquear(true);
  const resultado = await iniciarSesion(correo, clave);

  if (!resultado.ok) {
    mostrarMensaje(resultado.mensaje);
    bloquear(false);
    return;
  }

  window.location.href = BASE + 'seleccionar-empresa.html';
}

/* --- Interfaz --- */

function mostrarMensaje(texto) {
  $mensaje.textContent = texto;
  $mensaje.hidden = false;
}

function ocultarMensaje() {
  $mensaje.hidden = true;
}

function bloquear(estado) {
  $boton.disabled = estado;
  $boton.textContent = estado ? 'Verificando…' : 'Ingresar';
}

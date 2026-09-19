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
  { nombre: 'Halloween',   desdeMD: [10, 20], hastaMD: [10, 31], archivo: 'img/login-fondo-halloween.mp4' },
  { nombre: 'Navidad',     desdeMD: [12, 10], hastaMD: [12, 27], archivo: 'img/login-fondo-navidad.mp4' },
  { nombre: 'Fin de año',  desdeMD: [12, 28], hastaMD: [1, 2],   archivo: 'img/login-fondo-finanio.mp4' },
  { nombre: 'Reyes Magos', desdeMD: [1, 5],   hastaMD: [1, 6],   archivo: 'img/login-fondo-reyes.mp4' },
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

/* ============================================
   Marco del video (ver login.css, .acceso-marco-video)

   "object-fit: cover" en el <video> llena toda la pantalla sin
   dejar márgenes, recortando lo que sobra por los lados o por
   arriba/abajo según la forma de la pantalla — pero no expone
   ese cálculo a nada más, así que si uno posiciona los campos
   con % directamente sobre la ventana, se desalinean del dibujo
   en cuanto cambia el tamaño de pantalla. Esto reproduce el
   mismo cálculo que hace "cover" por dentro, y lo aplica a un
   marco del tamaño exacto del video (1280×720) para que los
   campos —puestos en % sobre ESE marco, en el centro, donde
   "cover" nunca recorta— queden siempre pegados al mismo lugar.
   ============================================ */

const VIDEO_ANCHO = 1920;
const VIDEO_ALTO = 1080;
const $marco = document.getElementById('marco-video');
const $escena = document.getElementById('acceso-escena');

function ajustarMarcoVideo() {
  const vw = $escena.clientWidth;
  const vh = $escena.clientHeight;
  const razonVideo = VIDEO_ANCHO / VIDEO_ALTO;
  const razonPantalla = vw / vh;

  let ancho, alto, left, top;
  if (razonPantalla > razonVideo) {
    // Pantalla más "ancha" que el video: se recorta arriba/abajo.
    // Se ancla ABAJO (igual que object-position: center bottom en
    // el <video>) para proteger el escudo y "NEXUS", que viven en
    // la parte baja del video — lo que se pierde es de la parte
    // de arriba (paneles, ADN), que importa menos.
    ancho = vw;
    alto = vw / razonVideo;
    left = 0;
    top = vh - alto;
  } else {
    // Pantalla más "alta" que el video: se recorta a los lados,
    // parejo (no hay un lado más importante que el otro aquí)
    alto = vh;
    ancho = vh * razonVideo;
    left = (vw - ancho) / 2;
    top = 0;
  }

  $marco.style.width = `${ancho}px`;
  $marco.style.height = `${alto}px`;
  $marco.style.left = `${left}px`;
  $marco.style.top = `${top}px`;
  $marco.style.setProperty('--escala-video', String(ancho / VIDEO_ANCHO));
}

ajustarMarcoVideo();
window.addEventListener('resize', ajustarMarcoVideo);

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

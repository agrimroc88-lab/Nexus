/* ============================================
   NEXUS · bienvenida.js
   Lógica exclusiva de index.html
   ============================================ */

import { videoDeBienvenida } from './tema-temporada.js';

const BASE = '/Nexus/';
const VIDEO_POR_DEFECTO = 'img/bienvenida.mp4';

const $video = document.getElementById('video-bienvenida');

/* Si el tema activo pide un video de bienvenida que todavía no
   subiste (ej. img/bienvenida-navidad.mp4 no existe), esto lo
   detecta solo y cae de vuelta al de siempre — no hace falta
   tener un video de bienvenida para cada tema desde el día uno. */
$video.addEventListener('error', () => {
  if ($video.src.endsWith('bienvenida.mp4')) return; // ya es el de respaldo, no hay más a qué caer
  $video.src = VIDEO_POR_DEFECTO;
  $video.load();
});

/* El video normal arranca YA, sin esperar la consulta a la base
   — así la bienvenida nunca se queda en negro. Si hay un tema
   especial activo, se cambia sobre la marcha. */
$video.src = VIDEO_POR_DEFECTO;
$video.load();

videoDeBienvenida().then((src) => {
  if (src !== VIDEO_POR_DEFECTO) {
    $video.src = src;
    $video.load();
  }
});

document.getElementById('pantalla-bienvenida').addEventListener('click', continuar);

function continuar() {
  sessionStorage.setItem('nexus_vio_bienvenida', '1');
  window.location.href = BASE + 'login.html';
}

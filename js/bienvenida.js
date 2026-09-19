/* ============================================
   NEXUS · bienvenida.js
   Lógica exclusiva de index.html
   ============================================ */

const BASE = '/Nexus/';

const $video = document.getElementById('video-bienvenida');
$video.src = 'img/bienvenida.mp4';
$video.load();

document.getElementById('pantalla-bienvenida').addEventListener('click', continuar);

function continuar() {
  sessionStorage.setItem('nexus_vio_bienvenida', '1');
  window.location.href = BASE + 'login.html';
}

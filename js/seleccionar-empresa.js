/* ============================================
   NEXUS · seleccionar-empresa.js
   Lógica exclusiva de seleccionar-empresa.html

   Punto de paso obligatorio entre iniciar sesión y
   cualquier módulo: decide con qué empresa se va a
   trabajar durante toda la sesión.
    · 0 empresas asignadas → aviso, no deja continuar.
    · 1 empresa asignada   → se fija sola, ni se muestra
      esta pantalla (rebote inmediato al Panel).
    · 2+ empresas          → el usuario elige una tarjeta.
   ============================================ */

import { protegerPagina, empresasPermitidas, elegirEmpresaActiva, cerrarSesion }
  from './auth.js';

const BASE = '/Nexus/';

/* Mismo criterio de temporada que login.js — si se agrega una
   temporada nueva ahí, hay que replicarla aquí también (son dos
   páginas de acceso, cada una con su propio <video>). */
const TEMPORADAS = [
  { desdeMD: [10, 20], hastaMD: [10, 31], archivo: 'img/login-fondo-halloween.mp4' },
  { desdeMD: [12, 10], hastaMD: [12, 27], archivo: 'img/login-fondo-navidad.mp4' },
  { desdeMD: [12, 28], hastaMD: [1, 2],   archivo: 'img/login-fondo-finanio.mp4' },
  { desdeMD: [1, 5],   hastaMD: [1, 6],   archivo: 'img/login-fondo-reyes.mp4' },
];
const VIDEO_POR_DEFECTO = 'img/login-fondo.mp4';

function fechaEnRango(hoy, [mesDesde, diaDesde], [mesHasta, diaHasta]) {
  const num = (mes, dia) => mes * 100 + dia;
  const actual = num(hoy.getMonth() + 1, hoy.getDate());
  const desde = num(mesDesde, diaDesde);
  const hasta = num(mesHasta, diaHasta);
  return desde <= hasta ? (actual >= desde && actual <= hasta) : (actual >= desde || actual <= hasta);
}

const $video = document.getElementById('video-fondo');
if ($video) {
  const hoy = new Date();
  const activa = TEMPORADAS.find((t) => fechaEnRango(hoy, t.desdeMD, t.hastaMD));
  $video.src = activa ? activa.archivo : VIDEO_POR_DEFECTO;
  $video.load();
}

const $lista = document.getElementById('sel-emp-lista');
const $mensaje = document.getElementById('mensaje');
const $btnCerrarSesion = document.getElementById('btn-cerrar-sesion');

if ($btnCerrarSesion) $btnCerrarSesion.addEventListener('click', cerrarSesion);

iniciar();

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  const permitidas = await empresasPermitidas(perfil);

  if (permitidas.length === 0) {
    mostrarMensaje(
      'Tu usuario no tiene ninguna empresa asignada. Contacta al administrador.'
    );
    return;
  }

  if (permitidas.length === 1) {
    // Nada que elegir: se fija sola y sigue derecho al Panel.
    elegirEmpresaActiva(permitidas[0].id);
    window.location.href = BASE + 'dashboard.html';
    return;
  }

  pintarOpciones(permitidas);
}

function pintarOpciones(empresas) {
  $lista.innerHTML = '';

  empresas.forEach((e) => {
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = 'sel-emp-opcion';
    boton.innerHTML =
      `<span>${escapar(e.razon_social)}</span><span class="sel-emp-flecha">→</span>`;
    boton.addEventListener('click', () => elegir(e.id));
    $lista.appendChild(boton);
  });
}

function elegir(id) {
  elegirEmpresaActiva(id);
  window.location.href = BASE + 'dashboard.html';
}

function mostrarMensaje(texto) {
  $mensaje.textContent = texto;
  $mensaje.hidden = false;
}

/* Copia local mínima: este archivo no depende de utils.js
   para no arrastrar el resto de sus helpers en la pantalla
   más liviana de todo el sistema. */
function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

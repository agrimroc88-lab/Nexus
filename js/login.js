/* ============================================
   NEXUS · login.js
   Lógica exclusiva de login.html
   ============================================ */

import { iniciarSesion, redirigirSiAutenticado } from './auth.js';

const BASE = '/Nexus/';

const $correo = document.getElementById('correo');
const $clave = document.getElementById('clave');
const $boton = document.getElementById('btn-ingresar');
const $mensaje = document.getElementById('mensaje');

/* Si ya hay sesión activa, no mostrar el login */
redirigirSiAutenticado();

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
    mostrarMensaje('Ingrese correo y contraseña');
    return;
  }

  bloquear(true);
  const resultado = await iniciarSesion(correo, clave);

  if (!resultado.ok) {
    mostrarMensaje(resultado.mensaje);
    bloquear(false);
    return;
  }

  window.location.href = BASE + 'dashboard.html';
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

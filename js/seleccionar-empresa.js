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

import { protegerPagina, empresasPermitidas, elegirEmpresaActiva }
  from './auth.js';

const BASE = '/Nexus/';

const $lista = document.getElementById('sel-emp-lista');
const $mensaje = document.getElementById('mensaje');

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

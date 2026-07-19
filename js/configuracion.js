/* ============================================
   NEXUS · configuracion.js
   Ajustes visuales del sistema (solo admin).
   Tamaño del logo, tamaño y posición del nombre.
   Se guarda en config_sistema (para todos).
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina } from './auth.js';
import { montarNavegacion } from './nav.js';

const estado = {
  logo_tam: 200,
  nombre_tam: 26,
  nombre_pos: 'centro'
};

iniciar();

async function iniciar() {
  const perfil = await protegerPagina(['admin']);
  if (!perfil) return;
  montarNavegacion(perfil, 'configuracion');

  await cargar();
  conectar();
  aplicarPrevia();
}

async function cargar() {
  const { data } = await supabase
    .from('config_sistema').select('*').eq('id', 1).maybeSingle();
  if (data) {
    estado.logo_tam = data.logo_tam ?? 200;
    estado.nombre_tam = data.nombre_tam ?? 26;
    estado.nombre_pos = data.nombre_pos ?? 'centro';
  }
  // Reflejar en los controles
  document.getElementById('cfg-logo-tam').value = estado.logo_tam;
  document.getElementById('cfg-nombre-tam').value = estado.nombre_tam;
  document.getElementById('val-logo-tam').textContent = estado.logo_tam;
  document.getElementById('val-nombre-tam').textContent = estado.nombre_tam;
  marcarPos(estado.nombre_pos);
}

function marcarPos(pos) {
  document.querySelectorAll('.pos-btn').forEach((b) =>
    b.classList.toggle('activa', b.dataset.pos === pos));
}

function aplicarPrevia() {
  document.getElementById('previa-logo').style.width = estado.logo_tam + 'px';
  const $nombre = document.getElementById('previa-nombre');
  $nombre.style.fontSize = estado.nombre_tam + 'px';

  const $tit = document.getElementById('previa-titulo');
  const map = { izquierda: 'flex-start', centro: 'center', derecha: 'flex-end' };
  $tit.style.alignItems = map[estado.nombre_pos] || 'center';
  $tit.style.textAlign = estado.nombre_pos === 'izquierda' ? 'left'
    : estado.nombre_pos === 'derecha' ? 'right' : 'center';
}

async function guardar() {
  const $g = document.getElementById('config-guardado');
  const { error } = await supabase.from('config_sistema').update({
    logo_tam: estado.logo_tam,
    nombre_tam: estado.nombre_tam,
    nombre_pos: estado.nombre_pos,
    modificado_en: new Date().toISOString()
  }).eq('id', 1);

  if (error) {
    const $a = document.getElementById('alerta-config');
    $a.textContent = 'No fue posible guardar: ' + error.message;
    $a.hidden = false;
    return;
  }
  document.getElementById('alerta-config').hidden = true;
  $g.textContent = 'Guardado. Recargue las páginas para ver el cambio.';
  setTimeout(() => { $g.textContent = ''; }, 4000);
}

function restaurar() {
  estado.logo_tam = 200;
  estado.nombre_tam = 26;
  estado.nombre_pos = 'centro';
  document.getElementById('cfg-logo-tam').value = 200;
  document.getElementById('cfg-nombre-tam').value = 26;
  document.getElementById('val-logo-tam').textContent = 200;
  document.getElementById('val-nombre-tam').textContent = 26;
  marcarPos('centro');
  aplicarPrevia();
}

function conectar() {
  document.getElementById('cfg-logo-tam').addEventListener('input', (e) => {
    estado.logo_tam = parseInt(e.target.value, 10);
    document.getElementById('val-logo-tam').textContent = estado.logo_tam;
    aplicarPrevia();
  });
  document.getElementById('cfg-nombre-tam').addEventListener('input', (e) => {
    estado.nombre_tam = parseInt(e.target.value, 10);
    document.getElementById('val-nombre-tam').textContent = estado.nombre_tam;
    aplicarPrevia();
  });
  document.querySelectorAll('.pos-btn').forEach((b) =>
    b.addEventListener('click', () => {
      estado.nombre_pos = b.dataset.pos;
      marcarPos(estado.nombre_pos);
      aplicarPrevia();
    }));
  document.getElementById('btn-guardar-config').addEventListener('click', guardar);
  document.getElementById('btn-restaurar').addEventListener('click', restaurar);
}

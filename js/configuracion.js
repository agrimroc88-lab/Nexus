/* ============================================
   NEXUS · configuracion.js
   Ajustes visuales del sistema (solo admin).
   Tamaño del logo, tamaño y posición del nombre.
   Se guarda en config_sistema (para todos).
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina } from './auth.js';
import { montarNavegacion } from './nav.js';
import { empresasPermitidas, sesionActual } from './auth.js';

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

  conectarTirador();
}

/* Arrastrar la esquina del logo para redimensionarlo,
   como en Word o PowerPoint. */
function conectarTirador() {
  const $tirador = document.getElementById('tirador');
  const $caja = document.getElementById('logo-caja');
  if (!$tirador || !$caja) return;

  let arrastrando = false;
  let inicioX = 0;
  let anchoInicial = 0;

  const MIN = 60, MAX = 600;

  function empezar(e) {
    arrastrando = true;
    inicioX = (e.touches ? e.touches[0].clientX : e.clientX);
    anchoInicial = estado.logo_tam;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  function mover(e) {
    if (!arrastrando) return;
    const x = (e.touches ? e.touches[0].clientX : e.clientX);
    let nuevo = anchoInicial + (x - inicioX);
    nuevo = Math.max(MIN, Math.min(MAX, Math.round(nuevo)));
    estado.logo_tam = nuevo;
    document.getElementById('val-logo-tam').textContent = nuevo;
    document.getElementById('cfg-logo-tam').value = nuevo;
    aplicarPrevia();
  }

  function terminar() {
    arrastrando = false;
    document.body.style.userSelect = '';
  }

  $tirador.addEventListener('mousedown', empezar);
  document.addEventListener('mousemove', mover);
  document.addEventListener('mouseup', terminar);

  $tirador.addEventListener('touchstart', empezar, { passive: false });
  document.addEventListener('touchmove', mover, { passive: false });
  document.addEventListener('touchend', terminar);
}

/* ============================================
   Pestaña: Sucursales y cargos
   ============================================ */


const cargosEstado = { empresaId: null };

async function initCargos() {
  // Pestañas
  document.querySelectorAll('.pestana').forEach((p) =>
    p.addEventListener('click', () => {
      const v = p.dataset.vista;
      document.querySelectorAll('.pestana').forEach((x) => x.classList.toggle('activa', x === p));
      document.getElementById('vista-apariencia').hidden = v !== 'apariencia';
      document.getElementById('vista-cargos').hidden = v !== 'cargos';
      if (v === 'cargos') cargarEmpresasCargos();
    }));

  document.getElementById('cfg-empresa').addEventListener('change', (e) => {
    cargosEstado.empresaId = e.target.value || null;
    document.getElementById('cargos-area').hidden = !cargosEstado.empresaId;
    if (cargosEstado.empresaId) { cargarSuc(); cargarCargos(); }
  });

  document.getElementById('btn-add-suc').addEventListener('click', addSucursal);
  document.getElementById('btn-add-cargo').addEventListener('click', addCargo);
}

let empresasCargadasCargos = false;
async function cargarEmpresasCargos() {
  if (empresasCargadasCargos) return;
  const perfil = sesionActual() || { rol: 'admin' };
  const data = await empresasPermitidas(perfil);
  const $s = document.getElementById('cfg-empresa');
  (data || []).forEach((e) => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.razon_social;
    $s.appendChild(o);
  });
  empresasCargadasCargos = true;
}

async function cargarSuc() {
  const { data } = await supabase.from('v_sucursales_reales')
    .select('id, nombre').eq('empresa_id', cargosEstado.empresaId).order('nombre');
  const $l = document.getElementById('lista-suc');
  $l.innerHTML = '';
  if (!data || data.length === 0) { $l.innerHTML = '<p class="lista-vacia">Sin sucursales aún.</p>'; return; }
  data.forEach((s) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span class="item-nombre">${escapar(s.nombre)}</span>`;
    const b = document.createElement('button');
    b.className = 'boton-icono'; b.textContent = 'Eliminar';
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar la sucursal ' + s.nombre + '?')) return;
      await supabase.from('sucursales').delete().eq('id', s.id);
      cargarSuc();
    });
    d.appendChild(b);
    $l.appendChild(d);
  });
}

async function addSucursal() {
  const nombre = document.getElementById('suc-nombre').value.trim();
  if (!nombre) return;
  const { error } = await supabase.from('sucursales')
    .insert({ empresa_id: cargosEstado.empresaId, nombre });
  if (error) { alert('No se pudo agregar: ' + error.message); return; }
  document.getElementById('suc-nombre').value = '';
  cargarSuc();
}

async function cargarCargos() {
  const { data } = await supabase.from('v_cargos_simple')
    .select('id, nombre, area').eq('empresa_id', cargosEstado.empresaId).order('nombre');
  const $l = document.getElementById('lista-cargos');
  $l.innerHTML = '';
  if (!data || data.length === 0) { $l.innerHTML = '<p class="lista-vacia">Sin cargos aún.</p>'; return; }
  data.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span class="item-nombre">${escapar(c.nombre)} <small style="color:#667">· ${escapar(c.area)}</small></span>`;
    const b = document.createElement('button');
    b.className = 'boton-icono'; b.textContent = 'Eliminar';
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar el cargo ' + c.nombre + '?')) return;
      await supabase.from('cargos').delete().eq('id', c.id);
      cargarCargos();
    });
    d.appendChild(b);
    $l.appendChild(d);
  });
}

async function addCargo() {
  const nombre = document.getElementById('cargo-nombre').value.trim();
  const tipo = document.getElementById('cargo-area').value;
  if (!nombre) return;
  // Obtener el área (Admin/Operativo) vía función SQL
  const { data: areaId, error: e1 } = await supabase
    .rpc('area_para_cargo', { p_empresa: cargosEstado.empresaId, p_tipo: tipo });
  if (e1) { alert('Error: ' + e1.message); return; }
  const { error } = await supabase.from('cargos').insert({ area_id: areaId, nombre });
  if (error) { alert('No se pudo agregar: ' + error.message); return; }
  document.getElementById('cargo-nombre').value = '';
  cargarCargos();
}

initCargos();

/* ============================================
   NEXUS · estructura.js
   Sucursales → Áreas → Cargos, en cascada, por empresa.
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina, empresasPermitidas } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar } from './utils.js';

const estado = {
  perfil: null,
  empresaId: null,
  sucursalSel: null,
  areaSel: null,
  modo: null   // 'sucursal' | 'area' | 'cargo'
};

const $empresa = document.getElementById('empresa-activa');
const $area = document.getElementById('area-trabajo');
const $avisoIni = document.getElementById('aviso-inicial');

iniciar();

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;
  estado.perfil = perfil;
  montarNavegacion(perfil, 'estructura');
  await cargarEmpresas();
  conectar();
}

async function cargarEmpresas() {
  const data = await empresasPermitidas(estado.perfil);
  (data || []).forEach((e) => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.razon_social;
    $empresa.appendChild(o);
  });
  const g = sessionStorage.getItem('nexus_empresa');
  if (g && (data || []).some((e) => e.id === g)) {
    $empresa.value = g;
    seleccionarEmpresa();
  }
}

function seleccionarEmpresa() {
  estado.empresaId = $empresa.value || null;
  estado.sucursalSel = null;
  estado.areaSel = null;
  if (!estado.empresaId) {
    $area.hidden = true; $avisoIni.hidden = false;
    sessionStorage.removeItem('nexus_empresa');
    return;
  }
  sessionStorage.setItem('nexus_empresa', estado.empresaId);
  $area.hidden = false; $avisoIni.hidden = true;
  cargarSucursales();
  document.getElementById('lista-areas').innerHTML = '';
  document.getElementById('lista-cargos').innerHTML = '';
  document.getElementById('ctx-area').hidden = false;
  document.getElementById('ctx-cargo').hidden = false;
  document.getElementById('btn-add-area').disabled = true;
  document.getElementById('btn-add-cargo').disabled = true;
}

/* --- Sucursales --- */
async function cargarSucursales() {
  const { data } = await supabase.from('sucursales')
    .select('id, nombre, provincia, activo')
    .eq('empresa_id', estado.empresaId).order('nombre');
  pintarLista('lista-sucursales', data || [], 'sucursal', estado.sucursalSel);
}

/* --- Áreas --- */
async function cargarAreas() {
  if (!estado.sucursalSel) return;
  const { data } = await supabase.from('areas')
    .select('id, nombre, activo')
    .eq('sucursal_id', estado.sucursalSel).order('nombre');
  pintarLista('lista-areas', data || [], 'area', estado.areaSel);
}

/* --- Cargos --- */
async function cargarCargos() {
  if (!estado.areaSel) return;
  const { data } = await supabase.from('cargos')
    .select('id, nombre, activo')
    .eq('area_id', estado.areaSel).order('nombre');
  pintarLista('lista-cargos', data || [], 'cargo', null);
}

function pintarLista(idCont, items, tipo, seleccionado) {
  const $c = document.getElementById(idCont);
  $c.innerHTML = '';
  if (items.length === 0) {
    $c.innerHTML = '<p class="lista-vacia">Sin registros aún.</p>';
    return;
  }
  items.forEach((it) => {
    const fila = document.createElement('div');
    fila.className = 'item' + (it.id === seleccionado ? ' item-sel' : '') + (it.activo === false ? ' item-inactivo' : '');
    const nom = document.createElement('span');
    nom.className = 'item-nombre';
    nom.textContent = it.nombre;
    fila.appendChild(nom);

    // Seleccionar (sucursal/área) para ver hijos
    if (tipo === 'sucursal' || tipo === 'area') {
      nom.style.cursor = 'pointer';
      nom.addEventListener('click', () => {
        if (tipo === 'sucursal') {
          estado.sucursalSel = it.id; estado.areaSel = null;
          document.getElementById('ctx-area').hidden = true;
          document.getElementById('btn-add-area').disabled = false;
          document.getElementById('lista-cargos').innerHTML = '';
          document.getElementById('ctx-cargo').hidden = false;
          document.getElementById('btn-add-cargo').disabled = true;
          cargarSucursales(); cargarAreas();
        } else {
          estado.areaSel = it.id;
          document.getElementById('ctx-cargo').hidden = true;
          document.getElementById('btn-add-cargo').disabled = false;
          cargarAreas(); cargarCargos();
        }
      });
    }

    const acc = document.createElement('div');
    acc.className = 'item-acc';
    const ed = document.createElement('button');
    ed.className = 'boton-icono'; ed.textContent = 'Editar';
    ed.addEventListener('click', () => abrirModal(tipo, it));
    acc.appendChild(ed);
    fila.appendChild(acc);

    $c.appendChild(fila);
  });
}

/* --- Modal --- */
function abrirModal(tipo, item) {
  estado.modo = tipo;
  estado.editando = item || null;

  const titulos = { sucursal: 'sucursal', area: 'área', cargo: 'cargo' };
  document.getElementById('modal-titulo').textContent =
    (item ? 'Editar ' : 'Nueva ') + titulos[tipo];

  document.getElementById('f_nombre').value = item?.nombre || '';
  document.getElementById('alerta').hidden = true;

  // Campos extra según tipo
  const $e1 = document.getElementById('campo-extra1');
  const $e2 = document.getElementById('campo-extra2');
  $e1.hidden = true; $e2.hidden = true;
  document.getElementById('f_extra1').value = '';
  document.getElementById('f_extra2').value = '';

  if (tipo === 'sucursal') {
    $e1.hidden = false; document.getElementById('lbl-extra1').textContent = 'Cantón';
    document.getElementById('f_extra1').value = item?.canton || '';
    $e2.hidden = false; document.getElementById('lbl-extra2').textContent = 'Provincia';
    document.getElementById('f_extra2').value = item?.provincia || '';
  } else {
    $e1.hidden = false; document.getElementById('lbl-extra1').textContent = 'Descripción';
    document.getElementById('f_extra1').value = item?.descripcion || '';
  }

  document.getElementById('modal').hidden = false;
  document.getElementById('f_nombre').focus();
}

async function guardar() {
  const $alerta = document.getElementById('alerta');
  const nombre = document.getElementById('f_nombre').value.trim();
  if (!nombre) { $alerta.textContent = 'El nombre es obligatorio.'; $alerta.hidden = false; return; }

  const extra1 = document.getElementById('f_extra1').value.trim() || null;
  const extra2 = document.getElementById('f_extra2').value.trim() || null;
  const item = estado.editando;

  let tabla, fila;
  if (estado.modo === 'sucursal') {
    tabla = 'sucursales';
    fila = { nombre, canton: extra1, provincia: extra2 };
    if (!item) fila.empresa_id = estado.empresaId;
  } else if (estado.modo === 'area') {
    tabla = 'areas';
    fila = { nombre, descripcion: extra1 };
    if (!item) fila.sucursal_id = estado.sucursalSel;
  } else {
    tabla = 'cargos';
    fila = { nombre, descripcion: extra1 };
    if (!item) fila.area_id = estado.areaSel;
  }

  const { error } = item
    ? await supabase.from(tabla).update(fila).eq('id', item.id)
    : await supabase.from(tabla).insert(fila);

  if (error) { $alerta.textContent = 'No se pudo guardar: ' + error.message; $alerta.hidden = false; return; }

  document.getElementById('modal').hidden = true;
  if (estado.modo === 'sucursal') cargarSucursales();
  else if (estado.modo === 'area') cargarAreas();
  else cargarCargos();
}

function conectar() {
  $empresa.addEventListener('change', seleccionarEmpresa);
  document.getElementById('btn-add-sucursal').addEventListener('click', () => abrirModal('sucursal', null));
  document.getElementById('btn-add-area').addEventListener('click', () => abrirModal('area', null));
  document.getElementById('btn-add-cargo').addEventListener('click', () => abrirModal('cargo', null));
  document.getElementById('btn-guardar').addEventListener('click', guardar);
  document.getElementById('btn-cerrar').addEventListener('click', () => document.getElementById('modal').hidden = true);
  document.getElementById('btn-cancelar').addEventListener('click', () => document.getElementById('modal').hidden = true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('modal').hidden) document.getElementById('modal').hidden = true;
  });
}

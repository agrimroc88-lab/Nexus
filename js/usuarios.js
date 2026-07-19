/* ============================================
   NEXUS · usuarios.js
   Gestión de usuarios (solo admin) — MÉTODO SIMPLE.
   Crea/edita/borra filas en la tabla usuarios_app
   directamente, sin Edge Functions.
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar, textoOGuion } from './utils.js';

const ROLES_TXT = {
  admin: 'Administrador',
  medico_ocupacional: 'Médico ocupacional',
  enfermeria: 'Enfermería',
  psicologo: 'Psicólogo',
  trabajo_social: 'Trabajo social',
  psico_social: 'Psico-social',
  tecnico_sst: 'Técnico SST',
  ergonomo: 'Ergónomo',
  consulta: 'Consulta'
};

const estado = {
  perfil: null,
  usuarios: [],
  editId: null
};

iniciar();

async function iniciar() {
  const perfil = await protegerPagina(['admin']);
  if (!perfil) return;
  estado.perfil = perfil;
  montarNavegacion(perfil, 'usuarios');
  await cargarUsuarios();
  conectarEventos();
}

async function cargarUsuarios() {
  const { data, error } = await supabase
    .from('usuarios_app')
    .select('id, cedula, nombres, apellidos, rol, registro_msp, activo')
    .order('apellidos');
  estado.usuarios = error ? [] : (data || []);
  pintar();
}

function pintar() {
  const texto = document.getElementById('us-busqueda').value.trim().toLowerCase();
  const rol = document.getElementById('us-rol').value;
  const est = document.getElementById('us-estado').value;
  const $cuerpo = document.getElementById('cuerpo-usuarios');

  const visibles = estado.usuarios.filter((u) => {
    if (rol && u.rol !== rol) return false;
    if (est === 'activo' && !u.activo) return false;
    if (est === 'inactivo' && u.activo) return false;
    if (!texto) return true;
    return [`${u.nombres} ${u.apellidos}`, u.cedula]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(texto));
  });

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-usuarios').hidden = visibles.length > 0;
  const frag = document.createDocumentFragment();
  visibles.forEach((u) => frag.appendChild(fila(u)));
  $cuerpo.appendChild(frag);
}

function fila(u) {
  const tr = document.createElement('tr');
  if (!u.activo) tr.classList.add('fila-inactiva');
  const esYo = u.id === estado.perfil.id;

  tr.innerHTML = `
    <td>
      <span class="principal">${escapar(u.apellidos)} ${escapar(u.nombres)}</span>
      ${u.registro_msp ? `<span class="secundario">MSP ${escapar(u.registro_msp)}</span>` : ''}
      ${esYo ? '<span class="secundario">(usted)</span>' : ''}
    </td>
    <td class="celda-centro celda-mono">${escapar(textoOGuion(u.cedula))}</td>
    <td><span class="rol-chip">${ROLES_TXT[u.rol] || u.rol}</span></td>
    <td class="celda-centro">
      <span class="estado-punto ${u.activo ? 'estado-activo' : 'estado-inactivo'}">
        ${u.activo ? 'Activo' : 'Inactivo'}
      </span>
    </td>
    <td class="celda-derecha"></td>`;

  const acc = tr.querySelector('td:last-child');
  acc.appendChild(boton('Editar', () => abrirEditar(u)));

  if (!esYo) {
    const bEstado = boton(u.activo ? 'Desactivar' : 'Activar', () => alternarActivo(u));
    if (u.activo) bEstado.classList.add('boton-peligro-txt');
    acc.appendChild(bEstado);
    acc.appendChild(boton('Eliminar', () => eliminar(u)));
  }
  return tr;
}

function boton(texto, fn) {
  const b = document.createElement('button');
  b.className = 'boton-icono';
  b.type = 'button';
  b.textContent = texto;
  b.addEventListener('click', fn);
  return b;
}

/* --- Crear / editar --- */

function abrirNuevo() {
  estado.editId = null;
  document.getElementById('us-modal-titulo').textContent = 'Nuevo usuario';
  document.getElementById('btn-guardar-usuario').textContent = 'Crear usuario';
  document.getElementById('us-campo-clave').hidden = false;
  document.getElementById('us_clave').placeholder = 'Mínimo 6 caracteres';

  ['us_cedula', 'us_nombres', 'us_apellidos', 'us_msp', 'us_clave']
    .forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('us_rol').value = 'medico_ocupacional';
  document.getElementById('us_cedula').disabled = false;
  document.getElementById('alerta-usuario').hidden = true;
  document.getElementById('modal-usuario').hidden = false;
  document.getElementById('us_cedula').focus();
}

function abrirEditar(u) {
  estado.editId = u.id;
  document.getElementById('us-modal-titulo').textContent = 'Editar usuario';
  document.getElementById('btn-guardar-usuario').textContent = 'Guardar cambios';
  // Al editar, la clave es opcional (si se deja vacía, no se cambia)
  document.getElementById('us-campo-clave').hidden = false;
  document.getElementById('us_clave').placeholder = 'Dejar vacío para no cambiarla';

  document.getElementById('us_cedula').value = u.cedula ?? '';
  document.getElementById('us_cedula').disabled = false;
  document.getElementById('us_nombres').value = u.nombres ?? '';
  document.getElementById('us_apellidos').value = u.apellidos ?? '';
  document.getElementById('us_msp').value = u.registro_msp ?? '';
  document.getElementById('us_rol').value = u.rol ?? 'consulta';
  document.getElementById('us_clave').value = '';
  document.getElementById('alerta-usuario').hidden = true;
  document.getElementById('modal-usuario').hidden = false;
}

async function guardarUsuario() {
  const $alerta = document.getElementById('alerta-usuario');
  const cedula = document.getElementById('us_cedula').value.trim();
  const nombres = document.getElementById('us_nombres').value.trim();
  const apellidos = document.getElementById('us_apellidos').value.trim();
  const rol = document.getElementById('us_rol').value;
  const msp = document.getElementById('us_msp').value.trim() || null;
  const clave = document.getElementById('us_clave').value;

  if (!/^[0-9]{10}$/.test(cedula)) return err($alerta, 'La cédula debe tener 10 dígitos.');
  if (!nombres || !apellidos) return err($alerta, 'Nombres y apellidos son obligatorios.');

  const $btn = document.getElementById('btn-guardar-usuario');
  $btn.disabled = true;

  if (estado.editId) {
    const patch = { cedula, nombres, apellidos, rol, registro_msp: msp };
    if (clave) {
      if (clave.length < 6) { $btn.disabled = false; return err($alerta, 'La clave debe tener al menos 6 caracteres.'); }
      patch.pass = clave;
    }
    const { error } = await supabase.from('usuarios_app').update(patch).eq('id', estado.editId);
    $btn.disabled = false;
    if (error) return err($alerta, traducir(error));
  } else {
    if (clave.length < 6) { $btn.disabled = false; return err($alerta, 'La clave debe tener al menos 6 caracteres.'); }
    const { error } = await supabase.from('usuarios_app').insert({
      cedula, pass: clave, nombres, apellidos, rol, registro_msp: msp, activo: true
    });
    $btn.disabled = false;
    if (error) return err($alerta, traducir(error));
  }

  document.getElementById('modal-usuario').hidden = true;
  await cargarUsuarios();
}

function traducir(error) {
  const m = error.message || '';
  if (m.includes('usuarios_app_cedula_key') || m.includes('duplicate')) return 'Ya existe un usuario con esa cédula.';
  if (m.includes('ck_cedula_app')) return 'La cédula debe tener 10 dígitos.';
  return 'No fue posible guardar: ' + m;
}

/* --- Activar / desactivar --- */

async function alternarActivo(u) {
  const accion = u.activo ? 'desactivar' : 'activar';
  if (!confirm(`¿Seguro que desea ${accion} a ${u.nombres} ${u.apellidos}?` +
    (u.activo ? '\n\nNo podrá iniciar sesión, pero sus registros se conservan.' : ''))) return;

  const { error } = await supabase.from('usuarios_app')
    .update({ activo: !u.activo }).eq('id', u.id);
  if (error) { alert('No fue posible cambiar el estado: ' + error.message); return; }
  await cargarUsuarios();
}

/* --- Eliminar --- */

async function eliminar(u) {
  if (!confirm(`¿ELIMINAR a ${u.nombres} ${u.apellidos}?\n\nEsta acción no se puede deshacer. ` +
    `Si la persona registró atenciones o certificados, es mejor DESACTIVAR en vez de eliminar.`)) return;

  const { error } = await supabase.from('usuarios_app').delete().eq('id', u.id);
  if (error) { alert('No fue posible eliminar: ' + error.message); return; }
  await cargarUsuarios();
}

/* --- Utilidades --- */

function err($el, msg) {
  $el.textContent = msg;
  $el.hidden = false;
}

function conectarEventos() {
  document.getElementById('us-busqueda').addEventListener('input', pintar);
  document.getElementById('us-rol').addEventListener('change', pintar);
  document.getElementById('us-estado').addEventListener('change', pintar);
  document.getElementById('btn-nuevo-usuario').addEventListener('click', abrirNuevo);
  document.getElementById('btn-guardar-usuario').addEventListener('click', guardarUsuario);

  document.querySelectorAll('[data-cierra]').forEach((b) =>
    b.addEventListener('click', () => { document.getElementById(b.dataset.cierra).hidden = true; }));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const $m = document.getElementById('modal-usuario');
      if (!$m.hidden) $m.hidden = true;
    }
  });
}

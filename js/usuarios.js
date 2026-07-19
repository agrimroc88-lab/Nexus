/* ============================================
   NEXUS · usuarios.js
   Gestión de usuarios (solo admin).
   Crear usuarios y reiniciar contraseñas vía
   Edge Functions seguras. Cambiar rol y activar/
   desactivar directamente sobre la tabla perfiles.
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
  editId: null,     // id del usuario en edición (null = nuevo)
  claveId: null     // id del usuario cuya clave se reinicia
};

iniciar();

async function iniciar() {
  // Solo admin entra a este módulo
  const perfil = await protegerPagina(['admin']);
  if (!perfil) return;

  estado.perfil = perfil;
  montarNavegacion(perfil, 'usuarios');

  await cargarUsuarios();
  conectarEventos();
}

async function cargarUsuarios() {
  const { data, error } = await supabase
    .from('perfiles')
    .select('id, nombres, apellidos, cedula, rol, registro_msp, activo')
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

  const bRol = boton('Editar', () => abrirEditar(u));
  acc.appendChild(bRol);

  const bClave = boton('Clave', () => abrirClave(u));
  acc.appendChild(bClave);

  // No permitir que el admin se desactive a sí mismo
  if (!esYo) {
    const bEstado = boton(u.activo ? 'Desactivar' : 'Activar', () => alternarActivo(u));
    if (u.activo) bEstado.classList.add('boton-peligro-txt');
    acc.appendChild(bEstado);
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

/* ============================================
   Crear / editar
   ============================================ */

function abrirNuevo() {
  estado.editId = null;
  document.getElementById('us-modal-titulo').textContent = 'Nuevo usuario';
  document.getElementById('btn-guardar-usuario').textContent = 'Crear usuario';
  document.getElementById('us-campo-clave').hidden = false;

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
  // Al editar no se cambia la clave aquí (hay botón aparte)
  document.getElementById('us-campo-clave').hidden = true;

  document.getElementById('us_cedula').value = u.cedula ?? '';
  document.getElementById('us_cedula').disabled = true; // la cédula es la llave de acceso
  document.getElementById('us_nombres').value = u.nombres ?? '';
  document.getElementById('us_apellidos').value = u.apellidos ?? '';
  document.getElementById('us_msp').value = u.registro_msp ?? '';
  document.getElementById('us_rol').value = u.rol ?? 'consulta';
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

  if (!nombres || !apellidos) return err($alerta, 'Nombres y apellidos son obligatorios.');

  const $btn = document.getElementById('btn-guardar-usuario');
  $btn.disabled = true;

  if (estado.editId) {
    // Edición: actualiza perfil (no toca auth)
    const { error } = await supabase.from('perfiles')
      .update({ nombres, apellidos, rol, registro_msp: msp })
      .eq('id', estado.editId);
    $btn.disabled = false;
    if (error) return err($alerta, 'No fue posible guardar: ' + error.message);
  } else {
    // Nuevo: Edge Function crear-usuario
    const clave = document.getElementById('us_clave').value;
    if (!/^[0-9]{10}$/.test(cedula)) { $btn.disabled = false; return err($alerta, 'La cédula debe tener 10 dígitos.'); }
    if (clave.length < 6) { $btn.disabled = false; return err($alerta, 'La clave debe tener al menos 6 caracteres.'); }

    const { data, error } = await supabase.functions.invoke('crear-usuario', {
      body: { cedula, clave, nombres, apellidos, rol, registro_msp: msp }
    });
    $btn.disabled = false;

    if (error || data?.error) {
      return err($alerta, data?.error || 'No fue posible crear el usuario.');
    }
  }

  document.getElementById('modal-usuario').hidden = true;
  await cargarUsuarios();
}

/* ============================================
   Activar / desactivar
   ============================================ */

async function alternarActivo(u) {
  const accion = u.activo ? 'desactivar' : 'activar';
  if (!confirm(`¿Seguro que desea ${accion} a ${u.nombres} ${u.apellidos}?` +
    (u.activo ? '\n\nNo podrá iniciar sesión, pero sus registros se conservan.' : ''))) return;

  const { error } = await supabase.from('perfiles')
    .update({ activo: !u.activo }).eq('id', u.id);

  if (error) { alert('No fue posible cambiar el estado: ' + error.message); return; }
  await cargarUsuarios();
}

/* ============================================
   Reset de clave
   ============================================ */

function abrirClave(u) {
  estado.claveId = u.id;
  document.getElementById('clave-persona').textContent =
    `Nueva contraseña para ${u.nombres} ${u.apellidos} (cédula ${u.cedula ?? '—'}).`;
  document.getElementById('rc_clave').value = '';
  document.getElementById('alerta-clave').hidden = true;
  document.getElementById('modal-clave').hidden = false;
  document.getElementById('rc_clave').focus();
}

async function guardarClave() {
  const $alerta = document.getElementById('alerta-clave');
  const clave = document.getElementById('rc_clave').value;
  if (clave.length < 6) return err($alerta, 'La clave debe tener al menos 6 caracteres.');

  const $btn = document.getElementById('btn-guardar-clave');
  $btn.disabled = true;

  const { data, error } = await supabase.functions.invoke('reset-clave', {
    body: { id: estado.claveId, clave }
  });
  $btn.disabled = false;

  if (error || data?.error) return err($alerta, data?.error || 'No fue posible reiniciar la contraseña.');

  document.getElementById('modal-clave').hidden = true;
  alert('Contraseña actualizada. Entréguesela a la persona.');
}

/* ============================================
   Utilidades
   ============================================ */

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
  document.getElementById('btn-guardar-clave').addEventListener('click', guardarClave);

  document.querySelectorAll('[data-cierra]').forEach((b) =>
    b.addEventListener('click', () => { document.getElementById(b.dataset.cierra).hidden = true; }));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['modal-clave', 'modal-usuario']) {
      const $m = document.getElementById(id);
      if (!$m.hidden) { $m.hidden = true; return; }
    }
  });
}

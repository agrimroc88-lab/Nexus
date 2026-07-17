/* ============================================
   NEXUS · empresas.js
   Lógica exclusiva de empresas.html
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina, ROLES } from './auth.js';
import { montarNavegacion } from './nav.js';
import { validarRuc, obligacionSst, escapar, textoOGuion, retrasar } from './utils.js';

/* --- Estado del módulo --- */
const estado = {
  perfil: null,
  empresas: [],
  editandoId: null
};

/* --- Referencias --- */
const $tabla = document.getElementById('cuerpo-tabla');
const $vacio = document.getElementById('vacio');
const $busqueda = document.getElementById('busqueda');
const $verInactivas = document.getElementById('ver-inactivas');
const $btnNueva = document.getElementById('btn-nueva');
const $modal = document.getElementById('modal');
const $modalTitulo = document.getElementById('modal-titulo');
const $alerta = document.getElementById('alerta');
const $ayudaRuc = document.getElementById('ayuda-ruc');
const $ayudaDelegado = document.getElementById('ayuda-delegado');

const CAMPOS = [
  'ruc', 'razon_social', 'nombre_comercial', 'representante_legal',
  'actividad_economica', 'ciiu', 'riesgo_ciiu', 'direccion',
  'provincia', 'canton', 'telefono', 'correo', 'num_trabajadores'
];

iniciar();

/* ============================================
   Arranque
   ============================================ */

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  estado.perfil = perfil;
  montarNavegacion(perfil, 'empresas');

  /* Solo admin y técnico SST pueden dar de alta */
  if (!puedeEscribir()) $btnNueva.hidden = true;

  await cargarEmpresas();
  conectarEventos();
}

function puedeEscribir() {
  return estado.perfil.rol === ROLES.ADMIN || estado.perfil.rol === ROLES.TECNICO;
}

/* ============================================
   Datos
   ============================================ */

async function cargarEmpresas() {
  const consulta = supabase
    .from('empresas')
    .select('*')
    .order('razon_social', { ascending: true });

  if (!$verInactivas.checked) consulta.eq('activo', true);

  const { data, error } = await consulta;

  if (error) {
    mostrarAlertaGlobal('No fue posible cargar las empresas: ' + error.message);
    return;
  }

  estado.empresas = data || [];
  pintarTabla();
}

async function guardarEmpresa() {
  const datos = recolectarFormulario();
  const validacion = validarFormulario(datos);

  if (!validacion.ok) {
    mostrarAlerta(validacion.mensaje);
    return;
  }

  bloquearGuardado(true);

  const { error } = estado.editandoId
    ? await supabase.from('empresas').update(datos).eq('id', estado.editandoId)
    : await supabase.from('empresas').insert(datos);

  bloquearGuardado(false);

  if (error) {
    mostrarAlerta(traducirErrorBd(error));
    return;
  }

  cerrarModal();
  await cargarEmpresas();
}

async function alternarEstado(id, activoActual) {
  const accion = activoActual ? 'desactivar' : 'reactivar';
  if (!confirm(`¿Confirma ${accion} esta empresa?`)) return;

  const { error } = await supabase
    .from('empresas')
    .update({ activo: !activoActual })
    .eq('id', id);

  if (error) {
    mostrarAlertaGlobal('No fue posible actualizar: ' + error.message);
    return;
  }
  await cargarEmpresas();
}

/* ============================================
   Interfaz · Tabla
   ============================================ */

function pintarTabla() {
  const filtro = $busqueda.value.trim().toLowerCase();

  const visibles = estado.empresas.filter((e) => {
    if (!filtro) return true;
    return [e.ruc, e.razon_social, e.nombre_comercial, e.actividad_economica]
      .filter(Boolean)
      .some((campo) => campo.toLowerCase().includes(filtro));
  });

  $tabla.innerHTML = '';
  $vacio.hidden = visibles.length > 0;

  const fragmento = document.createDocumentFragment();

  visibles.forEach((e) => {
    const fila = document.createElement('tr');
    if (!e.activo) fila.classList.add('fila-inactiva');

    fila.innerHTML = `
      <td class="celda-mono">${escapar(e.ruc)}</td>
      <td>
        <span class="principal">${escapar(e.razon_social)}</span>
        ${e.nombre_comercial ? `<span class="secundario">${escapar(e.nombre_comercial)}</span>` : ''}
      </td>
      <td class="celda-tenue">${escapar(textoOGuion(e.actividad_economica))}</td>
      <td class="celda-centro celda-mono">${escapar(textoOGuion(e.ciiu))}</td>
      <td class="celda-centro">${insigniaRiesgo(e.riesgo_ciiu)}</td>
      <td class="celda-centro">${e.num_trabajadores ?? 0}</td>
      <td class="celda-centro">
        <span class="insignia ${e.activo ? 'insignia-activa' : 'insignia-inactiva'}">
          ${e.activo ? 'Activa' : 'Inactiva'}
        </span>
      </td>
      <td class="celda-derecha"></td>
    `;

    if (puedeEscribir()) {
      const acciones = fila.querySelector('td:last-child');

      const editar = document.createElement('button');
      editar.className = 'boton-icono';
      editar.textContent = 'Editar';
      editar.addEventListener('click', () => abrirModal(e));
      acciones.appendChild(editar);

      const estadoBtn = document.createElement('button');
      estadoBtn.className = 'boton-icono';
      estadoBtn.textContent = e.activo ? 'Desactivar' : 'Reactivar';
      estadoBtn.addEventListener('click', () => alternarEstado(e.id, e.activo));
      acciones.appendChild(estadoBtn);
    }

    fragmento.appendChild(fila);
  });

  $tabla.appendChild(fragmento);
}

function insigniaRiesgo(nivel) {
  if (!nivel) return '<span class="celda-tenue">—</span>';
  return `<span class="riesgo riesgo-${nivel}">${nivel}</span>`;
}

/* ============================================
   Interfaz · Formulario
   ============================================ */

function abrirModal(empresa = null) {
  estado.editandoId = empresa ? empresa.id : null;
  $modalTitulo.textContent = empresa ? 'Editar empresa' : 'Nueva empresa';

  CAMPOS.forEach((campo) => {
    const $el = document.getElementById(campo);
    if (!$el) return;
    if (empresa) {
      $el.value = empresa[campo] ?? '';
    } else {
      $el.value = campo === 'provincia' ? 'El Oro' : (campo === 'num_trabajadores' ? '0' : '');
    }
  });

  /* El RUC no se edita: es la identidad legal del registro */
  document.getElementById('ruc').readOnly = Boolean(empresa);

  ocultarAlerta();
  $ayudaRuc.textContent = '';
  $ayudaRuc.className = 'ayuda';
  evaluarDelegado();

  $modal.hidden = false;
  document.getElementById(empresa ? 'razon_social' : 'ruc').focus();
}

function cerrarModal() {
  $modal.hidden = true;
  estado.editandoId = null;
}

function recolectarFormulario() {
  const datos = {};
  CAMPOS.forEach((campo) => {
    const $el = document.getElementById(campo);
    if (!$el) return;
    const valor = $el.value.trim();
    datos[campo] = valor === '' ? null : valor;
  });

  datos.num_trabajadores = parseInt(datos.num_trabajadores, 10) || 0;
  datos.riesgo_ciiu = datos.riesgo_ciiu ? parseInt(datos.riesgo_ciiu, 10) : null;

  return datos;
}

function validarFormulario(datos) {
  if (!datos.ruc) return { ok: false, mensaje: 'El RUC es obligatorio' };

  const ruc = validarRuc(datos.ruc);
  if (!ruc.valido) return { ok: false, mensaje: 'RUC inválido: ' + ruc.mensaje };

  if (!datos.razon_social) return { ok: false, mensaje: 'La razón social es obligatoria' };

  if (datos.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(datos.correo)) {
    return { ok: false, mensaje: 'El correo no tiene un formato válido' };
  }

  return { ok: true };
}

/* --- Validación en vivo --- */

function evaluarRuc() {
  const valor = document.getElementById('ruc').value.trim();

  if (valor.length === 0) {
    $ayudaRuc.textContent = '';
    $ayudaRuc.className = 'ayuda';
    return;
  }

  if (valor.length < 13) {
    $ayudaRuc.textContent = `${valor.length}/13 dígitos`;
    $ayudaRuc.className = 'ayuda';
    return;
  }

  const r = validarRuc(valor);
  $ayudaRuc.textContent = r.mensaje;
  $ayudaRuc.className = 'ayuda ' + (r.valido ? 'ayuda-ok' : 'ayuda-error');
}

function evaluarDelegado() {
  const n = parseInt(document.getElementById('num_trabajadores').value, 10) || 0;
  const o = obligacionSst(n);
  $ayudaDelegado.textContent = o.texto;
  $ayudaDelegado.className = 'ayuda ayuda-' + o.nivel;
}

/* ============================================
   Mensajes
   ============================================ */

function mostrarAlerta(texto) {
  $alerta.textContent = texto;
  $alerta.hidden = false;
}

function ocultarAlerta() {
  $alerta.hidden = true;
}

function mostrarAlertaGlobal(texto) {
  alert(texto);
}

function bloquearGuardado(estadoBloqueo) {
  const $btn = document.getElementById('btn-guardar');
  $btn.disabled = estadoBloqueo;
  $btn.textContent = estadoBloqueo ? 'Guardando…' : 'Guardar';
}

function traducirErrorBd(error) {
  if (error.code === '23505') return 'Ya existe una empresa registrada con ese RUC';
  if (error.code === '42501') return 'No tiene permisos para realizar esta acción';
  return 'Error al guardar: ' + error.message;
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  $btnNueva.addEventListener('click', () => abrirModal());
  document.getElementById('btn-cerrar').addEventListener('click', cerrarModal);
  document.getElementById('btn-cancelar').addEventListener('click', cerrarModal);
  document.getElementById('btn-guardar').addEventListener('click', guardarEmpresa);

  $busqueda.addEventListener('input', retrasar(pintarTabla, 200));
  $verInactivas.addEventListener('change', cargarEmpresas);

  document.getElementById('ruc').addEventListener('input', evaluarRuc);
  document.getElementById('num_trabajadores').addEventListener('input', evaluarDelegado);

  /* Cerrar con clic fuera o tecla Escape */
  $modal.addEventListener('click', (e) => {
    if (e.target === $modal) cerrarModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$modal.hidden) cerrarModal();
  });
}

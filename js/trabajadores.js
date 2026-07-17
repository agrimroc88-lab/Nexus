/* ============================================
   NEXUS · trabajadores.js
   Lógica exclusiva de trabajadores.html

   Reglas de negocio:
    · El trabajador pertenece a una empresa.
    · El código (1-3000) es permanente e irrepetible.
      Nunca se recicla; se conserva al reingresar.
    · La cédula es la llave de identidad: si ya existe
      en la empresa, no se crea duplicado, se reingresa.
    · La antigüedad se cuenta desde el último ingreso.
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina, ROLES, puedeVerClinica } from './auth.js';
import { montarNavegacion } from './nav.js';
import { validarCedula, escapar, textoOGuion, retrasar, formatearFecha } from './utils.js';

/* --- Estado --- */
const estado = {
  perfil: null,
  empresaId: null,
  trabajadores: [],
  cargos: [],
  editandoId: null,
  reingresoDe: null,   // trabajador detectado por cédula
  salidaPeriodo: null
};

/* --- Referencias --- */
const $empresa   = document.getElementById('empresa-activa');
const $resumen   = document.getElementById('resumen');
const $herr      = document.getElementById('herramientas');
const $panel     = document.getElementById('panel');
const $avisoIni  = document.getElementById('aviso-inicial');
const $tabla     = document.getElementById('cuerpo-tabla');
const $vacio     = document.getElementById('vacio');
const $busqueda  = document.getElementById('busqueda');
const $filtro    = document.getElementById('filtro-estado');
const $btnNuevo  = document.getElementById('btn-nuevo');
const $modal     = document.getElementById('modal');
const $alerta    = document.getElementById('alerta');
const $hallazgo  = document.getElementById('hallazgo');

const CAMPOS = ['cedula', 'codigo', 'apellidos', 'nombres',
                'fecha_nacimiento', 'sexo', 'tipo_sangre', 'telefono'];

iniciar();

/* ============================================
   Arranque
   ============================================ */

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  estado.perfil = perfil;
  montarNavegacion(perfil, 'trabajadores');

  /* El tipo de sangre es dato clínico */
  if (!puedeVerClinica(perfil.rol)) {
    document.getElementById('campo-sangre').hidden = true;
  }

  if (!puedeEscribir()) $btnNuevo.hidden = true;

  await cargarEmpresas();
  conectarEventos();
}

function puedeEscribir() {
  return [ROLES.ADMIN, ROLES.MEDICO, ROLES.TECNICO].includes(estado.perfil.rol);
}

/* ============================================
   Datos · Empresas y cargos
   ============================================ */

async function cargarEmpresas() {
  const { data, error } = await supabase
    .from('empresas')
    .select('id, razon_social')
    .eq('activo', true)
    .order('razon_social');

  if (error) {
    mostrarGlobal('No fue posible cargar las empresas: ' + error.message);
    return;
  }

  (data || []).forEach((e) => {
    const opcion = document.createElement('option');
    opcion.value = e.id;
    opcion.textContent = e.razon_social;
    $empresa.appendChild(opcion);
  });

  /* Recordar la última empresa consultada */
  const guardada = sessionStorage.getItem('nexus_empresa');
  if (guardada && (data || []).some((e) => e.id === guardada)) {
    $empresa.value = guardada;
    seleccionarEmpresa();
  }
}

async function cargarCargos() {
  /* Cargos de la empresa, atravesando sucursales y áreas */
  const { data, error } = await supabase
    .from('cargos')
    .select('id, nombre, areas!inner(nombre, sucursales!inner(nombre, empresa_id))')
    .eq('areas.sucursales.empresa_id', estado.empresaId)
    .eq('activo', true)
    .order('nombre');

  estado.cargos = error ? [] : (data || []);

  const $cargo = document.getElementById('cargo_id');
  $cargo.innerHTML = '<option value="">— Seleccionar —</option>';

  estado.cargos.forEach((c) => {
    const opcion = document.createElement('option');
    opcion.value = c.id;
    opcion.textContent = `${c.nombre} · ${c.areas.nombre}`;
    $cargo.appendChild(opcion);
  });

  const $ayuda = document.getElementById('ayuda-cargo');
  if (estado.cargos.length === 0) {
    $ayuda.textContent = 'Esta empresa aún no tiene cargos registrados';
    $ayuda.className = 'ayuda ayuda-aviso';
  } else {
    $ayuda.textContent = '';
    $ayuda.className = 'ayuda';
  }
}

/* ============================================
   Datos · Trabajadores
   ============================================ */

async function cargarTrabajadores() {
  const { data, error } = await supabase
    .from('v_trabajadores')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .order('codigo');

  if (error) {
    mostrarGlobal('No fue posible cargar la nómina: ' + error.message);
    return;
  }

  estado.trabajadores = data || [];
  pintarResumen();
  pintarTabla();
}

async function guardarTrabajador() {
  const datos = recolectar();
  const v = validar(datos);

  if (!v.ok) { mostrarAlerta(v.mensaje); return; }

  bloquear(true);

  /* --- Edición: solo datos personales --- */
  if (estado.editandoId) {
    const { codigo, cedula, ...personales } = datos;
    const { error } = await supabase
      .from('trabajadores')
      .update(personales)
      .eq('id', estado.editandoId);

    bloquear(false);
    if (error) { mostrarAlerta(traducirBd(error)); return; }

    cerrarModal();
    await cargarTrabajadores();
    return;
  }

  /* --- Alta: trabajador + primer periodo --- */
  const { data: nuevo, error: errorTrab } = await supabase
    .from('trabajadores')
    .insert({ ...datos, empresa_id: estado.empresaId })
    .select('id')
    .single();

  if (errorTrab) {
    bloquear(false);
    mostrarAlerta(traducirBd(errorTrab));
    return;
  }

  const { error: errorPer } = await supabase
    .from('periodos_laborales')
    .insert({
      trabajador_id: nuevo.id,
      cargo_id: document.getElementById('cargo_id').value || null,
      fecha_ingreso: document.getElementById('fecha_ingreso').value
    });

  bloquear(false);

  if (errorPer) {
    /* Compensación: el trabajador sin periodo es un registro huérfano */
    await supabase.from('trabajadores').delete().eq('id', nuevo.id);
    mostrarAlerta('No fue posible registrar la vinculación: ' + errorPer.message);
    return;
  }

  cerrarModal();
  await cargarTrabajadores();
}

/**
 * Reingreso: abre un periodo nuevo sobre el trabajador existente.
 * El código permanece; el cargo puede cambiar.
 */
async function registrarReingreso() {
  const t = estado.reingresoDe;
  if (!t) return;

  const cargoId = document.getElementById('cargo_id').value || null;
  const ingreso = document.getElementById('fecha_ingreso').value;

  if (!ingreso) { mostrarAlerta('Indique la fecha de ingreso'); return; }

  bloquear(true);
  const { error } = await supabase
    .from('periodos_laborales')
    .insert({ trabajador_id: t.id, cargo_id: cargoId, fecha_ingreso: ingreso });
  bloquear(false);

  if (error) {
    mostrarAlerta(error.code === '23505'
      ? 'Este trabajador ya tiene un periodo activo'
      : 'No fue posible registrar el reingreso: ' + error.message);
    return;
  }

  cerrarModal();
  await cargarTrabajadores();
}

async function confirmarSalida() {
  const fecha = document.getElementById('fecha_salida').value;
  const motivo = document.getElementById('motivo_salida').value || null;
  const $alertaSalida = document.getElementById('alerta-salida');

  if (!fecha) {
    $alertaSalida.textContent = 'Indique la fecha de salida';
    $alertaSalida.hidden = false;
    return;
  }

  const { error } = await supabase
    .from('periodos_laborales')
    .update({ fecha_salida: fecha, motivo_salida: motivo })
    .eq('id', estado.salidaPeriodo);

  if (error) {
    $alertaSalida.textContent = error.message.includes('ck_salida_posterior')
      ? 'La salida no puede ser anterior al ingreso'
      : 'Error: ' + error.message;
    $alertaSalida.hidden = false;
    return;
  }

  document.getElementById('modal-salida').hidden = true;
  await cargarTrabajadores();
}

/* ============================================
   Interfaz · Resumen
   ============================================ */

function pintarResumen() {
  const t = estado.trabajadores;
  document.getElementById('kpi-activos').textContent   = t.filter((x) => x.activo).length;
  document.getElementById('kpi-inactivos').textContent = t.filter((x) => !x.activo).length;
  document.getElementById('kpi-programar').textContent = t.filter((x) => x.estado_periodico === 'por_programar').length;
  document.getElementById('kpi-vencidos').textContent  = t.filter((x) => x.estado_periodico === 'vencido').length;
}

/* ============================================
   Interfaz · Tabla
   ============================================ */

function pintarTabla() {
  const texto = $busqueda.value.trim().toLowerCase();
  const filtro = $filtro.value;

  const visibles = estado.trabajadores.filter((t) => {
    if (filtro === 'activos'   && !t.activo) return false;
    if (filtro === 'inactivos' && t.activo)  return false;
    if (filtro === 'por_programar' && t.estado_periodico !== 'por_programar') return false;
    if (filtro === 'vencido'   && t.estado_periodico !== 'vencido') return false;

    if (!texto) return true;
    return [String(t.codigo), t.cedula, t.nombre_completo]
      .filter(Boolean)
      .some((c) => c.toLowerCase().includes(texto));
  });

  $tabla.innerHTML = '';
  $vacio.hidden = visibles.length > 0;

  const frag = document.createDocumentFragment();

  visibles.forEach((t) => {
    const fila = document.createElement('tr');
    if (!t.activo) fila.classList.add('fila-inactiva');

    fila.innerHTML = `
      <td class="celda-centro"><span class="codigo">${t.codigo}</span></td>
      <td class="celda-mono">${escapar(t.cedula)}</td>
      <td>
        <span class="principal">${escapar(t.nombre_completo)}</span>
        ${t.total_periodos > 1 ? `<span class="secundario">${t.total_periodos} periodos</span>` : ''}
      </td>
      <td class="celda-tenue">${escapar(textoOGuion(t.cargo))}</td>
      <td class="celda-centro">${t.edad ?? '—'}</td>
      <td class="celda-centro celda-mono">${t.ingreso_vigente ? formatearFecha(t.ingreso_vigente) : '—'}</td>
      <td class="celda-centro">${t.meses_antiguedad != null ? t.meses_antiguedad + ' m' : '—'}</td>
      <td class="celda-centro">${insigniaPeriodico(t)}</td>
      <td class="celda-derecha"></td>
    `;

    const acciones = fila.querySelector('td:last-child');

    const historial = document.createElement('button');
    historial.className = 'boton-icono';
    historial.textContent = 'Historial';
    historial.addEventListener('click', () => abrirHistorial(t));
    acciones.appendChild(historial);

    if (puedeEscribir()) {
      const editar = document.createElement('button');
      editar.className = 'boton-icono';
      editar.textContent = 'Editar';
      editar.addEventListener('click', () => abrirModal(t));
      acciones.appendChild(editar);

      if (t.activo && t.periodo_id) {
        const salida = document.createElement('button');
        salida.className = 'boton-icono';
        salida.textContent = 'Salida';
        salida.addEventListener('click', () => abrirSalida(t));
        acciones.appendChild(salida);
      } else if (!t.activo) {
        const reingreso = document.createElement('button');
        reingreso.className = 'boton-icono boton-icono-acento';
        reingreso.textContent = 'Reingresar';
        reingreso.addEventListener('click', () => abrirReingreso(t));
        acciones.appendChild(reingreso);
      }
    }

    frag.appendChild(fila);
  });

  $tabla.appendChild(frag);
}

function insigniaPeriodico(t) {
  if (!t.activo) return '<span class="celda-tenue">—</span>';

  const mapa = {
    al_dia:        ['insignia-activa',  'Al día'],
    por_programar: ['insignia-aviso',   'Programar'],
    vencido:       ['insignia-critica', 'Vencido']
  };
  const [clase, texto] = mapa[t.estado_periodico] || ['insignia-inactiva', '—'];
  return `<span class="insignia ${clase}">${texto}</span>`;
}

/* ============================================
   Interfaz · Formulario
   ============================================ */

async function abrirModal(trabajador = null) {
  estado.editandoId = trabajador ? trabajador.id : null;
  estado.reingresoDe = null;

  document.getElementById('modal-titulo').textContent =
    trabajador ? 'Editar trabajador' : 'Nuevo trabajador';

  CAMPOS.forEach((campo) => {
    const $el = document.getElementById(campo);
    if ($el) $el.value = trabajador ? (trabajador[campo] ?? '') : '';
  });

  /* Cédula y código son identidad: no se editan */
  document.getElementById('cedula').readOnly = Boolean(trabajador);
  document.getElementById('codigo').readOnly = Boolean(trabajador);

  /* La vinculación solo se define al crear */
  document.getElementById('bloque-vinculacion').hidden = Boolean(trabajador);
  document.getElementById('cargo_id').value = '';
  document.getElementById('fecha_ingreso').value = '';

  $hallazgo.hidden = true;
  ocultarAlerta();
  limpiarAyudas();

  if (!trabajador) {
    await sugerirCodigo();
    await cargarCargos();
  }

  document.getElementById('btn-guardar').hidden = false;
  $modal.hidden = false;
  document.getElementById(trabajador ? 'apellidos' : 'cedula').focus();
}

async function abrirReingreso(trabajador) {
  estado.editandoId = null;
  estado.reingresoDe = trabajador;

  document.getElementById('modal-titulo').textContent = 'Reingreso';

  CAMPOS.forEach((campo) => {
    const $el = document.getElementById(campo);
    if ($el) {
      $el.value = trabajador[campo] ?? '';
      $el.readOnly = true;
      if ($el.tagName === 'SELECT') $el.disabled = true;
    }
  });

  document.getElementById('bloque-vinculacion').hidden = false;
  document.getElementById('cargo_id').value = '';
  document.getElementById('fecha_ingreso').value = '';

  await cargarCargos();

  document.getElementById('hallazgo-texto').innerHTML =
    `<strong>${escapar(trabajador.nombre_completo)}</strong> conserva el código
     <strong>${trabajador.codigo}</strong>. La antigüedad se contará desde este nuevo ingreso.`;
  $hallazgo.hidden = false;
  document.getElementById('btn-reingresar').hidden = false;
  document.getElementById('btn-guardar').hidden = true;

  ocultarAlerta();
  $modal.hidden = false;
  document.getElementById('fecha_ingreso').focus();
}

function cerrarModal() {
  $modal.hidden = true;
  estado.editandoId = null;
  estado.reingresoDe = null;

  /* Restaurar campos bloqueados por reingreso */
  CAMPOS.forEach((campo) => {
    const $el = document.getElementById(campo);
    if ($el) {
      $el.readOnly = false;
      if ($el.tagName === 'SELECT') $el.disabled = false;
    }
  });
  document.getElementById('btn-reingresar').hidden = true;
}

function recolectar() {
  const datos = {};
  CAMPOS.forEach((campo) => {
    const $el = document.getElementById(campo);
    if (!$el) return;
    const valor = $el.value.trim();
    datos[campo] = valor === '' ? null : valor;
  });
  datos.codigo = parseInt(datos.codigo, 10) || null;
  return datos;
}

function validar(datos) {
  if (!datos.cedula) return { ok: false, mensaje: 'La cédula es obligatoria' };
  if (!validarCedula(datos.cedula)) return { ok: false, mensaje: 'La cédula no es válida' };
  if (!datos.codigo) return { ok: false, mensaje: 'El código es obligatorio' };
  if (datos.codigo < 1 || datos.codigo > 3000) {
    return { ok: false, mensaje: 'El código debe estar entre 1 y 3000' };
  }
  if (!datos.apellidos) return { ok: false, mensaje: 'Los apellidos son obligatorios' };
  if (!datos.nombres) return { ok: false, mensaje: 'Los nombres son obligatorios' };

  if (!estado.editandoId && !document.getElementById('fecha_ingreso').value) {
    return { ok: false, mensaje: 'La fecha de ingreso es obligatoria' };
  }
  return { ok: true };
}

/* ============================================
   Interfaz · Historial
   ============================================ */

async function abrirHistorial(trabajador) {
  const $lista = document.getElementById('historial-lista');
  document.getElementById('historial-titulo').textContent =
    `${trabajador.codigo} · ${trabajador.nombre_completo}`;
  $lista.innerHTML = '<p class="vacio">Cargando…</p>';
  document.getElementById('modal-historial').hidden = false;

  const { data, error } = await supabase
    .from('periodos_laborales')
    .select('fecha_ingreso, fecha_salida, motivo_salida, cargos(nombre)')
    .eq('trabajador_id', trabajador.id)
    .order('fecha_ingreso', { ascending: false });

  if (error) {
    $lista.innerHTML = '<p class="vacio">No fue posible cargar el historial.</p>';
    return;
  }

  if (!data || data.length === 0) {
    $lista.innerHTML = '<p class="vacio">Sin periodos registrados.</p>';
    return;
  }

  $lista.innerHTML = data.map((p) => {
    const vigente = !p.fecha_salida;
    return `
      <article class="periodo ${vigente ? 'periodo-vigente' : ''}">
        <div class="periodo-fechas">
          <span class="periodo-rango">
            ${formatearFecha(p.fecha_ingreso)} — ${vigente ? 'Vigente' : formatearFecha(p.fecha_salida)}
          </span>
          ${vigente ? '<span class="insignia insignia-activa">Activo</span>' : ''}
        </div>
        <div class="periodo-detalle">
          <span>${escapar(textoOGuion(p.cargos?.nombre))}</span>
          ${p.motivo_salida ? `<span class="periodo-motivo">${escapar(p.motivo_salida.replace(/_/g, ' '))}</span>` : ''}
        </div>
      </article>
    `;
  }).join('');
}

/* ============================================
   Interfaz · Salida
   ============================================ */

function abrirSalida(trabajador) {
  estado.salidaPeriodo = trabajador.periodo_id;
  document.getElementById('salida-sujeto').innerHTML =
    `<strong>${trabajador.codigo}</strong> · ${escapar(trabajador.nombre_completo)}`;
  document.getElementById('fecha_salida').value = new Date().toISOString().slice(0, 10);
  document.getElementById('motivo_salida').value = '';
  document.getElementById('alerta-salida').hidden = true;
  document.getElementById('modal-salida').hidden = false;
}

/* ============================================
   Validación en vivo
   ============================================ */

/**
 * Al completar la cédula, verifica si ya existe en la empresa.
 * Si existe, ofrece reingreso en vez de crear duplicado.
 */
const evaluarCedula = retrasar(async () => {
  const valor = document.getElementById('cedula').value.trim();
  const $ayuda = document.getElementById('ayuda-cedula');

  if (estado.editandoId || estado.reingresoDe) return;

  if (valor.length === 0) { $ayuda.textContent = ''; $ayuda.className = 'ayuda'; return; }

  if (valor.length < 10) {
    $ayuda.textContent = `${valor.length}/10 dígitos`;
    $ayuda.className = 'ayuda';
    $hallazgo.hidden = true;
    return;
  }

  if (!validarCedula(valor)) {
    $ayuda.textContent = 'Dígito verificador incorrecto';
    $ayuda.className = 'ayuda ayuda-error';
    $hallazgo.hidden = true;
    return;
  }

  $ayuda.textContent = 'Cédula válida';
  $ayuda.className = 'ayuda ayuda-ok';

  /* ¿Ya existe en esta empresa? */
  const existente = estado.trabajadores.find((t) => t.cedula === valor);
  if (!existente) { $hallazgo.hidden = true; return; }

  if (existente.activo) {
    $ayuda.textContent = `Ya registrado y activo · código ${existente.codigo}`;
    $ayuda.className = 'ayuda ayuda-error';
    $hallazgo.hidden = true;
    return;
  }

  /* Inactivo → reingreso */
  estado.reingresoDe = existente;
  document.getElementById('codigo').value = existente.codigo;
  document.getElementById('apellidos').value = existente.apellidos;
  document.getElementById('nombres').value = existente.nombres;
  document.getElementById('fecha_nacimiento').value = existente.fecha_nacimiento ?? '';
  document.getElementById('sexo').value = existente.sexo ?? '';
  document.getElementById('tipo_sangre').value = existente.tipo_sangre ?? '';
  document.getElementById('telefono').value = existente.telefono ?? '';

  document.getElementById('hallazgo-texto').innerHTML =
    `<strong>${escapar(existente.nombre_completo)}</strong> ya existe con código
     <strong>${existente.codigo}</strong> y se encuentra inactivo.
     Registre un reingreso para conservar su historial.`;
  $hallazgo.hidden = false;
  document.getElementById('btn-reingresar').hidden = false;
  document.getElementById('btn-guardar').hidden = true;
}, 350);

async function sugerirCodigo() {
  const { data, error } = await supabase.rpc('siguiente_codigo', { p_empresa: estado.empresaId });
  const $ayuda = document.getElementById('ayuda-codigo');

  if (error || data == null) { $ayuda.textContent = ''; return; }

  document.getElementById('codigo').value = data;
  $ayuda.textContent = `Sugerido: ${data}. Puede modificarlo.`;
  $ayuda.className = 'ayuda';
}

function evaluarCodigo() {
  const valor = parseInt(document.getElementById('codigo').value, 10);
  const $ayuda = document.getElementById('ayuda-codigo');

  if (!valor) { $ayuda.textContent = ''; $ayuda.className = 'ayuda'; return; }

  if (valor < 1 || valor > 3000) {
    $ayuda.textContent = 'Fuera del rango permitido (1-3000)';
    $ayuda.className = 'ayuda ayuda-error';
    return;
  }

  const ocupado = estado.trabajadores.find((t) => t.codigo === valor);
  if (ocupado && ocupado.id !== estado.editandoId) {
    $ayuda.textContent = `Ocupado por ${ocupado.nombre_completo}`;
    $ayuda.className = 'ayuda ayuda-error';
    return;
  }

  $ayuda.textContent = 'Código disponible';
  $ayuda.className = 'ayuda ayuda-ok';
}

function evaluarEdad() {
  const valor = document.getElementById('fecha_nacimiento').value;
  const $ayuda = document.getElementById('ayuda-edad');

  if (!valor) { $ayuda.textContent = ''; return; }

  const nacimiento = new Date(valor);
  const hoy = new Date();
  let edad = hoy.getFullYear() - nacimiento.getFullYear();
  const m = hoy.getMonth() - nacimiento.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < nacimiento.getDate())) edad--;

  if (edad < 15) {
    $ayuda.textContent = `${edad} años · verifique la fecha`;
    $ayuda.className = 'ayuda ayuda-error';
    return;
  }

  $ayuda.textContent = `${edad} años`;
  $ayuda.className = 'ayuda';
}

/**
 * Muestra la antigüedad que tendrá el periodo y si ya
 * cae dentro de la ventana de programación de periódico.
 */
function evaluarAntiguedad() {
  const valor = document.getElementById('fecha_ingreso').value;
  const $ayuda = document.getElementById('ayuda-antiguedad');

  if (!valor) { $ayuda.textContent = ''; return; }

  const ingreso = new Date(valor);
  const hoy = new Date();
  const meses = (hoy.getFullYear() - ingreso.getFullYear()) * 12
              + (hoy.getMonth() - ingreso.getMonth());

  if (meses < 0) {
    $ayuda.textContent = 'La fecha no puede ser futura';
    $ayuda.className = 'ayuda ayuda-error';
    return;
  }

  if (meses >= 12) {
    $ayuda.textContent = `${meses} meses · periódico vencido`;
    $ayuda.className = 'ayuda ayuda-critico';
  } else if (meses >= 10) {
    $ayuda.textContent = `${meses} meses · corresponde programar periódico`;
    $ayuda.className = 'ayuda ayuda-aviso';
  } else {
    $ayuda.textContent = `${meses} meses de antigüedad`;
    $ayuda.className = 'ayuda';
  }
}

function limpiarAyudas() {
  ['ayuda-cedula', 'ayuda-codigo', 'ayuda-edad', 'ayuda-antiguedad'].forEach((id) => {
    const $el = document.getElementById(id);
    if ($el) { $el.textContent = ''; $el.className = 'ayuda'; }
  });
}

/* ============================================
   Selección de empresa
   ============================================ */

async function seleccionarEmpresa() {
  estado.empresaId = $empresa.value || null;

  if (!estado.empresaId) {
    sessionStorage.removeItem('nexus_empresa');
    $resumen.hidden = $herr.hidden = $panel.hidden = true;
    $avisoIni.hidden = false;
    return;
  }

  sessionStorage.setItem('nexus_empresa', estado.empresaId);
  $resumen.hidden = $herr.hidden = $panel.hidden = false;
  $avisoIni.hidden = true;

  await cargarTrabajadores();
}

/* ============================================
   Mensajes
   ============================================ */

function mostrarAlerta(texto) { $alerta.textContent = texto; $alerta.hidden = false; }
function ocultarAlerta() { $alerta.hidden = true; }
function mostrarGlobal(texto) { alert(texto); }

function bloquear(b) {
  const $btn = document.getElementById('btn-guardar');
  const $btnR = document.getElementById('btn-reingresar');
  $btn.disabled = $btnR.disabled = b;
  $btn.textContent = b ? 'Guardando…' : 'Guardar';
}

function traducirBd(error) {
  if (error.code === '23505') {
    if (error.message.includes('uq_trabajador_codigo')) return 'Ese código ya está asignado en esta empresa';
    if (error.message.includes('uq_trabajador_cedula')) return 'Esa cédula ya está registrada en esta empresa';
    return 'Registro duplicado';
  }
  if (error.code === '23514') {
    if (error.message.includes('ck_codigo_rango')) return 'El código debe estar entre 1 y 3000';
    if (error.message.includes('ck_cedula_formato')) return 'La cédula debe tener 10 dígitos';
    return 'Los datos no cumplen una restricción de validación';
  }
  if (error.code === '42501') return 'No tiene permisos para esta acción';
  return 'Error al guardar: ' + error.message;
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  $empresa.addEventListener('change', seleccionarEmpresa);
  $btnNuevo.addEventListener('click', () => abrirModal());

  document.getElementById('btn-cerrar').addEventListener('click', cerrarModal);
  document.getElementById('btn-cancelar').addEventListener('click', cerrarModal);
  document.getElementById('btn-guardar').addEventListener('click', guardarTrabajador);
  document.getElementById('btn-reingresar').addEventListener('click', registrarReingreso);

  $busqueda.addEventListener('input', retrasar(pintarTabla, 200));
  $filtro.addEventListener('change', pintarTabla);

  document.getElementById('cedula').addEventListener('input', evaluarCedula);
  document.getElementById('codigo').addEventListener('input', evaluarCodigo);
  document.getElementById('fecha_nacimiento').addEventListener('change', evaluarEdad);
  document.getElementById('fecha_ingreso').addEventListener('change', evaluarAntiguedad);

  document.getElementById('btn-cerrar-historial').addEventListener('click', cerrarHistorial);
  document.getElementById('btn-cerrar-historial-2').addEventListener('click', cerrarHistorial);

  document.getElementById('btn-cerrar-salida').addEventListener('click', cerrarSalida);
  document.getElementById('btn-cancelar-salida').addEventListener('click', cerrarSalida);
  document.getElementById('btn-confirmar-salida').addEventListener('click', confirmarSalida);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$modal.hidden) cerrarModal();
    if (!document.getElementById('modal-historial').hidden) cerrarHistorial();
    if (!document.getElementById('modal-salida').hidden) cerrarSalida();
  });
}

function cerrarHistorial() { document.getElementById('modal-historial').hidden = true; }
function cerrarSalida() { document.getElementById('modal-salida').hidden = true; }

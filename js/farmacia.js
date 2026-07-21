/* ============================================
   NEXUS · farmacia.js
   Lógica exclusiva de farmacia.html

   Reglas de negocio:
    · El saldo se calcula desde el kárdex, nunca se almacena.
    · Toda existencia pertenece a un lote con caducidad.
    · La salida por consumo exige trabajador identificado.
    · Dispensación FEFO: primero el lote que caduca antes.
    · El kárdex es inmutable; se corrige con ajustes.
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina, puedeVerClinica } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar, textoOGuion, retrasar, formatearFecha } from './utils.js';

/* --- Estado --- */
const estado = {
  perfil: null,
  empresaId: null,
  medicamentos: [],
  insumos: [],
  lotes: [],
  kardex: [],
  trabajadores: [],
  editandoMedId: null,
  vista: 'existencias'
};

const HOY = () => new Date().toISOString().slice(0, 10);

/* Etiquetas legibles de los tipos de movimiento */
const ETIQUETA_MOV = {
  inventario_inicial: 'Inventario inicial',
  entrada_compra:     'Compra',
  entrada_donacion:   'Donación',
  salida_consumo:     'Consumo',
  ajuste_positivo:    'Ajuste +',
  ajuste_negativo:    'Ajuste −',
  baja_caducidad:     'Baja · caducidad',
  baja_deterioro:     'Baja · deterioro'
};

const ES_ENTRADA = ['inventario_inicial', 'entrada_compra', 'entrada_donacion', 'ajuste_positivo'];

/* --- Referencias --- */
const $empresa  = document.getElementById('empresa-activa');
const $area     = document.getElementById('area-trabajo');
const $avisoIni = document.getElementById('aviso-inicial');

iniciar();

/* ============================================
   Arranque
   ============================================ */

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  /* Farmacia contiene trazabilidad clínica */
  if (!puedeVerClinica(perfil.rol)) {
    window.location.href = '/Nexus/dashboard.html';
    return;
  }

  estado.perfil = perfil;
  montarNavegacion(perfil, 'farmacia');

  await cargarEmpresas();
  conectarEventos();
}

/* ============================================
   Datos
   ============================================ */

async function cargarEmpresas() {
  const { data, error } = await supabase
    .from('empresas')
    .select('id, razon_social')
    .eq('activo', true)
    .order('razon_social');

  if (error) { alert('No fue posible cargar las empresas: ' + error.message); return; }

  (data || []).forEach((e) => {
    const opcion = document.createElement('option');
    opcion.value = e.id;
    opcion.textContent = e.razon_social;
    $empresa.appendChild(opcion);
  });

  const guardada = sessionStorage.getItem('nexus_empresa');
  if (guardada && (data || []).some((e) => e.id === guardada)) {
    $empresa.value = guardada;
    await seleccionarEmpresa();
  }
}

async function cargarTodo() {
  await Promise.all([
    cargarMedicamentos(),
    cargarLotes(),
    cargarKardex(),
    cargarTrabajadores(),
    cargarInsumos()
  ]);
  pintarResumen();
  pintarExistencias();
  pintarLotes();
  pintarKardex();
}

async function cargarMedicamentos() {
  const { data, error } = await supabase
    .from('v_stock_medicamentos')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('activo', true)
    .order('nombre_generico');

  estado.medicamentos = error ? [] : (data || []);
}

async function cargarInsumos() {
  const { data, error } = await supabase
    .from('insumos')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('activo', true)
    .order('nombre');
  estado.insumos = error ? [] : (data || []);
}

async function cargarLotes() {
  const { data, error } = await supabase
    .from('v_stock_lotes')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('medicamento_activo', true)
    .order('fecha_caducidad');

  estado.lotes = error ? [] : (data || []);
}

async function cargarKardex() {
  const { data, error } = await supabase
    .from('kardex')
    .select(`
      id, tipo, fecha, cantidad, documento, proveedor, observacion,
      medicamentos ( nombre_generico, concentracion, forma ),
      lotes ( numero_lote, fecha_caducidad ),
      trabajadores ( codigo, apellidos, nombres )
    `)
    .eq('empresa_id', estado.empresaId)
    .order('fecha', { ascending: false })
    .order('creado_en', { ascending: false })
    .limit(300);

  estado.kardex = error ? [] : (data || []);
}

async function cargarTrabajadores() {
  const { data, error } = await supabase
    .from('v_trabajadores')
    .select('id, codigo, nombre_completo')
    .eq('empresa_id', estado.empresaId)
    .eq('activo', true)
    .order('codigo');

  estado.trabajadores = error ? [] : (data || []);
}

/* ============================================
   Resumen
   ============================================ */

function pintarResumen() {
  const m = estado.medicamentos;
  document.getElementById('kpi-items').textContent = m.length;
  document.getElementById('kpi-agotados').textContent = m.filter((x) => x.nivel === 'agotado').length;
  document.getElementById('kpi-bajos').textContent = m.filter((x) => x.nivel === 'bajo').length;

  const porCaducar = estado.lotes.filter(
    (l) => l.saldo > 0 && ['proximo', 'critico'].includes(l.estado_caducidad)
  ).length;
  const caducados = estado.lotes.filter(
    (l) => l.saldo > 0 && l.estado_caducidad === 'caducado'
  ).length;

  document.getElementById('kpi-caducar').textContent = porCaducar;
  document.getElementById('kpi-caducados').textContent = caducados;
}

/* ============================================
   Vista · Existencias
   ============================================ */

function pintarExistencias() {
  const texto = document.getElementById('busqueda').value.trim().toLowerCase();
  const nivel = document.getElementById('filtro-nivel').value;
  const $cuerpo = document.getElementById('cuerpo-existencias');

  const visibles = estado.medicamentos.filter((m) => {
    if (nivel !== 'todos' && m.nivel !== nivel) return false;
    if (!texto) return true;
    return [m.nombre_generico, m.nombre_comercial, m.concentracion]
      .filter(Boolean).some((c) => c.toLowerCase().includes(texto));
  });

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-existencias').hidden = visibles.length > 0;

  const frag = document.createDocumentFragment();

  visibles.forEach((m) => {
    const fila = document.createElement('tr');

    fila.innerHTML = `
      <td>
        <span class="principal">${escapar(m.nombre_generico)} ${escapar(m.concentracion || '')}</span>
        ${m.nombre_comercial ? `<span class="secundario">${escapar(m.nombre_comercial)}</span>` : ''}
      </td>
      <td class="celda-tenue">${escapar(m.forma)}</td>
      <td class="celda-centro">
        <span class="saldo ${m.nivel === 'agotado' ? 'saldo-cero' : ''}">${m.stock_disponible}</span>
        ${m.stock_caducado > 0 ? `<span class="secundario">+${m.stock_caducado} cad.</span>` : ''}
      </td>
      <td class="celda-centro celda-tenue">${m.stock_minimo}</td>
      <td class="celda-centro celda-tenue">${m.stock_optimo}</td>
      <td class="celda-centro">${m.reponer > 0 ? `<span class="reponer">${m.reponer}</span>` : '—'}</td>
      <td class="celda-centro celda-mono celda-tenue">
        ${m.proxima_caducidad ? formatearFecha(m.proxima_caducidad) : '—'}
      </td>
      <td class="celda-centro">${insigniaNivel(m.nivel)}</td>
      <td class="celda-derecha"></td>
    `;

    const acciones = fila.querySelector('td:last-child');

    const editar = document.createElement('button');
    editar.className = 'boton-icono';
    editar.textContent = 'Editar';
    editar.addEventListener('click', () => abrirMedicamento(m));
    acciones.appendChild(editar);

    frag.appendChild(fila);
  });

  $cuerpo.appendChild(frag);
}

function insigniaNivel(nivel) {
  const mapa = {
    agotado: ['insignia-critica', 'Agotado'],
    bajo:    ['insignia-aviso',   'Bajo'],
    normal:  ['insignia-activa',  'Normal'],
    exceso:  ['insignia-info',    'Exceso']
  };
  const [clase, texto] = mapa[nivel] || ['insignia-inactiva', '—'];
  return `<span class="insignia ${clase}">${texto}</span>`;
}

/* ============================================
   Vista · Lotes
   ============================================ */

function pintarLotes() {
  const texto = document.getElementById('busqueda-lotes').value.trim().toLowerCase();
  const filtro = document.getElementById('filtro-caducidad').value;
  const $cuerpo = document.getElementById('cuerpo-lotes');

  const visibles = estado.lotes.filter((l) => {
    if (filtro === 'con_saldo' && l.saldo <= 0) return false;
    if (filtro === 'caducado' && l.estado_caducidad !== 'caducado') return false;
    if (filtro === 'critico' && l.estado_caducidad !== 'critico') return false;
    if (filtro === 'proximo' && !['proximo', 'critico'].includes(l.estado_caducidad)) return false;

    if (!texto) return true;
    return [l.nombre_generico, l.numero_lote]
      .filter(Boolean).some((c) => c.toLowerCase().includes(texto));
  });

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-lotes').hidden = visibles.length > 0;

  const frag = document.createDocumentFragment();

  visibles.forEach((l) => {
    const fila = document.createElement('tr');
    if (l.saldo <= 0) fila.classList.add('fila-inactiva');

    fila.innerHTML = `
      <td>
        <span class="principal">${escapar(l.nombre_generico)} ${escapar(l.concentracion || '')}</span>
        <span class="secundario">${escapar(l.forma)}</span>
      </td>
      <td class="celda-mono">${escapar(l.numero_lote)}</td>
      <td class="celda-centro celda-mono">${formatearFecha(l.fecha_caducidad)}</td>
      <td class="celda-centro celda-tenue">${l.dias_para_caducar}</td>
      <td class="celda-centro"><span class="saldo">${l.saldo}</span></td>
      <td class="celda-centro">${insigniaCaducidad(l.estado_caducidad)}</td>
      <td class="celda-derecha"></td>
    `;

    /* Baja rápida de lote caducado con existencia */
    if (l.estado_caducidad === 'caducado' && l.saldo > 0) {
      const baja = document.createElement('button');
      baja.className = 'boton-icono boton-icono-critico';
      baja.textContent = 'Dar de baja';
      baja.addEventListener('click', () => bajaPorCaducidad(l));
      fila.querySelector('td:last-child').appendChild(baja);
    }

    frag.appendChild(fila);
  });

  $cuerpo.appendChild(frag);
}

function insigniaCaducidad(estadoCad) {
  const mapa = {
    vigente:  ['insignia-activa',  'Vigente'],
    proximo:  ['insignia-info',    '90 días'],
    critico:  ['insignia-aviso',   '30 días'],
    caducado: ['insignia-critica', 'Caducado']
  };
  const [clase, texto] = mapa[estadoCad] || ['insignia-inactiva', '—'];
  return `<span class="insignia ${clase}">${texto}</span>`;
}

async function bajaPorCaducidad(lote) {
  if (!confirm(`¿Dar de baja ${lote.saldo} unidades del lote ${lote.numero_lote}?\n\n` +
               `${lote.nombre_generico} · venció el ${formatearFecha(lote.fecha_caducidad)}`)) return;

  const { error } = await supabase.from('kardex').insert({
    empresa_id: estado.empresaId,
    medicamento_id: lote.medicamento_id,
    lote_id: lote.lote_id,
    tipo: 'baja_caducidad',
    fecha: HOY(),
    cantidad: lote.saldo,
    observacion: `Baja automática por caducidad del ${formatearFecha(lote.fecha_caducidad)}`
  });

  if (error) { alert('No fue posible registrar la baja: ' + error.message); return; }
  await cargarTodo();
}

/* ============================================
   Vista · Kárdex
   ============================================ */

function pintarKardex() {
  const texto = document.getElementById('busqueda-kardex').value.trim().toLowerCase();
  const filtro = document.getElementById('filtro-tipo').value;
  const $cuerpo = document.getElementById('cuerpo-kardex');

  const visibles = estado.kardex.filter((k) => {
    if (filtro === 'entradas' && !ES_ENTRADA.includes(k.tipo)) return false;
    if (filtro === 'salidas' && ES_ENTRADA.includes(k.tipo)) return false;
    if (!['todos', 'entradas', 'salidas'].includes(filtro) && k.tipo !== filtro) return false;

    if (!texto) return true;
    const trab = k.trabajadores ? `${k.trabajadores.apellidos} ${k.trabajadores.nombres}` : '';
    return [k.medicamentos?.nombre_generico, trab, k.lotes?.numero_lote]
      .filter(Boolean).some((c) => c.toLowerCase().includes(texto));
  });

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-kardex').hidden = visibles.length > 0;

  const frag = document.createDocumentFragment();

  visibles.forEach((k) => {
    const entrada = ES_ENTRADA.includes(k.tipo);
    const fila = document.createElement('tr');

    const trab = k.trabajadores
      ? `${k.trabajadores.codigo} · ${k.trabajadores.apellidos} ${k.trabajadores.nombres}`
      : null;

    fila.innerHTML = `
      <td class="celda-centro celda-mono">${formatearFecha(k.fecha)}</td>
      <td><span class="mov ${entrada ? 'mov-entrada' : 'mov-salida'}">${ETIQUETA_MOV[k.tipo]}</span></td>
      <td>
        <span class="principal">${escapar(k.medicamentos?.nombre_generico || '—')} ${escapar(k.medicamentos?.concentracion || '')}</span>
      </td>
      <td class="celda-mono celda-tenue">${escapar(k.lotes?.numero_lote || '—')}</td>
      <td class="celda-centro">
        <span class="cantidad ${entrada ? 'cantidad-mas' : 'cantidad-menos'}">
          ${entrada ? '+' : '−'}${k.cantidad}
        </span>
      </td>
      <td class="celda-tenue">${escapar(textoOGuion(trab))}</td>
      <td class="celda-tenue celda-nota">${escapar(textoOGuion(k.observacion || k.documento))}</td>
    `;

    frag.appendChild(fila);
  });

  $cuerpo.appendChild(frag);
}

/* ============================================
   Medicamento · Formulario
   ============================================ */

const CAMPOS_MED = ['nombre_generico', 'nombre_comercial', 'concentracion',
                    'forma', 'presentacion', 'stock_minimo', 'stock_optimo', 'stock_maximo'];

function abrirMedicamento(med = null) {
  estado.editandoMedId = med ? med.id : null;
  document.getElementById('med-titulo').textContent =
    med ? 'Editar medicamento' : 'Nuevo medicamento';

  CAMPOS_MED.forEach((campo) => {
    const $el = document.getElementById(campo);
    if (!$el) return;
    if (med) {
      $el.value = med[campo] ?? '';
    } else {
      $el.value = campo === 'forma' ? 'tableta'
                : (campo.startsWith('stock_') && campo !== 'stock_maximo') ? '0' : '';
    }
  });

  document.getElementById('alerta-med').hidden = true;
  document.getElementById('modal-med').hidden = false;
  document.getElementById('nombre_generico').focus();
}

async function guardarMedicamento() {
  const datos = {};
  CAMPOS_MED.forEach((campo) => {
    const valor = document.getElementById(campo).value.trim();
    datos[campo] = valor === '' ? null : valor;
  });

  datos.stock_minimo = parseInt(datos.stock_minimo, 10) || 0;
  datos.stock_optimo = parseInt(datos.stock_optimo, 10) || 0;
  datos.stock_maximo = datos.stock_maximo ? parseInt(datos.stock_maximo, 10) : null;

  if (!datos.nombre_generico) return alertaMed('El nombre genérico es obligatorio');
  if (datos.stock_optimo < datos.stock_minimo) {
    return alertaMed('El stock óptimo no puede ser menor al mínimo');
  }
  if (datos.stock_maximo !== null && datos.stock_maximo < datos.stock_optimo) {
    return alertaMed('El stock máximo no puede ser menor al óptimo');
  }

  const $btn = document.getElementById('btn-guardar-med');
  $btn.disabled = true;

  const { error } = estado.editandoMedId
    ? await supabase.from('medicamentos').update(datos).eq('id', estado.editandoMedId)
    : await supabase.from('medicamentos').insert({ ...datos, empresa_id: estado.empresaId });

  $btn.disabled = false;

  if (error) {
    return alertaMed(error.code === '23505'
      ? 'Ya existe ese medicamento con la misma concentración y forma'
      : 'Error: ' + error.message);
  }

  document.getElementById('modal-med').hidden = true;
  await cargarTodo();
}

function alertaMed(texto) {
  const $a = document.getElementById('alerta-med');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Ingreso
   ============================================ */

function abrirIngreso() {
  if (estado.medicamentos.length === 0) {
    alert('Registre primero al menos un medicamento en el catálogo.');
    return;
  }

  llenarSelectMedicamentos('ing_medicamento');
  document.getElementById('ing_tipo').value = 'inventario_inicial';
  document.getElementById('ing_fecha').value = HOY();
  document.getElementById('ing_cantidad').value = '';
  document.getElementById('ing_caducidad').value = '';
  document.getElementById('ing_observacion').value = '';
  document.getElementById('ayuda-caducidad').textContent = '';

  actualizarAyudaTipoIngreso();
  document.getElementById('alerta-ingreso').hidden = true;
  document.getElementById('modal-ingreso').hidden = false;
}

function llenarSelectMedicamentos(idSelect) {
  const $sel = document.getElementById(idSelect);
  $sel.innerHTML = '<option value="">— Seleccionar —</option>';

  estado.medicamentos.forEach((m) => {
    const opcion = document.createElement('option');
    opcion.value = m.id;
    opcion.textContent = `${m.nombre_generico} ${m.concentracion || ''} · ${m.forma}`.trim();
    $sel.appendChild(opcion);
  });
}

/**
 * Deriva el identificador de lote desde la fecha de caducidad.
 * El usuario no registra lotes: el sistema los agrupa por caducidad,
 * que es el único dato que sostiene las alertas sanitarias.
 */
function loteDesdeCaducidad(caducidad) {
  return 'C' + caducidad.replace(/-/g, '');
}

function actualizarAyudaTipoIngreso() {
  const tipo = document.getElementById('ing_tipo').value;
  const textos = {
    inventario_inicial: 'Conteo de lo que ya existe en el botiquín',
    entrada_compra: 'Reposición adquirida a un proveedor',
    entrada_donacion: 'Ingreso recibido sin costo'
  };
  document.getElementById('ayuda-tipo-ing').textContent = textos[tipo] || '';
}

function evaluarCaducidad() {
  const valor = document.getElementById('ing_caducidad').value;
  const $ayuda = document.getElementById('ayuda-caducidad');

  if (!valor) { $ayuda.textContent = ''; return; }

  const dias = Math.round((new Date(valor) - new Date()) / 86400000);

  if (dias < 0) {
    $ayuda.textContent = 'Lote caducado · no se puede ingresar';
    $ayuda.className = 'ayuda ayuda-error';
  } else if (dias < 90) {
    $ayuda.textContent = `Caduca en ${dias} días`;
    $ayuda.className = 'ayuda ayuda-aviso';
  } else {
    $ayuda.textContent = `Caduca en ${dias} días`;
    $ayuda.className = 'ayuda ayuda-ok';
  }
}

async function guardarIngreso() {
  const medId = document.getElementById('ing_medicamento').value;
  const tipo = document.getElementById('ing_tipo').value;
  const fecha = document.getElementById('ing_fecha').value;
  const cantidad = parseInt(document.getElementById('ing_cantidad').value, 10);
  const caducidad = document.getElementById('ing_caducidad').value;

  if (!medId) return alertaIngreso('Seleccione el medicamento');
  if (!fecha) return alertaIngreso('Indique la fecha');
  if (!cantidad || cantidad < 1) return alertaIngreso('La cantidad debe ser mayor a cero');
  if (!caducidad) return alertaIngreso('Indique la fecha de caducidad');
  if (new Date(caducidad) < new Date(HOY())) {
    return alertaIngreso('No se puede ingresar un medicamento ya caducado');
  }

  const $btn = document.getElementById('btn-guardar-ingreso');
  $btn.disabled = true;

  /* El lote se agrupa por caducidad. Si ya existe uno con esa
     fecha para este medicamento, se reutiliza; si no, se crea. */
  let loteId = estado.lotes.find(
    (l) => l.medicamento_id === medId && l.fecha_caducidad === caducidad
  )?.lote_id;

  if (!loteId) {
    const { data: lote, error: errorLote } = await supabase
      .from('lotes')
      .insert({
        medicamento_id: medId,
        numero_lote: loteDesdeCaducidad(caducidad),
        fecha_caducidad: caducidad
      })
      .select('id')
      .single();

    if (errorLote) {
      $btn.disabled = false;
      return alertaIngreso('No fue posible registrar el lote: ' + errorLote.message);
    }
    loteId = lote.id;
  }

  const { error } = await supabase.from('kardex').insert({
    empresa_id: estado.empresaId,
    medicamento_id: medId,
    lote_id: loteId,
    tipo,
    fecha,
    cantidad,
    observacion: document.getElementById('ing_observacion').value.trim() || null
  });

  $btn.disabled = false;

  if (error) return alertaIngreso(traducirBd(error));

  document.getElementById('modal-ingreso').hidden = true;
  await cargarTodo();
}

function alertaIngreso(texto) {
  const $a = document.getElementById('alerta-ingreso');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Salida
   ============================================ */

function abrirSalida() {
  if (estado.medicamentos.length === 0) {
    alert('Registre primero al menos un medicamento en el catálogo.');
    return;
  }

  llenarSelectMedicamentos('sal_medicamento');

  const $trab = document.getElementById('sal_trabajador');
  $trab.innerHTML = '<option value="">— Seleccionar —</option>';
  estado.trabajadores.forEach((t) => {
    const opcion = document.createElement('option');
    opcion.value = t.id;
    opcion.textContent = `${t.codigo} · ${t.nombre_completo}`;
    $trab.appendChild(opcion);
  });

  document.getElementById('sal_tipo').value = 'salida_consumo';
  document.getElementById('sal_fecha').value = HOY();
  document.getElementById('sal_cantidad').value = '';
  document.getElementById('sal_observacion').value = '';
  document.getElementById('sal_lote').innerHTML = '<option value="">— Seleccionar medicamento primero —</option>';
  document.getElementById('ayuda-lote-sal').textContent = '';
  document.getElementById('ayuda-cantidad-sal').textContent = '';

  alternarTrabajador();
  document.getElementById('alerta-salida').hidden = true;
  document.getElementById('modal-salida').hidden = false;
}

/** El trabajador solo se exige en salida por consumo */
function alternarTrabajador() {
  const tipo = document.getElementById('sal_tipo').value;
  document.getElementById('campo-trabajador').hidden = tipo !== 'salida_consumo';
  cargarLotesDeSalida();
}

/**
 * Carga los lotes con saldo. Aplica FEFO: preselecciona
 * el que caduca antes. En baja por caducidad, muestra
 * únicamente los caducados.
 */
function cargarLotesDeSalida() {
  const medId = document.getElementById('sal_medicamento').value;
  const tipo = document.getElementById('sal_tipo').value;
  const $sel = document.getElementById('sal_lote');
  const $ayuda = document.getElementById('ayuda-lote-sal');

  $sel.innerHTML = '<option value="">— Seleccionar —</option>';
  $ayuda.textContent = '';

  if (!medId) return;

  let disponibles = estado.lotes.filter((l) => l.medicamento_id === medId && l.saldo > 0);

  if (tipo === 'baja_caducidad') {
    disponibles = disponibles.filter((l) => l.estado_caducidad === 'caducado');
    if (disponibles.length === 0) {
      $ayuda.textContent = 'No hay lotes caducados con existencia';
      $ayuda.className = 'ayuda';
      return;
    }
  } else if (tipo === 'salida_consumo') {
    disponibles = disponibles.filter((l) => l.estado_caducidad !== 'caducado');
    if (disponibles.length === 0) {
      $ayuda.textContent = 'Sin existencia dispensable';
      $ayuda.className = 'ayuda ayuda-error';
      return;
    }
  }

  disponibles.sort((a, b) => new Date(a.fecha_caducidad) - new Date(b.fecha_caducidad));

  disponibles.forEach((l) => {
    const opcion = document.createElement('option');
    opcion.value = l.lote_id;
    opcion.dataset.saldo = l.saldo;
    opcion.textContent = `${l.numero_lote} · vence ${formatearFecha(l.fecha_caducidad)} · saldo ${l.saldo}`;
    $sel.appendChild(opcion);
  });

  /* FEFO: el primero es el que caduca antes */
  if (disponibles.length > 0 && tipo === 'salida_consumo') {
    $sel.value = disponibles[0].lote_id;
    $ayuda.textContent = 'Sugerido por caducidad más próxima (FEFO)';
    $ayuda.className = 'ayuda ayuda-ok';
    evaluarCantidadSalida();
  }
}

function evaluarCantidadSalida() {
  const $sel = document.getElementById('sal_lote');
  const opcion = $sel.options[$sel.selectedIndex];
  const $ayuda = document.getElementById('ayuda-cantidad-sal');

  if (!opcion || !opcion.dataset.saldo) { $ayuda.textContent = ''; return; }

  const saldo = parseInt(opcion.dataset.saldo, 10);
  const cantidad = parseInt(document.getElementById('sal_cantidad').value, 10) || 0;

  if (cantidad > saldo) {
    $ayuda.textContent = `Excede el saldo del lote (${saldo})`;
    $ayuda.className = 'ayuda ayuda-error';
  } else {
    $ayuda.textContent = `Disponible en el lote: ${saldo}`;
    $ayuda.className = 'ayuda';
  }
}

async function guardarSalida() {
  const tipo = document.getElementById('sal_tipo').value;
  const medId = document.getElementById('sal_medicamento').value;
  const loteId = document.getElementById('sal_lote').value;
  const fecha = document.getElementById('sal_fecha').value;
  const cantidad = parseInt(document.getElementById('sal_cantidad').value, 10);
  const trabajadorId = document.getElementById('sal_trabajador').value;

  if (!medId) return alertaSalida('Seleccione el medicamento');
  if (!loteId) return alertaSalida('Seleccione el lote');
  if (!fecha) return alertaSalida('Indique la fecha');
  if (!cantidad || cantidad < 1) return alertaSalida('La cantidad debe ser mayor a cero');
  if (tipo === 'salida_consumo' && !trabajadorId) {
    return alertaSalida('La entrega a un trabajador requiere identificarlo');
  }

  const $btn = document.getElementById('btn-guardar-salida');
  $btn.disabled = true;

  const { error } = await supabase.from('kardex').insert({
    empresa_id: estado.empresaId,
    medicamento_id: medId,
    lote_id: loteId,
    tipo,
    fecha,
    cantidad,
    trabajador_id: tipo === 'salida_consumo' ? trabajadorId : null,
    observacion: document.getElementById('sal_observacion').value.trim() || null
  });

  $btn.disabled = false;

  if (error) return alertaSalida(traducirBd(error));

  document.getElementById('modal-salida').hidden = true;
  await cargarTodo();
}

function alertaSalida(texto) {
  const $a = document.getElementById('alerta-salida');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Pestañas
   ============================================ */

/* ============================================
   Insumos
   ============================================ */

let insumoActual = null;

function rolEscribeFarmacia() {
  const rol = estado.perfil ? estado.perfil.rol : '';
  return ['admin', 'enfermeria', 'medico_ocupacional'].includes(rol);
}

function pintarInsumos() {
  const filtro = (document.getElementById('filtro-insumo').value || '').toLowerCase();
  const lista = (estado.insumos || []).filter((i) => i.nombre.toLowerCase().includes(filtro));
  const $cuerpo = document.getElementById('cuerpo-insumos');
  const $vacio = document.getElementById('vacio-insumos');
  $cuerpo.innerHTML = '';

  if (lista.length === 0) { $vacio.hidden = false; return; }
  $vacio.hidden = true;

  lista.forEach((i) => {
    const bajo = Number(i.stock_disponible) <= Number(i.stock_minimo);
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><span class="principal">${escapar(i.nombre)}</span></td>` +
      `<td class="celda-tenue">${escapar(i.unidad || 'unidad')}</td>` +
      `<td class="celda-centro"><span class="saldo ${bajo ? 'saldo-cero' : ''}">${i.stock_disponible}</span></td>` +
      `<td class="celda-centro celda-tenue">${i.stock_minimo}</td>` +
      `<td class="celda-centro celda-tenue">${i.stock_optimo}</td>` +
      `<td class="celda-derecha"></td>`;
    const acc = tr.querySelector('td:last-child');

    if (rolEscribeFarmacia()) {
      const rep = document.createElement('button');
      rep.className = 'boton-icono'; rep.textContent = 'Reponer';
      rep.addEventListener('click', () => reponerInsumo(i));
      acc.appendChild(rep);

      const ed = document.createElement('button');
      ed.className = 'boton-icono'; ed.textContent = 'Editar';
      ed.addEventListener('click', () => abrirInsumo(i));
      acc.appendChild(ed);
    }
    $cuerpo.appendChild(tr);
  });
}

function abrirInsumo(insumo) {
  insumoActual = insumo || null;
  document.getElementById('titulo-modal-insumo').textContent = insumo ? 'Editar insumo' : 'Nuevo insumo';
  document.getElementById('ins_nombre').value = insumo ? insumo.nombre : '';
  document.getElementById('ins_unidad').value = insumo ? (insumo.unidad || '') : 'unidad';
  document.getElementById('ins_disponible').value = insumo ? insumo.stock_disponible : 0;
  document.getElementById('ins_minimo').value = insumo ? insumo.stock_minimo : 0;
  document.getElementById('ins_optimo').value = insumo ? insumo.stock_optimo : 0;
  document.getElementById('alerta-insumo').hidden = true;
  document.getElementById('btn-eliminar-insumo').hidden = !insumo || !rolEscribeFarmacia();
  document.getElementById('modal-insumo').hidden = false;
}

async function reponerInsumo(insumo) {
  const cant = prompt(`Reponer "${insumo.nombre}". ¿Cuántas unidades ingresan?`);
  if (cant === null) return;
  const n = parseInt(cant, 10);
  if (isNaN(n) || n <= 0) { alert('Cantidad no válida.'); return; }
  const nuevo = Number(insumo.stock_disponible) + n;
  const { error } = await supabase.from('insumos').update({ stock_disponible: nuevo }).eq('id', insumo.id);
  if (error) { alert('No se pudo reponer: ' + error.message); return; }
  await supabase.from('insumos_kardex').insert({ insumo_id: insumo.id, tipo: 'entrada', cantidad: n, nota: 'Reposición' });
  await cargarInsumos();
  pintarInsumos();
}

async function guardarInsumo() {
  const $alerta = document.getElementById('alerta-insumo');
  const nombre = document.getElementById('ins_nombre').value.trim();
  if (!nombre) { $alerta.textContent = 'El nombre es obligatorio.'; $alerta.hidden = false; return; }

  const fila = {
    nombre: nombre.toUpperCase(),
    unidad: document.getElementById('ins_unidad').value.trim() || 'unidad',
    stock_disponible: parseInt(document.getElementById('ins_disponible').value, 10) || 0,
    stock_minimo: parseInt(document.getElementById('ins_minimo').value, 10) || 0,
    stock_optimo: parseInt(document.getElementById('ins_optimo').value, 10) || 0
  };

  let error;
  if (insumoActual) {
    ({ error } = await supabase.from('insumos').update(fila).eq('id', insumoActual.id));
  } else {
    fila.empresa_id = estado.empresaId;
    ({ error } = await supabase.from('insumos').insert(fila));
  }
  if (error) {
    $alerta.textContent = error.message.includes('duplicate') ? 'Ese insumo ya existe.' : 'No se pudo guardar: ' + error.message;
    $alerta.hidden = false; return;
  }
  document.getElementById('modal-insumo').hidden = true;
  await cargarInsumos();
  pintarInsumos();
}

async function eliminarInsumo() {
  if (!insumoActual) return;
  if (!confirm('¿Eliminar el insumo ' + insumoActual.nombre + '?')) return;
  await supabase.from('insumos').update({ activo: false }).eq('id', insumoActual.id);
  document.getElementById('modal-insumo').hidden = true;
  await cargarInsumos();
  pintarInsumos();
}

function insumosAReponer() {
  return (estado.insumos || [])
    .filter((i) => Number(i.stock_disponible) <= Number(i.stock_minimo))
    .map((i) => ({ ...i, pedir: Math.max(0, Number(i.stock_optimo) - Number(i.stock_disponible)) }))
    .filter((i) => i.pedir > 0)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/* ============================================
   Orden de compra (reposición)
   ============================================ */

function medicamentosAReponer() {
  // Bajo mínimo: stock disponible <= stock mínimo. Cantidad para llegar al óptimo.
  return (estado.medicamentos || [])
    .filter((m) => Number(m.stock_disponible) <= Number(m.stock_minimo))
    .map((m) => {
      const optimo = Number(m.stock_optimo) || 0;
      const actual = Number(m.stock_disponible) || 0;
      const pedir = Math.max(0, optimo - actual);
      return { ...m, pedir };
    })
    .filter((m) => m.pedir > 0)
    .sort((a, b) => a.nombre_generico.localeCompare(b.nombre_generico));
}

function pintarOrden() {
  const lista = medicamentosAReponer();
  const $cuerpo = document.getElementById('cuerpo-orden');
  const $vacio = document.getElementById('vacio-orden');
  $cuerpo.innerHTML = '';

  if (lista.length === 0) {
    $vacio.hidden = false;
  } else {
    $vacio.hidden = true;
    lista.forEach((m) => {
      const tr = document.createElement('tr');
      const presentacion = `${m.concentracion || ''} ${m.forma || ''}`.trim();
      tr.innerHTML =
        `<td><span class="principal">${escapar(m.nombre_generico)}</span>` +
        (m.nombre_comercial ? `<br><span class="secundario">${escapar(m.nombre_comercial)}</span>` : '') + `</td>` +
        `<td class="celda-tenue">${escapar(presentacion)}</td>` +
        `<td class="celda-centro">${m.stock_disponible}</td>` +
        `<td class="celda-centro celda-tenue">${m.stock_minimo}</td>` +
        `<td class="celda-centro celda-tenue">${m.stock_optimo}</td>` +
        `<td class="celda-centro"><strong>${m.pedir}</strong></td>`;
      $cuerpo.appendChild(tr);
    });
  }

  // Insumos a reponer
  const insumos = insumosAReponer();
  const $ci = document.getElementById('cuerpo-orden-insumos');
  const $vi = document.getElementById('vacio-orden-insumos');
  if ($ci) {
    $ci.innerHTML = '';
    if (insumos.length === 0) { $vi.hidden = false; }
    else {
      $vi.hidden = true;
      insumos.forEach((i) => {
        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td><span class="principal">${escapar(i.nombre)}</span></td>` +
          `<td class="celda-tenue">${escapar(i.unidad || 'unidad')}</td>` +
          `<td class="celda-centro">${i.stock_disponible}</td>` +
          `<td class="celda-centro celda-tenue">${i.stock_minimo}</td>` +
          `<td class="celda-centro celda-tenue">${i.stock_optimo}</td>` +
          `<td class="celda-centro"><strong>${i.pedir}</strong></td>`;
        $ci.appendChild(tr);
      });
    }
  }
}

function imprimirOrden() {
  const lista = medicamentosAReponer();
  const insumos = insumosAReponer();
  if (lista.length === 0 && insumos.length === 0) {
    alert('No hay medicamentos ni insumos por debajo del mínimo para pedir.');
    return;
  }

  const empresaNombre = ($empresa.options[$empresa.selectedIndex] || {}).textContent || 'Empresa';
  const hoy = new Date();
  const fecha = hoy.toLocaleDateString('es-EC', { year: 'numeric', month: 'long', day: 'numeric' });
  const numOrden = 'OC-' + hoy.getFullYear() +
    String(hoy.getMonth() + 1).padStart(2, '0') +
    String(hoy.getDate()).padStart(2, '0') +
    '-' + String(hoy.getHours()).padStart(2, '0') + String(hoy.getMinutes()).padStart(2, '0');

  const filasMed = lista.map((m, i) => {
    const presentacion = `${m.concentracion || ''} ${m.forma || ''}`.trim();
    return `<tr>
      <td style="text-align:center">${i + 1}</td>
      <td>${escapar(m.nombre_generico)}${m.nombre_comercial ? ' (' + escapar(m.nombre_comercial) + ')' : ''}</td>
      <td>${escapar(presentacion)}</td>
      <td style="text-align:center">${m.stock_disponible}</td>
      <td style="text-align:center"><strong>${m.pedir}</strong></td>
    </tr>`;
  }).join('');

  const filasIns = insumos.map((it, i) => {
    return `<tr>
      <td style="text-align:center">${i + 1}</td>
      <td>${escapar(it.nombre)}</td>
      <td>${escapar(it.unidad || 'unidad')}</td>
      <td style="text-align:center">${it.stock_disponible}</td>
      <td style="text-align:center"><strong>${it.pedir}</strong></td>
    </tr>`;
  }).join('');

  const seccionMed = lista.length > 0 ? `
      <h2 class="oc-seccion">Medicamentos</h2>
      <table class="oc-tabla">
        <thead>
          <tr>
            <th style="width:5%">#</th>
            <th style="width:40%">Medicamento</th>
            <th style="width:25%">Presentación</th>
            <th style="width:15%">Stock actual</th>
            <th style="width:15%">Cantidad a pedir</th>
          </tr>
        </thead>
        <tbody>${filasMed}</tbody>
      </table>` : '';

  const seccionIns = insumos.length > 0 ? `
      <h2 class="oc-seccion">Insumos</h2>
      <table class="oc-tabla">
        <thead>
          <tr>
            <th style="width:5%">#</th>
            <th style="width:45%">Insumo</th>
            <th style="width:20%">Unidad</th>
            <th style="width:15%">Stock actual</th>
            <th style="width:15%">Cantidad a pedir</th>
          </tr>
        </thead>
        <tbody>${filasIns}</tbody>
      </table>` : '';

  const html = `
    <div class="oc-hoja">
      <div class="oc-cabecera">
        <img src="logo.png" class="oc-logo" alt="">
        <div>
          <h1>ORDEN DE COMPRA / REPOSICIÓN DE MEDICAMENTOS E INSUMOS</h1>
          <p><strong>${escapar(empresaNombre)}</strong></p>
          <p>Unidad de Seguridad y Salud Ocupacional</p>
        </div>
      </div>

      <div class="oc-datos">
        <span><strong>N° de orden:</strong> ${numOrden}</span>
        <span><strong>Fecha:</strong> ${fecha}</span>
      </div>

      ${seccionMed}
      ${seccionIns}

      <div class="oc-firmas">
        <div class="oc-firma"><div class="oc-linea"></div><p>Solicitado por</p></div>
        <div class="oc-firma"><div class="oc-linea"></div><p>Autorizado por</p></div>
      </div>
    </div>`;

  document.getElementById('orden-impresion').innerHTML = html;
  document.body.classList.add('imprimiendo-orden');
  window.print();
  setTimeout(() => document.body.classList.remove('imprimiendo-orden'), 500);
}

function cambiarVista(vista) {
  estado.vista = vista;

  document.querySelectorAll('.pestana').forEach((p) => {
    p.classList.toggle('activa', p.dataset.vista === vista);
  });

  ['existencias', 'lotes', 'kardex', 'insumos', 'orden'].forEach((v) => {
    document.getElementById('vista-' + v).hidden = v !== vista;
  });
  if (vista === 'orden') pintarOrden();
  if (vista === 'insumos') pintarInsumos();
}

/* ============================================
   Empresa
   ============================================ */

async function seleccionarEmpresa() {
  estado.empresaId = $empresa.value || null;

  if (!estado.empresaId) {
    sessionStorage.removeItem('nexus_empresa');
    $area.hidden = true;
    $avisoIni.hidden = false;
    return;
  }

  sessionStorage.setItem('nexus_empresa', estado.empresaId);
  $area.hidden = false;
  $avisoIni.hidden = true;

  await cargarTodo();
}

/* ============================================
   Utilidad
   ============================================ */

function traducirBd(error) {
  const m = error.message || '';
  if (m.includes('lote caducado')) return 'No se puede operar con un lote caducado';
  if (m.includes('Existencia insuficiente')) return m;
  if (m.includes('no pertenece a la empresa')) return 'Los datos no corresponden a la empresa seleccionada';
  if (m.includes('inmutable')) return 'El kárdex no admite modificaciones. Registre un ajuste.';
  if (error.code === '42501') return 'No tiene permisos para esta acción';
  return 'Error: ' + m;
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  $empresa.addEventListener('change', seleccionarEmpresa);

  document.querySelectorAll('.pestana').forEach((p) => {
    p.addEventListener('click', () => cambiarVista(p.dataset.vista));
  });

  const $btnOrden = document.getElementById('btn-imprimir-orden');
  if ($btnOrden) $btnOrden.addEventListener('click', imprimirOrden);

  // Insumos
  const $bni = document.getElementById('btn-nuevo-insumo');
  if ($bni) $bni.addEventListener('click', () => abrirInsumo(null));
  const $fi = document.getElementById('filtro-insumo');
  if ($fi) $fi.addEventListener('input', pintarInsumos);
  const $gi = document.getElementById('guardar-insumo');
  if ($gi) $gi.addEventListener('click', guardarInsumo);
  const $ci2 = document.getElementById('cancelar-insumo');
  if ($ci2) $ci2.addEventListener('click', () => document.getElementById('modal-insumo').hidden = true);
  const $cei = document.getElementById('cerrar-insumo');
  if ($cei) $cei.addEventListener('click', () => document.getElementById('modal-insumo').hidden = true);
  const $eli = document.getElementById('btn-eliminar-insumo');
  if ($eli) $eli.addEventListener('click', eliminarInsumo);

  /* Cierre genérico de modales */
  document.querySelectorAll('[data-cierra]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.cierra).hidden = true;
    });
  });

  /* Medicamento */
  document.getElementById('btn-nuevo-med').addEventListener('click', () => abrirMedicamento());
  document.getElementById('btn-guardar-med').addEventListener('click', guardarMedicamento);

  /* Ingreso */
  document.getElementById('btn-ingreso').addEventListener('click', abrirIngreso);
  document.getElementById('btn-guardar-ingreso').addEventListener('click', guardarIngreso);
  document.getElementById('ing_tipo').addEventListener('change', actualizarAyudaTipoIngreso);
  document.getElementById('ing_caducidad').addEventListener('change', evaluarCaducidad);

  /* Salida */
  document.getElementById('btn-salida').addEventListener('click', abrirSalida);
  document.getElementById('btn-guardar-salida').addEventListener('click', guardarSalida);
  document.getElementById('sal_tipo').addEventListener('change', alternarTrabajador);
  document.getElementById('sal_medicamento').addEventListener('change', cargarLotesDeSalida);
  document.getElementById('sal_lote').addEventListener('change', evaluarCantidadSalida);
  document.getElementById('sal_cantidad').addEventListener('input', evaluarCantidadSalida);

  /* Filtros */
  document.getElementById('busqueda').addEventListener('input', retrasar(pintarExistencias, 200));
  document.getElementById('filtro-nivel').addEventListener('change', pintarExistencias);
  document.getElementById('busqueda-lotes').addEventListener('input', retrasar(pintarLotes, 200));
  document.getElementById('filtro-caducidad').addEventListener('change', pintarLotes);
  document.getElementById('busqueda-kardex').addEventListener('input', retrasar(pintarKardex, 200));
  document.getElementById('filtro-tipo').addEventListener('change', pintarKardex);

  /* Escape cierra el modal visible */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['modal-med', 'modal-ingreso', 'modal-salida'].forEach((id) => {
      const $m = document.getElementById(id);
      if (!$m.hidden) $m.hidden = true;
    });
  });
}

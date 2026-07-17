/* ============================================
   NEXUS · atenciones.js
   Lógica exclusiva de atenciones.html

   Reglas de negocio:
    · La atención es el hecho clínico; el descuento de
      farmacia es su consecuencia. Si falta existencia,
      la atención se registra y el medicamento queda
      como no entregado.
    · El primer diagnóstico es el principal y sostiene
      los indicadores de morbilidad.
    · Las alergias pertenecen al trabajador, no a la
      atención: se capturan aquí y persisten en su ficha.
    · Morbilidad común. Lo ocupacional tendrá módulo propio.
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina, puedeVerClinica } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar, textoOGuion, retrasar, formatearFecha } from './utils.js';

/* --- Estado --- */
const estado = {
  perfil: null,
  empresaId: null,
  atenciones: [],
  medicamentos: [],
  morbilidad: [],
  trabajador: null,     // trabajador de la atención en curso
  diagnosticos: [],     // [{codigo, descripcion, observacion}]
  prescripciones: [],   // [{medicamento_id, nombre, cantidad, indicacion, disponible}]
  cieDestino: null,     // índice del diagnóstico que abrió el buscador
  paciente: null,       // trabajador localizado en la pestaña Atenciones
  histAbierto: false,   // historial embebido desplegado
  vista: 'atenciones'
};

const HOY = () => new Date().toISOString().slice(0, 10);

const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

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

  if (!puedeVerClinica(perfil.rol)) {
    window.location.href = '/Nexus/dashboard.html';
    return;
  }

  estado.perfil = perfil;
  montarNavegacion(perfil, 'atenciones');

  prepararAnios();
  await cargarEmpresas();
  conectarEventos();
}

function prepararAnios() {
  const actual = new Date().getFullYear();
  ['morb-anio', 'cons-anio'].forEach((id) => {
    const $sel = document.getElementById(id);
    for (let a = actual; a >= actual - 5; a--) {
      const opcion = document.createElement('option');
      opcion.value = a;
      opcion.textContent = a;
      $sel.appendChild(opcion);
    }
  });
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

async function cargarAtenciones() {
  const { data, error } = await supabase
    .from('v_atenciones')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .order('fecha', { ascending: false })
    .order('creado_en', { ascending: false })
    .limit(500);

  estado.atenciones = error ? [] : (data || []);
}

async function cargarMedicamentos() {
  const { data, error } = await supabase
    .from('v_stock_medicamentos')
    .select('id, nombre_generico, nombre_comercial, concentracion, forma, presentacion, stock_disponible')
    .eq('empresa_id', estado.empresaId)
    .eq('activo', true)
    .order('nombre_generico');

  estado.medicamentos = error ? [] : (data || []);
}

async function cargarMorbilidad() {
  const { data, error } = await supabase
    .from('v_morbilidad')
    .select('*')
    .eq('empresa_id', estado.empresaId);

  estado.morbilidad = error ? [] : (data || []);
}

/* ============================================
   Resumen
   ============================================ */

function pintarResumen() {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth() + 1;

  const delAnio = estado.atenciones.filter((a) => new Date(a.fecha + 'T00:00').getFullYear() === anio);
  const delMes = delAnio.filter((a) => new Date(a.fecha + 'T00:00').getMonth() + 1 === mes);

  document.getElementById('kpi-mes').textContent = delMes.length;
  document.getElementById('kpi-anio').textContent = delAnio.length;
  document.getElementById('kpi-personas').textContent =
    new Set(delAnio.map((a) => a.trabajador_id)).size;
  document.getElementById('kpi-reposo').textContent =
    delAnio.reduce((s, a) => s + (a.dias_reposo || 0), 0);
}

/* ============================================
   Vista · Atenciones de hoy
   ============================================ */

function pintarHoy() {
  const hoy = HOY();
  const $cuerpo = document.getElementById('cuerpo-hoy');

  document.getElementById('dia-fecha').textContent =
    new Date().toLocaleDateString('es-EC', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

  const visibles = estado.atenciones.filter((a) => a.fecha === hoy);
  document.getElementById('dia-contador').textContent = visibles.length;

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-hoy').hidden = visibles.length > 0;

  const frag = document.createDocumentFragment();
  visibles.forEach((a) => frag.appendChild(filaAtencion(a, true)));
  $cuerpo.appendChild(frag);
}

/* ============================================
   Vista · Consolidado
   ============================================ */

/** Alimenta el filtro de diagnósticos con los realmente usados */
function llenarFiltroDx() {
  const $sel = document.getElementById('cons-dx');
  const previo = $sel.value;

  const mapa = new Map();
  estado.atenciones.forEach((a) => {
    if (a.cie10_principal && !mapa.has(a.cie10_principal)) {
      mapa.set(a.cie10_principal, a.diagnostico_principal);
    }
  });

  const items = [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  $sel.innerHTML = '<option value="">Todos los diagnósticos</option>';
  items.forEach(([codigo, descripcion]) => {
    const opcion = document.createElement('option');
    opcion.value = codigo;
    opcion.textContent = `${codigo} · ${descripcion || ''}`.trim();
    $sel.appendChild(opcion);
  });

  if (previo && mapa.has(previo)) $sel.value = previo;
}

function pintarConsolidado() {
  const anio = parseInt(document.getElementById('cons-anio').value, 10);
  const mes = parseInt(document.getElementById('cons-mes').value, 10);
  const dx = document.getElementById('cons-dx').value;
  const texto = document.getElementById('cons-busqueda').value.trim().toLowerCase();
  const $cuerpo = document.getElementById('cuerpo-consolidado');

  const visibles = estado.atenciones.filter((a) => {
    const f = new Date(a.fecha + 'T00:00');
    if (f.getFullYear() !== anio) return false;
    if (mes !== 0 && f.getMonth() + 1 !== mes) return false;
    if (dx && a.cie10_principal !== dx) return false;

    if (!texto) return true;
    return [String(a.codigo_trabajador), a.nombre_completo, a.cedula]
      .filter(Boolean).some((c) => String(c).toLowerCase().includes(texto));
  });

  /* Resumen del filtro aplicado */
  const $resumen = document.getElementById('cons-resumen');
  if (dx || mes !== 0 || texto) {
    const partes = [`${visibles.length} atención${visibles.length === 1 ? '' : 'es'}`];
    if (mes !== 0) partes.push(`en ${MESES[mes]} ${anio}`);
    else partes.push(`en ${anio}`);
    if (dx) {
      const desc = estado.atenciones.find((a) => a.cie10_principal === dx)?.diagnostico_principal;
      partes.push(`por ${dx}${desc ? ' · ' + desc : ''}`);
    }
    const personas = new Set(visibles.map((a) => a.trabajador_id)).size;
    partes.push(`· ${personas} trabajador${personas === 1 ? '' : 'es'}`);

    document.getElementById('cons-resumen-texto').textContent = partes.join(' ');
    $resumen.hidden = false;
  } else {
    $resumen.hidden = true;
  }

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-consolidado').hidden = visibles.length > 0;

  const frag = document.createDocumentFragment();
  visibles.forEach((a) => frag.appendChild(filaAtencion(a, false)));
  $cuerpo.appendChild(frag);
}

function limpiarFiltrosConsolidado() {
  document.getElementById('cons-mes').value = '0';
  document.getElementById('cons-dx').value = '';
  document.getElementById('cons-busqueda').value = '';
  pintarConsolidado();
}

/* ============================================
   Fila de atención · compartida
   ============================================ */

/**
 * @param {object} a - atención
 * @param {boolean} esHoy - muestra hora en vez de fecha
 */
function filaAtencion(a, esHoy) {
  const fila = document.createElement('tr');

  const primeraColumna = esHoy
    ? new Date(a.creado_en).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })
    : formatearFecha(a.fecha);

  fila.innerHTML = `
    <td class="celda-centro celda-mono">${primeraColumna}</td>
    <td class="celda-centro"><span class="codigo">${a.codigo_trabajador}</span></td>
    <td>
      <span class="principal">${escapar(a.nombre_completo)}</span>
      ${a.cargo ? `<span class="secundario">${escapar(a.cargo)}</span>` : ''}
    </td>
    <td class="celda-centro">${a.edad_atencion ?? '—'}</td>
    <td>
      ${a.cie10_principal
        ? `<span class="cie-chip">${escapar(a.cie10_principal)}</span>
           <span class="secundario">${escapar(a.diagnostico_principal || '')}</span>`
        : '<span class="celda-tenue">Sin diagnóstico</span>'}
    </td>
    <td class="celda-centro celda-tenue">${a.total_diagnosticos}</td>
    <td class="celda-centro">
      ${a.total_medicamentos > 0
        ? `<span class="${a.medicamentos_no_entregados > 0 ? 'rx-parcial' : 'celda-tenue'}">
             ${a.total_medicamentos}${a.medicamentos_no_entregados > 0 ? ' ⚠' : ''}
           </span>`
        : '—'}
    </td>
    <td class="celda-centro">${a.dias_reposo > 0 ? `<span class="reposo">${a.dias_reposo}</span>` : '—'}</td>
    <td class="celda-derecha"></td>
  `;

  const ver = document.createElement('button');
  ver.className = 'boton-icono';
  ver.textContent = 'Ver';
  ver.addEventListener('click', () => abrirDetalle(a));
  fila.querySelector('td:last-child').appendChild(ver);

  return fila;
}

/* ============================================
   Vista · Morbilidad
   ============================================ */

function pintarMorbilidad() {
  const anio = parseInt(document.getElementById('morb-anio').value, 10);
  const mes = parseInt(document.getElementById('morb-mes').value, 10);
  const tipo = document.getElementById('morb-tipo').value;
  const $cuerpo = document.getElementById('cuerpo-morbilidad');

  /* Agrupar por código sumando por sexo */
  const mapa = new Map();

  estado.morbilidad
    .filter((m) => m.anio === anio)
    .filter((m) => mes === 0 || m.mes === mes)
    .filter((m) => tipo === 'todos' || m.es_principal)
    .forEach((m) => {
      if (!mapa.has(m.codigo_cie10)) {
        mapa.set(m.codigo_cie10, {
          codigo: m.codigo_cie10,
          descripcion: m.descripcion,
          hombres: 0, mujeres: 0, total: 0
        });
      }
      const item = mapa.get(m.codigo_cie10);
      if (m.sexo === 'M') item.hombres += m.casos;
      else if (m.sexo === 'F') item.mujeres += m.casos;
      item.total += m.casos;
    });

  const filas = [...mapa.values()].sort((a, b) => b.total - a.total);
  const granTotal = filas.reduce((s, f) => s + f.total, 0);

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-morbilidad').hidden = filas.length > 0;

  const frag = document.createDocumentFragment();

  filas.forEach((f, i) => {
    const porcentaje = granTotal > 0 ? (f.total / granTotal * 100) : 0;
    const fila = document.createElement('tr');

    fila.innerHTML = `
      <td class="celda-centro celda-tenue">${i + 1}</td>
      <td class="celda-centro"><span class="cie-chip">${escapar(f.codigo)}</span></td>
      <td>${escapar(f.descripcion)}</td>
      <td class="celda-centro celda-tenue">${f.hombres}</td>
      <td class="celda-centro celda-tenue">${f.mujeres}</td>
      <td class="celda-centro"><span class="saldo">${f.total}</span></td>
      <td>
        <div class="barra">
          <div class="barra-relleno" style="width:${porcentaje.toFixed(1)}%"></div>
          <span class="barra-texto">${porcentaje.toFixed(1)}%</span>
        </div>
      </td>
    `;
    frag.appendChild(fila);
  });

  $cuerpo.appendChild(frag);
}

/* ============================================
   Atención · Apertura
   ============================================ */

function abrirAtencion() {
  estado.trabajador = null;
  estado.diagnosticos = [];
  estado.prescripciones = [];

  document.getElementById('at_codigo').value = '';
  document.getElementById('at_fecha').value = HOY();
  document.getElementById('at_motivo').value = '';
  document.getElementById('at_observacion').value = '';
  document.getElementById('at_reposo').value = '0';
  document.getElementById('at_alergias').value = '';
  document.getElementById('ayuda-codigo').textContent = '';
  document.getElementById('ayuda-imc').textContent = '';

  ['at_sistolica', 'at_diastolica', 'at_fc', 'at_fr',
   'at_temp', 'at_sat', 'at_peso', 'at_talla'].forEach((id) => {
    document.getElementById(id).value = '';
  });

  ocultarBloques();
  document.getElementById('alerta-atencion').hidden = true;
  document.getElementById('modal-atencion').hidden = false;
  document.getElementById('at_codigo').focus();
}

function ocultarBloques() {
  ['ficha', 'antecedente', 'bloque-motivo', 'bloque-vitales', 'bloque-diagnosticos',
   'bloque-medicamentos', 'bloque-cierre'].forEach((id) => {
    document.getElementById(id).hidden = true;
  });
}

function mostrarBloques() {
  ['ficha', 'bloque-motivo', 'bloque-vitales', 'bloque-diagnosticos',
   'bloque-medicamentos', 'bloque-cierre'].forEach((id) => {
    document.getElementById(id).hidden = false;
  });
}

/* ============================================
   Atención · Búsqueda del trabajador
   ============================================ */

const buscarTrabajador = retrasar(async () => {
  const codigo = parseInt(document.getElementById('at_codigo').value, 10);
  const $ayuda = document.getElementById('ayuda-codigo');

  if (!codigo) {
    $ayuda.textContent = '';
    estado.trabajador = null;
    ocultarBloques();
    return;
  }

  const { data, error } = await supabase
    .from('v_trabajadores')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('codigo', codigo)
    .maybeSingle();

  if (error || !data) {
    $ayuda.textContent = 'No existe un trabajador con ese código en esta empresa';
    $ayuda.className = 'ayuda ayuda-error';
    estado.trabajador = null;
    ocultarBloques();
    return;
  }

  if (!data.activo) {
    $ayuda.textContent = `${data.nombre_completo} · inactivo`;
    $ayuda.className = 'ayuda ayuda-aviso';
  } else {
    $ayuda.textContent = 'Trabajador identificado';
    $ayuda.className = 'ayuda ayuda-ok';
  }

  estado.trabajador = data;
  pintarFicha(data);
  pintarAntecedente(data);
  mostrarBloques();

  /* Primer diagnóstico listo para capturar */
  if (estado.diagnosticos.length === 0) agregarDiagnostico();
}, 400);

/**
 * Contexto clínico inmediato: última atención y frecuencia.
 * Evita que el médico tenga que salir del formulario para
 * saber si el trabajador ya consultó por lo mismo.
 */
function pintarAntecedente(t) {
  const $ant = document.getElementById('antecedente');
  const propias = estado.atenciones.filter((a) => a.trabajador_id === t.id);

  if (propias.length === 0) {
    $ant.innerHTML = '<span class="antecedente-vacio">Primera atención registrada</span>';
    $ant.className = 'antecedente';
    $ant.hidden = false;
    return;
  }

  const ultima = propias[0];
  const dias = Math.round((new Date() - new Date(ultima.fecha + 'T00:00')) / 86400000);

  const anio = new Date().getFullYear();
  const delAnio = propias.filter((a) => new Date(a.fecha + 'T00:00').getFullYear() === anio).length;

  /* Reincidencia sobre el mismo diagnóstico */
  const mismoDx = ultima.cie10_principal
    ? propias.filter((a) => a.cie10_principal === ultima.cie10_principal).length
    : 0;

  const alerta = dias <= 30 || mismoDx >= 3;

  $ant.className = 'antecedente' + (alerta ? ' antecedente-alerta' : '');
  $ant.innerHTML = `
    <div class="antecedente-linea">
      <span class="antecedente-etiqueta">Última atención</span>
      <span class="antecedente-valor">
        ${formatearFecha(ultima.fecha)} · hace ${dias} día${dias === 1 ? '' : 's'}
      </span>
      ${ultima.cie10_principal
        ? `<span class="cie-chip">${escapar(ultima.cie10_principal)}</span>
           <span class="antecedente-dx">${escapar(ultima.diagnostico_principal || '')}</span>`
        : ''}
    </div>
    <div class="antecedente-linea antecedente-meta">
      <span>${propias.length} atención${propias.length === 1 ? '' : 'es'} en total</span>
      <span>${delAnio} este año</span>
      ${mismoDx >= 3
        ? `<span class="antecedente-flag">${mismoDx} veces por ${escapar(ultima.cie10_principal)}</span>`
        : ''}
    </div>
  `;
  $ant.hidden = false;
}

function pintarFicha(t) {
  document.getElementById('f-nombre').textContent = t.nombre_completo;
  document.getElementById('f-cedula').textContent = t.cedula;
  document.getElementById('f-edad').textContent = t.edad != null ? `${t.edad} años` : '—';
  document.getElementById('f-sexo').textContent =
    t.sexo === 'M' ? 'Masculino' : t.sexo === 'F' ? 'Femenino' : '—';
  document.getElementById('f-cargo').textContent = textoOGuion(t.cargo);
  document.getElementById('f-sangre').textContent = textoOGuion(t.tipo_sangre);

  const $alergias = document.getElementById('at_alergias');
  $alergias.value = t.alergias || '';
  $alergias.classList.toggle('con-alergia', Boolean(t.alergias));
}

/* ============================================
   Diagnósticos
   ============================================ */

function agregarDiagnostico() {
  estado.diagnosticos.push({ codigo: '', descripcion: '', observacion: '' });
  pintarDiagnosticos();
}

function quitarDiagnostico(indice) {
  estado.diagnosticos.splice(indice, 1);
  if (estado.diagnosticos.length === 0) agregarDiagnostico();
  else pintarDiagnosticos();
}

function pintarDiagnosticos() {
  const $lista = document.getElementById('lista-diagnosticos');
  $lista.innerHTML = '';

  estado.diagnosticos.forEach((d, i) => {
    const item = document.createElement('article');
    item.className = 'renglon' + (i === 0 ? ' renglon-principal' : '');

    item.innerHTML = `
      <div class="renglon-orden">
        ${i === 0 ? '<span class="etiqueta-principal">Principal</span>' : `<span class="orden-num">${i + 1}</span>`}
      </div>
      <div class="renglon-cuerpo">
        <button class="selector-cie ${d.codigo ? 'selector-lleno' : ''}" type="button" data-i="${i}">
          ${d.codigo
            ? `<span class="cie-chip">${escapar(d.codigo)}</span><span class="cie-desc">${escapar(d.descripcion)}</span>`
            : '<span class="cie-vacio">Buscar diagnóstico CIE-10…</span>'}
        </button>
        <input class="entrada entrada-mini" type="text" placeholder="Observación"
               value="${escapar(d.observacion)}" data-obs="${i}">
      </div>
      <button class="boton-quitar" type="button" data-quitar="${i}" aria-label="Quitar">×</button>
    `;

    $lista.appendChild(item);
  });

  /* Eventos por renglón */
  $lista.querySelectorAll('.selector-cie').forEach((btn) => {
    btn.addEventListener('click', () => abrirBuscadorCie(parseInt(btn.dataset.i, 10)));
  });
  $lista.querySelectorAll('[data-obs]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      estado.diagnosticos[parseInt(e.target.dataset.obs, 10)].observacion = e.target.value;
    });
  });
  $lista.querySelectorAll('[data-quitar]').forEach((btn) => {
    btn.addEventListener('click', () => quitarDiagnostico(parseInt(btn.dataset.quitar, 10)));
  });
}

/* ============================================
   Buscador CIE-10
   ============================================ */

function abrirBuscadorCie(indice) {
  estado.cieDestino = indice;
  document.getElementById('cie-busqueda').value = '';
  document.getElementById('cie-resultados').innerHTML =
    '<p class="pista">Escriba al menos dos caracteres para buscar.</p>';
  document.getElementById('agregar-cie').hidden = true;
  document.getElementById('nuevo_cie_codigo').value = '';
  document.getElementById('nuevo_cie_desc').value = '';
  document.getElementById('alerta-cie').hidden = true;
  document.getElementById('modal-cie').hidden = false;
  document.getElementById('cie-busqueda').focus();
}

const buscarCie = retrasar(async () => {
  const texto = document.getElementById('cie-busqueda').value.trim();
  const $res = document.getElementById('cie-resultados');

  if (texto.length < 2) {
    $res.innerHTML = '<p class="pista">Escriba al menos dos caracteres para buscar.</p>';
    return;
  }

  /* Búsqueda por código o descripción, indistintamente */
  const { data, error } = await supabase
    .from('cie10')
    .select('codigo, descripcion, capitulo')
    .eq('activo', true)
    .or(`codigo.ilike.${texto}%,descripcion.ilike.%${texto}%`)
    .order('codigo')
    .limit(40);

  if (error) {
    $res.innerHTML = '<p class="pista">Error en la búsqueda.</p>';
    return;
  }

  if (!data || data.length === 0) {
    $res.innerHTML = `
      <p class="pista">
        Sin coincidencias para «${escapar(texto)}».<br>
        Use «+ Código no listado» para registrarlo.
      </p>`;
    /* Precargar lo escrito en el formulario de alta */
    const pareceCodigo = /^[A-Za-z][0-9]/.test(texto);
    document.getElementById(pareceCodigo ? 'nuevo_cie_codigo' : 'nuevo_cie_desc').value =
      pareceCodigo ? texto.toUpperCase() : texto;
    return;
  }

  $res.innerHTML = '';
  const frag = document.createDocumentFragment();

  data.forEach((c) => {
    const item = document.createElement('button');
    item.className = 'resultado';
    item.type = 'button';
    item.innerHTML = `
      <span class="cie-chip">${escapar(c.codigo)}</span>
      <span class="resultado-desc">${escapar(c.descripcion)}</span>
      ${c.capitulo ? `<span class="resultado-cap">${escapar(c.capitulo)}</span>` : ''}
    `;
    item.addEventListener('click', () => elegirCie(c));
    frag.appendChild(item);
  });

  $res.appendChild(frag);
}, 250);

function elegirCie(c) {
  const i = estado.cieDestino;
  if (i == null) return;

  /* Evitar duplicados en la misma atención */
  const yaEsta = estado.diagnosticos.some((d, j) => j !== i && d.codigo === c.codigo);
  if (yaEsta) {
    alertaCie('Ese diagnóstico ya está registrado en esta atención');
    return;
  }

  estado.diagnosticos[i].codigo = c.codigo;
  estado.diagnosticos[i].descripcion = c.descripcion;
  pintarDiagnosticos();
  document.getElementById('modal-cie').hidden = true;
}

async function crearCie() {
  const codigo = document.getElementById('nuevo_cie_codigo').value.trim().toUpperCase();
  const descripcion = document.getElementById('nuevo_cie_desc').value.trim();

  if (!codigo) return alertaCie('Indique el código');
  if (!descripcion) return alertaCie('Indique la descripción');
  if (!/^[A-Z][0-9]{2}(\.[0-9X]{1,2})?$/.test(codigo)) {
    return alertaCie('Formato inválido. Ejemplos válidos: M54, M54.5, Z57.0');
  }

  const $btn = document.getElementById('btn-crear-cie');
  $btn.disabled = true;

  const { error } = await supabase
    .from('cie10')
    .insert({ codigo, descripcion, capitulo: 'Añadido por el usuario', personalizado: true });

  $btn.disabled = false;

  if (error) {
    if (error.code === '23505') {
      /* Ya existía: recuperarlo y usarlo */
      const { data } = await supabase
        .from('cie10').select('codigo, descripcion').eq('codigo', codigo).single();
      if (data) { elegirCie(data); return; }
    }
    return alertaCie('No fue posible registrar el código: ' + error.message);
  }

  elegirCie({ codigo, descripcion });
}

function alertaCie(texto) {
  const $a = document.getElementById('alerta-cie');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Medicamentos
   ============================================ */

function agregarMedicamento() {
  if (estado.medicamentos.length === 0) {
    alert('Esta empresa aún no tiene medicamentos en el catálogo de farmacia.');
    return;
  }
  estado.prescripciones.push({ medicamento_id: '', cantidad: 1, indicacion: '' });
  pintarMedicamentos();
}

function quitarMedicamento(indice) {
  estado.prescripciones.splice(indice, 1);
  pintarMedicamentos();
}

function pintarMedicamentos() {
  const $lista = document.getElementById('lista-medicamentos');
  $lista.innerHTML = '';

  estado.prescripciones.forEach((p, i) => {
    const med = estado.medicamentos.find((m) => m.id === p.medicamento_id);
    const insuficiente = med && p.cantidad > med.stock_disponible;

    const item = document.createElement('article');
    item.className = 'renglon';

    const opciones = estado.medicamentos.map((m) => {
      const etiqueta = `${m.nombre_generico} ${m.concentracion || ''} · ${m.forma}`.trim();
      const stock = m.stock_disponible > 0 ? `(${m.stock_disponible})` : '(sin stock)';
      return `<option value="${m.id}" ${m.id === p.medicamento_id ? 'selected' : ''}>
                ${escapar(etiqueta)} ${stock}
              </option>`;
    }).join('');

    item.innerHTML = `
      <div class="renglon-orden"><span class="orden-num">${i + 1}</span></div>
      <div class="renglon-cuerpo renglon-medicamento">
        <select class="entrada entrada-mini" data-med="${i}">
          <option value="">— Seleccionar medicamento —</option>
          ${opciones}
        </select>
        <input class="entrada entrada-cantidad ${insuficiente ? 'entrada-alerta' : ''}"
               type="number" min="1" value="${p.cantidad}" data-cant="${i}" placeholder="Cant.">
        <input class="entrada entrada-mini" type="text" placeholder="Indicación · posología"
               value="${escapar(p.indicacion)}" data-ind="${i}">
      </div>
      <button class="boton-quitar" type="button" data-quitar-med="${i}" aria-label="Quitar">×</button>
    `;

    $lista.appendChild(item);

    if (insuficiente) {
      const aviso = document.createElement('p');
      aviso.className = 'aviso-stock';
      aviso.textContent = `Existencia disponible: ${med.stock_disponible}. Se registrará como no entregado.`;
      $lista.appendChild(aviso);
    }
  });

  /* Eventos */
  $lista.querySelectorAll('[data-med]').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      estado.prescripciones[parseInt(e.target.dataset.med, 10)].medicamento_id = e.target.value;
      pintarMedicamentos();
    });
  });
  $lista.querySelectorAll('[data-cant]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      estado.prescripciones[parseInt(e.target.dataset.cant, 10)].cantidad =
        parseInt(e.target.value, 10) || 1;
      pintarMedicamentos();
    });
  });
  $lista.querySelectorAll('[data-ind]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      estado.prescripciones[parseInt(e.target.dataset.ind, 10)].indicacion = e.target.value;
    });
  });
  $lista.querySelectorAll('[data-quitar-med]').forEach((btn) => {
    btn.addEventListener('click', () => quitarMedicamento(parseInt(btn.dataset.quitarMed, 10)));
  });
}

/* ============================================
   Índice de masa corporal
   ============================================ */

function calcularImc() {
  const peso = parseFloat(document.getElementById('at_peso').value);
  const talla = parseFloat(document.getElementById('at_talla').value);
  const $ayuda = document.getElementById('ayuda-imc');

  if (!peso || !talla) { $ayuda.textContent = ''; return; }

  const imc = peso / (talla * talla);
  let clase = 'ayuda';
  let texto;

  if (imc < 18.5) { texto = 'Bajo peso'; clase = 'ayuda ayuda-aviso'; }
  else if (imc < 25) { texto = 'Normal'; clase = 'ayuda ayuda-ok'; }
  else if (imc < 30) { texto = 'Sobrepeso'; clase = 'ayuda ayuda-aviso'; }
  else { texto = 'Obesidad'; clase = 'ayuda ayuda-critico'; }

  $ayuda.textContent = `IMC ${imc.toFixed(1)} · ${texto}`;
  $ayuda.className = clase;
}

/* ============================================
   Guardar
   ============================================ */

async function guardarAtencion() {
  if (!estado.trabajador) return alertaAtencion('Identifique al trabajador');

  const diagnosticos = estado.diagnosticos.filter((d) => d.codigo);
  if (diagnosticos.length === 0) return alertaAtencion('Registre al menos un diagnóstico');

  const prescripciones = estado.prescripciones.filter((p) => p.medicamento_id && p.cantidad > 0);

  const $btn = document.getElementById('btn-guardar-atencion');
  $btn.disabled = true;
  $btn.textContent = 'Registrando…';

  const vitales = {
    presion_sistolica: valorNumerico('at_sistolica'),
    presion_diastolica: valorNumerico('at_diastolica'),
    frecuencia_cardiaca: valorNumerico('at_fc'),
    frecuencia_resp: valorNumerico('at_fr'),
    temperatura: valorNumerico('at_temp'),
    saturacion: valorNumerico('at_sat'),
    peso: valorNumerico('at_peso'),
    talla: valorNumerico('at_talla')
  };

  const { data, error } = await supabase.rpc('registrar_atencion', {
    p_empresa: estado.empresaId,
    p_trabajador: estado.trabajador.id,
    p_fecha: document.getElementById('at_fecha').value,
    p_motivo: document.getElementById('at_motivo').value,
    p_observacion: document.getElementById('at_observacion').value,
    p_dias_reposo: parseInt(document.getElementById('at_reposo').value, 10) || 0,
    p_vitales: vitales,
    p_alergias: document.getElementById('at_alergias').value,
    p_diagnosticos: diagnosticos.map((d) => ({ codigo: d.codigo, observacion: d.observacion })),
    p_medicamentos: prescripciones.map((p) => ({
      medicamento_id: p.medicamento_id,
      cantidad: p.cantidad,
      indicacion: p.indicacion
    }))
  });

  $btn.disabled = false;
  $btn.textContent = 'Registrar atención';

  if (error) return alertaAtencion('No fue posible registrar: ' + error.message);

  /* Informar lo que no se pudo entregar */
  const noEntregados = data?.no_entregados || [];
  if (noEntregados.length > 0) {
    const detalle = noEntregados
      .map((n) => `· ${n.medicamento} (${n.solicitado} solicitadas)`)
      .join('\n');
    alert('Atención registrada.\n\nSin existencia suficiente para entregar:\n\n' +
          detalle + '\n\nQuedaron registrados como no entregados.');
  }

  document.getElementById('modal-atencion').hidden = true;
  await recargar();
}

function valorNumerico(id) {
  const v = document.getElementById(id).value;
  return v === '' ? null : parseFloat(v);
}

function alertaAtencion(texto) {
  const $a = document.getElementById('alerta-atencion');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Detalle
   ============================================ */

async function abrirDetalle(a) {
  const $cuerpo = document.getElementById('detalle-cuerpo');
  document.getElementById('detalle-titulo').textContent =
    `${formatearFecha(a.fecha)} · ${a.nombre_completo}`;
  $cuerpo.innerHTML = '<p class="pista">Cargando…</p>';
  document.getElementById('modal-detalle').hidden = false;

  const [dx, rx, at] = await Promise.all([
    supabase.from('atencion_diagnosticos')
      .select('codigo_cie10, orden, observacion, cie10(descripcion)')
      .eq('atencion_id', a.id).order('orden'),
    supabase.from('atencion_medicamentos')
      .select('cantidad, indicacion, entregado, motivo_no_entrega, medicamentos(nombre_generico, concentracion, forma)')
      .eq('atencion_id', a.id),
    supabase.from('atenciones')
      .select('motivo_consulta, presion_sistolica, presion_diastolica, frecuencia_cardiaca, frecuencia_resp, temperatura, saturacion, peso, talla')
      .eq('id', a.id).single()
  ]);

  const vitales = at.data || {};
  const hayVitales = ['presion_sistolica', 'frecuencia_cardiaca', 'temperatura',
                      'saturacion', 'peso'].some((k) => vitales[k] != null);

  $cuerpo.innerHTML = `
    <div class="detalle-encabezado">
      <div class="ficha-item">
        <span class="ficha-etiqueta">Código</span>
        <span class="ficha-valor">${a.codigo_trabajador}</span>
      </div>
      <div class="ficha-item">
        <span class="ficha-etiqueta">Cédula</span>
        <span class="ficha-valor celda-mono">${escapar(a.cedula)}</span>
      </div>
      <div class="ficha-item">
        <span class="ficha-etiqueta">Edad</span>
        <span class="ficha-valor">${a.edad_atencion ?? '—'}</span>
      </div>
      <div class="ficha-item">
        <span class="ficha-etiqueta">Cargo</span>
        <span class="ficha-valor">${escapar(textoOGuion(a.cargo))}</span>
      </div>
    </div>

    ${a.alergias ? `<p class="detalle-alergia">⚠ Alergias: ${escapar(a.alergias)}</p>` : ''}

    ${vitales.motivo_consulta ? `
      <h4 class="detalle-titulo">Motivo de consulta</h4>
      <p class="detalle-texto">${escapar(vitales.motivo_consulta)}</p>` : ''}

    ${hayVitales ? `
      <h4 class="detalle-titulo">Signos vitales</h4>
      <div class="vitales-tira">
        ${vitales.presion_sistolica ? `<span class="vital">PA ${vitales.presion_sistolica}/${vitales.presion_diastolica ?? '—'}</span>` : ''}
        ${vitales.frecuencia_cardiaca ? `<span class="vital">FC ${vitales.frecuencia_cardiaca}</span>` : ''}
        ${vitales.frecuencia_resp ? `<span class="vital">FR ${vitales.frecuencia_resp}</span>` : ''}
        ${vitales.temperatura ? `<span class="vital">T° ${vitales.temperatura}</span>` : ''}
        ${vitales.saturacion ? `<span class="vital">SatO₂ ${vitales.saturacion}%</span>` : ''}
        ${vitales.peso ? `<span class="vital">${vitales.peso} kg</span>` : ''}
        ${vitales.talla ? `<span class="vital">${vitales.talla} m</span>` : ''}
      </div>` : ''}

    <h4 class="detalle-titulo">Diagnósticos</h4>
    ${(dx.data || []).map((d) => `
      <div class="detalle-linea">
        <span class="cie-chip">${escapar(d.codigo_cie10)}</span>
        <span>${escapar(d.cie10?.descripcion || '')}</span>
        ${d.orden === 1 ? '<span class="etiqueta-principal">Principal</span>' : ''}
        ${d.observacion ? `<span class="secundario">${escapar(d.observacion)}</span>` : ''}
      </div>
    `).join('') || '<p class="pista">Sin diagnósticos.</p>'}

    <h4 class="detalle-titulo">Medicamentos</h4>
    ${(rx.data || []).map((m) => `
      <div class="detalle-linea">
        <span class="${m.entregado ? 'insignia insignia-activa' : 'insignia insignia-critica'}">
          ${m.entregado ? 'Entregado' : 'No entregado'}
        </span>
        <span>${escapar(m.medicamentos?.nombre_generico || '')} ${escapar(m.medicamentos?.concentracion || '')}</span>
        <span class="celda-mono">× ${m.cantidad}</span>
        ${m.indicacion ? `<span class="secundario">${escapar(m.indicacion)}</span>` : ''}
      </div>
    `).join('') || '<p class="pista">Sin prescripción.</p>'}

    ${a.observacion ? `
      <h4 class="detalle-titulo">Observación</h4>
      <p class="detalle-texto">${escapar(a.observacion)}</p>` : ''}

    ${a.dias_reposo > 0 ? `<p class="detalle-reposo">Reposo: ${a.dias_reposo} días</p>` : ''}

    <p class="detalle-pie">
      Registró: ${escapar(textoOGuion(a.atendido_por_nombre))}
    </p>
  `;
}

/* ============================================
   Buscador de paciente · pestaña Atenciones
   ============================================ */

/** Búsqueda por código. Se dispara con Enter o con el botón. */
async function buscarPaciente() {
  const codigo = parseInt(document.getElementById('busca_codigo').value, 10);
  const $ayuda = document.getElementById('ayuda-busca');

  if (!codigo) {
    $ayuda.textContent = 'Indique un código de trabajador';
    $ayuda.className = 'ayuda ayuda-error';
    return;
  }

  const { data, error } = await supabase
    .from('v_trabajadores')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('codigo', codigo)
    .maybeSingle();

  if (error || !data) {
    $ayuda.textContent = 'No existe un trabajador con ese código en esta empresa';
    $ayuda.className = 'ayuda ayuda-error';
    limpiarPaciente();
    return;
  }

  $ayuda.textContent = '';
  document.getElementById('busca_nombre').value = '';
  ocultarSugerencias();
  mostrarPaciente(data);
}

/** Búsqueda por nombre o cédula: devuelve sugerencias */
const buscarPorNombre = retrasar(async () => {
  const texto = document.getElementById('busca_nombre').value.trim();
  const $sug = document.getElementById('busca_sugerencias');

  if (texto.length < 2) { ocultarSugerencias(); return; }

  const { data, error } = await supabase
    .from('v_trabajadores')
    .select('id, codigo, cedula, nombre_completo, activo')
    .eq('empresa_id', estado.empresaId)
    .or(`nombre_completo.ilike.%${texto}%,cedula.ilike.${texto}%`)
    .order('apellidos')
    .limit(12);

  if (error || !data || data.length === 0) {
    $sug.innerHTML = '<p class="sugerencia-vacia">Sin coincidencias</p>';
    $sug.hidden = false;
    return;
  }

  $sug.innerHTML = '';
  const frag = document.createDocumentFragment();

  data.forEach((t) => {
    const item = document.createElement('button');
    item.className = 'sugerencia';
    item.type = 'button';
    item.innerHTML = `
      <span class="codigo">${t.codigo}</span>
      <span class="sugerencia-nombre">${escapar(t.nombre_completo)}</span>
      <span class="sugerencia-meta">${escapar(t.cedula)}</span>
      ${!t.activo ? '<span class="insignia insignia-inactiva">Inactivo</span>' : ''}
    `;
    item.addEventListener('click', () => {
      document.getElementById('busca_codigo').value = t.codigo;
      document.getElementById('busca_nombre').value = '';
      ocultarSugerencias();
      buscarPaciente();
    });
    frag.appendChild(item);
  });

  $sug.appendChild(frag);
  $sug.hidden = false;
}, 300);

function ocultarSugerencias() {
  document.getElementById('busca_sugerencias').hidden = true;
}

function limpiarPaciente() {
  estado.paciente = null;
  estado.histAbierto = false;
  document.getElementById('paciente').hidden = true;
}

/** Pinta la ficha del paciente localizado */
function mostrarPaciente(t) {
  estado.paciente = t;
  estado.histAbierto = false;

  document.getElementById('paciente').hidden = false;
  document.getElementById('p-historial').hidden = true;
  document.getElementById('btn-historial').textContent = 'Historial';

  document.getElementById('p-nombre').textContent = t.nombre_completo;
  document.getElementById('p-meta').textContent =
    [t.cargo, t.area, t.sucursal].filter(Boolean).join(' · ') || 'Sin cargo asignado';
  document.getElementById('p-codigo').textContent = t.codigo;
  document.getElementById('p-cedula').textContent = t.cedula;
  document.getElementById('p-edad').textContent = t.edad != null ? `${t.edad} años` : '—';
  document.getElementById('p-sexo').textContent =
    t.sexo === 'M' ? 'Masculino' : t.sexo === 'F' ? 'Femenino' : '—';
  document.getElementById('p-cargo').textContent = textoOGuion(t.cargo);
  document.getElementById('p-sangre').textContent = textoOGuion(t.tipo_sangre);

  document.getElementById('p-estado').innerHTML = t.activo
    ? '<span class="insignia insignia-activa">Activo</span>'
    : '<span class="insignia insignia-inactiva">Inactivo</span>';

  const propias = estado.atenciones.filter((a) => a.trabajador_id === t.id);
  document.getElementById('p-total').textContent = propias.length;

  const $alergias = document.getElementById('p-alergias');
  if (t.alergias) {
    $alergias.textContent = `⚠ Alergias: ${t.alergias}`;
    $alergias.hidden = false;
  } else {
    $alergias.hidden = true;
  }
}

/* ============================================
   Historial embebido
   ============================================ */

async function alternarHistorial() {
  const $hist = document.getElementById('p-historial');
  const $btn = document.getElementById('btn-historial');

  if (estado.histAbierto) {
    $hist.hidden = true;
    $btn.textContent = 'Historial';
    estado.histAbierto = false;
    return;
  }

  const t = estado.paciente;
  if (!t) return;

  const $lista = document.getElementById('p-lista');
  $lista.innerHTML = '<p class="pista">Cargando…</p>';
  $hist.hidden = false;
  $btn.textContent = 'Ocultar historial';
  estado.histAbierto = true;

  const propias = estado.atenciones.filter((a) => a.trabajador_id === t.id);

  pintarRecurrencia(propias);

  if (propias.length === 0) {
    $lista.innerHTML = '<p class="pista">Este trabajador no registra atenciones.</p>';
    return;
  }

  const ids = propias.map((a) => a.id);

  const [dx, rx] = await Promise.all([
    supabase.from('atencion_diagnosticos')
      .select('atencion_id, codigo_cie10, orden, observacion, cie10(descripcion)')
      .in('atencion_id', ids).order('orden'),
    supabase.from('atencion_medicamentos')
      .select('atencion_id, cantidad, indicacion, entregado, medicamentos(nombre_generico, concentracion)')
      .in('atencion_id', ids)
  ]);

  const porDx = agrupar(dx.data || [], 'atencion_id');
  const porRx = agrupar(rx.data || [], 'atencion_id');

  /* Agrupar por año */
  const porAnio = new Map();
  propias.forEach((a) => {
    const anio = new Date(a.fecha + 'T00:00').getFullYear();
    if (!porAnio.has(anio)) porAnio.set(anio, []);
    porAnio.get(anio).push(a);
  });

  const anios = [...porAnio.keys()].sort((a, b) => b - a);

  $lista.innerHTML = anios.map((anio) => `
    <div class="anio-bloque">
      <div class="anio-marca">
        <span class="anio-numero">${anio}</span>
        <span class="anio-conteo">${porAnio.get(anio).length} atención${porAnio.get(anio).length === 1 ? '' : 'es'}</span>
      </div>
      ${porAnio.get(anio).map((a) => pintarEventoTimeline(a, porDx, porRx)).join('')}
    </div>
  `).join('');
}

/**
 * Detecta diagnósticos repetidos.
 * La reincidencia sobre un mismo código es señal de vigilancia:
 * puede indicar exposición no controlada o enfermedad ocupacional.
 */
function pintarRecurrencia(atenciones) {
  const $panel = document.getElementById('p-recurrencia');
  const $chips = document.getElementById('p-chips');
  const $nota = document.getElementById('p-nota-recurrencia');

  if (atenciones.length === 0) { $panel.hidden = true; return; }

  const conteo = new Map();
  atenciones.forEach((a) => {
    if (!a.cie10_principal) return;
    if (!conteo.has(a.cie10_principal)) {
      conteo.set(a.cie10_principal, {
        codigo: a.cie10_principal, descripcion: a.diagnostico_principal, veces: 0
      });
    }
    conteo.get(a.cie10_principal).veces++;
  });

  const items = [...conteo.values()].sort((a, b) => b.veces - a.veces);
  if (items.length === 0) { $panel.hidden = true; return; }

  $chips.innerHTML = items.map((i) => `
    <span class="chip ${i.veces >= 3 ? 'chip-alerta' : ''}">
      <span class="cie-chip">${escapar(i.codigo)}</span>
      <span class="chip-desc">${escapar(i.descripcion || '')}</span>
      <span class="chip-conteo">${i.veces}</span>
    </span>
  `).join('');

  const reincidentes = items.filter((i) => i.veces >= 3);
  if (reincidentes.length > 0) {
    $nota.textContent = 'Diagnóstico repetido tres o más veces. Considere evaluar exposición ' +
                        'laboral y pertinencia de vigilancia específica.';
    $nota.className = 'nota nota-alerta';
  } else {
    $nota.textContent = 'Conteo por diagnóstico principal.';
    $nota.className = 'nota';
  }

  $panel.hidden = false;
}

function pintarEventoTimeline(a, porDx, porRx) {
  const diagnosticos = porDx[a.id] || [];
  const medicamentos = porRx[a.id] || [];

  return `
    <article class="evento">
      <div class="evento-fecha">
        <span class="evento-dia">${formatearFecha(a.fecha)}</span>
        ${a.dias_reposo > 0 ? `<span class="reposo">${a.dias_reposo} d</span>` : ''}
      </div>

      <div class="evento-cuerpo">
        ${a.motivo_consulta
          ? `<p class="evento-motivo">${escapar(a.motivo_consulta)}</p>`
          : ''}

        ${diagnosticos.map((d) => `
          <div class="evento-dx">
            <span class="cie-chip">${escapar(d.codigo_cie10)}</span>
            <span>${escapar(d.cie10?.descripcion || '')}</span>
            ${d.orden === 1 ? '<span class="etiqueta-principal">Principal</span>' : ''}
          </div>
        `).join('')}

        ${medicamentos.length > 0 ? `
          <div class="evento-rx">
            ${medicamentos.map((m) => `
              <span class="rx-item ${m.entregado ? '' : 'rx-no-entregado'}">
                ${escapar(m.medicamentos?.nombre_generico || '')} ${escapar(m.medicamentos?.concentracion || '')}
                × ${m.cantidad}${m.entregado ? '' : ' · no entregado'}
              </span>
            `).join('')}
          </div>` : ''}

        ${a.observacion ? `<p class="evento-obs">${escapar(a.observacion)}</p>` : ''}
      </div>
    </article>
  `;
}

function agrupar(lista, clave) {
  return lista.reduce((acc, item) => {
    (acc[item[clave]] ||= []).push(item);
    return acc;
  }, {});
}

/** Abre el formulario con el paciente ya cargado */
function nuevaAtencionDesdeFicha() {
  const t = estado.paciente;
  if (!t) return;

  abrirAtencion();
  document.getElementById('at_codigo').value = t.codigo;
  buscarTrabajador();
}

/* ============================================
   Pestañas y empresa
   ============================================ */

function cambiarVista(vista) {
  estado.vista = vista;
  document.querySelectorAll('.pestana').forEach((p) => {
    p.classList.toggle('activa', p.dataset.vista === vista);
  });
  ['atenciones', 'consolidado', 'morbilidad'].forEach((v) => {
    document.getElementById('vista-' + v).hidden = v !== vista;
  });
  if (vista === 'morbilidad') pintarMorbilidad();
  if (vista === 'consolidado') pintarConsolidado();
  if (vista === 'atenciones') document.getElementById('busca_codigo').focus();
}

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

  await recargar();
}

async function recargar() {
  await Promise.all([cargarAtenciones(), cargarMedicamentos(), cargarMorbilidad()]);
  pintarResumen();
  pintarHoy();
  llenarFiltroDx();

  if (estado.vista === 'consolidado') pintarConsolidado();
  if (estado.vista === 'morbilidad') pintarMorbilidad();

  /* Si hay una ficha abierta, reflejar la nueva atención */
  if (estado.paciente) {
    const abierto = estado.histAbierto;
    mostrarPaciente(estado.paciente);
    if (abierto) await alternarHistorial();
  }
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  $empresa.addEventListener('change', seleccionarEmpresa);

  document.querySelectorAll('.pestana').forEach((p) => {
    p.addEventListener('click', () => cambiarVista(p.dataset.vista));
  });

  document.querySelectorAll('[data-cierra]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.cierra).hidden = true;
    });
  });

  /* --- Buscador de paciente --- */
  document.getElementById('btn-buscar').addEventListener('click', buscarPaciente);
  document.getElementById('busca_codigo').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); buscarPaciente(); }
  });
  document.getElementById('busca_nombre').addEventListener('input', buscarPorNombre);
  document.getElementById('btn-nueva-atencion').addEventListener('click', nuevaAtencionDesdeFicha);
  document.getElementById('btn-historial').addEventListener('click', alternarHistorial);

  /* Cerrar sugerencias al hacer clic fuera */
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#busca_nombre') && !e.target.closest('#busca_sugerencias')) {
      ocultarSugerencias();
    }
  });

  /* --- Formulario de atención --- */
  document.getElementById('btn-guardar-atencion').addEventListener('click', guardarAtencion);
  document.getElementById('at_codigo').addEventListener('input', buscarTrabajador);
  document.getElementById('btn-add-diagnostico').addEventListener('click', agregarDiagnostico);
  document.getElementById('btn-add-medicamento').addEventListener('click', agregarMedicamento);
  document.getElementById('at_peso').addEventListener('input', calcularImc);
  document.getElementById('at_talla').addEventListener('input', calcularImc);

  /* --- Buscador CIE-10 --- */
  document.getElementById('cie-busqueda').addEventListener('input', buscarCie);
  document.getElementById('btn-crear-cie').addEventListener('click', crearCie);
  document.getElementById('btn-mostrar-agregar').addEventListener('click', () => {
    const $a = document.getElementById('agregar-cie');
    $a.hidden = !$a.hidden;
    if (!$a.hidden) document.getElementById('nuevo_cie_codigo').focus();
  });

  /* --- Consolidado --- */
  document.getElementById('cons-anio').addEventListener('change', pintarConsolidado);
  document.getElementById('cons-mes').addEventListener('change', pintarConsolidado);
  document.getElementById('cons-dx').addEventListener('change', pintarConsolidado);
  document.getElementById('cons-busqueda').addEventListener('input', retrasar(pintarConsolidado, 200));
  document.getElementById('cons-limpiar').addEventListener('click', limpiarFiltrosConsolidado);

  /* --- Morbilidad --- */
  document.getElementById('morb-anio').addEventListener('change', pintarMorbilidad);
  document.getElementById('morb-mes').addEventListener('change', pintarMorbilidad);
  document.getElementById('morb-tipo').addEventListener('change', pintarMorbilidad);

  /* Escape cierra el modal superior */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const orden = ['modal-cie', 'modal-detalle', 'modal-atencion'];
    for (const id of orden) {
      const $m = document.getElementById(id);
      if (!$m.hidden) { $m.hidden = true; return; }
    }
  });
}

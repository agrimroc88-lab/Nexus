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
  vista: 'listado'
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
  const $sel = document.getElementById('morb-anio');
  const actual = new Date().getFullYear();
  for (let a = actual; a >= actual - 5; a--) {
    const opcion = document.createElement('option');
    opcion.value = a;
    opcion.textContent = a;
    $sel.appendChild(opcion);
  }
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
   Vista · Listado
   ============================================ */

function pintarListado() {
  const texto = document.getElementById('busqueda').value.trim().toLowerCase();
  const periodo = document.getElementById('filtro-periodo').value;
  const $cuerpo = document.getElementById('cuerpo-listado');

  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth() + 1;

  const visibles = estado.atenciones.filter((a) => {
    const f = new Date(a.fecha + 'T00:00');
    if (periodo === 'mes' && (f.getFullYear() !== anio || f.getMonth() + 1 !== mes)) return false;
    if (periodo === 'anio' && f.getFullYear() !== anio) return false;

    if (!texto) return true;
    return [String(a.codigo_trabajador), a.nombre_completo, a.cedula,
            a.diagnostico_principal, a.cie10_principal]
      .filter(Boolean).some((c) => String(c).toLowerCase().includes(texto));
  });

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-listado').hidden = visibles.length > 0;

  const frag = document.createDocumentFragment();

  visibles.forEach((a) => {
    const fila = document.createElement('tr');

    fila.innerHTML = `
      <td class="celda-centro celda-mono">${formatearFecha(a.fecha)}</td>
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

    frag.appendChild(fila);
  });

  $cuerpo.appendChild(frag);
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
  ['ficha', 'bloque-motivo', 'bloque-vitales', 'bloque-diagnosticos',
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
  mostrarBloques();

  /* Primer diagnóstico listo para capturar */
  if (estado.diagnosticos.length === 0) agregarDiagnostico();
}, 400);

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
   Pestañas y empresa
   ============================================ */

function cambiarVista(vista) {
  estado.vista = vista;
  document.querySelectorAll('.pestana').forEach((p) => {
    p.classList.toggle('activa', p.dataset.vista === vista);
  });
  ['listado', 'morbilidad'].forEach((v) => {
    document.getElementById('vista-' + v).hidden = v !== vista;
  });
  if (vista === 'morbilidad') pintarMorbilidad();
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
  pintarListado();
  if (estado.vista === 'morbilidad') pintarMorbilidad();
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

  document.getElementById('btn-nueva').addEventListener('click', abrirAtencion);
  document.getElementById('btn-guardar-atencion').addEventListener('click', guardarAtencion);
  document.getElementById('at_codigo').addEventListener('input', buscarTrabajador);

  document.getElementById('btn-add-diagnostico').addEventListener('click', agregarDiagnostico);
  document.getElementById('btn-add-medicamento').addEventListener('click', agregarMedicamento);

  document.getElementById('cie-busqueda').addEventListener('input', buscarCie);
  document.getElementById('btn-crear-cie').addEventListener('click', crearCie);
  document.getElementById('btn-mostrar-agregar').addEventListener('click', () => {
    const $a = document.getElementById('agregar-cie');
    $a.hidden = !$a.hidden;
    if (!$a.hidden) document.getElementById('nuevo_cie_codigo').focus();
  });

  document.getElementById('at_peso').addEventListener('input', calcularImc);
  document.getElementById('at_talla').addEventListener('input', calcularImc);

  document.getElementById('busqueda').addEventListener('input', retrasar(pintarListado, 200));
  document.getElementById('filtro-periodo').addEventListener('change', pintarListado);
  document.getElementById('morb-anio').addEventListener('change', pintarMorbilidad);
  document.getElementById('morb-mes').addEventListener('change', pintarMorbilidad);
  document.getElementById('morb-tipo').addEventListener('change', pintarMorbilidad);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    /* Cerrar solo el modal superior */
    const orden = ['modal-cie', 'modal-detalle', 'modal-atencion'];
    for (const id of orden) {
      const $m = document.getElementById(id);
      if (!$m.hidden) { $m.hidden = true; return; }
    }
  });
}

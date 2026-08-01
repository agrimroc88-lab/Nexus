/* ============================================
   NEXUS · botiquines.js

   Control mensual de botiquines de primeros auxilios.
   Código del Trabajo Art. 430 · Requisito SP-01 del Anexo 1.

   Cómo se trabaja:
     Se elige el mes, se abre la revisión y se recorre cada
     botiquín anotando lo que se encontró. El faltante sale
     solo de restar contra la dotación, y lo repuesto se
     propone igual al faltante porque es lo normal —pero se
     puede bajar cuando la farmacia no tiene stock, que es
     justo la diferencia que un auditor pregunta.

   Qué produce:
     · Un informe mensual con todos los botiquines, agrupados
       por departamento.
     · Un acta de entrega por área, con firmas de quien
       entrega y quien recibe.
   ============================================ */

import { supabase } from './supabase.js';
import { ROLES } from './auth.js';
import { escapar, formatearFecha } from './utils.js';
import { imprimirHoja } from './impresion.js';

const bt = {
  perfil: null,
  empresaId: null,
  empresaNombre: '',
  periodo: null,        // 'YYYY-MM'
  botiquines: [],
  revisiones: [],       // del periodo elegido
  detalle: {},          // revision_id → [líneas]
  actual: null          // revisión abierta
};

/* Debe coincidir con es_personal_salud() de la base */
const PERSONAL = [
  ROLES.ADMIN, ROLES.MEDICO, ROLES.ENFERMERIA, ROLES.PSICOLOGO,
  ROLES.TRABAJO_SOCIAL, ROLES.PSICO_SOCIAL, ROLES.ERGONOMO, ROLES.TECNICO
];

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const HOY = () => new Date().toISOString().slice(0, 10);

function puedeEscribir() {
  return PERSONAL.includes(bt.perfil?.rol);
}

/** 'YYYY-MM' → primer día del mes, que es como se guarda */
function primerDia(clave) {
  return clave + '-01';
}

function nombreMes(clave) {
  const [a, m] = clave.split('-');
  return `${MESES[parseInt(m, 10) - 1]} de ${a}`;
}

/* Cantidades sin decimales cuando son enteras: '6' y no '6.00' */
function num(v) {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/* ============================================
   Arranque
   ============================================ */

export function montarBotiquines(perfil) {
  bt.perfil = perfil;
  prepararPeriodos();
  conectar();
}

function prepararPeriodos() {
  const $sel = document.getElementById('bt-periodo');
  if (!$sel || $sel.options.length > 0) return;

  /* Dos años hacia atrás basta: el control es mensual y lo
     anterior se consulta en los informes ya emitidos. */
  const hoy = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    const clave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const o = document.createElement('option');
    o.value = clave;
    o.textContent = nombreMes(clave);
    $sel.appendChild(o);
  }
  bt.periodo = $sel.value;
}

export async function cargarBotiquines(empresaId, empresaNombre) {
  bt.empresaId = empresaId;
  bt.empresaNombre = empresaNombre || '';

  if (!empresaId) { bt.botiquines = []; bt.revisiones = []; return; }

  bt.periodo = document.getElementById('bt-periodo')?.value || bt.periodo;

  const [bots, revs] = await Promise.all([
    supabase.from('v_botiquines').select('*')
      .eq('empresa_id', empresaId).eq('activo', true).order('orden'),
    supabase.from('v_botiquin_revisiones').select('*')
      .eq('empresa_id', empresaId).eq('periodo', primerDia(bt.periodo)).order('orden')
  ]);

  bt.botiquines = bots.data || [];
  bt.revisiones = revs.data || [];

  await cargarDetalle();
}

async function cargarDetalle() {
  bt.detalle = {};
  if (bt.revisiones.length === 0) return;

  const ids = bt.revisiones.map((r) => r.id);
  const { data } = await supabase
    .from('v_botiquin_detalle')
    .select('*')
    .in('revision_id', ids)
    .order('insumo_orden');

  (data || []).forEach((d) => (bt.detalle[d.revision_id] ||= []).push(d));
}

/* ============================================
   Listado
   ============================================ */

export function pintarBotiquines() {
  pintarResumen();
  pintarTabla();

  const abierto = bt.revisiones.length > 0;
  const $abrir = document.getElementById('bt-btn-abrir');
  if ($abrir) $abrir.hidden = abierto || !puedeEscribir();

  ['bt-btn-informe', 'bt-btn-actas'].forEach((id) => {
    const $b = document.getElementById(id);
    if ($b) $b.disabled = !abierto;
  });
}

function pintarResumen() {
  const rev = bt.revisiones;
  const revisados = rev.filter((r) => r.lineas_faltantes !== null && r.fecha_revision).length;

  const poner = (id, v) => {
    const $e = document.getElementById(id);
    if ($e) $e.textContent = v;
  };

  poner('bt-total', bt.botiquines.length);
  poner('bt-revisados', rev.filter((r) => r.estado === 'cerrada').length);
  poner('bt-faltantes', num(rev.reduce((s, r) => s + Number(r.total_faltante || 0), 0)));
  poner('bt-pendientes', num(rev.reduce((s, r) => s + Number(r.total_pendiente || 0), 0)));
}

function pintarTabla() {
  const $c = document.getElementById('bt-cuerpo');
  const $vacio = document.getElementById('bt-vacio');
  if (!$c) return;

  $c.innerHTML = '';

  if (bt.botiquines.length === 0) {
    if ($vacio) {
      $vacio.hidden = false;
      $vacio.textContent = 'No hay botiquines registrados para esta empresa.';
    }
    return;
  }

  if (bt.revisiones.length === 0) {
    if ($vacio) {
      $vacio.hidden = false;
      $vacio.textContent =
        `La revisión de ${nombreMes(bt.periodo)} aún no se ha abierto.`;
    }
    return;
  }
  if ($vacio) $vacio.hidden = true;

  /* Agrupado por departamento, como se recorre en campo */
  let departamentoPrevio = null;

  bt.revisiones.forEach((r) => {
    if (r.departamento !== departamentoPrevio) {
      departamentoPrevio = r.departamento;
      const sep = document.createElement('tr');
      sep.className = 'bt-separador';
      sep.innerHTML = `<td colspan="7">${escapar(r.departamento)}</td>`;
      $c.appendChild(sep);
    }

    const cerrada = r.estado === 'cerrada';
    const faltan = Number(r.total_faltante || 0);
    const pend = Number(r.total_pendiente || 0);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapar(r.area || r.departamento)}</td>
      <td class="celda-centro">${r.lineas}</td>
      <td class="celda-centro">${faltan > 0 ? num(faltan) : '—'}</td>
      <td class="celda-centro">${num(r.total_repuesto)}</td>
      <td class="celda-centro">${pend > 0
        ? `<span class="bt-pendiente">${num(pend)}</span>` : '—'}</td>
      <td class="celda-centro">
        <span class="insignia ${cerrada ? 'insignia-activa' : 'insignia-aviso'}">
          ${cerrada ? 'Cerrada' : 'Abierta'}
        </span>
      </td>
      <td class="celda-centro"></td>
    `;

    const btn = document.createElement('button');
    btn.className = 'boton-icono';
    btn.type = 'button';
    btn.textContent = cerrada ? 'Ver' : 'Revisar';
    btn.addEventListener('click', () => abrirRevision(r));
    tr.lastElementChild.appendChild(btn);

    $c.appendChild(tr);
  });
}

/* ============================================
   Apertura del mes
   ============================================ */

async function abrirMes() {
  if (!bt.empresaId) return alert('Seleccione una empresa');

  const $btn = document.getElementById('bt-btn-abrir');
  $btn.disabled = true;

  const { error } = await supabase.rpc('abrir_mes_botiquines', {
    p_empresa: bt.empresaId,
    p_periodo: primerDia(bt.periodo)
  });

  $btn.disabled = false;
  if (error) return alert(traducir(error));

  await refrescar();
}

/* ============================================
   Revisión de un botiquín
   ============================================ */

function abrirRevision(r) {
  bt.actual = r;

  document.getElementById('bt-r-titulo').textContent = r.botiquin;
  document.getElementById('bt-r-periodo').textContent = nombreMes(bt.periodo);

  document.getElementById('bt_fecha_revision').value = r.fecha_revision || HOY();
  document.getElementById('bt_revisado_por').value = r.revisado_por || '';
  document.getElementById('bt_recibido_por').value = r.recibido_por || '';
  document.getElementById('bt_observacion').value = r.observacion || '';

  pintarDetalle();

  const editable = puedeEscribir() && r.estado !== 'cerrada';
  ['bt_fecha_revision', 'bt_revisado_por', 'bt_recibido_por', 'bt_observacion']
    .forEach((id) => { document.getElementById(id).disabled = !editable; });

  document.getElementById('bt-btn-guardar').hidden = !editable;
  document.getElementById('bt-btn-completar').hidden = !editable;
  document.getElementById('bt-btn-cerrar-revision').hidden = !editable;
  document.getElementById('bt-btn-reabrir').hidden =
    !(puedeEscribir() && r.estado === 'cerrada');

  document.getElementById('bt-alerta-revision').hidden = true;
  document.getElementById('bt-modal-revision').hidden = false;
}

function pintarDetalle() {
  const r = bt.actual;
  const lineas = bt.detalle[r.id] || [];
  const editable = puedeEscribir() && r.estado !== 'cerrada';

  const $c = document.getElementById('bt-r-detalle');
  $c.innerHTML = '';

  lineas.forEach((l) => {
    const fila = document.createElement('tr');
    fila.dataset.insumo = l.insumo_id;

    const nombre = l.insumo + (l.presentacion ? ` (${l.presentacion})` : '');

    fila.innerHTML = `
      <td>${escapar(nombre)}${l.medicamento
        ? '<span class="bt-marca-med">Medicamento</span>' : ''}</td>
      <td class="celda-centro celda-tenue">${num(l.dotacion)} ${escapar(l.unidad)}</td>
      <td class="celda-centro">
        <input class="bt-num" type="number" min="0" step="1"
               data-campo="encontrado" value="${num(l.encontrado)}"
               ${editable ? '' : 'disabled'}>
      </td>
      <td class="celda-centro bt-falta">${num(l.faltante)}</td>
      <td class="celda-centro">
        <input class="bt-num" type="number" min="0" step="1"
               data-campo="repuesto" value="${num(l.repuesto)}"
               ${editable ? '' : 'disabled'}>
      </td>
    `;

    /* El faltante se recalcula al teclear: quien revisa ve el
       resultado sin esperar a guardar. */
    const $enc = fila.querySelector('[data-campo="encontrado"]');
    $enc.addEventListener('input', () => recalcularFila(fila, l));

    $c.appendChild(fila);
  });
}

function recalcularFila(fila, linea) {
  const enc = Number(fila.querySelector('[data-campo="encontrado"]').value || 0);
  const falta = Math.max(Number(linea.dotacion) - enc, 0);

  fila.querySelector('.bt-falta').textContent = num(falta);
  fila.classList.toggle('bt-fila-falta', falta > 0);
}

/** Propone reponer exactamente lo que falta, que es lo normal */
function completarReposicion() {
  document.querySelectorAll('#bt-r-detalle tr').forEach((fila) => {
    const falta = Number(fila.querySelector('.bt-falta').textContent || 0);
    const $rep = fila.querySelector('[data-campo="repuesto"]');
    if ($rep && !$rep.disabled) $rep.value = falta;
  });
}

async function guardarRevision(cerrar) {
  const r = bt.actual;
  if (!r) return;

  const filas = [...document.querySelectorAll('#bt-r-detalle tr')];

  const detalle = filas.map((f) => ({
    revision_id: r.id,
    insumo_id: f.dataset.insumo,
    encontrado: Number(f.querySelector('[data-campo="encontrado"]').value || 0),
    repuesto: Number(f.querySelector('[data-campo="repuesto"]').value || 0)
  }));

  if (detalle.some((d) => d.encontrado < 0 || d.repuesto < 0)) {
    return alertaRevision('Las cantidades no pueden ser negativas');
  }

  /* Cerrar sin haber anotado nada suele ser un descuido */
  if (cerrar) {
    const revisadoPor = document.getElementById('bt_revisado_por').value.trim();
    if (!revisadoPor) {
      return alertaRevision('Indique quién realizó la revisión antes de cerrarla');
    }
  }

  const $btn = document.getElementById(cerrar ? 'bt-btn-cerrar-revision' : 'bt-btn-guardar');
  $btn.disabled = true;

  const cabecera = {
    fecha_revision: document.getElementById('bt_fecha_revision').value || HOY(),
    revisado_por: document.getElementById('bt_revisado_por').value.trim() || null,
    recibido_por: document.getElementById('bt_recibido_por').value.trim() || null,
    observacion: document.getElementById('bt_observacion').value.trim() || null
  };
  if (cerrar) {
    cabecera.estado = 'cerrada';
    cabecera.fecha_entrega = cabecera.fecha_revision;
  }

  const { error: e1 } = await supabase
    .from('botiquin_revision_detalle')
    .upsert(detalle, { onConflict: 'revision_id,insumo_id' });

  if (e1) { $btn.disabled = false; return alertaRevision(traducir(e1)); }

  const { error: e2 } = await supabase
    .from('botiquin_revisiones')
    .update(cabecera)
    .eq('id', r.id);

  $btn.disabled = false;
  if (e2) return alertaRevision(traducir(e2));

  document.getElementById('bt-modal-revision').hidden = true;
  await refrescar();
}

async function reabrirRevision() {
  const r = bt.actual;
  if (!r) return;
  if (!confirm('¿Reabrir la revisión para corregirla?')) return;

  const { error } = await supabase
    .from('botiquin_revisiones')
    .update({ estado: 'abierta' })
    .eq('id', r.id);

  if (error) return alertaRevision(traducir(error));

  document.getElementById('bt-modal-revision').hidden = true;
  await refrescar();
}

/* ============================================
   Informe mensual
   Un solo documento con todos los botiquines.
   ============================================ */

function cabecera(titulo, subtitulo, codigo) {
  return `
    <header class="bt-cabecera">
      <img src="logo.png" class="bt-logo" alt="">
      <div class="bt-identidad">
        <span class="bt-empresa">${escapar(bt.empresaNombre || 'Empresa')}</span>
        <span class="bt-unidad">Departamento de Seguridad y Salud Ocupacional</span>
      </div>
      <div class="bt-control">
        <span><b>Anexo 1</b> · ${escapar(codigo)}</span>
        <span>${new Date().toLocaleDateString('es-EC')}</span>
      </div>
    </header>

    <div class="bt-titulo-banda">
      <h1 class="bt-titulo">${escapar(titulo)}</h1>
      ${subtitulo ? `<p class="bt-subtitulo">${escapar(subtitulo)}</p>` : ''}
    </div>`;
}

function firmas(izq, der) {
  return `
    <div class="bt-firmas" data-firmas>
      <div class="bt-firma">
        <div class="bt-linea"></div>
        <p class="bt-firma-cargo">${escapar(izq)}</p>
        <p class="bt-firma-nota">Nombre, firma y cédula</p>
      </div>
      <div class="bt-firma">
        <div class="bt-linea"></div>
        <p class="bt-firma-cargo">${escapar(der)}</p>
        <p class="bt-firma-nota">Nombre, firma y cédula</p>
      </div>
    </div>`;
}

const NOTA_LEGAL = `
  <p class="bt-nota-legal">
    Documento elaborado conforme al Art. 430 del Código del Trabajo y al Anexo 3
    del A.M. MDT-2024-196, requisito SP-01 del Anexo 1. El faltante corresponde
    al consumo del periodo, calculado sobre la dotación establecida para cada
    botiquín.
  </p>`;

function imprimirInforme() {
  if (bt.revisiones.length === 0) return;

  /* Agrupado por departamento: así se recorre en campo y así
     se lee después. */
  const departamentos = [];
  bt.revisiones.forEach((r) => {
    let d = departamentos.find((x) => x.nombre === r.departamento);
    if (!d) { d = { nombre: r.departamento, revisiones: [] }; departamentos.push(d); }
    d.revisiones.push(r);
  });

  const totalFaltante = bt.revisiones.reduce((s, r) => s + Number(r.total_faltante || 0), 0);
  const totalRepuesto = bt.revisiones.reduce((s, r) => s + Number(r.total_repuesto || 0), 0);

  /* Consolidado de insumos: lo que hay que pedir a farmacia */
  const consolidado = new Map();
  bt.revisiones.forEach((r) => {
    (bt.detalle[r.id] || []).forEach((l) => {
      if (Number(l.faltante) === 0 && Number(l.repuesto) === 0) return;
      const clave = l.insumo + '|' + (l.presentacion || '');
      const x = consolidado.get(clave)
        || { insumo: l.insumo, presentacion: l.presentacion, unidad: l.unidad, falta: 0, rep: 0 };
      x.falta += Number(l.faltante);
      x.rep += Number(l.repuesto);
      consolidado.set(clave, x);
    });
  });

  const secciones = departamentos.map((d) => `
    <section class="bt-departamento">
      <h2 class="bt-seccion">${escapar(d.nombre)}
        <span class="bt-seccion-cuenta">${d.revisiones.length}
          ${d.revisiones.length === 1 ? 'botiquín' : 'botiquines'}</span>
      </h2>

      ${d.revisiones.map((r) => {
        const lineas = (bt.detalle[r.id] || []).filter(
          (l) => Number(l.faltante) > 0 || Number(l.repuesto) > 0);

        return `
          <h3 class="bt-sub">${escapar(r.area || r.departamento)}
            <span class="bt-sub-meta">Revisado el ${
              r.fecha_revision ? formatearFecha(r.fecha_revision) : '—'
            }${r.revisado_por ? ' por ' + escapar(r.revisado_por) : ''}</span>
          </h3>
          ${lineas.length === 0
            ? '<p class="bt-completo">Botiquín completo. No se registró consumo en el periodo.</p>'
            : `<table class="bt-tabla">
                 <thead>
                   <tr>
                     <th style="width:40%">Insumo</th>
                     <th style="width:15%">Dotación</th>
                     <th style="width:15%">Encontrado</th>
                     <th style="width:15%">Consumido</th>
                     <th style="width:15%">Repuesto</th>
                   </tr>
                 </thead>
                 <tbody>
                   ${lineas.map((l) => `
                     <tr>
                       <td>${escapar(l.insumo)}${l.presentacion
                         ? ' · ' + escapar(l.presentacion) : ''}</td>
                       <td class="bt-num-c">${num(l.dotacion)}</td>
                       <td class="bt-num-c">${num(l.encontrado)}</td>
                       <td class="bt-num-c">${num(l.faltante)}</td>
                       <td class="bt-num-c">${num(l.repuesto)}</td>
                     </tr>`).join('')}
                 </tbody>
               </table>`}
          ${r.observacion
            ? `<p class="bt-obs">Observación: ${escapar(r.observacion)}</p>` : ''}
        `;
      }).join('')}
    </section>`).join('');

  const html = `
    <div class="bt-hoja">
      ${cabecera(
        'Informe mensual de revisión y reposición de botiquines',
        nombreMes(bt.periodo), 'SP-01')}

      <table class="bt-resumen">
        <thead>
          <tr><th>Concepto</th><th>Cantidad</th></tr>
        </thead>
        <tbody>
          <tr><td>Botiquines revisados</td><td class="bt-num-c">${bt.revisiones.length}</td></tr>
          <tr><td>Unidades consumidas en el periodo</td><td class="bt-num-c">${num(totalFaltante)}</td></tr>
          <tr><td>Unidades repuestas</td><td class="bt-num-c">${num(totalRepuesto)}</td></tr>
        </tbody>
      </table>

      ${consolidado.size > 0 ? `
        <h2 class="bt-seccion">Consolidado de reposición</h2>
        <table class="bt-tabla">
          <thead>
            <tr>
              <th style="width:50%">Insumo</th>
              <th style="width:16%">Unidad</th>
              <th style="width:17%">Consumido</th>
              <th style="width:17%">Repuesto</th>
            </tr>
          </thead>
          <tbody>
            ${[...consolidado.values()].map((x) => `
              <tr>
                <td>${escapar(x.insumo)}${x.presentacion
                  ? ' · ' + escapar(x.presentacion) : ''}</td>
                <td>${escapar(x.unidad)}</td>
                <td class="bt-num-c">${num(x.falta)}</td>
                <td class="bt-num-c">${num(x.rep)}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : ''}

      ${secciones}
      ${NOTA_LEGAL}
      ${firmas('Responsable de Salud Ocupacional', 'Técnico de Seguridad e Higiene')}
    </div>`;

  lanzar(html, 'Informe de botiquines · ' + nombreMes(bt.periodo));
}

/* ============================================
   Actas de entrega
   Una por botiquín, cada una en su hoja.
   ============================================ */

function imprimirActas() {
  const conEntrega = bt.revisiones.filter(
    (r) => (bt.detalle[r.id] || []).some((l) => Number(l.repuesto) > 0));

  if (conEntrega.length === 0) {
    alert('Ningún botiquín tiene reposición registrada en este periodo.');
    return;
  }

  const hojas = conEntrega.map((r, i) => {
    const lineas = (bt.detalle[r.id] || []).filter((l) => Number(l.repuesto) > 0);

    return `
      <div class="bt-hoja${i > 0 ? ' bt-hoja-nueva' : ''}">
        ${cabecera('Acta de entrega de insumos de botiquín',
                   `${r.botiquin} · ${nombreMes(bt.periodo)}`, 'SP-01')}

        <table class="bt-datos">
          <tr>
            <th>Departamento</th><td>${escapar(r.departamento)}</td>
            <th>Área</th><td>${escapar(r.area || '—')}</td>
          </tr>
          <tr>
            <th>Periodo</th><td>${nombreMes(bt.periodo)}</td>
            <th>Fecha de entrega</th>
            <td>${formatearFecha(r.fecha_entrega || r.fecha_revision || HOY())}</td>
          </tr>
          ${r.responsable
            ? `<tr><th>Responsable del botiquín</th><td colspan="3">${escapar(r.responsable)}</td></tr>`
            : ''}
        </table>

        <p class="bt-parrafo">
          En la fecha señalada se hace entrega de los insumos que se detallan a
          continuación, destinados a reponer la dotación del botiquín de primeros
          auxilios indicado. Quien recibe declara haberlos recibido conformes en
          cantidad y estado.
        </p>

        <table class="bt-tabla">
          <thead>
            <tr>
              <th style="width:8%">#</th>
              <th style="width:52%">Insumo</th>
              <th style="width:20%">Unidad</th>
              <th style="width:20%">Cantidad</th>
            </tr>
          </thead>
          <tbody>
            ${lineas.map((l, n) => `
              <tr>
                <td class="bt-num-c">${n + 1}</td>
                <td>${escapar(l.insumo)}${l.presentacion
                  ? ' · ' + escapar(l.presentacion) : ''}</td>
                <td>${escapar(l.unidad)}</td>
                <td class="bt-num-c">${num(l.repuesto)}</td>
              </tr>`).join('')}
          </tbody>
        </table>

        ${r.observacion
          ? `<p class="bt-obs">Observación: ${escapar(r.observacion)}</p>` : ''}

        ${firmas(r.revisado_por || 'Entregado por',
                 r.recibido_por || 'Recibido por')}
      </div>`;
  }).join('');

  lanzar(hojas, 'Actas de entrega · ' + nombreMes(bt.periodo));
}

function lanzar(html, titulo) {
  const $z = document.getElementById('bt-impresion');
  if (!$z) return;
  $z.innerHTML = html;
  imprimirHoja('bt-impresion', 'imprimiendo-botiquines', titulo);
}

/* ============================================
   Refresco y eventos
   ============================================ */

async function refrescar() {
  await cargarBotiquines(bt.empresaId, bt.empresaNombre);
  pintarBotiquines();
}

function alertaRevision(texto) {
  const $a = document.getElementById('bt-alerta-revision');
  if (!$a) return;
  $a.textContent = texto;
  $a.hidden = false;
}

function traducir(error) {
  const m = error.message || '';
  if (error.code === '42501') {
    return 'Su rol no tiene permiso para esta acción';
  }
  if (m.includes('ck_detalle_no_negativo')) {
    return 'Las cantidades no pueden ser negativas';
  }
  if (m.includes('ck_periodo_mes')) {
    return 'El periodo debe corresponder al primer día del mes';
  }
  if (error.code === '23505') return 'Ese registro ya existe';
  return 'Error: ' + m;
}

function enBt(id, evento, fn) {
  const $e = document.getElementById(id);
  if ($e) $e.addEventListener(evento, fn);
}

function conectar() {
  enBt('bt-periodo', 'change', refrescar);
  enBt('bt-btn-abrir', 'click', abrirMes);
  enBt('bt-btn-informe', 'click', imprimirInforme);
  enBt('bt-btn-actas', 'click', imprimirActas);

  enBt('bt-btn-guardar', 'click', () => guardarRevision(false));
  enBt('bt-btn-cerrar-revision', 'click', () => guardarRevision(true));
  enBt('bt-btn-completar', 'click', completarReposicion);
  enBt('bt-btn-reabrir', 'click', reabrirRevision);

  document.querySelectorAll('[data-cierra]').forEach((b) => {
    if (b.dataset.cierra !== 'bt-modal-revision') return;
    b.addEventListener('click', () => {
      document.getElementById('bt-modal-revision').hidden = true;
    });
  });
}

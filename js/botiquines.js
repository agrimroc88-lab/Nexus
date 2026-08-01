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
import { imprimirHoja } from './impresion.js';
import { ROLES } from './auth.js';
import { escapar, formatearFecha } from './utils.js';
import { envolverWord, descargarWord, recuadroFoto, bloqueFirmas,
         membreteWord, bandaTitulo, tablaWord, logoEnBase64,
         encabezadoMemo, escaparTexto }
  from './documento.js';

const bt = {
  perfil: null,
  empresaId: null,
  empresaNombre: '',
  periodo: null,        // 'YYYY-MM'
  botiquines: [],
  revisiones: [],       // del periodo elegido
  detalle: {},          // revision_id → [líneas]
  actual: null,         // revisión abierta
  motivos: [],          // catálogo de motivos de reposición
  destinatarios: [],    // del informe general
  nomina: [],           // para el buscador de destinatario
  logo: null            // en base64, para que viaje en el .doc
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

  const [bots, revs, mot, dest, nom] = await Promise.all([
    supabase.from('v_botiquines').select('*')
      .eq('empresa_id', empresaId).eq('activo', true).order('orden'),
    supabase.from('v_botiquin_revisiones').select('*')
      .eq('empresa_id', empresaId).eq('periodo', primerDia(bt.periodo)).order('orden'),
    supabase.from('botiquin_motivos').select('*')
      .eq('activo', true).order('orden').order('nombre'),
    supabase.from('botiquin_destinatarios').select('*')
      .eq('empresa_id', empresaId).eq('activo', true).order('orden'),
    supabase.from('v_trabajadores')
      .select('id, codigo, cedula, nombre_completo')
      .eq('empresa_id', empresaId).eq('activo', true).order('codigo')
  ]);

  bt.botiquines = bots.data || [];
  bt.revisiones = revs.data || [];
  bt.motivos = mot.data || [];
  bt.destinatarios = dest.data || [];
  bt.nomina = nom.data || [];

  /* El logo se lee una vez: va incrustado en cada documento
     para que no se rompa al enviarlo por correo. */
  if (!bt.logo) bt.logo = await logoEnBase64();

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

  ['bt-btn-informe', 'bt-btn-actas', 'bt-btn-actas-doc'].forEach((id) => {
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
  document.getElementById('bt_observacion').value = r.observacion || '';
  document.getElementById('bt_rev_buscar').value = '';
  document.getElementById('bt_rev_sugerencias').hidden = true;

  pintarDetalle();

  const editable = puedeEscribir() && r.estado !== 'cerrada';
  ['bt_fecha_revision', 'bt_revisado_por', 'bt_rev_buscar', 'bt_observacion']
    .forEach((id) => { document.getElementById(id).disabled = !editable; });

  const $dest = document.getElementById('bt-btn-destinatario');
  if ($dest) {
    $dest.hidden = !puedeEscribir();
    $dest.textContent = r.sin_destinatario
      ? 'Destinatario: firma en blanco'
      : 'Destinatario: ' + (r.destinatario || 'sin definir');
  }

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
      <td>
        <select class="entrada bt-motivo" data-campo="motivo"
                ${editable ? '' : 'disabled'}>
          <option value="">—</option>
          ${bt.motivos.map((m) => `
            <option value="${m.id}" ${m.id === l.motivo_id ? 'selected' : ''}>
              ${escapar(m.nombre)}
            </option>`).join('')}
          <option value="__nuevo">+ Otro motivo…</option>
        </select>
      </td>
    `;

    /* El faltante se recalcula al teclear: quien revisa ve el
       resultado sin esperar a guardar. */
    const $enc = fila.querySelector('[data-campo="encontrado"]');
    $enc.addEventListener('input', () => recalcularFila(fila, l));

    /* Un motivo nuevo se escribe una vez y queda en el
       catálogo para la siguiente revisión. */
    const $mot = fila.querySelector('[data-campo="motivo"]');
    $mot.addEventListener('change', () => {
      if ($mot.value === '__nuevo') anadirMotivo($mot);
    });

    $c.appendChild(fila);
  });
}

async function anadirMotivo($select) {
  const texto = (prompt('Nuevo motivo de reposición:') || '').trim();
  $select.value = '';

  if (!texto) return;

  const { data, error } = await supabase
    .from('botiquin_motivos')
    .insert({ nombre: texto, estandar: false, orden: 90 })
    .select('*')
    .maybeSingle();

  /* Si ya existía, se recupera en lugar de fallar */
  let motivo = data;
  if (error) {
    if (error.code !== '23505') return alertaRevision(traducir(error));
    const { data: existente } = await supabase
      .from('botiquin_motivos').select('*').eq('nombre', texto).maybeSingle();
    motivo = existente;
  }
  if (!motivo) return;

  if (!bt.motivos.some((m) => m.id === motivo.id)) bt.motivos.push(motivo);

  /* Se añade a todos los desplegables abiertos, no solo al
     que lo originó: es catálogo, no dato de una fila. */
  document.querySelectorAll('#bt-r-detalle [data-campo="motivo"]').forEach(($s) => {
    const o = document.createElement('option');
    o.value = motivo.id;
    o.textContent = motivo.nombre;
    $s.insertBefore(o, $s.querySelector('[value="__nuevo"]'));
  });

  $select.value = motivo.id;
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
    repuesto: Number(f.querySelector('[data-campo="repuesto"]').value || 0),
    motivo_id: (() => {
      const v = f.querySelector('[data-campo="motivo"]').value;
      return v && v !== '__nuevo' ? v : null;
    })()
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

    /* Reponer sin decir por qué deja el informe sin explicar
       lo que un auditor va a preguntar primero. */
    const sinMotivo = detalle.filter((d) => d.repuesto > 0 && !d.motivo_id);
    if (sinMotivo.length > 0) {
      return alertaRevision(
        `Indique el motivo de reposición en ${sinMotivo.length} `
        + `${sinMotivo.length === 1 ? 'insumo' : 'insumos'} antes de cerrar.`);
    }
  }

  const $btn = document.getElementById(cerrar ? 'bt-btn-cerrar-revision' : 'bt-btn-guardar');
  $btn.disabled = true;

  const cabecera = {
    fecha_revision: document.getElementById('bt_fecha_revision').value || HOY(),
    revisado_por: document.getElementById('bt_revisado_por').value.trim() || null,
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
   Documentos
   Se descargan en formato Word: los informes llevan
   evidencia fotográfica y las fotos salen del celular de
   quien inspecciona. Se abre el archivo, se pega la foto en
   su recuadro y se imprime.
   ============================================ */

/**
 * El "DE:" sale de quien tiene la sesión abierta.
 *
 * Se relee de la sesión guardada si el perfil no llegó al
 * módulo: un documento sin firmante no sirve para nada, y
 * fallar en silencio es peor que reintentar.
 */
function firmante() {
  let p = bt.perfil;

  if (!p || !p.nombres) {
    try {
      p = JSON.parse(localStorage.getItem('nexus_sesion') || 'null') || {};
    } catch { p = {}; }
  }

  const nombre = [p.nombres, p.apellidos].filter(Boolean).join(' ').trim();

  return {
    nombre: [p.titulo, nombre].filter(Boolean).join(' ') || nombre || '',
    cargo: p.cargo || '',
    sinDatos: !nombre
  };
}

function fechaLarga() {
  return new Date().toLocaleDateString('es-EC',
    { day: 'numeric', month: 'long', year: 'numeric' });
}

/* Tabla de insumos. En el informe se muestra todo con su
   motivo; en el acta, la dotación que se entrega. */
function tablaInsumos(lineas, modo) {
  if (modo === 'informe') {
    return tablaWord(
      [
        { titulo: 'N°',         ancho: 5,  centrado: true },
        { titulo: 'DETALLE',    ancho: 33 },
        { titulo: 'DOTACIÓN',   ancho: 12, centrado: true },
        { titulo: 'ENCONTRADO', ancho: 13, centrado: true },
        { titulo: 'REPONE',     ancho: 11, centrado: true },
        { titulo: 'MOTIVO',     ancho: 26 }
      ],
      lineas.map((l, i) => [
        String(i + 1),
        nombreInsumo(l),
        num(l.dotacion),
        num(l.encontrado),
        num(l.repuesto),
        escaparTexto(l.motivo || '—')
      ]));
  }

  return tablaWord(
    [
      { titulo: 'N°',       ancho: 8,  centrado: true },
      { titulo: 'DETALLE',  ancho: 62 },
      { titulo: 'CANTIDAD', ancho: 30, centrado: true }
    ],
    lineas.map((l, i) => [
      String(i + 1),
      nombreInsumo(l),
      num(l.dotacion) + ' ' + escaparTexto(l.unidad)
    ]));
}

function nombreInsumo(l) {
  return escaparTexto(l.insumo)
    + (l.presentacion ? ' · ' + escaparTexto(l.presentacion) : '');
}

/**
 * Informe mensual de inspección.
 * Un solo documento: una sección por botiquín con su tabla y
 * su recuadro de evidencia, más la carátula dirigida a
 * gerencia con los sitios inspeccionados.
 */
async function generarInforme() {
  if (bt.revisiones.length === 0) return;

  const de = firmante();
  const principal = bt.destinatarios.find((d) => d.tipo === 'principal');
  const copias = bt.destinatarios.filter((d) => d.tipo === 'copia');

  if (de.sinDatos && !confirm(
      'No se pudo leer su nombre para la firma del documento.\n\n'
    + '¿Desea generarlo de todos modos?')) return;

  /* Carátula: a quién va y qué sitios se recorrieron */
  const sitios = tablaWord(
    [
      { titulo: 'N°',                  ancho: 6,  centrado: true },
      { titulo: 'UBICACIÓN',           ancho: 34 },
      { titulo: 'RESPONSABLE DEL ÁREA', ancho: 32 },
      { titulo: 'OBSERVACIÓN',         ancho: 28 }
    ],
    bt.revisiones.map((r, i) => [
      String(i + 1),
      escaparTexto(r.botiquin),
      escaparTexto(r.sin_destinatario ? 'Guardia de turno' : (r.destinatario || '—')),
      Number(r.total_repuesto) > 0
        ? 'Inspección, limpieza y reposición'
        : 'Inspección y limpieza'
    ]));

  const caratula = `
    ${membreteWord(bt.empresaNombre, bt.logo)}
    ${bandaTitulo('Informe mensual de inspección de botiquines',
                  nombreMes(bt.periodo))}

    ${encabezadoMemo([
      { etiqueta: 'DE:',    valor: de.nombre, detalle: de.cargo },
      principal ? { etiqueta: 'PARA:', valor: principal.nombre, detalle: principal.cargo } : null,
      ...copias.map((c) => ({ etiqueta: 'C.C.:', valor: c.nombre, detalle: c.cargo })),
      { etiqueta: 'FECHA:',  valor: nombreMes(bt.periodo).toUpperCase() },
      { etiqueta: 'ASUNTO:', valor: 'INSPECCIÓN MENSUAL DE BOTIQUINES' }
    ])}

    <p style="text-align:justify;margin:8pt 0;">
      Mediante el presente informe damos a conocer el estado y funcionamiento de
      los botiquines implementados en los distintos puntos de la empresa, los
      cuales facilitan al personal la rápida aplicación de primeros auxilios,
      vendajes compresivos y lavado de heridas, para su correcta movilización
      hacia la unidad médica.
    </p>

    <p style="margin:6pt 0 4pt;">A continuación, detallo los sitios inspeccionados:</p>

    ${sitios}

    ${bloqueFirmas([{
      rotulo: 'Responsable de la inspección',
      nombre: de.nombre,
      detalle: de.cargo
    }])}`;

  /* Una sección por botiquín */
  const secciones = bt.revisiones.map((r) => {
    const lineas = bt.detalle[r.id] || [];
    const repuestas = lineas.filter((l) => Number(l.repuesto) > 0);

    return `
      <div class="salto">
        ${membreteWord(bt.empresaNombre, bt.logo)}
        ${bandaTitulo('Inspección de botiquín', r.botiquin)}

        ${encabezadoMemo([
          { etiqueta: 'DE:',    valor: de.nombre, detalle: de.cargo },
          { etiqueta: 'FECHA:', valor: nombreMes(bt.periodo).toUpperCase() },
          { etiqueta: 'ASUNTO:',
            valor: 'INSPECCIÓN MENSUAL DE BOTIQUÍN · ' + r.botiquin.toUpperCase() },
          { etiqueta: 'OBJETIVO:',
            valor: r.objetivo || 'Verificar que los medicamentos e insumos no se '
                 + 'encuentren contaminados o vencidos y disponer de los elementos '
                 + 'necesarios para tratar pequeñas heridas y dolencias leves.' }
        ])}

        <p style="text-align:justify;margin:8pt 0;">
          Se detalla a continuación el estado de la dotación del botiquín ubicado
          ${escaparTexto(r.ubicacion_texto || r.botiquin)}, con la cantidad
          encontrada durante la inspección y la reposición efectuada, indicando
          el motivo en cada caso.
        </p>

        ${tablaInsumos(lineas, 'informe')}

        ${repuestas.length === 0
          ? '<p style="font-style:italic;font-size:10pt;">El botiquín se encontró '
            + 'completo. No fue necesaria reposición en el periodo.</p>'
          : ''}

        ${r.observacion
          ? `<p style="font-size:10pt;margin:4pt 0;"><b>Observación:</b> ${
              escaparTexto(r.observacion)}</p>` : ''}

        <p style="font-weight:bold;margin:12pt 0 4pt;font-size:11pt;">
          EVIDENCIA FOTOGRÁFICA
        </p>
        ${recuadroFoto('BOTIQUÍN ' + r.botiquin.toUpperCase(), 80)}

        ${bloqueFirmas([{
          rotulo: 'Responsable de la inspección',
          nombre: de.nombre,
          detalle: de.cargo
        }], 30)}
      </div>`;
  }).join('');

  const html = envolverWord(caratula + secciones,
    'Informe de inspección de botiquines · ' + nombreMes(bt.periodo));

  descargarWord(html, `Informe botiquines ${bt.periodo}`);
}

/**
 * Actas de entrega.
 * Una por botiquín, cada una en su hoja, porque cada
 * responsable firma la suya. Se entrega la dotación completa,
 * que es como se venía haciendo.
 */
/**
 * Construye las actas. El mismo HTML sirve para imprimir y
 * para descargar: los estilos van en línea, que es lo único
 * que respetan a la vez el navegador y Word.
 *
 * @param {number} espacioFirma mm sobre las firmas. Cero al
 *   imprimir: ahí lo calcula impresion.js según lo que quede
 *   de hoja.
 */
function construirActas(espacioFirma) {
  if (bt.revisiones.length === 0) return null;

  const de = firmante();

  /* Un acta sin firmante ni destinatario no sirve de nada:
     mejor avisar antes de que alguien la imprima y la lleve
     a firmar en blanco. */
  const faltan = [];
  if (de.sinDatos) faltan.push('su nombre para la firma');

  const sinDest = bt.revisiones.filter(
    (r) => !r.sin_destinatario && !r.destinatario);
  if (sinDest.length > 0) {
    faltan.push(`el destinatario de ${sinDest.length} `
      + `${sinDest.length === 1 ? 'botiquín' : 'botiquines'}`);
  }

  if (faltan.length > 0 && !confirm(
      'Faltan datos en las actas: ' + faltan.join(' y ') + '.\n\n'
    + '¿Desea generarlas de todos modos?')) return null;

  const hojas = bt.revisiones.map((r, i) => {
    const lineas = bt.detalle[r.id] || [];

    /* Área 7 la recibe el guardia de turno, que cambia cada
       día: la línea va en blanco para que firme quien esté. */
    const recibe = r.sin_destinatario
      ? { rotulo: 'Recibido por:', nombre: '', detalle: 'Nombre, firma y cédula' }
      : { rotulo: 'Recibido por:', nombre: r.destinatario || '',
          detalle: r.destinatario_cargo || '' };

    return `
      <div${i > 0 ? ' class="salto"' : ''}>
        ${membreteWord(bt.empresaNombre, bt.logo)}
        ${bandaTitulo('Acta de entrega de insumos de botiquín',
                      r.botiquin + ' · ' + nombreMes(bt.periodo))}

        ${encabezadoMemo([
          { etiqueta: 'DE:', valor: de.nombre, detalle: de.cargo },
          r.sin_destinatario
            ? null
            : { etiqueta: 'PARA:', valor: r.destinatario || '—',
                detalle: r.destinatario_cargo || '' },
          { etiqueta: 'FECHA:',
            valor: (r.fecha_entrega || r.fecha_revision)
              ? formatearFecha(r.fecha_entrega || r.fecha_revision)
              : fechaLarga().toUpperCase() },
          { etiqueta: 'ASUNTO:',
            valor: 'ENTREGA DE MEDICAMENTOS E INSUMOS MÉDICOS PARA BOTIQUÍN DE SU ÁREA' },
          { etiqueta: 'OBJETIVO:',
            valor: r.objetivo || 'Disponer de los elementos necesarios para tratar '
                 + 'pequeñas heridas, dolencias leves y de uso inmediato.' }
        ])}

        <p style="text-align:justify;margin:8pt 0;">
          Mediante este informe detallo la entrega de medicamentos e insumos
          básicos que son indispensables para el botiquín ubicado
          ${escaparTexto(r.ubicacion_texto || r.botiquin)}.
        </p>

        <p style="margin:6pt 0 4pt;">A continuación, detallamos la distribución:</p>

        <p style="text-align:center;font-weight:bold;font-size:12pt;
                  margin:6pt 0 4pt;color:#1b5e20;">
          ENTREGA DE MEDICAMENTOS E INSUMOS
        </p>

        ${tablaInsumos(lineas, 'acta')}

        ${bloqueFirmas([
          { rotulo: 'Elaborado por:', nombre: de.nombre, detalle: de.cargo },
          recibe
        ], espacioFirma)}
      </div>`;
  }).join('');

  return hojas;
}

/* Imprimir es lo natural: el acta no lleva fotografías, así
   que descargarla para imprimirla sería un rodeo. */
function imprimirActas() {
  const hojas = construirActas(0);
  if (!hojas) return;

  const $z = document.getElementById('bt-impresion');
  if (!$z) return;

  $z.innerHTML = hojas;
  imprimirHoja('bt-impresion', 'imprimiendo-botiquines',
    'Actas de entrega · ' + nombreMes(bt.periodo));
}

/* Descargar queda como alternativa: sirve para archivar o
   enviar por correo sin pasar por el papel. */
function descargarActas() {
  const hojas = construirActas(50);
  if (!hojas) return;

  const html = envolverWord(hojas, 'Actas de entrega · ' + nombreMes(bt.periodo));
  descargarWord(html, `Actas entrega botiquines ${bt.periodo}`);
}

/* ============================================
   Destinatario del botiquín
   Persiste entre meses: se escribe una vez y se arrastra
   hacia adelante hasta que alguien lo cambie.
   ============================================ */

function abrirDestinatario() {
  const r = bt.actual;
  if (!r) return;

  document.getElementById('bt-d-botiquin').textContent = r.botiquin;
  document.getElementById('bt_dest_nombre').value = r.destinatario || '';
  document.getElementById('bt_dest_cargo').value = r.destinatario_cargo || '';
  document.getElementById('bt_dest_blanco').checked = Boolean(r.sin_destinatario);
  document.getElementById('bt_dest_buscar').value = '';
  document.getElementById('bt_dest_sugerencias').hidden = true;

  alternarDestinatario();
  document.getElementById('bt-alerta-destinatario').hidden = true;
  document.getElementById('bt-modal-destinatario').hidden = false;
}

function alternarDestinatario() {
  const blanco = document.getElementById('bt_dest_blanco').checked;
  document.getElementById('bt-bloque-destinatario').hidden = blanco;
}

/* Quién revisó se elige de la nómina: escribir el nombre a
   mano cada mes invita a erratas que luego no cuadran con
   ningún trabajador. Sigue admitiendo texto libre para
   personal externo. */
function buscarRevisor() {
  buscarEnNomina('bt_rev_buscar', 'bt_rev_sugerencias', (t) => {
    document.getElementById('bt_revisado_por').value = t.nombre_completo;
  });
}

function buscarDestinatario() {
  buscarEnNomina('bt_dest_buscar', 'bt_dest_sugerencias', (t) => {
    document.getElementById('bt_dest_nombre').value = t.nombre_completo;
  });
}

/** Buscador de nómina compartido: filtra en memoria */
function buscarEnNomina(idEntrada, idLista, alElegir) {
  const texto = document.getElementById(idEntrada).value.trim().toLowerCase();
  const $s = document.getElementById(idLista);

  if (texto.length < 2) { $s.hidden = true; return; }

  const hallados = bt.nomina.filter((t) => {
    const campo = `${t.codigo} ${t.cedula ?? ''} ${t.nombre_completo}`.toLowerCase();
    return campo.includes(texto);
  }).slice(0, 10);

  if (hallados.length === 0) {
    $s.innerHTML = '<p class="bt-sug-vacia">Sin coincidencias en la nómina</p>';
    $s.hidden = false;
    return;
  }

  $s.innerHTML = '';
  hallados.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'bt-sugerencia';
    b.type = 'button';
    b.innerHTML = `<span class="codigo">${t.codigo ?? '—'}</span>
                   <span>${escapar(t.nombre_completo)}</span>`;
    b.addEventListener('click', () => {
      alElegir(t);
      document.getElementById(idEntrada).value = '';
      $s.hidden = true;
    });
    $s.appendChild(b);
  });
  $s.hidden = false;
}

async function guardarDestinatario() {
  const r = bt.actual;
  if (!r) return;

  const blanco = document.getElementById('bt_dest_blanco').checked;
  const nombre = document.getElementById('bt_dest_nombre').value.trim();

  if (!blanco && !nombre) {
    return alertaDestinatario('Indique el destinatario o marque la firma en blanco');
  }

  const $btn = document.getElementById('bt-btn-guardar-destinatario');
  $btn.disabled = true;

  const { error } = await supabase
    .from('botiquines')
    .update({
      destinatario: blanco ? null : nombre,
      destinatario_cargo: blanco
        ? null : (document.getElementById('bt_dest_cargo').value.trim() || null),
      sin_destinatario: blanco
    })
    .eq('id', r.botiquin_id);

  $btn.disabled = false;
  if (error) return alertaDestinatario(traducir(error));

  document.getElementById('bt-modal-destinatario').hidden = true;
  document.getElementById('bt-modal-revision').hidden = true;
  await refrescar();
}

function alertaDestinatario(texto) {
  const $a = document.getElementById('bt-alerta-destinatario');
  if (!$a) return;
  $a.textContent = texto;
  $a.hidden = false;
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
  enBt('bt-btn-informe', 'click', generarInforme);
  enBt('bt-btn-actas', 'click', imprimirActas);
  enBt('bt-btn-actas-doc', 'click', descargarActas);

  enBt('bt-btn-destinatario', 'click', abrirDestinatario);
  enBt('bt-btn-guardar-destinatario', 'click', guardarDestinatario);
  enBt('bt_dest_buscar', 'input', buscarDestinatario);
  enBt('bt_rev_buscar', 'input', buscarRevisor);
  enBt('bt_dest_blanco', 'change', alternarDestinatario);

  enBt('bt-btn-guardar', 'click', () => guardarRevision(false));
  enBt('bt-btn-cerrar-revision', 'click', () => guardarRevision(true));
  enBt('bt-btn-completar', 'click', completarReposicion);
  enBt('bt-btn-reabrir', 'click', reabrirRevision);

  document.querySelectorAll('[data-cierra]').forEach((b) => {
    const destino = b.dataset.cierra;
    if (!['bt-modal-revision', 'bt-modal-destinatario'].includes(destino)) return;
    b.addEventListener('click', () => {
      document.getElementById(destino).hidden = true;
    });
  });
}

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

import { supabase } from './supabase.js?v=11';
import { ROLES } from './auth.js?v=11';
import { escapar, formatearFecha } from './utils.js?v=11';
import { esperarImagenes } from './impresion.js?v=11';
import { envolverWord, descargarWord, recuadroFoto, bloqueFirmas,
         membreteWord, bandaTitulo, tablaWord,
         listaDocumento, seccionDocumento, logoEnBase64,
         encabezadoMemo, escaparTexto, fijarEscala }
  from './documento.js?v=11';

/* Marca de versión.
   GitHub Pages sirve los archivos a través de una caché que
   puede tardar en refrescarse, y el navegador guarda además
   su propia copia. Comprobar en la consola qué versión está
   corriendo evita perseguir errores ya corregidos. */
const VERSION = 'v12';

/* La versión se anuncia en consola y se estampa al pie de cada
   documento. Dos equipos con archivos distintos producían
   informes distintos y no había forma de saber cuál era cuál
   sin abrir las herramientas del navegador. */
console.info('NEXUS · botiquines', VERSION);

const bt = {
  perfil: null,
  empresaId: null,
  empresaNombre: '',
  periodo: null,        // 'YYYY-MM'
  botiquines: [],
  revisiones: [],       // del periodo elegido
  detalle: {},          // revision_id → [líneas]
  actual: null,         // revisión abierta
  dotacion: {},         // botiquin_id → [{id, insumo_id, cantidad}]
  insumos: [],          // catálogo global de insumos de botiquín
  bAbierto: null,       // botiquín en edición (ficha o dotación)
  dotEdicion: [],       // dotación en edición dentro del modal
  motivos: [],          // catálogo de motivos de reposición
  destinatarios: [],    // del informe general
  nomina: [],           // para el buscador de destinatario
  logo: null,           // en base64, para que viaje en el .doc
  logoChico: null       // versión reducida para las páginas de continuación
};

/* Debe coincidir con es_personal_salud() de la base */
const PERSONAL = [
  ROLES.ADMIN, ROLES.MEDICO, ROLES.ENFERMERIA, ROLES.PSICOLOGO,
  ROLES.TRABAJO_SOCIAL, ROLES.PSICO_SOCIAL, ROLES.ERGONOMO, ROLES.TECNICO
];

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const HOY = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

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

  /* Los logotipos se leen al abrir la pestaña, no al pulsar
     imprimir: así ya están en memoria cuando hacen falta.
     Se generan a los dos tamaños que usan los documentos. */
  logoEnBase64('logo.png', 76).then((l) => { if (l) bt.logo = l; });
  logoEnBase64('logo.png', 49).then((l) => { if (l) bt.logoChico = l; });
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

  /* Se lee la tabla base y no la vista: el módulo ahora edita el
     botiquín, y para escribir hacen falta sus columnas reales.
     La vista solo servía para contarlos. */
  const [bots, revs, mot, dest, nom, ins] = await Promise.all([
    supabase.from('botiquines').select('*')
      .eq('empresa_id', empresaId).eq('activo', true)
      .order('orden').order('area'),
    supabase.from('v_botiquin_revisiones').select('*')
      .eq('empresa_id', empresaId).eq('periodo', primerDia(bt.periodo)).order('orden'),
    supabase.from('botiquin_motivos').select('*')
      .eq('activo', true).order('orden').order('nombre'),
    /* Sin filtrar por empresa: quien firma y a quién se dirige
       el informe son cargos del departamento, no de una sede.
       Filtrarlo dejaba el documento sin destinatarios cuando el
       registro había quedado asociado a otra empresa. */
    supabase.from('botiquin_destinatarios').select('*')
      .eq('activo', true).order('orden'),
    supabase.from('v_trabajadores')
      .select('id, codigo, cedula, nombre_completo')
      .eq('empresa_id', empresaId).eq('activo', true).order('codigo'),
    /* Catálogo de insumos: es común a todas las empresas, como el
       de motivos. Un botiquín de cocina y uno de mina llevan las
       mismas gasas; lo que cambia es cuántas. */
    supabase.from('botiquin_insumos').select('*')
      .eq('activo', true).order('orden').order('nombre')
  ]);

  bt.botiquines = bots.data || [];
  bt.revisiones = revs.data || [];
  bt.motivos = mot.data || [];
  bt.destinatarios = dest.data || [];
  bt.nomina = nom.data || [];
  bt.insumos = ins.data || [];

  /* Quien firma la elaboración del informe es del departamento,
     no de una empresa concreta. Si el registro quedó asociado a
     otra empresa —el script de instalación siembra en la
     primera que encuentra— la consulta anterior no lo trae y el
     informe saldría firmado dos veces por la misma persona.
     Se busca entonces sin filtrar por empresa. */
  /* Los errores de consulta se informaban como lista vacía, así
     que un fallo de permisos era indistinguible de "no hay
     datos". El documento salía mal sin que nada lo dijera. */
  if (dest.error) {
    console.error('NEXUS · No se pudieron leer los destinatarios del informe:',
                  dest.error.message, '· código', dest.error.code);
  } else if (bt.destinatarios.length === 0) {
    console.warn('NEXUS · La tabla de destinatarios está vacía. '
               + 'Ejecute 032_firma_informe.sql.');
  }

  bt.errorDestinatarios = dest.error || null;

  /* El logo se lee una vez: va incrustado en cada documento
     para que no se rompa al enviarlo por correo. */
  if (!bt.logo) bt.logo = await logoEnBase64('logo.png', 76);
  if (!bt.logoChico) bt.logoChico = await logoEnBase64('logo.png', 49);

  await Promise.all([cargarDotacion(), cargarDetalle()]);
}

/* La dotación es lo que el botiquín DEBE tener. Existe con
   independencia de que se haya abierto la revisión del mes:
   por eso se lee siempre, y por eso el listado puede mostrar
   los botiquines aunque nadie los haya revisado todavía. */
async function cargarDotacion() {
  bt.dotacion = {};
  if (bt.botiquines.length === 0) return;

  const ids = bt.botiquines.map((b) => b.id);
  const { data, error } = await supabase
    .from('botiquin_dotacion')
    .select('id, botiquin_id, insumo_id, cantidad')
    .in('botiquin_id', ids);

  if (error) {
    console.error('NEXUS · No se pudo leer la dotación:', error.message);
    return;
  }

  (data || []).forEach((d) => (bt.dotacion[d.botiquin_id] ||= []).push(d));
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

/** Nombre visible del botiquín: el área, y el departamento si no hay área. */
function nombreBotiquin(b) {
  return b.area || b.departamento || 'Botiquín';
}

/** Líneas de dotación de un botiquín, resueltas contra el catálogo. */
function dotacionDe(botiquinId) {
  return (bt.dotacion[botiquinId] || [])
    .map((d) => ({ ...d, insumo: bt.insumos.find((i) => i.id === d.insumo_id) }))
    .filter((d) => d.insumo)
    .sort((a, b) => (a.insumo.orden ?? 99) - (b.insumo.orden ?? 99)
                 || a.insumo.nombre.localeCompare(b.insumo.nombre));
}

export function pintarBotiquines() {
  pintarResumen();
  pintarTabla();

  const abierto = bt.revisiones.length > 0;
  const $abrir = document.getElementById('bt-btn-abrir');
  if ($abrir) {
    $abrir.hidden = abierto || !puedeEscribir() || bt.botiquines.length === 0;
  }

  const $nuevo = document.getElementById('bt-btn-nuevo');
  if ($nuevo) $nuevo.hidden = !puedeEscribir() || !bt.empresaId;

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

/* El listado recorre los BOTIQUINES, no las revisiones.

   Antes se recorrían las revisiones, y eso hacía que la pestaña
   apareciera vacía mientras no se abriera el mes: los botiquines
   existían en la base pero no se veían por ninguna parte, y no
   había modo de corregir su dotación. Ahora el botiquín se ve
   siempre con lo que debe contener, y las cifras de consumo se
   añaden encima cuando hay revisión abierta. */
function pintarTabla() {
  const $c = document.getElementById('bt-cuerpo');
  const $vacio = document.getElementById('bt-vacio');
  if (!$c) return;

  $c.innerHTML = '';

  if (bt.botiquines.length === 0) {
    if ($vacio) {
      $vacio.hidden = false;
      $vacio.textContent = puedeEscribir()
        ? 'No hay botiquines registrados. Use «+ Nuevo botiquín» para crear el primero.'
        : 'No hay botiquines registrados para esta empresa.';
    }
    return;
  }
  if ($vacio) $vacio.hidden = true;

  const porBotiquin = new Map(bt.revisiones.map((r) => [r.botiquin_id, r]));

  /* Agrupado por departamento, como se recorre en campo */
  let departamentoPrevio = null;

  bt.botiquines.forEach((b) => {
    if (b.departamento !== departamentoPrevio) {
      departamentoPrevio = b.departamento;
      const sep = document.createElement('tr');
      sep.className = 'bt-separador';
      sep.innerHTML = `<td colspan="9">${escapar(b.departamento || 'Sin departamento')}</td>`;
      $c.appendChild(sep);
    }

    const dot = dotacionDe(b.id);
    const unidades = dot.reduce((s, d) => s + Number(d.cantidad || 0), 0);

    const r = porBotiquin.get(b.id);
    const cerrada = r && r.estado === 'cerrada';
    const faltan = r ? Number(r.total_faltante || 0) : 0;
    const pend = r ? Number(r.total_pendiente || 0) : 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapar(nombreBotiquin(b))}</td>
      <td class="celda-tenue">${escapar(b.ubicacion || '—')}</td>
      <td class="celda-centro">${dot.length || '—'}</td>
      <td class="celda-centro">${unidades > 0 ? num(unidades) : '—'}</td>
      <td class="celda-centro">${r && faltan > 0 ? num(faltan) : '—'}</td>
      <td class="celda-centro">${r ? num(r.total_repuesto) : '—'}</td>
      <td class="celda-centro">${r && pend > 0
        ? `<span class="bt-pendiente">${num(pend)}</span>` : '—'}</td>
      <td class="celda-centro">
        ${r
          ? `<span class="insignia ${cerrada ? 'insignia-activa' : 'insignia-aviso'}">
               ${cerrada ? 'Cerrada' : 'Abierta'}
             </span>`
          : '<span class="insignia insignia-neutra">Sin abrir</span>'}
      </td>
      <td class="celda-centro bt-acciones"></td>
    `;

    const $acc = tr.lastElementChild;

    const btnIns = document.createElement('button');
    btnIns.className = 'boton-icono';
    btnIns.type = 'button';
    btnIns.textContent = 'Insumos';
    btnIns.title = 'Ver y editar la dotación del botiquín';
    btnIns.addEventListener('click', () => abrirDotacion(b));
    $acc.appendChild(btnIns);

    if (r) {
      const btnRev = document.createElement('button');
      btnRev.className = 'boton-icono';
      btnRev.type = 'button';
      btnRev.textContent = cerrada ? 'Ver' : 'Revisar';
      btnRev.addEventListener('click', () => abrirRevision(r));
      $acc.appendChild(btnRev);
    }

    if (puedeEscribir()) {
      const btnEd = document.createElement('button');
      btnEd.className = 'boton-icono';
      btnEd.type = 'button';
      btnEd.textContent = 'Editar';
      btnEd.title = 'Datos del botiquín';
      btnEd.addEventListener('click', () => abrirBotiquin(b));
      $acc.appendChild(btnEd);
    }

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
      num(l.repuesto) + ' ' + escaparTexto(l.unidad)
    ]));
}

function nombreInsumo(l) {
  return escaparTexto(l.insumo)
    + (l.presentacion ? ' · ' + escaparTexto(l.presentacion) : '');
}

/* ============================================
   Contenido normativo y técnico del informe

   Un informe que solo enseña tablas obliga a quien lo lee a
   saber de antemano por qué existe un botiquín y qué debe
   contener. Estas secciones lo explican, y de paso dejan por
   escrito el fundamento legal de la inspección.
   ============================================ */

const OBJETIVO_GENERAL =
  'Verificar el estado, la dotación y las condiciones de conservación de los '
+ 'botiquines de primeros auxilios ubicados en las áreas operativas y '
+ 'administrativas de la empresa, garantizando su disponibilidad inmediata ante '
+ 'lesiones o dolencias que se presenten durante la jornada laboral.';

const OBJETIVOS_ESPECIFICOS = [
  'Comprobar la existencia física de cada insumo frente a la dotación establecida '
+ 'para el botiquín, dejando constancia de la cantidad encontrada.',

  'Identificar insumos caducados, deteriorados, contaminados o con empaque abierto, '
+ 'y retirarlos del botiquín para su reposición.',

  'Reponer los insumos consumidos o retirados, registrando el motivo que sustenta '
+ 'cada reposición.',

  'Verificar que el botiquín permanezca accesible, señalizado, limpio y libre de '
+ 'obstáculos, sin cerradura que impida su uso en una emergencia.',

  'Constatar que el área conozca la ubicación del botiquín y al responsable '
+ 'designado para su custodia.',

  'Documentar la inspección y la entrega de insumos como evidencia del cumplimiento '
+ 'del requisito SP-01 del Anexo 1 del A.M. MDT-2024-196.'
];

const MARCO_NORMATIVO = [
  { titulo: 'Código del Trabajo (2005), Art. 430',
    texto: 'obliga al empleador a mantener un botiquín de emergencia para la '
         + 'prestación de primeros auxilios a los trabajadores, según el riesgo '
         + 'y el número de personas en el lugar de trabajo.' },

  { titulo: 'Decisión 584 de la CAN (2004), Art. 11',
    texto: 'establece el deber del empleador de adoptar las medidas necesarias '
         + 'para la prevención de riesgos y la atención de emergencias.' },

  { titulo: 'Resolución 957 (2008), Art. 1',
    texto: 'incorpora los procedimientos de respuesta ante emergencias dentro de '
         + 'los procedimientos operativos básicos del sistema de gestión.' },

  { titulo: 'Decreto Ejecutivo 255 (2024)',
    texto: 'Reglamento de Seguridad y Salud en el Trabajo; desarrolla las '
         + 'obligaciones del empleador en materia de atención de primeros auxilios.' },

  { titulo: 'A.M. MDT-2024-196, Anexo 1, requisito SP-01 y Anexo 3',
    texto: 'exige el botiquín de emergencia para primeros auxilios como elemento '
         + 'verificable dentro de los servicios permanentes.' },

  { titulo: 'Convenio 155 de la OIT (1981), Art. 18',
    texto: 'dispone que los empleadores prevean medidas para hacer frente a '
         + 'situaciones de urgencia y accidentes, incluidos medios adecuados para '
         + 'la administración de primeros auxilios.' },

  { titulo: 'Convenio 161 de la OIT (1985), Art. 5',
    texto: 'sitúa la organización de los primeros auxilios y la atención de '
         + 'urgencia entre las funciones de los servicios de salud en el trabajo.' }
];

const CRITERIOS_TECNICOS = [
  { titulo: 'Accesibilidad',
    texto: 'el botiquín debe estar a la vista, señalizado y sin cerradura. Un '
         + 'botiquín bajo llave equivale a no tenerlo cuando ocurre la emergencia.' },

  { titulo: 'Ubicación',
    texto: 'próximo a las áreas de mayor exposición y a las rutas de circulación, '
         + 'a una altura que permita alcanzarlo sin escalera ni ayuda.' },

  { titulo: 'Conservación',
    texto: 'lugar limpio, seco y ventilado, protegido de la luz directa, del calor '
         + 'y de la humedad, que degradan tanto el material estéril como los '
         + 'medicamentos.' },

  { titulo: 'Contenido',
    texto: 'material de curación e insumos de uso inmediato. No se almacenan '
         + 'medicamentos de prescripción ni sustancias sujetas a control sin '
         + 'supervisión del profesional de salud.' },

  { titulo: 'Caducidad',
    texto: 'se revisa en cada inspección. El material estéril con empaque abierto, '
         + 'húmedo o dañado pierde su condición aunque no haya vencido.' },

  { titulo: 'Responsable',
    texto: 'cada botiquín tiene una persona designada que custodia su contenido y '
         + 'reporta el consumo a la unidad de salud ocupacional.' },

  { titulo: 'Registro',
    texto: 'el consumo y la reposición se documentan mensualmente, lo que permite '
         + 'dimensionar la dotación según el uso real de cada área.' }
];

/**
 * Informe mensual de inspección.
 *
 * Un solo documento: carátula dirigida a gerencia con el
 * marco de la inspección, y después una sección por botiquín
 * con su tabla y su espacio de evidencia fotográfica.
 */
async function generarInforme() {
  if (bt.revisiones.length === 0) return;

  fijarEscala(ESCALA_INFORME);

  const de = firmante();
  const principal = bt.destinatarios.find((d) => d.tipo === 'principal');
  const copias = bt.destinatarios.filter((d) => d.tipo === 'copia');

  /* Quien encabeza el departamento firma la elaboración del
     informe; quien recorrió los botiquines firma la
     inspección. Son dos responsabilidades distintas y el
     documento debe distinguirlas. */
  const elabora = bt.destinatarios.find((d) => d.tipo === 'elabora');
  const referencia = 'Informe de botiquines · ' + nombreMes(bt.periodo);

  const pendientes = [];
  if (de.sinDatos) pendientes.push('su nombre para la firma');

  /* Sin este registro el informe sale firmado dos veces por la
     misma persona, que es un error difícil de notar hasta que
     alguien lo revisa. */
  if (!elabora) {
    pendientes.push(bt.errorDestinatarios
      ? 'quién elabora el informe: su usuario no tiene permiso para leer esa '
      + 'tabla (' + bt.errorDestinatarios.message + '). '
      + 'Avise a quien administra la plataforma.'
      : 'quién elabora el informe. Falta ejecutar la configuración inicial '
      + '(032_firma_informe.sql).');
  }

  if (pendientes.length > 0 && !confirm(
      'Faltan datos en el informe:\n\n· ' + pendientes.join('\n· ')
    + '\n\n¿Desea generarlo de todos modos?')) return;

  /* --- Datos agregados --- */
  const totalFaltante = bt.revisiones.reduce(
    (x, r) => x + Number(r.total_faltante || 0), 0);
  const totalRepuesto = bt.revisiones.reduce(
    (x, r) => x + Number(r.total_repuesto || 0), 0);
  const completos = bt.revisiones.filter(
    (r) => Number(r.total_faltante || 0) === 0).length;

  /* Consolidado: lo que hay que pedir a farmacia */
  const consolidado = new Map();
  bt.revisiones.forEach((r) => {
    (bt.detalle[r.id] || []).forEach((l) => {
      if (Number(l.faltante) === 0 && Number(l.repuesto) === 0) return;
      const clave = l.insumo + '|' + (l.presentacion || '');
      const x = consolidado.get(clave) || {
        insumo: l.insumo, presentacion: l.presentacion,
        unidad: l.unidad, falta: 0, rep: 0
      };
      x.falta += Number(l.faltante);
      x.rep += Number(l.repuesto);
      consolidado.set(clave, x);
    });
  });

  /* --- Carátula --- */
  const caratula = `
    ${membreteWord(bt.empresaNombre, bt.logo)}
    ${bandaTitulo('Informe mensual de inspección de botiquines',
                  nombreMes(bt.periodo))}

    ${encabezadoMemo([
      /* El informe lo emite el departamento, no quien recorrió
         los botiquines: en el DE va quien lo suscribe. */
      { etiqueta: 'DE:',
        valor:   elabora ? elabora.nombre : de.nombre,
        detalle: elabora ? (elabora.cargo || '') : de.cargo },
      principal ? { etiqueta: 'PARA:', valor: principal.nombre,
                    detalle: principal.cargo } : null,
      ...copias.map((c) => ({ etiqueta: 'C.C.:', valor: c.nombre, detalle: c.cargo })),
      { etiqueta: 'FECHA:',  valor: nombreMes(bt.periodo).toUpperCase() },
      { etiqueta: 'ASUNTO:', valor: 'INSPECCIÓN MENSUAL DE BOTIQUINES DE PRIMEROS AUXILIOS' }
    ])}

    ${seccionDocumento('1. Introducción')}
    <p style="text-align:justify;">
      El botiquín de primeros auxilios es el recurso más inmediato ante una lesión
      leve o el inicio de una emergencia. Su utilidad no depende de que exista,
      sino de que en el momento del hecho tenga lo que debe tener, en condiciones
      de ser usado y al alcance de quien lo necesita; de ahí que su control sea
      mensual y documentado. El presente informe da cuenta del estado y
      funcionamiento de los ${bt.revisiones.length} botiquines implementados en los
      distintos puntos de la empresa, que permiten la aplicación de primeros
      auxilios, vendajes compresivos y lavado de heridas antes de la movilización
      hacia la unidad médica.
    </p>

    ${seccionDocumento('2. Objetivo general')}
    <p style="text-align:justify;">${escaparTexto(OBJETIVO_GENERAL)}</p>

    ${seccionDocumento('3. Objetivos específicos')}
    ${listaDocumento(OBJETIVOS_ESPECIFICOS, true)}

    ${seccionDocumento('4. Marco normativo')}
    <p style="text-align:justify;">
      La obligación de mantener botiquines de primeros auxilios y de verificar
      periódicamente su dotación se sustenta en:
    </p>
    ${tablaWord(
      [{ titulo: 'DISPOSICIÓN', ancho: 32 }, { titulo: 'CONTENIDO', ancho: 68 }],
      MARCO_NORMATIVO.map((n) => [escaparTexto(n.titulo), escaparTexto(n.texto)]))}

    ${seccionDocumento('5. Criterios técnicos de verificación')}
    ${tablaWord(
      [{ titulo: 'ASPECTO', ancho: 22 }, { titulo: 'CRITERIO APLICADO', ancho: 78 }],
      CRITERIOS_TECNICOS.map((c) => [escaparTexto(c.titulo), escaparTexto(c.texto)]))}

    ${seccionDocumento('6. Sitios inspeccionados')}
    ${tablaWord(
      [
        { titulo: 'N°',                   ancho: 6,  centrado: true },
        { titulo: 'UBICACIÓN',            ancho: 32 },
        { titulo: 'RESPONSABLE DEL ÁREA', ancho: 30 },
        { titulo: 'OBSERVACIÓN',          ancho: 32 }
      ],
      bt.revisiones.map((r, i) => [
        String(i + 1),
        escaparTexto(r.botiquin),
        escaparTexto(r.sin_destinatario ? 'Guardia de turno' : (r.destinatario || '—')),
        Number(r.total_repuesto) > 0
          ? 'Inspección, limpieza y reposición'
          : 'Inspección y limpieza'
      ]))}

    ${seccionDocumento('7. Resultados del periodo')}
    ${tablaWord(
      [{ titulo: 'CONCEPTO', ancho: 70 }, { titulo: 'CANTIDAD', ancho: 30, centrado: true }],
      [
        ['Botiquines inspeccionados', String(bt.revisiones.length)],
        ['Botiquines hallados completos', String(completos)],
        ['Unidades retiradas o consumidas', num(totalFaltante)],
        ['Unidades repuestas', num(totalRepuesto)]
      ])}

    ${consolidado.size > 0 ? `
      ${seccionDocumento('8. Consolidado de reposición')}
      ${tablaWord(
        [
          { titulo: 'INSUMO',    ancho: 48 },
          { titulo: 'UNIDAD',    ancho: 16 },
          { titulo: 'RETIRADO',  ancho: 18, centrado: true },
          { titulo: 'REPUESTO',  ancho: 18, centrado: true }
        ],
        [...consolidado.values()].map((x) => [
          escaparTexto(x.insumo) + (x.presentacion ? ' · ' + escaparTexto(x.presentacion) : ''),
          escaparTexto(x.unidad),
          num(x.falta),
          num(x.rep)
        ]))}` : ''}

    ${seccionDocumento('9. Conclusión')}
    <p style="text-align:justify;">
      Se verificó la totalidad de los botiquines previstos para el periodo. Los
      insumos consumidos, caducados o deteriorados fueron repuestos según el detalle
      que consta en las secciones siguientes, quedando los botiquines en condiciones
      de uso. El detalle individual de cada botiquín, con su respectiva evidencia
      fotográfica, se presenta a continuación.
    </p>`;

  /* --- Detalle por botiquín ---
     Sin salto de página forzado: once saltos convertían el
     informe en once hojas casi vacías. El contenido fluye y
     Word pagina donde toca; solo se evita que una tabla se
     parta a la mitad. */
  const detalle = `
    ${seccionDocumento('10. Detalle por botiquín')}
    <p style="text-align:justify;">
      Se detallan los insumos con movimiento en el periodo: los consumidos,
      retirados o repuestos, con el motivo que sustenta cada caso. Los insumos
      hallados completos y en buen estado no se listan; su verificación consta en
      el número de insumos revisados de cada botiquín.
    </p>

    ${bt.revisiones.map((r) => {
      const lineas = bt.detalle[r.id] || [];

      /* Solo lo que se movió. Repetir los once insumos íntegros
         de cada botiquín triplicaba el informe y enterraba lo
         que importa entre filas sin novedad; el total revisado
         queda dicho en el encabezado de cada bloque. */
      const conMovimiento = lineas.filter(
        (l) => Number(l.faltante) > 0 || Number(l.repuesto) > 0);

      return `
        <div class="no-partir" style="margin-top:5pt;">
          <p style="font-size:9.5pt;font-weight:bold;margin:4pt 0 1pt;
                    background:#e6f0e6;padding:1pt 4pt;">
            ${escaparTexto(r.botiquin)}
            <span style="font-weight:normal;font-size:8pt;">
              · ${lineas.length} insumos verificados
              · ${r.fecha_revision ? formatearFecha(r.fecha_revision) : '—'}
              · ${escaparTexto(
                  r.sin_destinatario ? 'Guardia de turno' : (r.destinatario || '—'))}
            </span>
          </p>

          ${conMovimiento.length === 0
            ? '<p style="font-style:italic;font-size:8.5pt;margin:1pt 0 3pt;">'
              + 'Dotación completa y en condiciones adecuadas de conservación. '
              + 'Sin consumo ni reposición en el periodo.</p>'
            : tablaInsumos(conMovimiento, 'informe')}

          ${r.observacion
            ? `<p style="font-size:8.5pt;margin:1pt 0 3pt;"><b>Observación:</b> ${
                escaparTexto(r.observacion)}</p>` : ''}
        </div>`;
    }).join('')}`;

  /* --- Evidencia fotográfica ---
     Agrupada al final y en rejilla de dos columnas. Repartir
     un recuadro por hoja multiplicaba las páginas sin añadir
     nada: seis caben en una y se comparan mejor entre sí. */
  /* Dos por fila. Cabrían más pequeños, pero un recuadro de
     cuatro centímetros no deja ver el estado del botiquín, y
     entonces la fotografía solo acredita que alguien pasó por
     ahí. A este tamaño se distingue el contenido. */
  const POR_FILA = 2;
  const filas = [];
  for (let i = 0; i < bt.revisiones.length; i += POR_FILA) {
    filas.push(bt.revisiones.slice(i, i + POR_FILA));
  }

  const evidencia = `
    <div>
      ${seccionDocumento('11. Evidencia fotográfica')}
      <p style="text-align:justify;">
        Registro fotográfico de los botiquines inspeccionados en el periodo.
        <span style="font-size:8pt;color:#555555;">Al pegar cada imagen,
        ajústela al ancho del recuadro (8,5 cm) para conservar la
        distribución de la página.</span>
      </p>

      <table style="width:100%;">
        ${filas.map((par) => `
          <tr>
            ${par.map((r) => `
              <td style="width:50%;vertical-align:top;padding:1pt 3pt;">
                ${recuadroFoto(r.botiquin.toUpperCase(), 64)}
              </td>`).join('')}
            ${Array.from({ length: POR_FILA - par.length })
                .map(() => '<td style="width:50%;"></td>').join('')}
          </tr>`).join('')}
      </table>
    </div>`;

  /* La firma va una sola vez y al cierre, después de los
     anexos: es lo que se firma cuando ya se ha leído todo. */
  const columnas = [
    { rotulo: 'Elaborado por:',
      nombre:  elabora ? elabora.nombre : de.nombre,
      detalle: elabora ? (elabora.cargo || '') : de.cargo },

    /* Quien recorrió los botiquines firma la inspección. Sale
       de la sesión: cambia con el profesional que la realizó. */
    { rotulo: 'Inspección realizada por:',
      nombre:  de.nombre,
      detalle: de.cargo }
  ];

  const cierre = `
    <div class="no-partir">
      ${seccionDocumento('12. Cierre del informe')}
      <p style="text-align:justify;">
        Se deja constancia de que la inspección de los ${bt.revisiones.length}
        botiquines correspondientes a ${escaparTexto(nombreMes(bt.periodo))} fue
        realizada conforme a los objetivos y criterios señalados en este documento,
        y que los insumos consumidos, caducados o deteriorados fueron repuestos
        según el detalle de los anexos precedentes.
      </p>
      ${bloqueFirmas(columnas, 50)}
    </div>`;

  const sello = `
    <p style="font-size:6.5pt;color:#999999;text-align:right;margin-top:6pt;">
      NEXUS ${VERSION} · generado el ${new Date().toLocaleString('es-EC')}
    </p>`;

  const html = envolverWord(caratula + detalle + evidencia + cierre + sello,
    'Informe de inspección de botiquines · ' + nombreMes(bt.periodo),
    { superior: 15, inferior: 15, izquierdo: 28, derecho: 12 });

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
/* El acta se lee de pie mientras se firma y le sobra hoja:
   la letra crece un veinte por ciento. El informe conserva la
   suya, que es lo que lo mantiene en ocho páginas. */
const ESCALA_ACTA = 1.2;
const ESCALA_INFORME = 1;

function construirActas(espacioFirma, logo) {
  if (bt.revisiones.length === 0) return null;

  fijarEscala(ESCALA_ACTA);

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
    /* El acta es de entrega: solo lo que se repone. Listar la
       dotación completa del botiquín aquí duplicaría el informe
       y mostraría como "entregado" lo que ni se tocó. */
    const lineas = (bt.detalle[r.id] || []).filter(
      (l) => Number(l.repuesto) > 0);

    /* Área 7 la recibe el guardia de turno, que cambia cada
       día: la línea va en blanco para que firme quien esté. */
    const recibe = r.sin_destinatario
      ? { rotulo: 'Recibido por:', nombre: '', detalle: 'Nombre, firma y cédula' }
      : { rotulo: 'Recibido por:', nombre: r.destinatario || '',
          detalle: r.destinatario_cargo || '' };

    /* El hueco de firma es fijo por diseño (idéntico en papel
       y en el .doc descargado, que es lo que se buscaba al no
       calcularlo al vuelo). Pero un botiquín con muchos
       insumos repuestos —como Hacienda Las Acacias— alarga la
       tabla lo suficiente para que esos 5 cm ya no quepan en
       la hoja, y la firma se va sola a una segunda página. Se
       cede parte de ese aire a partir de la sexta línea, hasta
       un mínimo de 2 cm, que sigue siendo espacio de sobra
       para firmar. */
    const espacioHoja = lineas.length <= 5
      ? espacioFirma
      : Math.max(20, espacioFirma - (lineas.length - 5) * 5);

    return `
      <div${i > 0 ? ' class="salto"' : ''}>
        ${membreteWord(bt.empresaNombre, logo)}
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

        ${lineas.length === 0
          ? '<p style="font-style:italic;margin:6pt 0;">No hubo insumos que '
            + 'reponer en este botiquín durante el periodo.</p>'
          : tablaInsumos(lineas, 'acta')}

        ${bloqueFirmas([
          { rotulo: 'Elaborado por:', nombre: de.nombre, detalle: de.cargo },
          recibe
        ], espacioHoja)}
      </div>`;
  }).join('');

  return hojas;
}

/* Imprimir es lo natural: el acta no lleva fotografías, así
   que descargarla para imprimirla sería un rodeo.

   El espacio de firma va fijo en la propia hoja, como celda
   de tabla, en lugar de calcularlo al vuelo: así los cinco
   centímetros son los mismos en papel y en el archivo, y no
   dependen de que una medición acierte. */
async function imprimirActas() {
  /* El logo ya está leído en memoria desde que se abrió la
     pestaña: usarlo evita una descarga justo cuando el
     usuario espera el diálogo de impresión. La ruta relativa
     queda de respaldo por si esa lectura falló. */
  const hojas = construirActas(50, bt.logo || 'logo.png');
  if (!hojas) return;

  const $z = document.getElementById('bt-impresion');
  if (!$z) return;

  $z.innerHTML = hojas;

  /* print() no espera a las imágenes: sin esto, la vista
     previa sale sin logo o con él a medio dibujar. */
  await esperarImagenes($z);

  const titulo = document.title;
  document.title = 'Actas de entrega · ' + nombreMes(bt.periodo);
  document.body.classList.add('imprimiendo-botiquines');
  window.print();

  setTimeout(() => {
    document.body.classList.remove('imprimiendo-botiquines');
    document.title = titulo;
  }, 500);
}

/* Descargar queda como alternativa: sirve para archivar o
   enviar por correo sin pasar por el papel. Ahí el logo debe
   viajar dentro del archivo. */
function descargarActas() {
  const hojas = construirActas(50, bt.logo);
  if (!hojas) return;

  const html = envolverWord(hojas, 'Actas de entrega · ' + nombreMes(bt.periodo),
    { superior: 20, inferior: 20, izquierdo: 30, derecho: 15 });
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
   Dotación · qué debe contener cada botiquín

   La dotación vive en botiquin_dotacion y es propia de cada
   botiquín; el catálogo de insumos (botiquin_insumos) es común
   a todos. Se separan porque el de cocina y el de mina llevan
   las mismas gasas: lo que cambia es cuántas.

   Se edita en memoria y se guarda de una vez. Escribir cada
   celda al teclear dejaría la dotación a medio cambiar si
   alguien cierra la pestaña en mitad de la corrección.
   ============================================ */

function abrirDotacion(b) {
  bt.bAbierto = b;

  /* Copia de trabajo: el original no se toca hasta guardar */
  bt.dotEdicion = dotacionDe(b.id).map((d) => ({
    id: d.id, insumo_id: d.insumo_id, cantidad: Number(d.cantidad || 0)
  }));

  document.getElementById('bt-dot-titulo').textContent = nombreBotiquin(b);
  document.getElementById('bt-dot-sub').textContent =
    [b.departamento, b.ubicacion].filter(Boolean).join(' · ');

  const editable = puedeEscribir();
  document.getElementById('bt-btn-guardar-dotacion').hidden = !editable;
  document.querySelector('.bt-dot-agregar').hidden = !editable;
  document.getElementById('bt-dot-plegable-nuevo').hidden = !editable;

  pintarDotacion();
  document.getElementById('bt-alerta-dotacion').hidden = true;
  document.getElementById('bt-modal-dotacion').hidden = false;
}

function pintarDotacion() {
  const editable = puedeEscribir();
  const $c = document.getElementById('bt-dot-cuerpo');
  const $vacio = document.getElementById('bt-dot-vacio');
  $c.innerHTML = '';

  const lineas = bt.dotEdicion
    .map((d) => ({ ...d, insumo: bt.insumos.find((i) => i.id === d.insumo_id) }))
    .filter((d) => d.insumo)
    .sort((a, b) => (a.insumo.orden ?? 99) - (b.insumo.orden ?? 99)
                 || a.insumo.nombre.localeCompare(b.insumo.nombre));

  if ($vacio) $vacio.hidden = lineas.length > 0;

  lineas.forEach((d) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapar(d.insumo.nombre)}${d.insumo.presentacion
        ? `<span class="celda-tenue"> · ${escapar(d.insumo.presentacion)}</span>` : ''}
        ${d.insumo.medicamento ? '<span class="bt-marca-med">Medicamento</span>' : ''}</td>
      <td class="celda-centro celda-tenue">${escapar(d.insumo.unidad || '—')}</td>
      <td class="celda-centro">
        <input class="bt-num" type="number" min="0" step="1"
               value="${num(d.cantidad)}" ${editable ? '' : 'disabled'}>
      </td>
      <td class="celda-centro"></td>
    `;

    tr.querySelector('input').addEventListener('input', (e) => {
      const linea = bt.dotEdicion.find((x) => x.insumo_id === d.insumo_id);
      if (linea) linea.cantidad = Number(e.target.value || 0);
    });

    if (editable) {
      const btn = document.createElement('button');
      btn.className = 'boton-icono boton-icono-peligro';
      btn.type = 'button';
      btn.textContent = 'Quitar';
      btn.addEventListener('click', () => {
        bt.dotEdicion = bt.dotEdicion.filter((x) => x.insumo_id !== d.insumo_id);
        pintarDotacion();
      });
      tr.lastElementChild.appendChild(btn);
    }

    $c.appendChild(tr);
  });

  pintarCatalogo();
}

/* El desplegable solo ofrece lo que aún no está en el botiquín:
   un insumo repetido rompería la clave y confundiría el conteo. */
function pintarCatalogo() {
  const $sel = document.getElementById('bt_dot_catalogo');
  if (!$sel) return;

  const puestos = new Set(bt.dotEdicion.map((d) => d.insumo_id));
  const libres = bt.insumos.filter((i) => !puestos.has(i.id));

  $sel.innerHTML = '';

  if (libres.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Todos los insumos del catálogo ya están en el botiquín';
    $sel.appendChild(o);
    $sel.disabled = true;
    return;
  }

  $sel.disabled = false;
  libres.forEach((i) => {
    const o = document.createElement('option');
    o.value = i.id;
    o.textContent = i.nombre
      + (i.presentacion ? ` · ${i.presentacion}` : '')
      + (i.unidad ? ` (${i.unidad})` : '');
    $sel.appendChild(o);
  });
}

function agregarDeCatalogo() {
  const id = document.getElementById('bt_dot_catalogo').value;
  const cantidad = Number(document.getElementById('bt_dot_cantidad').value || 0);

  if (!id) return;
  if (cantidad <= 0) return alertaDotacion('Indique una cantidad mayor que cero');

  bt.dotEdicion.push({ id: null, insumo_id: id, cantidad });
  document.getElementById('bt_dot_cantidad').value = 1;
  document.getElementById('bt-alerta-dotacion').hidden = true;
  pintarDotacion();
}

async function crearInsumo() {
  const nombre = document.getElementById('bt_ins_nombre').value.trim();
  const unidad = document.getElementById('bt_ins_unidad').value.trim();
  const cantidad = Number(document.getElementById('bt_ins_cantidad').value || 0);

  if (!nombre) return alertaDotacion('Escriba el nombre del insumo');
  if (!unidad) return alertaDotacion('Indique la unidad (unidad, sobre, frasco…)');
  if (cantidad <= 0) return alertaDotacion('Indique una cantidad mayor que cero');

  const $btn = document.getElementById('bt-btn-ins-crear');
  $btn.disabled = true;

  const fila = {
    nombre,
    presentacion: document.getElementById('bt_ins_presentacion').value.trim() || null,
    unidad,
    medicamento: document.getElementById('bt_ins_medicamento').checked,
    orden: 90,
    activo: true
  };

  const { data, error } = await supabase
    .from('botiquin_insumos').insert(fila).select('*').maybeSingle();

  $btn.disabled = false;
  if (error) return alertaDotacion(traducir(error));
  if (!data) return alertaDotacion('No se pudo crear el insumo');

  bt.insumos.push(data);
  bt.dotEdicion.push({ id: null, insumo_id: data.id, cantidad });

  ['bt_ins_nombre', 'bt_ins_presentacion', 'bt_ins_unidad']
    .forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('bt_ins_cantidad').value = 1;
  document.getElementById('bt_ins_medicamento').checked = false;
  document.getElementById('bt-dot-plegable-nuevo').open = false;
  document.getElementById('bt-alerta-dotacion').hidden = true;

  pintarDotacion();
}

async function guardarDotacion() {
  const b = bt.bAbierto;
  if (!b) return;

  if (bt.dotEdicion.some((d) => Number(d.cantidad) <= 0)) {
    return alertaDotacion('Todas las cantidades deben ser mayores que cero. '
                        + 'Para retirar un insumo, use «Quitar».');
  }

  const $btn = document.getElementById('bt-btn-guardar-dotacion');
  $btn.disabled = true;

  const previas = bt.dotacion[b.id] || [];
  const vivos = new Set(bt.dotEdicion.map((d) => d.insumo_id));

  const retirados = previas.filter((p) => !vivos.has(p.insumo_id));
  const nuevos = bt.dotEdicion.filter((d) => !d.id);
  const cambiados = bt.dotEdicion.filter((d) => {
    const p = previas.find((x) => x.id === d.id);
    return p && Number(p.cantidad) !== Number(d.cantidad);
  });

  const fallo = (e) => { $btn.disabled = false; alertaDotacion(traducir(e)); };

  if (retirados.length > 0) {
    const { error } = await supabase.from('botiquin_dotacion')
      .delete().in('id', retirados.map((r) => r.id));
    if (error) return fallo(error);
  }

  if (nuevos.length > 0) {
    const { error } = await supabase.from('botiquin_dotacion').insert(
      nuevos.map((d) => ({
        botiquin_id: b.id, insumo_id: d.insumo_id, cantidad: d.cantidad
      })));
    if (error) return fallo(error);
  }

  for (const d of cambiados) {
    const { error } = await supabase.from('botiquin_dotacion')
      .update({ cantidad: d.cantidad }).eq('id', d.id);
    if (error) return fallo(error);
  }

  await sincronizarRevisionAbierta(b, retirados.map((r) => r.insumo_id),
                                   nuevos.length > 0);

  $btn.disabled = false;
  document.getElementById('bt-modal-dotacion').hidden = true;
  await refrescar();
}

/**
 * Ajusta la revisión del mes en curso a la nueva dotación.
 *
 * Solo la abierta: una revisión cerrada es el acta de lo que se
 * entregó ese mes, y reescribirla convertiría la corrección de
 * hoy en historia falsa de ayer.
 *
 * @param {object}   b          botiquín editado
 * @param {string[]} retirados  insumos que salieron de la dotación
 * @param {boolean}  hayNuevos  si se añadió alguno
 */
async function sincronizarRevisionAbierta(b, retirados, hayNuevos) {
  const r = bt.revisiones.find(
    (x) => x.botiquin_id === b.id && x.estado !== 'cerrada');
  if (!r) return;

  if (retirados.length > 0) {
    await supabase.from('botiquin_revision_detalle')
      .delete().eq('revision_id', r.id).in('insumo_id', retirados);
  }

  /* La misma función que abre el mes añade las líneas que
     falten sin tocar las que ya tienen anotaciones. */
  if (hayNuevos) {
    await supabase.rpc('abrir_revision_botiquin', {
      p_botiquin: b.id, p_periodo: primerDia(bt.periodo)
    });
  }
}

function alertaDotacion(texto) {
  const $a = document.getElementById('bt-alerta-dotacion');
  if (!$a) return;
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Alta, edición y baja de botiquines
   ============================================ */

function abrirBotiquin(b) {
  bt.bAbierto = b || null;

  document.getElementById('bt-b-titulo').textContent =
    b ? 'Editar botiquín' : 'Nuevo botiquín';

  const v = (id, valor) => { document.getElementById(id).value = valor ?? ''; };
  v('bt_b_area', b?.area);
  v('bt_b_departamento', b?.departamento);
  v('bt_b_ubicacion', b?.ubicacion);
  v('bt_b_ubicacion_texto', b?.ubicacion_texto);
  v('bt_b_responsable', b?.responsable);
  v('bt_b_objetivo', b?.objetivo);
  v('bt_b_orden', b?.orden ?? siguienteOrden());

  document.getElementById('bt-btn-eliminar-botiquin').hidden = !b;
  document.getElementById('bt-alerta-botiquin').hidden = true;
  document.getElementById('bt-modal-botiquin').hidden = false;
}

/* El nuevo va al final: el orden lo decide quien recorre la
   planta, no el momento en que se dio de alta. */
function siguienteOrden() {
  return bt.botiquines.reduce((m, b) => Math.max(m, Number(b.orden || 0)), 0) + 1;
}

async function guardarBotiquin() {
  const area = document.getElementById('bt_b_area').value.trim();
  const departamento = document.getElementById('bt_b_departamento').value.trim();

  if (!area) return alertaBotiquin('Escriba el nombre del botiquín');
  if (!departamento) return alertaBotiquin('Indique el departamento');

  const $btn = document.getElementById('bt-btn-guardar-botiquin');
  $btn.disabled = true;

  const fila = {
    empresa_id: bt.empresaId,
    area,
    departamento,
    ubicacion: document.getElementById('bt_b_ubicacion').value.trim() || null,
    ubicacion_texto:
      document.getElementById('bt_b_ubicacion_texto').value.trim() || null,
    responsable: document.getElementById('bt_b_responsable').value.trim() || null,
    objetivo: document.getElementById('bt_b_objetivo').value.trim() || null,
    orden: Number(document.getElementById('bt_b_orden').value || 0)
  };

  let error;
  if (bt.bAbierto) {
    ({ error } = await supabase.from('botiquines')
      .update(fila).eq('id', bt.bAbierto.id));
  } else {
    fila.activo = true;
    ({ error } = await supabase.from('botiquines').insert(fila));
  }

  $btn.disabled = false;
  if (error) return alertaBotiquin(traducir(error));

  document.getElementById('bt-modal-botiquin').hidden = true;
  await refrescar();
}

/**
 * Baja de un botiquín.
 *
 * Si nunca se revisó, se borra de verdad: es un registro creado
 * por error y conservarlo solo estorba. Si tiene revisiones, se
 * desactiva —los informes de los meses cerrados siguen citándolo
 * y borrarlo dejaría actas firmadas apuntando a nada.
 */
async function eliminarBotiquin() {
  const b = bt.bAbierto;
  if (!b) return;

  const { count } = await supabase
    .from('botiquin_revisiones')
    .select('id', { count: 'exact', head: true })
    .eq('botiquin_id', b.id);

  const conHistoria = (count || 0) > 0;

  const aviso = conHistoria
    ? `«${nombreBotiquin(b)}» tiene ${count} `
      + `${count === 1 ? 'revisión registrada' : 'revisiones registradas'}.\n\n`
      + 'Se retirará del listado y de las próximas revisiones, pero los meses '
      + 'ya cerrados conservarán su registro.\n\n¿Continuar?'
    : `¿Eliminar «${nombreBotiquin(b)}»?\n\n`
      + 'No tiene revisiones registradas, así que se borra por completo.';

  if (!confirm(aviso)) return;

  const $btn = document.getElementById('bt-btn-eliminar-botiquin');
  $btn.disabled = true;

  let error;
  if (conHistoria) {
    ({ error } = await supabase.from('botiquines')
      .update({ activo: false }).eq('id', b.id));
  } else {
    await supabase.from('botiquin_dotacion').delete().eq('botiquin_id', b.id);
    ({ error } = await supabase.from('botiquines').delete().eq('id', b.id));
  }

  $btn.disabled = false;
  if (error) return alertaBotiquin(traducir(error));

  document.getElementById('bt-modal-botiquin').hidden = true;
  await refrescar();
}

function alertaBotiquin(texto) {
  const $a = document.getElementById('bt-alerta-botiquin');
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

  /* Dotación */
  enBt('bt-btn-dot-agregar', 'click', agregarDeCatalogo);
  enBt('bt-btn-ins-crear', 'click', crearInsumo);
  enBt('bt-btn-guardar-dotacion', 'click', guardarDotacion);

  /* Alta y baja de botiquines */
  enBt('bt-btn-nuevo', 'click', () => abrirBotiquin(null));
  enBt('bt-btn-guardar-botiquin', 'click', guardarBotiquin);
  enBt('bt-btn-eliminar-botiquin', 'click', eliminarBotiquin);

  document.querySelectorAll('[data-cierra]').forEach((b) => {
    const destino = b.dataset.cierra;
    if (!['bt-modal-revision', 'bt-modal-destinatario',
          'bt-modal-dotacion', 'bt-modal-botiquin'].includes(destino)) return;
    b.addEventListener('click', () => {
      document.getElementById(destino).hidden = true;
    });
  });
}

/* ============================================
   NEXUS · instalaciones.js

   Inspección de cocina, comedores, servicios higiénicos
   y lavabos.
   Requisitos SP-02, SP-03, SP-05 y SP-07 del Anexo 1.

   Cómo se trabaja:
     La primera vez, la instalación se crea en el momento de
     inspeccionarla: se pulsa "Nueva instalación", se indica
     tipo y ubicación, y el sistema abre su lista de
     verificación. Después ya queda en el listado.

     Cada criterio se marca Cumple, No cumple o No aplica.
     Bajo el criterio aparece lo que se anotó la vez pasada:
     qué mirar antes de mirar.

     Los incumplimientos no se gestionan con responsables ni
     plazos. Se imprimen en una hoja que se lleva al recorrido
     siguiente, y si el mismo criterio vuelve a fallar, el
     informe lo destaca como reincidencia sin que nadie tenga
     que marcarlo.

   Qué produce:
     · Informe de servicios de alimentación (mensual).
     · Informe de servicios sanitarios (trimestral).
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { ROLES } from './auth.js?v=11';
import { escapar, formatearFecha } from './utils.js?v=11';
import { envolverWord, descargarWord, recuadroFoto, bloqueFirmas,
         membreteWord, bandaTitulo, tablaWord, seccionDocumento,
         logoEnBase64, encabezadoMemo, escaparTexto, fijarEscala }
  from './documento.js?v=11';

const VERSION = 'v9';
console.info('NEXUS · instalaciones', VERSION);

const ins = {
  perfil: null,
  empresaId: null,
  empresaNombre: '',
  periodo: null,          // 'YYYY-MM'
  vista: 'inspecciones',  // o 'novedades'
  instalaciones: [],
  inspecciones: [],
  detalle: {},            // inspeccion_id → [criterios]
  criterios: [],          // catálogo completo, para las hojas de campo
  noConformes: [],        // incumplimientos con su racha
  novedades: [],          // los de la última inspección de cada sitio
  destinatarios: [],
  nomina: [],             // para buscar al acompañante
  actual: null,           // inspección abierta
  editando: null,         // instalación en edición (ficha o piezas)
  piezasEdicion: [],      // piezas en edición dentro del modal
  logo: null
};

/* Clases de pieza. La letra encabeza la columna en la hoja de
   campo: una sola, porque la columna mide ocho milímetros. */
const PIEZAS = {
  sanitario: { texto: 'Sanitario', letra: 'S', orden: 1 },
  urinario:  { texto: 'Urinario',  letra: 'U', orden: 2 },
  lavabo:    { texto: 'Lavabo',    letra: 'L', orden: 3 },
  ducha:     { texto: 'Ducha',     letra: 'D', orden: 4 },
  vestidor:  { texto: 'Vestidor',  letra: 'V', orden: 5 },
  mesa:      { texto: 'Mesa',      letra: 'M', orden: 6 }
};

/* Debe coincidir con las políticas de la base */
const PERSONAL = [
  ROLES.ADMIN, ROLES.MEDICO, ROLES.ENFERMERIA, ROLES.PSICOLOGO,
  ROLES.TRABAJO_SOCIAL, ROLES.PSICO_SOCIAL, ROLES.ERGONOMO, ROLES.TECNICO
];

const TIPOS = {
  cocina:               'Cocina',
  comedor:              'Comedor',
  servicios_higienicos: 'Servicios higiénicos',
  lavabos:              'Lavabos'
};

/* Los dos informes agrupan por afinidad y por frecuencia */
const GRUPOS_INFORME = {
  alimentacion: {
    titulo: 'Servicios de alimentación',
    tipos: ['cocina', 'comedor'],
    requisitos: 'SP-02 · SP-03',
    frecuencia: 'mensual'
  },
  sanitarios: {
    titulo: 'Servicios sanitarios',
    tipos: ['servicios_higienicos', 'lavabos'],
    requisitos: 'SP-05 · SP-07',
    frecuencia: 'trimestral'
  }
};

const RESULTADOS = {
  conforme:    ['ins-conforme',    'Cumple'],
  no_conforme: ['ins-no-conforme', 'No cumple'],
  no_aplica:   ['ins-no-aplica',   'No aplica']
};

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const HOY = () => new Date().toISOString().slice(0, 10);

function puedeEscribir() {
  return PERSONAL.includes(ins.perfil?.rol);
}

function nombreMes(clave) {
  const [a, m] = clave.split('-');
  return `${MESES[parseInt(m, 10) - 1]} de ${a}`;
}

/* El trimestre se nombra por su rango, no por su número:
   "julio a septiembre" se entiende sin traducir. */
function nombreTrimestre(clave) {
  const [a, m] = clave.split('-').map(Number);
  const inicio = Math.floor((m - 1) / 3) * 3;
  return `${MESES[inicio]} a ${MESES[inicio + 2]} de ${a}`;
}

function primerDiaMes(clave) {
  return clave + '-01';
}

function primerDiaTrimestre(clave) {
  const [a, m] = clave.split('-').map(Number);
  const inicio = Math.floor((m - 1) / 3) * 3 + 1;
  return `${a}-${String(inicio).padStart(2, '0')}-01`;
}

/* ============================================
   Arranque
   ============================================ */

export function montarInstalaciones(perfil) {
  ins.perfil = perfil;
  prepararPeriodos();
  conectar();
  logoEnBase64('logo.png', 76).then((l) => { if (l) ins.logo = l; });
}

function prepararPeriodos() {
  const $sel = document.getElementById('ins-periodo');
  if (!$sel || $sel.options.length > 0) return;

  const hoy = new Date();
  for (let i = 0; i < 24; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    const clave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const o = document.createElement('option');
    o.value = clave;
    o.textContent = nombreMes(clave);
    $sel.appendChild(o);
  }
  ins.periodo = $sel.value;
}

export async function cargarInstalaciones(empresaId, empresaNombre) {
  ins.empresaId = empresaId;
  ins.empresaNombre = empresaNombre || '';

  if (!empresaId) {
    ins.instalaciones = []; ins.inspecciones = [];
    ins.noConformes = []; ins.novedades = []; ins.criterios = [];
    return;
  }

  ins.periodo = document.getElementById('ins-periodo')?.value || ins.periodo;

  /* Cada instalación se inspecciona en su propio periodo: las
     de alimentación por mes, las sanitarias por trimestre. Se
     piden ambos y se filtra después, en lugar de dos consultas
     encadenadas. */
  const mes = primerDiaMes(ins.periodo);
  const trim = primerDiaTrimestre(ins.periodo);

  const [inst, insp, hall, dest, crit, nom] = await Promise.all([
    /* Se lee la tabla base y no la vista: el módulo ahora edita
       la instalación y necesita padre_id, codigo, pieza y
       numero, que la vista no expone. Lo que la vista añadía
       —el nombre compuesto y el número de criterios— se arma
       aquí abajo, en decorar(). */
    supabase.from('instalaciones').select('*')
      .eq('empresa_id', empresaId).eq('activo', true)
      .order('tipo').order('orden'),
    supabase.from('v_inspecciones').select('*')
      .eq('empresa_id', empresaId).in('periodo', [mes, trim]).order('orden'),
    supabase.from('v_no_conformes').select('*')
      .eq('empresa_id', empresaId).order('periodo', { ascending: false }),
    supabase.from('botiquin_destinatarios').select('*')
      .eq('activo', true).order('orden'),

    /* Catálogo completo: la hoja de campo se imprime en
       blanco, sin depender de que haya inspección abierta. */
    supabase.from('inspeccion_criterios').select('*')
      .eq('activo', true).order('tipo').order('orden'),

    /* Nómina: el acompañante se elige, no se teclea. Escribirlo
       a mano cada trimestre produce erratas que después no
       cuadran con ningún trabajador. */
    supabase.from('v_trabajadores')
      .select('id, codigo, cedula, nombre_completo, cargo')
      .eq('empresa_id', empresaId).eq('activo', true).order('codigo')
  ]);

  if (inst.error) console.error('NEXUS · instalaciones:', inst.error.message);

  ins.instalaciones = inst.data || [];
  ins.noConformes = hall.data || [];
  ins.destinatarios = dest.data || [];
  ins.criterios = crit.data || [];
  ins.nomina = nom.data || [];

  decorar();

  /* Novedades: lo hallado en la última inspección de cada
     instalación, sea de este periodo o de uno anterior. */
  const ultima = new Map();
  ins.noConformes.forEach((n) => {
    const p = ultima.get(n.instalacion_id);
    if (!p || n.periodo > p) ultima.set(n.instalacion_id, n.periodo);
  });
  ins.novedades = ins.noConformes.filter(
    (n) => n.periodo === ultima.get(n.instalacion_id));

  /* Solo la inspección que corresponde a la frecuencia de cada
     instalación: sin esto, una sanitaria aparecería dos veces
     cuando el mes elegido abre trimestre. */
  const porFrecuencia = new Map(
    ins.instalaciones.map((i) => [i.id, i.frecuencia]));

  ins.inspecciones = (insp.data || []).filter((r) => {
    const esperado = porFrecuencia.get(r.instalacion_id) === 'trimestral' ? trim : mes;
    return r.periodo === esperado;
  });

  await cargarDetalle();
}

/* ============================================
   Jerarquía · bloques y piezas

   El bloque de baños es una instalación; cada sanitario,
   urinario o lavabo es otra que cuelga de él. Se resuelve
   aquí, en memoria, para que el resto del módulo siga viendo
   una lista plana con los campos de siempre —nombre y
   criterios— y no haya que reescribir informes y hojas.
   ============================================ */

function decorar() {
  const porId = new Map(ins.instalaciones.map((i) => [i.id, i]));

  ins.instalaciones.forEach((i) => {
    const padre = i.padre_id ? porId.get(i.padre_id) : null;

    i.esPieza = Boolean(i.pieza);
    i.padre = padre || null;
    i.nombreBloque = [i.departamento, i.area].filter(Boolean).join(' · ');

    if (i.esPieza && padre) {
      const p = PIEZAS[i.pieza] || { texto: i.pieza, orden: 9 };
      i.nombreCorto = `${p.texto} ${i.numero ?? ''}`.trim();
      i.nombre = `${padre.nombreBloque} · ${i.nombreCorto}`;
    } else {
      i.nombreCorto = i.nombreBloque || 'Instalación';
      i.nombre = i.nombreCorto;
    }

    /* La vista lo traía calculado; aquí sale del catálogo que
       ya está en memoria, sin una consulta más. */
    i.criterios = ins.criterios.filter((c) => c.tipo === i.tipo).length;
  });

  ordenarJerarquico();
}

/* Cada pieza va detrás de su bloque y en el orden en que se
   recorren: primero los sanitarios, después los urinarios,
   los lavabos y las duchas. */
function ordenarJerarquico() {
  const bloques = ins.instalaciones.filter((i) => !i.esPieza);
  const piezas = ins.instalaciones.filter((i) => i.esPieza);

  bloques.sort((a, b) =>
    String(a.tipo).localeCompare(String(b.tipo))
    || (a.orden ?? 0) - (b.orden ?? 0)
    || a.nombreBloque.localeCompare(b.nombreBloque));

  const hijas = (id) => piezas
    .filter((p) => p.padre_id === id)
    .sort((a, b) => (PIEZAS[a.pieza]?.orden ?? 9) - (PIEZAS[b.pieza]?.orden ?? 9)
                 || (a.numero ?? 0) - (b.numero ?? 0));

  const orden = [];
  bloques.forEach((b) => { orden.push(b, ...hijas(b.id)); });

  /* Una pieza huérfana —su bloque se desactivó— seguiría
     existiendo sin sitio donde pintarse. Va al final antes que
     desaparecer sin aviso. */
  piezas.filter((p) => !orden.includes(p)).forEach((p) => orden.push(p));

  ins.instalaciones = orden;
}

function piezasDe(bloqueId) {
  return ins.instalaciones.filter((i) => i.padre_id === bloqueId);
}

/**
 * Sigla de un texto para armar el código.
 * «Base 7» → B7 · «Bloque 1» → B1 · «Campamento Nuevo» → CN
 *
 * Se toma la inicial de cada palabra, salvo si la palabra es un
 * número: ahí entra entero. Es lo que la gente ya escribe a
 * mano en las hojas.
 */
function sigla(texto) {
  return String(texto || '')
    .split(/[\s\-_/]+/)
    .filter(Boolean)
    .map((p) => (/^\d+$/.test(p) ? p : p[0]))
    .join('')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function codigoBloque(departamento, area) {
  return [sigla(departamento), sigla(area)].filter(Boolean).join('-');
}

function codigoPieza(bloque, clase, numero) {
  const letra = PIEZAS[clase]?.letra || 'X';
  return `${bloque.codigo || codigoBloque(bloque.departamento, bloque.area)}`
       + `-${letra}${numero}`;
}

/** Añade sufijo si el código ya está en uso por otra fila. */
function codigoLibre(propuesto, exceptoId) {
  const usados = new Set(ins.instalaciones
    .filter((i) => i.id !== exceptoId && i.codigo)
    .map((i) => i.codigo.toUpperCase()));

  let c = propuesto;
  let n = 2;
  while (usados.has(c.toUpperCase())) c = `${propuesto}-${n++}`;
  return c;
}

async function cargarDetalle() {
  ins.detalle = {};
  if (ins.inspecciones.length === 0) return;

  const ids = ins.inspecciones.map((r) => r.id);
  const { data } = await supabase
    .from('v_inspeccion_detalle')
    .select('*')
    .in('inspeccion_id', ids)
    .order('criterio_orden');

  (data || []).forEach((d) => (ins.detalle[d.inspeccion_id] ||= []).push(d));
}

/* ============================================
   Listado
   ============================================ */

export function pintarInstalaciones() {
  pintarResumen();

  const enNovedades = ins.vista === 'novedades';
  document.getElementById('ins-panel-inspecciones').hidden = enNovedades;
  document.getElementById('ins-panel-novedades').hidden = !enNovedades;

  document.querySelectorAll('[data-ins-vista]').forEach((b) => {
    b.classList.toggle('activa', b.dataset.insVista === ins.vista);
  });

  if (enNovedades) pintarNovedades();
  else pintarTabla();

  const $nueva = document.getElementById('ins-btn-nueva');
  if ($nueva) $nueva.hidden = !puedeEscribir();

  ['ins-btn-alimentacion', 'ins-btn-sanitarios'].forEach((id) => {
    const $b = document.getElementById(id);
    if ($b) $b.disabled = ins.inspecciones.length === 0;
  });

  const $hoja = document.getElementById('ins-btn-hoja');
  if ($hoja) $hoja.disabled = ins.novedades.length === 0;

  /* Las listas de verificación son las de la norma: están
     disponibles aunque no haya nada dado de alta. */
  const $campo = document.getElementById('ins-btn-campo');
  if ($campo) $campo.disabled = ins.criterios.length === 0;
}

function pintarResumen() {
  const reincidentes = ins.novedades.filter((n) => n.reincidente).length;

  const poner = (id, v) => {
    const $e = document.getElementById(id);
    if ($e) $e.textContent = v;
  };

  poner('ins-total', ins.instalaciones.length);
  poner('ins-inspeccionadas',
        ins.inspecciones.filter((r) => r.estado === 'cerrada').length);
  poner('ins-novedades-total', ins.novedades.length);
  poner('ins-reincidentes', reincidentes);

  const $b = document.getElementById('ins-btn-novedades');
  if ($b) {
    $b.textContent = ins.novedades.length > 0
      ? `Novedades (${ins.novedades.length})` : 'Novedades';
  }
}

function pintarTabla() {
  const $c = document.getElementById('ins-cuerpo');
  const $vacio = document.getElementById('ins-vacio');
  if (!$c) return;

  $c.innerHTML = '';

  if (ins.instalaciones.length === 0) {
    if ($vacio) {
      $vacio.hidden = false;
      $vacio.textContent = 'Todavía no hay instalaciones registradas. '
        + 'Use «Nueva instalación» para crear la primera mientras la inspecciona.';
    }
    return;
  }
  if ($vacio) $vacio.hidden = true;

  const filtro = document.getElementById('ins-filtro-tipo')?.value || 'todos';
  const porInstalacion = new Map(
    ins.inspecciones.map((r) => [r.instalacion_id, r]));

  let tipoPrevio = null;

  ins.instalaciones
    .filter((i) => filtro === 'todos' || i.tipo === filtro)
    .forEach((i) => {
      if (i.tipo !== tipoPrevio) {
        tipoPrevio = i.tipo;
        const sep = document.createElement('tr');
        sep.className = 'ins-separador';
        sep.innerHTML = `<td colspan="8">${escapar(TIPOS[i.tipo] || i.tipo)}</td>`;
        $c.appendChild(sep);
      }

      const r = porInstalacion.get(i.id);
      const cerrada = r && r.estado === 'cerrada';

      const pendientes = ins.novedades.filter(
        (n) => n.instalacion_id === i.id).length;

      const hijas = i.esPieza ? [] : piezasDe(i.id);

      const tr = document.createElement('tr');
      if (i.esPieza) tr.className = 'ins-fila-pieza';

      tr.innerHTML = `
        <td class="ins-celda-codigo">
          <span class="ins-codigo">${escapar(i.codigo || '—')}</span>
        </td>
        <td>
          ${i.esPieza ? '<span class="ins-sangria">└</span>' : ''}
          ${escapar(i.esPieza ? i.nombreCorto : i.nombreBloque)}
          ${!i.esPieza && i.frecuencia === 'trimestral'
            ? '<span class="ins-marca">Trimestral</span>' : ''}
          ${hijas.length > 0
            ? `<span class="ins-marca ins-marca-piezas">${hijas.length} piezas</span>` : ''}
          ${pendientes > 0 && (!r || r.estado !== 'cerrada')
            ? `<span class="ins-aviso-previo" title="Novedades de la inspección anterior">${
                pendientes} de la vez pasada</span>` : ''}
        </td>
        <td class="celda-centro">${i.criterios}</td>
        <td class="celda-centro">${r ? r.conformes : '—'}</td>
        <td class="celda-centro">${r && r.no_conformes > 0
          ? `<span class="ins-alerta">${r.no_conformes}</span>` : '—'}</td>
        <td class="celda-centro">${r && r.porcentaje !== null
          ? r.porcentaje + '%' : '—'}</td>
        <td class="celda-centro">
          ${r
            ? `<span class="insignia ${cerrada ? 'insignia-activa' : 'insignia-aviso'}">
                 ${cerrada ? 'Cerrada' : 'Abierta'}</span>`
            : '<span class="insignia insignia-inactiva">Sin abrir</span>'}
        </td>
        <td class="celda-centro ins-acciones"></td>
      `;

      const $acc = tr.lastElementChild;

      /* Un bloque con piezas no se inspecciona: lo que se
         revisa es cada sanitario. Ofrecer las dos cosas
         llevaría a llenar la lista del bloque y dejar las
         piezas en blanco, o al revés, y el porcentaje saldría
         de una mezcla de ambas. */
      if (hijas.length === 0) {
        const btn = document.createElement('button');
        btn.className = r ? 'boton-icono' : 'boton-icono boton-icono-destacado';
        btn.type = 'button';
        btn.textContent = !r ? 'Inspeccionar' : (cerrada ? 'Ver' : 'Continuar');
        btn.addEventListener('click', () => r ? abrirInspeccion(r) : abrirYCargar(i));
        $acc.appendChild(btn);
      }

      if (!i.esPieza && puedeEscribir()) {
        const btnP = document.createElement('button');
        btnP.className = 'boton-icono';
        btnP.type = 'button';
        btnP.textContent = 'Piezas';
        btnP.title = 'Numerar sanitarios, urinarios, lavabos y duchas';
        btnP.addEventListener('click', () => abrirPiezas(i));
        $acc.appendChild(btnP);
      }

      if (puedeEscribir()) {
        const btnE = document.createElement('button');
        btnE.className = 'boton-icono';
        btnE.type = 'button';
        btnE.textContent = 'Editar';
        btnE.addEventListener('click', () => abrirFicha(i));
        $acc.appendChild(btnE);
      }

      $c.appendChild(tr);
    });
}

/* ============================================
   Ficha de la instalación · alta, edición y baja
   ============================================ */

function abrirNueva() { abrirFicha(null); }

function abrirFicha(i) {
  ins.editando = i || null;

  document.getElementById('ins-n-titulo').textContent =
    i ? (i.esPieza ? 'Editar pieza' : 'Editar instalación') : 'Nueva instalación';

  const v = (id, valor) => { document.getElementById(id).value = valor ?? ''; };

  v('ins_n_tipo', i?.tipo || 'cocina');
  v('ins_n_departamento', i?.departamento);
  v('ins_n_area', i?.area);
  v('ins_n_codigo', i?.codigo);
  v('ins_n_ubicacion', i?.ubicacion_texto);
  v('ins_n_responsable', i?.responsable);
  v('ins_n_cargo', i?.responsable_cargo);
  v('ins_n_usuarios', i?.usuarios);
  v('ins_n_piezas', i?.piezas);

  /* En una pieza el tipo y el sitio los manda el bloque: se
     bloquean para que no se puedan separar del padre. */
  const esPieza = Boolean(i?.esPieza);
  ['ins_n_tipo', 'ins_n_departamento', 'ins_n_area']
    .forEach((id) => { document.getElementById(id).disabled = esPieza; });

  document.getElementById('ins-bloque-pieza').hidden = !esPieza;
  if (esPieza) {
    v('ins_n_clase', i.pieza);
    v('ins_n_numero', i.numero);
  }

  const $br = document.getElementById('ins_resp_buscar');
  if ($br) $br.value = '';
  const $sr = document.getElementById('ins_resp_sugerencias');
  if ($sr) $sr.hidden = true;

  document.getElementById('ins-btn-eliminar').hidden = !i;
  document.getElementById('ins-btn-guardar-nueva').textContent =
    i ? 'Guardar' : 'Guardar e inspeccionar';

  alternarCamposTipo();
  document.getElementById('ins-alerta-nueva').hidden = true;
  document.getElementById('ins-modal-nueva').hidden = false;
  if (!i) document.getElementById('ins_n_departamento').focus();
}

/* Las piezas solo importan donde hay proporción exigida */
function alternarCamposTipo() {
  const tipo = document.getElementById('ins_n_tipo').value;
  const conPiezas = ['servicios_higienicos', 'lavabos'].includes(tipo);

  document.getElementById('ins-bloque-piezas').hidden = !conPiezas;

  const $ayuda = document.getElementById('ins-ayuda-frecuencia');
  if ($ayuda) {
    $ayuda.textContent = conPiezas
      ? 'Los servicios sanitarios se inspeccionan cada trimestre.'
      : 'Cocinas y comedores se inspeccionan cada mes.';
  }

  sugerirCodigo();
}

/* El código se propone mientras se escribe el sitio y solo si
   nadie lo ha tocado: escribirlo a mano es la excepción, no
   la regla, pero corregirlo debe ser posible. */
function sugerirCodigo() {
  const $c = document.getElementById('ins_n_codigo');
  if (!$c || $c.dataset.manual === '1' || ins.editando) return;

  const propuesto = codigoBloque(
    document.getElementById('ins_n_departamento').value,
    document.getElementById('ins_n_area').value);

  $c.value = propuesto ? codigoLibre(propuesto) : '';
}

async function guardarNueva() {
  const i = ins.editando;
  const tipo = document.getElementById('ins_n_tipo').value;
  const departamento = document.getElementById('ins_n_departamento').value.trim();
  const codigo = document.getElementById('ins_n_codigo').value.trim().toUpperCase();

  if (!departamento) return alertaNueva('Indique el departamento');
  if (!codigo) return alertaNueva('Indique el código de la instalación');

  const repetido = ins.instalaciones.some(
    (x) => x.id !== i?.id && (x.codigo || '').toUpperCase() === codigo);
  if (repetido) return alertaNueva(`El código ${codigo} ya está en uso`);

  const usuarios = document.getElementById('ins_n_usuarios').value;
  const piezas = document.getElementById('ins_n_piezas').value;

  const datos = {
    empresa_id: ins.empresaId,
    tipo,
    codigo,
    departamento: departamento.toUpperCase(),
    area: document.getElementById('ins_n_area').value.trim() || null,
    ubicacion_texto: document.getElementById('ins_n_ubicacion').value.trim() || null,
    responsable: document.getElementById('ins_n_responsable').value.trim() || null,
    responsable_cargo: document.getElementById('ins_n_cargo').value.trim() || null,
    frecuencia: ['servicios_higienicos', 'lavabos'].includes(tipo)
      ? 'trimestral' : 'mensual',
    usuarios: usuarios === '' ? null : parseInt(usuarios, 10),
    piezas: piezas === '' ? null : parseInt(piezas, 10)
  };

  /* Una pieza conserva su sitio y su clase; solo cambia lo que
     el formulario dejó editable. */
  if (i?.esPieza) {
    const numero = parseInt(document.getElementById('ins_n_numero').value, 10);
    datos.tipo = i.tipo;
    datos.departamento = i.departamento;
    datos.area = i.area;
    datos.frecuencia = i.frecuencia;
    datos.pieza = document.getElementById('ins_n_clase').value;
    datos.numero = Number.isFinite(numero) ? numero : i.numero;
  }

  const $btn = document.getElementById('ins-btn-guardar-nueva');
  $btn.disabled = true;

  let data, error;
  if (i) {
    ({ error } = await supabase.from('instalaciones')
      .update(datos).eq('id', i.id));

    /* Las piezas heredaron estos datos del bloque cuando se
       crearon. Si cambian, tienen que cambiar en todas: de lo
       contrario la hoja de campo del bloque nombra a una
       persona y la de sus sanitarios a otra. */
    if (!error && !i.esPieza) {
      const hijas = piezasDe(i.id);
      if (hijas.length > 0) {
        await supabase.from('instalaciones').update({
          responsable: datos.responsable,
          responsable_cargo: datos.responsable_cargo,
          ubicacion_texto: datos.ubicacion_texto
        }).in('id', hijas.map((h) => h.id));
      }
    }
  } else {
    ({ data, error } = await supabase
      .from('instalaciones').insert(datos).select('id').maybeSingle());
  }

  $btn.disabled = false;
  if (error) return alertaNueva(traducir(error));

  document.getElementById('ins-modal-nueva').hidden = true;
  document.getElementById('ins_n_codigo').dataset.manual = '0';

  /* Se abre su inspección de inmediato: la instalación se
     crea porque se está yendo a inspeccionar, no antes. */
  if (!i && data?.id) {
    await supabase.rpc('abrir_inspeccion', {
      p_instalacion: data.id,
      p_fecha: HOY()
    });
  }

  await refrescar();

  if (!i && data?.id) {
    const nueva = ins.inspecciones.find((r) => r.instalacion_id === data.id);
    if (nueva) abrirInspeccion(nueva);
  }
}

/**
 * Baja de una instalación.
 *
 * Si nunca se inspeccionó se borra de verdad; si tiene
 * historial se desactiva, porque los informes de los periodos
 * cerrados la citan y borrarla los dejaría apuntando a nada.
 *
 * Un bloque arrastra sus piezas: dejar sanitarios colgando de
 * un bloque retirado los volvería inalcanzables.
 */
async function eliminarInstalacion() {
  const i = ins.editando;
  if (!i) return;

  const hijas = i.esPieza ? [] : piezasDe(i.id);
  const ids = [i.id, ...hijas.map((h) => h.id)];

  const { count } = await supabase
    .from('inspecciones')
    .select('id', { count: 'exact', head: true })
    .in('instalacion_id', ids);

  const conHistoria = (count || 0) > 0;

  const aviso = conHistoria
    ? `«${i.nombre}» tiene ${count} `
      + `${count === 1 ? 'inspección registrada' : 'inspecciones registradas'}.\n\n`
      + (hijas.length > 0
          ? `Se retirarán también sus ${hijas.length} piezas.\n\n` : '')
      + 'Saldrá del listado y de las próximas inspecciones, pero los periodos '
      + 'ya cerrados conservarán su registro.\n\n¿Continuar?'
    : `¿Eliminar «${i.nombre}»?\n\n`
      + (hijas.length > 0
          ? `Se eliminarán también sus ${hijas.length} piezas.\n\n` : '')
      + 'No tiene inspecciones registradas, así que se borra por completo.';

  if (!confirm(aviso)) return;

  const $btn = document.getElementById('ins-btn-eliminar');
  $btn.disabled = true;

  let error;
  if (conHistoria) {
    ({ error } = await supabase.from('instalaciones')
      .update({ activo: false }).in('id', ids));
  } else {
    ({ error } = await supabase.from('instalaciones').delete().in('id', ids));
  }

  $btn.disabled = false;
  if (error) return alertaNueva(traducir(error));

  document.getElementById('ins-modal-nueva').hidden = true;
  await refrescar();
}

/* ============================================
   Piezas de un bloque

   Numerar cada sanitario, urinario y lavabo. La pieza es la
   unidad que se inspecciona: solo así el historial puede
   decir que el sanitario 2 lleva tres trimestres sin
   descarga, en lugar de que «al bloque le falta algo».
   ============================================ */

function abrirPiezas(bloque) {
  ins.editando = bloque;

  ins.piezasEdicion = piezasDe(bloque.id).map((p) => ({
    id: p.id, pieza: p.pieza, numero: p.numero, codigo: p.codigo, nueva: false
  }));

  document.getElementById('ins-p-titulo').textContent = bloque.nombreBloque;
  document.getElementById('ins-p-codigo').textContent = bloque.codigo || '—';
  document.getElementById('ins_p_cantidad').value = 1;

  pintarPiezas();
  document.getElementById('ins-alerta-piezas').hidden = true;
  document.getElementById('ins-modal-piezas').hidden = false;
}

function pintarPiezas() {
  const $c = document.getElementById('ins-p-cuerpo');
  const $vacio = document.getElementById('ins-p-vacio');
  $c.innerHTML = '';

  const lista = [...ins.piezasEdicion].sort(
    (a, b) => (PIEZAS[a.pieza]?.orden ?? 9) - (PIEZAS[b.pieza]?.orden ?? 9)
           || (a.numero ?? 0) - (b.numero ?? 0));

  if ($vacio) $vacio.hidden = lista.length > 0;

  lista.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="ins-codigo">${escapar(p.codigo)}</span></td>
      <td>${escapar(PIEZAS[p.pieza]?.texto || p.pieza)} ${p.numero}</td>
      <td class="celda-centro">${p.nueva
        ? '<span class="ins-marca">nueva</span>' : ''}</td>
      <td class="celda-centro"></td>
    `;

    const btn = document.createElement('button');
    btn.className = 'boton-icono boton-icono-peligro';
    btn.type = 'button';
    btn.textContent = 'Quitar';
    btn.addEventListener('click', () => {
      ins.piezasEdicion = ins.piezasEdicion.filter((x) => x !== p);
      pintarPiezas();
    });
    tr.lastElementChild.appendChild(btn);

    $c.appendChild(tr);
  });

  const total = ins.piezasEdicion.length;
  document.getElementById('ins-p-cuenta').textContent = total === 0
    ? 'Sin piezas'
    : `${total} pieza${total === 1 ? '' : 's'}`;
}

/* Se agregan por tandas: «3 sanitarios» crea el 1, el 2 y el
   3 con su código. Darlos de alta uno a uno para un bloque de
   diez piezas es donde la gente abandona. */
function agregarPiezas() {
  const clase = document.getElementById('ins_p_clase').value;
  const cantidad = parseInt(document.getElementById('ins_p_cantidad').value, 10);

  if (!Number.isFinite(cantidad) || cantidad < 1) {
    return alertaPiezas('Indique cuántas piezas agregar');
  }

  /* La numeración continúa donde se quedó: si ya hay dos
     sanitarios, el siguiente es el 3 aunque el 1 se haya
     retirado. Reutilizar un número rompería el historial. */
  const usados = ins.piezasEdicion
    .filter((p) => p.pieza === clase)
    .map((p) => Number(p.numero) || 0);
  let siguiente = (usados.length ? Math.max(...usados) : 0) + 1;

  const tomados = new Set(ins.piezasEdicion.map((p) => p.codigo.toUpperCase()));

  for (let n = 0; n < cantidad; n++, siguiente++) {
    let codigo = codigoPieza(ins.editando, clase, siguiente);
    let sufijo = 2;
    while (tomados.has(codigo.toUpperCase())) codigo = `${codigo}-${sufijo++}`;
    tomados.add(codigo.toUpperCase());

    ins.piezasEdicion.push({
      id: null, pieza: clase, numero: siguiente, codigo, nueva: true
    });
  }

  document.getElementById('ins-alerta-piezas').hidden = true;
  pintarPiezas();
}

async function guardarPiezas() {
  const b = ins.editando;
  if (!b) return;

  const $btn = document.getElementById('ins-btn-guardar-piezas');
  $btn.disabled = true;

  const previas = piezasDe(b.id);
  const vivos = new Set(ins.piezasEdicion.filter((p) => p.id).map((p) => p.id));
  const retiradas = previas.filter((p) => !vivos.has(p.id));
  const nuevas = ins.piezasEdicion.filter((p) => !p.id);

  const fallo = (e) => { $btn.disabled = false; alertaPiezas(traducir(e)); };

  /* Se retiran igual que un bloque: si nunca se inspeccionaron
     se borran, si tienen historial se desactivan. */
  if (retiradas.length > 0) {
    const ids = retiradas.map((p) => p.id);
    const { count } = await supabase
      .from('inspecciones')
      .select('id', { count: 'exact', head: true })
      .in('instalacion_id', ids);

    const { error } = (count || 0) > 0
      ? await supabase.from('instalaciones').update({ activo: false }).in('id', ids)
      : await supabase.from('instalaciones').delete().in('id', ids);

    if (error) return fallo(error);
  }

  if (nuevas.length > 0) {
    const { error } = await supabase.from('instalaciones').insert(
      nuevas.map((p) => ({
        empresa_id: ins.empresaId,
        padre_id: b.id,
        tipo: b.tipo,
        frecuencia: b.frecuencia,
        departamento: b.departamento,
        area: b.area,
        ubicacion_texto: b.ubicacion_texto,
        responsable: b.responsable,
        responsable_cargo: b.responsable_cargo,
        codigo: p.codigo,
        pieza: p.pieza,
        numero: p.numero,
        orden: b.orden ?? 0
      })));
    if (error) return fallo(error);
  }

  $btn.disabled = false;
  document.getElementById('ins-modal-piezas').hidden = true;
  await refrescar();
}

/** Abre la inspección de una instalación ya registrada */
async function abrirYCargar(instalacion) {
  const { error } = await supabase.rpc('abrir_inspeccion', {
    p_instalacion: instalacion.id,
    p_fecha: HOY()
  });
  if (error) return alert(traducir(error));

  await refrescar();
  const r = ins.inspecciones.find((x) => x.instalacion_id === instalacion.id);
  if (r) abrirInspeccion(r);
}

/* ============================================
   Lista de verificación
   ============================================ */

function abrirInspeccion(r) {
  ins.actual = r;

  document.getElementById('ins-i-titulo').textContent = r.instalacion;
  document.getElementById('ins-i-periodo').textContent =
    `${TIPOS[r.tipo] || r.tipo} · ${r.frecuencia === 'trimestral'
      ? nombreTrimestre(ins.periodo) : nombreMes(ins.periodo)}`;

  document.getElementById('ins_fecha').value = r.fecha_inspeccion || HOY();

  /* El inspector es quien tiene la sesión abierta.

     Antes era un campo libre y salía en blanco o con el nombre
     de otro, porque se rellenaba a mano después del recorrido.
     Quien firma la inspección es quien la hizo, y eso el
     sistema ya lo sabe: no hay por qué preguntarlo. Se guarda
     el texto —no el id— para que el informe de un trimestre
     pasado siga diciendo quién fue aunque esa persona ya no
     esté dada de alta. */
  const yo = firmante();
  document.getElementById('ins_inspector').value = r.inspector || yo.nombre;

  document.getElementById('ins_acompanante').value = r.acompanante || '';
  document.getElementById('ins_acomp_buscar').value = '';
  document.getElementById('ins_acomp_sugerencias').hidden = true;
  document.getElementById('ins_observacion').value = r.observacion || '';

  const editable = puedeEscribir() && r.estado !== 'cerrada';
  ['ins_fecha', 'ins_acompanante', 'ins_acomp_buscar', 'ins_observacion']
    .forEach((id) => { document.getElementById(id).disabled = !editable; });

  pintarCriterios(editable);

  document.getElementById('ins-btn-guardar').hidden = !editable;
  document.getElementById('ins-btn-cerrar-inspeccion').hidden = !editable;
  document.getElementById('ins-btn-reabrir').hidden =
    !(puedeEscribir() && r.estado === 'cerrada');

  document.getElementById('ins-alerta-inspeccion').hidden = true;
  document.getElementById('ins-modal-inspeccion').hidden = false;
}

function pintarCriterios(editable) {
  const r = ins.actual;
  const lineas = ins.detalle[r.id] || [];
  const $c = document.getElementById('ins-i-criterios');
  $c.innerHTML = '';

  let grupoPrevio = null;

  lineas.forEach((l) => {
    if (l.grupo !== grupoPrevio) {
      grupoPrevio = l.grupo;
      const h = document.createElement('div');
      h.className = 'ins-grupo';
      h.textContent = l.grupo;
      $c.appendChild(h);
    }

    const fila = document.createElement('div');
    fila.className = 'ins-criterio';
    fila.dataset.criterio = l.criterio_id;
    if (l.resultado) fila.classList.add('ins-evaluado');

    /* Lo que se anotó la vez pasada, bajo el criterio: quien
       inspecciona sabe qué mirar antes de mirar. */
    const previa = ins.novedades.find(
      (n) => n.instalacion_id === r.instalacion_id
          && n.criterio_id === l.criterio_id
          && n.inspeccion_id !== r.id);

    fila.innerHTML = `
      <div class="ins-criterio-texto">
        ${escapar(l.criterio)}
        ${l.critico ? '<span class="ins-critico">Crítico</span>' : ''}
        ${l.normativa
          ? `<span class="ins-norma">${escapar(l.normativa)}</span>` : ''}
      </div>
      ${previa ? `
        <div class="ins-previa">
          <span class="ins-previa-etiqueta">Vez anterior</span>
          <span class="ins-previa-texto">${escapar(previa.observacion || 'No cumplía')}</span>
          ${previa.veces > 1
            ? `<span class="ins-reincide">${previa.veces}.ª vez</span>` : ''}
        </div>` : ''}
      <div class="ins-opciones">
        ${Object.entries(RESULTADOS).map(([valor, [clase, texto]]) => `
          <button class="ins-opcion ${clase}${l.resultado === valor ? ' activa' : ''}"
                  type="button" data-valor="${valor}"
                  ${editable ? '' : 'disabled'}>${texto}</button>`).join('')}
      </div>
      <div class="ins-observacion" ${l.resultado === 'no_conforme' ? '' : 'hidden'}>
        <input class="entrada" type="text" data-campo="observacion"
               placeholder="Qué se encontró"
               value="${escapar(l.observacion || '')}"
               ${editable ? '' : 'disabled'}>
      </div>
    `;

    /* La observación solo aparece al marcar un incumplimiento:
       pedirla siempre alarga el recorrido sin aportar nada. */
    fila.querySelectorAll('.ins-opcion').forEach((b) => {
      b.addEventListener('click', () => {
        fila.querySelectorAll('.ins-opcion').forEach(
          (x) => x.classList.remove('activa'));
        b.classList.add('activa');
        fila.classList.add('ins-evaluado');
        fila.querySelector('.ins-observacion').hidden =
          b.dataset.valor !== 'no_conforme';
        actualizarAvance();
      });
    });

    $c.appendChild(fila);
  });

  actualizarAvance();
}

/* Cuántos criterios quedan por evaluar. En una lista de
   veintiún puntos, saber cuánto falta evita abandonarla. */
function actualizarAvance() {
  const filas = [...document.querySelectorAll('#ins-i-criterios .ins-criterio')];
  const hechos = filas.filter(
    (f) => f.querySelector('.ins-opcion.activa')).length;

  const $a = document.getElementById('ins-avance');
  if (!$a) return;

  $a.textContent = `${hechos} de ${filas.length} evaluados`;
  $a.classList.toggle('ins-avance-completo', hechos === filas.length);

  const $barra = document.getElementById('ins-barra');
  if ($barra) {
    $barra.style.width = filas.length
      ? Math.round(hechos / filas.length * 100) + '%' : '0%';
  }
}

async function guardarInspeccion(cerrar) {
  const r = ins.actual;
  if (!r) return;

  const filas = [...document.querySelectorAll('#ins-i-criterios .ins-criterio')];

  const detalle = filas.map((f) => {
    const activa = f.querySelector('.ins-opcion.activa');
    return {
      inspeccion_id: r.id,
      criterio_id: f.dataset.criterio,
      resultado: activa ? activa.dataset.valor : null,
      observacion: f.querySelector('[data-campo="observacion"]').value.trim() || null
    };
  });

  if (cerrar) {
    const inspector = document.getElementById('ins_inspector').value.trim();
    if (!inspector) {
      return alertaInspeccion('Indique quién realizó la inspección antes de cerrarla');
    }

    const pendientes = detalle.filter((d) => !d.resultado).length;
    if (pendientes > 0) {
      return alertaInspeccion(
        `Faltan ${pendientes} criterio${pendientes === 1 ? '' : 's'} por evaluar. `
      + 'Una inspección cerrada a medias no acredita nada.');
    }
  }

  const $btn = document.getElementById(
    cerrar ? 'ins-btn-cerrar-inspeccion' : 'ins-btn-guardar');
  $btn.disabled = true;

  const cabecera = {
    fecha_inspeccion: document.getElementById('ins_fecha').value || HOY(),
    inspector: document.getElementById('ins_inspector').value.trim() || null,
    acompanante: document.getElementById('ins_acompanante').value.trim() || null,
    observacion: document.getElementById('ins_observacion').value.trim() || null
  };
  if (cerrar) cabecera.estado = 'cerrada';

  const { error: e1 } = await supabase
    .from('inspeccion_detalle')
    .upsert(detalle, { onConflict: 'inspeccion_id,criterio_id' });

  if (e1) { $btn.disabled = false; return alertaInspeccion(traducir(e1)); }

  const { error: e2 } = await supabase
    .from('inspecciones').update(cabecera).eq('id', r.id);

  $btn.disabled = false;
  if (e2) return alertaInspeccion(traducir(e2));

  document.getElementById('ins-modal-inspeccion').hidden = true;
  await refrescar();

  /* Los incumplimientos quedan como novedad de esta
     inspección y se llevarán impresos al recorrido siguiente. */
  if (cerrar && detalle.some((d) => d.resultado === 'no_conforme')) {
    ins.vista = 'novedades';
    pintarInstalaciones();
  }
}

async function reabrirInspeccion() {
  const r = ins.actual;
  if (!r) return;
  if (!confirm('¿Reabrir la inspección para corregirla?')) return;

  const { error } = await supabase
    .from('inspecciones').update({ estado: 'abierta' }).eq('id', r.id);

  if (error) return alertaInspeccion(traducir(error));

  document.getElementById('ins-modal-inspeccion').hidden = true;
  await refrescar();
}

/* ============================================
   Hallazgos
   ============================================ */

/* ============================================
   Novedades
   Lo hallado en la última inspección de cada instalación.
   No es una lista de tareas: es lo que se lleva impreso al
   recorrido siguiente para saber qué mirar antes de mirar.
   ============================================ */

function pintarNovedades() {
  const $c = document.getElementById('ins-cuerpo-novedades');
  const $vacio = document.getElementById('ins-vacio-novedades');
  if (!$c) return;

  $c.innerHTML = '';

  if (ins.novedades.length === 0) {
    if ($vacio) {
      $vacio.hidden = false;
      $vacio.textContent = ins.inspecciones.length === 0
        ? 'Todavía no hay inspecciones registradas.'
        : 'No hay novedades: la última inspección de cada instalación resultó conforme.';
    }
    return;
  }
  if ($vacio) $vacio.hidden = true;

  /* Agrupado por instalación, como se recorre en campo */
  const porInstalacion = new Map();
  ins.novedades.forEach((n) => {
    if (!porInstalacion.has(n.instalacion)) porInstalacion.set(n.instalacion, []);
    porInstalacion.get(n.instalacion).push(n);
  });

  [...porInstalacion].forEach(([nombre, lista]) => {
    const sep = document.createElement('tr');
    sep.className = 'ins-separador';
    sep.innerHTML = `<td colspan="4">
      ${escapar(nombre)}
      <span class="ins-sep-meta">${escapar(TIPOS[lista[0].tipo] || lista[0].tipo)}
        · ${formatearFecha(lista[0].fecha_inspeccion)}</span>
    </td>`;
    $c.appendChild(sep);

    lista.forEach((n) => {
      const tr = document.createElement('tr');
      if (n.reincidente) tr.classList.add('ins-fila-reincide');

      tr.innerHTML = `
        <td>${escapar(n.grupo)}</td>
        <td>
          ${escapar(n.criterio)}
          ${n.critico ? '<span class="ins-critico">Crítico</span>' : ''}
        </td>
        <td>${escapar(n.observacion || '—')}</td>
        <td class="celda-centro">
          ${n.reincidente
            ? `<span class="ins-reincide">${n.veces}.ª vez</span>`
            : '<span class="ins-primera">1.ª vez</span>'}
        </td>
      `;
      $c.appendChild(tr);
    });
  });
}

/**
 * Hoja de recorrido.
 *
 * Se lleva doblada en el bolsillo: la inspección se registra
 * en el celular, el papel solo recuerda qué se encontró la vez
 * pasada. Sin casillas que llenar ni espacio para escribir,
 * porque no se llena.
 */
function imprimirHoja() {
  if (ins.novedades.length === 0) return;

  const porInstalacion = new Map();
  ins.novedades.forEach((n) => {
    if (!porInstalacion.has(n.instalacion)) porInstalacion.set(n.instalacion, []);
    porInstalacion.get(n.instalacion).push(n);
  });

  const bloques = [...porInstalacion].map(([nombre, lista]) => `
    <div class="hr-sitio">
      <h2 class="hr-titulo">${escapar(nombre)}
        <span class="hr-tipo">${escapar(TIPOS[lista[0].tipo] || lista[0].tipo)}</span>
        <span class="hr-fecha">${formatearFecha(lista[0].fecha_inspeccion)}</span>
      </h2>
      <ul class="hr-lista">
        ${lista.map((n) => `
          <li${n.reincidente ? ' class="hr-reincide"' : ''}>
            ${escapar(n.observacion || n.criterio)}
            ${n.reincidente
              ? `<span class="hr-veces">${n.veces}.ª vez</span>` : ''}
          </li>`).join('')}
      </ul>
    </div>`).join('');

  const html = `
    <div class="hr-hoja">
      <header class="hr-cabecera">
        <img src="logo.png" class="hr-logo" alt="">
        <div>
          <div class="hr-empresa">${escapar(ins.empresaNombre || 'Empresa')}</div>
          <div class="hr-unidad">Departamento de Seguridad y Salud Ocupacional</div>
        </div>
        <div class="hr-fecha-hoja">${new Date().toLocaleDateString('es-EC')}</div>
      </header>

      <p class="hr-encabezado">Novedades de la inspección anterior</p>
      <p class="hr-nota">Hoja de consulta para el recorrido. La inspección se
        registra en el sistema; este papel solo recuerda qué revisar.</p>

      ${bloques}
    </div>`;

  const $z = document.getElementById('ins-impresion');
  if (!$z) {
    alert('Falta actualizar la página en el servidor para poder imprimir.');
    return;
  }

  $z.innerHTML = html;

  const titulo = document.title;
  document.title = 'Novedades de la inspección anterior';
  document.body.classList.add('imprimiendo-instalaciones');
  window.print();

  setTimeout(() => {
    document.body.classList.remove('imprimiendo-instalaciones');
    document.title = titulo;
  }, 500);
}

/**
 * Hojas de campo.
 *
 * La lista completa de verificación, en blanco, para llenar a
 * mano. Sirve donde no hay señal y para que otra persona haga
 * el recorrido sin acceso al sistema.
 *
 * Una hoja por instalación, para poder repartirlas o llevar
 * solo la que toca. Bajo los criterios que fallaron la vez
 * pasada va una nota: así una sola hoja recuerda qué mirar y
 * sirve para anotar.
 */
/**
 * Selección de hojas de campo.
 *
 * Las listas de verificación existen por sí mismas: son las
 * de la norma, no dependen de que haya instalaciones dadas de
 * alta. De ahí que se ofrezcan siempre en blanco, y además,
 * si hay instalaciones registradas, con su nombre ya puesto y
 * lo pendiente de la vez anterior.
 */
function abrirSeleccionCampo() {
  const $c = document.getElementById('ins-c-lista');

  /* Salir en silencio cuando falta un elemento convierte un
     archivo sin subir en un botón que no responde y no dice
     por qué. Mejor decirlo. */
  if (!$c) {
    console.error('NEXUS · Falta la ventana de selección en la página. '
                + 'Suba la versión actualizada de salud-ocupacional.html.');
    alert('Esta función necesita una versión más reciente de la página.\n\n'
        + 'Falta actualizar salud-ocupacional.html en el servidor.');
    return;
  }

  $c.innerHTML = '';

  /* --- Listas en blanco, una por tipo --- */
  const cabecera = document.createElement('div');
  cabecera.className = 'ins-c-grupo';
  cabecera.innerHTML = '<span>Listas en blanco</span>';
  $c.appendChild(cabecera);

  Object.entries(TIPOS).forEach(([tipo, nombre]) => {
    const n = ins.criterios.filter((c) => c.tipo === tipo).length;
    if (n === 0) return;

    const fila = document.createElement('label');
    fila.className = 'ins-c-opcion';
    fila.innerHTML = `
      <input type="checkbox" value="tipo:${tipo}" data-clase="tipo">
      <span class="ins-c-cuerpo">
        <span class="ins-c-nombre">${escapar(nombre)}</span>
        <span class="ins-c-meta">${n} criterios · hoja en blanco</span>
      </span>`;
    fila.querySelector('input').addEventListener('change', actualizarCuentaCampo);
    $c.appendChild(fila);
  });

  /* --- Instalaciones registradas --- */
  if (ins.instalaciones.length > 0) {
    const cab2 = document.createElement('div');
    cab2.className = 'ins-c-grupo';
    cab2.innerHTML = `
      <span>Instalaciones registradas</span>
      <button class="ins-c-todos" type="button">Marcar todas</button>`;

    cab2.querySelector('.ins-c-todos').addEventListener('click', () => {
      const casillas = [...$c.querySelectorAll('input[data-clase="instalacion"]')];
      const marcar = casillas.some((x) => !x.checked);
      casillas.forEach((x) => { x.checked = marcar; });
      actualizarCuentaCampo();
    });

    $c.appendChild(cab2);

    ins.instalaciones.forEach((i) => {
      const n = ins.criterios.filter((c) => c.tipo === i.tipo).length;
      const pendientes = ins.novedades.filter(
        (x) => x.instalacion_id === i.id).length;

      const fila = document.createElement('label');
      fila.className = 'ins-c-opcion';
      fila.innerHTML = `
        <input type="checkbox" value="inst:${i.id}" data-clase="instalacion" checked>
        <span class="ins-c-cuerpo">
          <span class="ins-c-nombre">${escapar(i.nombre)}</span>
          <span class="ins-c-meta">
            ${escapar(TIPOS[i.tipo] || i.tipo)} · ${n} criterios
            ${pendientes > 0
              ? ` · <b>${pendientes} novedad${pendientes === 1 ? '' : 'es'} de la vez pasada</b>`
              : ''}
          </span>
        </span>`;
      fila.querySelector('input').addEventListener('change', actualizarCuentaCampo);
      $c.appendChild(fila);
    });
  } else {
    /* Sin instalaciones, las listas en blanco vienen marcadas:
       es lo único que se puede imprimir y lo que se ha pedido. */
    $c.querySelectorAll('input[data-clase="tipo"]')
      .forEach((x) => { x.checked = true; });

    const nota = document.createElement('p');
    nota.className = 'ins-c-nota';
    nota.textContent = 'Todavía no hay instalaciones registradas. '
      + 'Las hojas saldrán en blanco, con espacio para anotar el sitio.';
    $c.appendChild(nota);
  }

  document.getElementById('ins_c_novedades').checked = true;

  actualizarCuentaCampo();
  document.getElementById('ins-modal-campo').hidden = false;
}

/* Cuántas hojas van a salir. Imprimir once por descuido es
   fácil; verlo antes de pulsar, no cuesta nada. */
function actualizarCuentaCampo() {
  const n = document.querySelectorAll('#ins-c-lista input:checked').length;
  const $b = document.getElementById('ins-btn-imprimir-campo');
  const $t = document.getElementById('ins-c-cuenta');

  if ($t) {
    $t.textContent = n === 0
      ? 'Ninguna seleccionada'
      : `${n} hoja${n === 1 ? '' : 's'} para imprimir`;
  }
  if ($b) $b.disabled = n === 0;
}

function imprimirHojasCampo() {
  const marcadas = [...document.querySelectorAll('#ins-c-lista input:checked')]
    .map((x) => x.value);

  if (marcadas.length === 0) return;

  const conNovedades = document.getElementById('ins_c_novedades').checked;
  const enRejilla = document.getElementById('ins_c_rejilla')?.checked;
  document.getElementById('ins-modal-campo').hidden = true;

  const hojas = enRejilla
    ? construirRejilla(marcadas, conNovedades)
    : construirHojasSueltas(marcadas, conNovedades);

  if (!hojas) return;

  const $z = document.getElementById('ins-impresion');
  if (!$z) {
    alert('Falta actualizar la página en el servidor para poder imprimir.');
    return;
  }

  $z.innerHTML = hojas;

  const titulo = document.title;
  document.title = 'Hojas de campo · inspección de instalaciones';
  document.body.classList.add('imprimiendo-instalaciones');
  window.print();

  setTimeout(() => {
    document.body.classList.remove('imprimiendo-instalaciones');
    document.title = titulo;
  }, 500);
}

/* ============================================
   Hoja de campo en rejilla

   Una hoja por tipo, con los criterios en las filas y una
   columna por instalación identificada con su código. El
   inspector escribe S, N o / en el cuadro.

   Por qué:
     Una hoja por sanitario significa llevar veinte al
     recorrido, y veinte hojas se traspapelan, se mojan y se
     firman a medias. En rejilla, un bloque entero cabe en una
     página y la comparación entre piezas se lee de un vistazo:
     si la columna del sanitario 3 está llena de enes, salta a
     la vista sin sumar nada.

   Qué se pierde:
     El espacio para observación por criterio. Va una sola
     columna al final de la hoja, para lo que haya que anotar
     del conjunto. Lo detallado se escribe al transcribir.
   ============================================ */

/* Diez columnas es lo que cabe en A4 vertical con el criterio
   legible. A partir de ahí se pasa a una segunda hoja en vez
   de encoger la letra hasta que no se pueda leer en campo. */
const COLUMNAS_POR_HOJA = 10;

/* Qué tipos comparten hoja.

   Servicios higiénicos y lavabos van juntos porque se
   recorren juntos: el bloque de baños tiene los sanitarios y
   los lavabos en el mismo cuarto, y separarlos obliga a
   cambiar de papel a medio metro de distancia.

   Cocina y comedor no se juntan aunque sean del mismo informe:
   están en sitios distintos y sus criterios apenas se
   solapan, así que una hoja común saldría medio tachada. */
const HOJAS_REJILLA = {
  cocina:               { clave: 'cocina',     titulo: 'Cocina' },
  comedor:              { clave: 'comedor',    titulo: 'Comedor' },
  servicios_higienicos: { clave: 'sanitarios',
                          titulo: 'Servicios higiénicos, lavabos y duchas' },
  lavabos:              { clave: 'sanitarios',
                          titulo: 'Servicios higiénicos, lavabos y duchas' }
};

/**
 * Criterios de varios tipos fundidos en una sola lista.
 *
 * Cuando dos tipos comparten hoja, sus listas de verificación
 * no son iguales. Se unen sin repetir, y de cada criterio se
 * recuerda a qué tipos aplica: en la rejilla, la casilla de
 * una columna a la que ese criterio no le corresponde sale
 * sombreada, para que nadie la deje en blanco creyendo que se
 * le olvidó.
 */
function criteriosUnificados(tipos) {
  const mapa = new Map();
  const ordenGrupo = new Map();

  tipos.forEach((t) => {
    ins.criterios.filter((c) => c.tipo === t).forEach((c) => {
      if (!ordenGrupo.has(c.grupo)) ordenGrupo.set(c.grupo, ordenGrupo.size);

      const clave = `${c.grupo}|${c.texto}`.toLowerCase().trim();
      if (mapa.has(clave)) {
        const x = mapa.get(clave);
        x.tipos.add(t);
        x.ids.push(c.id);
        x.critico = x.critico || c.critico;
      } else {
        mapa.set(clave, {
          grupo: c.grupo, texto: c.texto, critico: c.critico,
          orden: c.orden ?? 99, tipos: new Set([t]), ids: [c.id]
        });
      }
    });
  });

  return [...mapa.values()].sort((a, b) =>
    (ordenGrupo.get(a.grupo) ?? 99) - (ordenGrupo.get(b.grupo) ?? 99)
    || a.orden - b.orden);
}

function construirRejilla(marcadas, conNovedades) {
  /* Las listas en blanco no tienen columna: la rejilla se
     construye sobre instalaciones con código. */
  const elegidas = marcadas
    .filter((v) => v.startsWith('inst:'))
    .map((v) => ins.instalaciones.find((i) => i.id === v.slice(5)))
    .filter(Boolean);

  if (elegidas.length === 0) {
    alert('La hoja en rejilla necesita instalaciones registradas.\n\n'
        + 'Marque al menos una en la lista de abajo, o desmarque la rejilla '
        + 'para imprimir listas en blanco.');
    return null;
  }

  const yo = firmante();

  /* Agrupadas por hoja, no por tipo: sanitarios y lavabos
     caen en la misma. */
  const porHoja = new Map();
  elegidas.forEach((i) => {
    const h = HOJAS_REJILLA[i.tipo] || { clave: i.tipo, titulo: TIPOS[i.tipo] || i.tipo };
    if (!porHoja.has(h.clave)) {
      porHoja.set(h.clave, { titulo: h.titulo, tipos: new Set(), lista: [] });
    }
    const g = porHoja.get(h.clave);
    g.tipos.add(i.tipo);
    g.lista.push(i);
  });

  let n = 0;
  const hojas = [];

  porHoja.forEach((g) => {
    const criterios = criteriosUnificados([...g.tipos]);
    if (criterios.length === 0) return;

    /* Ordenadas por bloque para que las columnas de un mismo
       cuarto queden contiguas y no repartidas entre hojas. */
    const lista = [...g.lista].sort((a, b) =>
      (a.padre?.codigo || a.codigo || '').localeCompare(b.padre?.codigo || b.codigo || '')
      || (a.codigo || '').localeCompare(b.codigo || ''));

    const deCuantas = Math.ceil(lista.length / COLUMNAS_POR_HOJA);

    for (let d = 0; d < lista.length; d += COLUMNAS_POR_HOJA) {
      hojas.push(hojaRejilla(g.titulo, criterios,
                             lista.slice(d, d + COLUMNAS_POR_HOJA),
                             conNovedades, yo, n++, deCuantas, d));
    }
  });

  return hojas.join('');
}

function hojaRejilla(titulo, criterios, columnas, conNovedades, yo, n, deCuantas, desde) {
  /* El ancho del criterio cede terreno según cuántas columnas
     haya: con tres piezas sobra sitio, con diez va justo. */
  const anchoCol = Math.max(6, Math.min(11, 78 / columnas.length));
  const anchoTexto = 100 - anchoCol * columnas.length - 14;

  /* Marca de lo que falló la vez pasada: un punto junto al
     criterio, no un texto, porque no hay sitio para texto y lo
     que hace falta es la señal de «mire esto primero». */
  const pendientes = new Set();
  if (conNovedades) {
    columnas.forEach((i) => {
      ins.novedades
        .filter((x) => x.instalacion_id === i.id)
        .forEach((x) => pendientes.add(x.criterio_id));
    });
  }

  let grupoPrevio = null;
  const cuerpo = criterios.map((c) => {
    const cab = c.grupo !== grupoPrevio
      ? `<tr><td colspan="${columnas.length + 2}" class="hc-grupo">${
          escaparTexto(c.grupo)}</td></tr>`
      : '';
    grupoPrevio = c.grupo;

    const previo = c.ids.some((id) => pendientes.has(id));

    return cab + `
      <tr>
        <td class="hc-texto hc-texto-rejilla">
          ${escaparTexto(c.texto)}
          ${c.critico ? '<span class="hc-critico">crítico</span>' : ''}
          ${previo ? '<span class="hc-marca-previa">•</span>' : ''}
        </td>
        ${columnas.map((i) => c.tipos.has(i.tipo)
          ? '<td class="hc-cuadro"></td>'
          : '<td class="hc-cuadro hc-no-aplica"></td>').join('')}
        <td class="hc-obs-rejilla"></td>
      </tr>`;
  }).join('');

  /* Con columnas de varios bloques, el subtítulo nombra el
     sitio en vez de un bloque concreto. */
  const sitios = [...new Set(columnas.map(
    (i) => (i.esPieza && i.padre ? i.padre : i).nombreBloque))];
  const subtitulo = sitios.length === 1 ? sitios[0]
    : sitios.slice(0, 3).join(' · ') + (sitios.length > 3 ? ' …' : '');

  const hayNoAplica = criterios.some(
    (c) => columnas.some((i) => !c.tipos.has(i.tipo)));

  return `
    <div class="hc-hoja hc-rejilla${n > 0 ? ' hc-nueva' : ''}">
      <header class="hc-cabecera">
        <img src="logo.png" class="hc-logo" alt="">
        <div class="hc-identidad">
          <div class="hc-empresa">${escaparTexto(ins.empresaNombre || 'Empresa')}</div>
          <div class="hc-unidad">Departamento de Seguridad y Salud Ocupacional</div>
        </div>
        <div class="hc-ref">Hoja de campo<br>SG-SST-FOR-013</div>
      </header>

      <div class="hc-titulo">
        ${escaparTexto(titulo)} · ${escaparTexto(subtitulo)}
        ${deCuantas > 1
          ? `<span class="hc-parte">hoja ${Math.floor(desde / COLUMNAS_POR_HOJA) + 1}
             de ${deCuantas}</span>` : ''}
      </div>

      <table class="hc-datos">
        <tr>
          <th>Fecha</th><td class="hc-linea"></td>
          <th>Inspecciona</th>
          <td class="${yo.sinDatos ? 'hc-linea' : ''}">${escaparTexto(yo.nombre)}</td>
        </tr>
        <tr>
          <th>Acompaña</th><td class="hc-linea" colspan="3"></td>
        </tr>
      </table>

      <table class="hc-tabla hc-tabla-rejilla">
        <colgroup>
          <col style="width:${anchoTexto}%">
          ${columnas.map(() => `<col style="width:${anchoCol}%">`).join('')}
          <col style="width:14%">
        </colgroup>
        <thead>
          <tr>
            <th class="hc-th-texto">Criterio de verificación</th>
            ${columnas.map((i) => `
              <th class="hc-th-codigo">
                <span class="hc-vertical">${escaparTexto(i.codigo || '—')}</span>
              </th>`).join('')}
            <th class="hc-th-obs">Observación</th>
          </tr>
        </thead>
        <tbody>${cuerpo}</tbody>
      </table>

      <div class="hc-leyenda">
        <b>Cómo anotar:</b>
        <span class="hc-clave">S</span> cumple ·
        <span class="hc-clave">N</span> no cumple ·
        <span class="hc-clave">/</span> no aplica
        ${hayNoAplica
          ? ' · <span class="hc-clave hc-clave-na"></span> no corresponde a esa instalación'
          : ''}
        ${pendientes.size > 0
          ? ' · <span class="hc-marca-previa">•</span> falló en la inspección anterior'
          : ''}
      </div>

      <table class="hc-referencia">
        <tr>
          ${columnas.map((i) => `
            <td>
              <b>${escaparTexto(i.codigo || '—')}</b>
              ${escaparTexto(i.esPieza ? i.nombreCorto : i.nombreBloque)}
            </td>`).join('')}
        </tr>
      </table>

      <div class="hc-pie">
        <div class="hc-firma">
          <div class="hc-firma-linea"></div>
          <div class="hc-firma-rotulo">Firma de quien inspecciona</div>
        </div>
        <div class="hc-firma">
          <div class="hc-firma-linea"></div>
          <div class="hc-firma-rotulo">Firma de quien acompaña</div>
        </div>
      </div>

      <p class="hc-nota">
        Anote en esta hoja durante el recorrido y traslade los resultados al
        sistema al regresar.
      </p>
    </div>`;
}

function construirHojasSueltas(marcadas, conNovedades) {
  /* Cada hoja es o bien una lista en blanco de un tipo, o bien
     la de una instalación concreta. Se unifican aquí para que
     el maquetado sea uno solo. */
  const hojas = marcadas.map((valor, n) => {
    const [clase, id] = valor.split(':');

    const inst = clase === 'inst'
      ? ins.instalaciones.find((i) => i.id === id)
      : null;

    const tipo = inst ? inst.tipo : id;
    const criterios = ins.criterios.filter((c) => c.tipo === tipo);
    if (criterios.length === 0) return '';

    const previas = new Map();
    if (inst && conNovedades) {
      ins.novedades
        .filter((x) => x.instalacion_id === inst.id)
        .forEach((x) => previas.set(x.criterio_id, x));
    }

    /* Altura de fila según cuántos criterios tenga la lista.

       Con una altura fija, cocina —veintiún criterios— se
       partía en dos páginas y lavabos —once— dejaba media
       hoja vacía. Repartiendo el espacio disponible, cada
       lista llena su página: las cortas con filas holgadas
       para escribir, las largas apuradas pero enteras. */
    const grupos = new Set(criterios.map((c) => c.grupo)).size;

    /* Se reserva margen: varios criterios son largos y ocupan
       dos líneas, así que la fila real crece por encima de la
       altura pedida. Redondear hacia abajo evita que la última
       fila empuje la tabla a una segunda página.

       El espacio parte de los 262 mm de hoja menos lo que
       ocupan cabecera, datos, firmas y nota. */
    const disponibleMm = 172 - grupos * 4.2;
    const altoPt = Math.max(13, Math.min(26,
      Math.floor(disponibleMm / criterios.length / 0.3528) - 6));

    let grupoPrevio = null;
    const cuerpo = criterios.map((c) => {
      const cab = c.grupo !== grupoPrevio
        ? `<tr><td colspan="5" class="hc-grupo">${escaparTexto(c.grupo)}</td></tr>`
        : '';
      grupoPrevio = c.grupo;

      const previa = previas.get(c.id);

      return cab + `
        <tr>
          <td class="hc-texto">
            ${escaparTexto(c.texto)}
            ${c.critico ? '<span class="hc-critico">crítico</span>' : ''}
            ${previa ? `
              <div class="hc-previa">Vez anterior:
                ${escaparTexto(previa.observacion || 'no cumplía')}
                ${previa.veces > 1 ? ` · ${previa.veces}.ª vez` : ''}
              </div>` : ''}
          </td>
          <td class="hc-casilla" style="height:${altoPt}pt"></td>
          <td class="hc-casilla"></td>
          <td class="hc-casilla"></td>
          <td class="hc-obs"></td>
        </tr>`;
    }).join('');

    return `
      <div class="hc-hoja${n > 0 ? ' hc-nueva' : ''}">
        <header class="hc-cabecera">
          <img src="logo.png" class="hc-logo" alt="">
          <div class="hc-identidad">
            <div class="hc-empresa">${escaparTexto(ins.empresaNombre || 'Empresa')}</div>
            <div class="hc-unidad">Departamento de Seguridad y Salud Ocupacional</div>
          </div>
          <div class="hc-ref">Hoja de campo<br>SG-SST-FOR-013</div>
        </header>

        <div class="hc-titulo">${escaparTexto(TIPOS[tipo] || tipo)}</div>

        <table class="hc-datos">
          <tr>
            <th>Sitio</th>
            <td colspan="3" class="${inst ? '' : 'hc-linea'}">
              ${inst ? escaparTexto(inst.nombre) : ''}
            </td>
          </tr>
          <tr>
            <th>Fecha</th><td class="hc-linea"></td>
            <th>Inspecciona</th><td class="hc-linea"></td>
          </tr>
          <tr>
            <th>Acompaña</th><td class="hc-linea"></td>
            <th>Responsable del área</th>
            <td class="${inst && inst.responsable ? '' : 'hc-linea'}">
              ${inst ? escaparTexto(inst.responsable || '') : ''}
            </td>
          </tr>
        </table>

        <table class="hc-tabla">
          <thead>
            <tr>
              <th class="hc-th-texto">Criterio de verificación</th>
              <th class="hc-th-casilla">Cumple</th>
              <th class="hc-th-casilla">No<br>cumple</th>
              <th class="hc-th-casilla">No<br>aplica</th>
              <th class="hc-th-obs">Observación</th>
            </tr>
          </thead>
          <tbody>${cuerpo}</tbody>
        </table>

        <div class="hc-pie">
          <div class="hc-firma">
            <div class="hc-firma-linea"></div>
            <div class="hc-firma-rotulo">Firma de quien inspecciona</div>
          </div>
          <div class="hc-firma">
            <div class="hc-firma-linea"></div>
            <div class="hc-firma-rotulo">Firma de quien acompaña</div>
          </div>
        </div>

        <p class="hc-nota">
          Anote en esta hoja durante el recorrido y traslade los resultados al
          sistema al regresar.
        </p>
      </div>`;
  }).join('');

  return hojas;
}

/* ============================================
   Informes
   ============================================ */

const OBJETIVO = {
  alimentacion:
    'Verificar las condiciones de salubridad, infraestructura y conservación de '
  + 'los servicios de cocina y comedor de la empresa, garantizando que la '
  + 'alimentación del personal se prepare y consuma en condiciones que no '
  + 'comprometan su salud.',
  sanitarios:
    'Verificar el estado, la dotación y las condiciones de higiene de los '
  + 'servicios higiénicos y lavabos, comprobando que existan en número '
  + 'suficiente, con separación por sexo y con los útiles de aseo que exige '
  + 'la normativa.'
};

const NORMATIVA = {
  alimentacion: [
    ['Código del Trabajo (2005), Art. 42',
     'obliga al empleador a proveer comedor con adecuada salubridad y ambientación en los centros de trabajo que lo requieran.'],
    ['D.E. 2393, Art. 37',
     'establece las condiciones de los comedores: local independiente, superficie suficiente, mobiliario e iluminación.'],
    ['A.M. MDT-2024-196, Anexo 1 · SP-02 y SP-03',
     'exige comedor y servicios de cocina con adecuada salubridad y almacenamiento de productos alimenticios.'],
    ['Ley Orgánica de Salud, Art. 100 y 118',
     'certificado de salud del personal manipulador y control sanitario de los ambientes de trabajo.'],
    ['Reglamento de alimentos · ARCSA',
     'condiciones de almacenamiento, conservación y manipulación de alimentos.'],
    ['Convenio 155 de la OIT (1981), Art. 16',
     'obliga a que los locales de trabajo no entrañen riesgo para la salud de los trabajadores.']
  ],
  sanitarios: [
    ['Código del Trabajo (2005), Art. 42',
     'obliga a mantener servicios higiénicos en condiciones adecuadas y con separación para hombres y mujeres.'],
    ['D.E. 2393, Art. 41',
     'fija la proporción de excusados, urinarios y lavabos según el número de trabajadores, y su separación por sexo.'],
    ['A.M. MDT-2024-196, Anexo 1 · SP-05 y SP-07',
     'exige servicios higiénicos en buenas condiciones y lavabos con útiles de aseo personal.'],
    ['Ley Orgánica de Salud, Art. 96 y 97',
     'abastecimiento de agua apta para consumo humano y disposición sanitaria de aguas residuales.'],
    ['Convenio 161 de la OIT (1985), Art. 5',
     'incluye la vigilancia del saneamiento entre las funciones de los servicios de salud en el trabajo.']
  ]
};

async function generarInforme(clave) {
  const g = GRUPOS_INFORME[clave];
  const filas = ins.inspecciones.filter((r) => g.tipos.includes(r.tipo));

  if (filas.length === 0) {
    alert(`No hay inspecciones de ${g.titulo.toLowerCase()} en este periodo.`);
    return;
  }

  fijarEscala(1);

  const de = firmante();
  const elabora = ins.destinatarios.find((d) => d.tipo === 'elabora');
  const principal = ins.destinatarios.find((d) => d.tipo === 'principal');
  const copias = ins.destinatarios.filter((d) => d.tipo === 'copia');

  const periodo = g.frecuencia === 'trimestral'
    ? nombreTrimestre(ins.periodo) : nombreMes(ins.periodo);

  /* Incumplimientos de estas inspecciones, y de ellos los que
     ya venían de antes. */
  const idsInsp = new Set(filas.map((r) => r.id));
  const hallazgos = ins.noConformes.filter((n) => idsInsp.has(n.inspeccion_id));
  const reincidentes = hallazgos.filter((n) => n.reincidente);

  const conformes = filas.reduce((s, r) => s + r.conformes, 0);
  const noConformes = filas.reduce((s, r) => s + r.no_conformes, 0);
  const media = filas.length
    ? Math.round(filas.reduce((s, r) => s + Number(r.porcentaje || 0), 0)
        / filas.length * 10) / 10
    : 0;

  const caratula = `
    ${membreteWord(ins.empresaNombre, ins.logo)}
    ${bandaTitulo('Informe de inspección · ' + g.titulo, periodo)}

    ${encabezadoMemo([
      { etiqueta: 'DE:',
        valor: elabora ? elabora.nombre : de.nombre,
        detalle: elabora ? (elabora.cargo || '') : de.cargo },
      principal ? { etiqueta: 'PARA:', valor: principal.nombre,
                    detalle: principal.cargo } : null,
      ...copias.map((c) => ({ etiqueta: 'C.C.:', valor: c.nombre, detalle: c.cargo })),
      { etiqueta: 'FECHA:', valor: periodo.toUpperCase() },
      { etiqueta: 'ASUNTO:',
        valor: 'INSPECCIÓN DE ' + g.titulo.toUpperCase() },
      { etiqueta: 'ANEXO 1:', valor: g.requisitos }
    ])}

    ${seccionDocumento('1. Objetivo')}
    <p style="text-align:justify;">${escaparTexto(OBJETIVO[clave])}</p>

    ${seccionDocumento('2. Marco normativo')}
    ${tablaWord(
      [{ titulo: 'DISPOSICIÓN', ancho: 32 }, { titulo: 'CONTENIDO', ancho: 68 }],
      NORMATIVA[clave].map(([t, c]) => [escaparTexto(t), escaparTexto(c)]))}

    ${seccionDocumento('3. Instalaciones inspeccionadas')}
    ${tablaWord(
      [
        { titulo: 'N°',           ancho: 6,  centrado: true },
        { titulo: 'INSTALACIÓN',  ancho: 30 },
        { titulo: 'TIPO',         ancho: 18 },
        { titulo: 'FECHA',        ancho: 14, centrado: true },
        { titulo: 'CONFORMIDAD',  ancho: 14, centrado: true },
        { titulo: 'RESPONSABLE',  ancho: 18 }
      ],
      filas.map((r, i) => [
        String(i + 1),
        escaparTexto(r.instalacion),
        escaparTexto(TIPOS[r.tipo] || r.tipo),
        r.fecha_inspeccion ? formatearFecha(r.fecha_inspeccion) : '—',
        r.porcentaje !== null ? r.porcentaje + '%' : '—',
        escaparTexto(r.responsable || '—')
      ]))}

    ${seccionDocumento('4. Resultados del periodo')}
    ${tablaWord(
      [{ titulo: 'CONCEPTO', ancho: 70 }, { titulo: 'CANTIDAD', ancho: 30, centrado: true }],
      [
        ['Instalaciones inspeccionadas', String(filas.length)],
        ['Criterios conformes', String(conformes)],
        ['Criterios no conformes', String(noConformes)],
        ['Conformidad media', media + '%'],
        ['Criterios no conformes detectados', String(hallazgos.length)],
        ['De ellos, reincidentes', String(reincidentes.length)]
      ])}`;

  /* Detalle: solo los incumplimientos. Repetir los criterios
     conformes de cada instalación llenaría el informe de
     filas sin novedad. */
  const detalle = `
    ${seccionDocumento('5. Detalle por instalación')}
    <p style="text-align:justify;">
      Se detallan los criterios no conformes de cada instalación. Los criterios
      verificados y conformes no se listan; su número consta en el encabezado
      de cada bloque.
    </p>

    ${filas.map((r) => {
      const lineas = (ins.detalle[r.id] || []);
      const malos = lineas.filter((l) => l.resultado === 'no_conforme');

      return `
        <div class="no-partir" style="margin-top:5pt;">
          <p style="font-size:9.5pt;font-weight:bold;margin:4pt 0 1pt;
                    background:#e6f0e6;padding:1pt 4pt;">
            ${escaparTexto(r.instalacion)}
            <span style="font-weight:normal;font-size:8pt;">
              · ${lineas.length} criterios verificados
              · ${r.conformes} conformes
              · ${r.fecha_inspeccion ? formatearFecha(r.fecha_inspeccion) : '—'}
              ${r.inspector ? ' · ' + escaparTexto(r.inspector) : ''}
            </span>
          </p>

          ${malos.length === 0
            ? '<p style="font-style:italic;font-size:8.5pt;margin:1pt 0 3pt;">'
              + 'Instalación conforme en todos los criterios verificados.</p>'
            : tablaWord(
                [
                  { titulo: 'N°',        ancho: 5,  centrado: true },
                  { titulo: 'ASPECTO',   ancho: 16 },
                  { titulo: 'CRITERIO NO CONFORME', ancho: 44 },
                  { titulo: 'OBSERVACIÓN', ancho: 35 }
                ],
                malos.map((l, i) => [
                  String(i + 1),
                  escaparTexto(l.grupo),
                  escaparTexto(l.criterio) + (l.critico ? ' (crítico)' : ''),
                  escaparTexto(l.observacion || '—')
                ]))}

          ${r.observacion
            ? `<p style="font-size:8.5pt;margin:1pt 0 3pt;"><b>Observación general:</b> ${
                escaparTexto(r.observacion)}</p>` : ''}
        </div>`;
    }).join('')}`;

  const seguimiento = hallazgos.length === 0 ? '' : `
    ${seccionDocumento('6. Hallazgos del periodo')}
    <p style="text-align:justify;">
      Criterios no conformes detectados durante las inspecciones, con el sitio
      exacto y lo observado.
    </p>
    ${tablaWord(
      [
        { titulo: 'DEPARTAMENTO', ancho: 15 },
        { titulo: 'ÁREA',         ancho: 15 },
        { titulo: 'INSTALACIÓN',  ancho: 16 },
        { titulo: 'ASPECTO',      ancho: 14 },
        { titulo: 'LO OBSERVADO', ancho: 40 }
      ],
      hallazgos.map((n) => [
        escaparTexto(n.departamento),
        escaparTexto(n.area || '—'),
        escaparTexto(TIPOS[n.tipo] || n.tipo),
        escaparTexto(n.grupo),
        escaparTexto(n.observacion || n.criterio)
          + (n.critico ? ' (crítico)' : '')
      ]))}`;

  /* Lo que se repite pesa distinto que lo que aparece por
     primera vez: va en su propio cuadro para que no se
     confunda entre las demás filas. */
  const insistencias = reincidentes.length === 0 ? '' : `
    ${seccionDocumento('7. Reincidencias')}
    <p style="text-align:justify;">
      Criterios que ya se habían encontrado no conformes en inspecciones
      anteriores y siguen sin corregirse. Se detallan aparte por su carácter
      persistente.
    </p>
    ${tablaWord(
      [
        { titulo: 'INSTALACIÓN',  ancho: 24 },
        { titulo: 'CRITERIO',     ancho: 38 },
        { titulo: 'LO OBSERVADO', ancho: 24 },
        { titulo: 'VECES',        ancho: 7,  centrado: true },
        { titulo: 'DESDE',        ancho: 7,  centrado: true }
      ],
      reincidentes.map((n) => [
        escaparTexto(n.instalacion),
        escaparTexto(n.criterio) + (n.critico ? ' (crítico)' : ''),
        escaparTexto(n.observacion || '—'),
        String(n.veces),
        n.desde ? n.desde.slice(0, 7) : '—'
      ]))}`;

  /* Una fotografía general por instalación, más una por cada
     hallazgo abierto: el informe crece solo cuando hay algo
     que mostrar. */
  /* Las secciones 6 y 7 aparecen solo si hay algo que
     contar; la numeración de las siguientes se ajusta. */
  let siguiente = 5 + (hallazgos.length ? 1 : 0) + (reincidentes.length ? 1 : 0);
  const nSeccion = (n) => String(siguiente + 1 + n);


  const recuadros = [];
  filas.forEach((r) => {
    recuadros.push({ pie: r.instalacion.toUpperCase(), alto: 64 });
  });
  hallazgos.forEach((n) => {
    recuadros.push({
      pie: 'HALLAZGO · ' + n.instalacion.toUpperCase(),
      alto: 64
    });
  });

  const parejas = [];
  for (let i = 0; i < recuadros.length; i += 2) {
    parejas.push(recuadros.slice(i, i + 2));
  }

  const evidencia = `
    ${seccionDocumento(nSeccion(0) + '. Evidencia fotográfica')}
    <p style="text-align:justify;">
      Registro fotográfico de las instalaciones inspeccionadas y de los
      incumplimientos detectados.
      <span style="font-size:8pt;color:#555555;">Al pegar cada imagen, ajústela
      al ancho del recuadro (8,5 cm) para conservar la distribución.</span>
    </p>
    <table style="width:100%;">
      ${parejas.map((par) => `
        <tr>
          ${par.map((x) => `
            <td style="width:50%;vertical-align:top;padding:1pt 3pt;">
              ${recuadroFoto(x.pie, x.alto)}
            </td>`).join('')}
          ${par.length === 1 ? '<td style="width:50%;"></td>' : ''}
        </tr>`).join('')}
    </table>`;

  const columnas = [
    { rotulo: 'Elaborado por:',
      nombre: elabora ? elabora.nombre : de.nombre,
      detalle: elabora ? (elabora.cargo || '') : de.cargo },
    { rotulo: 'Inspección realizada por:', nombre: de.nombre, detalle: de.cargo }
  ];

  const cierre = `
    <div class="no-partir">
      ${seccionDocumento(nSeccion(1) + '. Cierre del informe')}
      <p style="text-align:justify;">
        Se deja constancia de que la inspección de ${filas.length}
        ${filas.length === 1 ? 'instalación' : 'instalaciones'} correspondiente a
        ${escaparTexto(periodo)} fue realizada conforme a los criterios señalados.
        ${hallazgos.length > 0
          ? `Se detectaron ${hallazgos.length} criterio${hallazgos.length === 1 ? '' : 's'} `
            + 'no conforme' + (hallazgos.length === 1 ? '' : 's')
            + (reincidentes.length > 0
                ? `, de los cuales ${reincidentes.length} `
                  + (reincidentes.length === 1 ? 'ya se había detectado' : 'ya se habían detectado')
                  + ' en inspecciones anteriores.'
                : '.')
          : 'Todas las instalaciones resultaron conformes.'}
      </p>
      ${bloqueFirmas(columnas, 50)}
      <p style="font-size:6.5pt;color:#999999;text-align:right;margin-top:6pt;">
        NEXUS ${VERSION} · generado el ${new Date().toLocaleString('es-EC')}
      </p>
    </div>`;

  const html = envolverWord(
    caratula + detalle + seguimiento + insistencias + evidencia + cierre,
    'Inspección de ' + g.titulo + ' · ' + periodo,
    { superior: 15, inferior: 15, izquierdo: 28, derecho: 12 });

  descargarWord(html, `Inspeccion ${g.titulo} ${ins.periodo}`);
}

function firmante() {
  let p = ins.perfil;
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

/* ============================================
   Refresco y eventos
   ============================================ */

async function refrescar() {
  await cargarInstalaciones(ins.empresaId, ins.empresaNombre);
  pintarInstalaciones();
}

function mostrar(id, texto) {
  const $a = document.getElementById(id);
  if (!$a) return;
  $a.textContent = texto;
  $a.hidden = false;
}

function alertaNueva(t)      { mostrar('ins-alerta-nueva', t); }
function alertaInspeccion(t) { mostrar('ins-alerta-inspeccion', t); }
function alertaPiezas(t)     { mostrar('ins-alerta-piezas', t); }

/* ============================================
   Buscador de nómina · acompañante

   Se busca por código o por nombre porque en campo se conoce
   una cosa o la otra: el técnico sabe el nombre, la hoja
   impresa trae el código. Admite además texto libre, que es
   como se registra a un contratista que no está en nómina.
   ============================================ */

/**
 * Conecta un buscador de nómina a un campo de texto.
 *
 * Se busca por código, cédula o nombre porque en campo se
 * conoce una cosa o la otra: el técnico sabe el nombre, la
 * hoja impresa trae el código. El campo de destino sigue
 * admitiendo texto libre, que es como se registra a un
 * contratista que no está en nómina.
 *
 * @param {string}   idBuscador     campo donde se teclea
 * @param {string}   idSugerencias  contenedor de resultados
 * @param {function} alElegir       recibe el trabajador elegido
 */
function conectarBuscadorNomina(idBuscador, idSugerencias, alElegir) {
  const $b = document.getElementById(idBuscador);
  const $s = document.getElementById(idSugerencias);
  if (!$b || !$s) return;

  $b.addEventListener('input', () => {
    const texto = $b.value.trim().toLowerCase();

    if (texto.length < 2) { $s.hidden = true; return; }

    const hallados = ins.nomina.filter((t) => {
      const campo = `${t.codigo ?? ''} ${t.cedula ?? ''} ${t.nombre_completo}`
        .toLowerCase();
      return campo.includes(texto);
    }).slice(0, 10);

    if (hallados.length === 0) {
      $s.innerHTML = '<p class="ins-sug-vacia">Sin coincidencias · '
                   + 'puede escribirlo a mano arriba</p>';
      $s.hidden = false;
      return;
    }

    $s.innerHTML = '';
    hallados.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'ins-sugerencia';
      b.type = 'button';
      b.innerHTML = `<span class="codigo">${t.codigo ?? 's/c'}</span>
                     <span>${escapar(t.nombre_completo)}</span>
                     ${t.cargo
                       ? `<span class="ins-sug-cargo">${escapar(t.cargo)}</span>` : ''}`;
      b.addEventListener('click', () => {
        alElegir(t);
        $b.value = '';
        $s.hidden = true;
      });
      $s.appendChild(b);
    });
    $s.hidden = false;
  });
}

function traducir(error) {
  const m = error.message || '';
  if (error.code === '42501') return 'Su rol no tiene permiso para esta acción';
  if (m.includes('uq_instalacion')) {
    return 'Ya existe una instalación de ese tipo en ese departamento y área';
  }
  if (error.code === '23505') return 'Ese registro ya existe';
  return 'Error: ' + m;
}

function enIns(id, evento, fn) {
  const $e = document.getElementById(id);
  if ($e) $e.addEventListener(evento, fn);
}

function conectar() {
  enIns('ins-periodo', 'change', refrescar);
  enIns('ins-filtro-tipo', 'change', pintarTabla);

  document.querySelectorAll('[data-ins-vista]').forEach((b) => {
    b.addEventListener('click', () => {
      ins.vista = b.dataset.insVista;
      pintarInstalaciones();
    });
  });

  enIns('ins-btn-nueva', 'click', abrirNueva);
  enIns('ins-btn-guardar-nueva', 'click', guardarNueva);
  enIns('ins-btn-eliminar', 'click', eliminarInstalacion);
  enIns('ins_n_tipo', 'change', alternarCamposTipo);
  enIns('ins_n_departamento', 'input', sugerirCodigo);
  enIns('ins_n_area', 'input', sugerirCodigo);
  enIns('ins_n_codigo', 'input', (e) => { e.target.dataset.manual = '1'; });

  enIns('ins-btn-agregar-piezas', 'click', agregarPiezas);
  enIns('ins-btn-guardar-piezas', 'click', guardarPiezas);

  conectarBuscadorNomina('ins_acomp_buscar', 'ins_acomp_sugerencias', (t) => {
    document.getElementById('ins_acompanante').value = t.nombre_completo;
  });

  /* Al elegir de nómina se rellena también el cargo: teclearlo
     aparte es donde aparecen cargos que no coinciden con los
     de la ficha del trabajador. Queda editable por si el cargo
     que corresponde al acta es otro. */
  conectarBuscadorNomina('ins_resp_buscar', 'ins_resp_sugerencias', (t) => {
    document.getElementById('ins_n_responsable').value = t.nombre_completo;
    if (t.cargo) document.getElementById('ins_n_cargo').value = t.cargo;
  });

  enIns('ins-btn-guardar', 'click', () => guardarInspeccion(false));
  enIns('ins-btn-cerrar-inspeccion', 'click', () => guardarInspeccion(true));
  enIns('ins-btn-reabrir', 'click', reabrirInspeccion);

  enIns('ins-btn-hoja', 'click', imprimirHoja);
  enIns('ins-btn-campo', 'click', abrirSeleccionCampo);
  enIns('ins-btn-imprimir-campo', 'click', imprimirHojasCampo);

  enIns('ins-btn-alimentacion', 'click', () => generarInforme('alimentacion'));
  enIns('ins-btn-sanitarios', 'click', () => generarInforme('sanitarios'));

  document.querySelectorAll('[data-cierra]').forEach((b) => {
    const destino = b.dataset.cierra;
    if (!destino.startsWith('ins-modal')) return;
    b.addEventListener('click', () => {
      document.getElementById(destino).hidden = true;
    });
  });
}

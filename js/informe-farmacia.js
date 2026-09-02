/* ============================================
   NEXUS · informe-farmacia.js

   Informe mensual de medicamentos e insumos.

   Reemplaza la hoja de Excel que se venía llenando a mano:
   ciento sesenta filas transcritas cada mes desde el kardex,
   con el riesgo de error que eso tiene y sin forma de saber
   quién puso qué número.

   Las cuatro columnas del informe:

     ANTERIOR   saldo al cierre del mes previo
     INGRESOS   entradas del mes
     EGRESOS    salidas del mes
     ACTUAL     anterior + ingresos − egresos

   Todas salen del kardex. Ninguna se teclea.

   Dos decisiones que conviene no revertir:

   1 · El corte es el fin de mes, no el día en que se genera.
       Si el informe de julio se hace el 10 de agosto, cubre
       julio y nada más. La fecha de elaboración va aparte, en
       la portada. Si el corte se moviera al día de emisión,
       el ACTUAL de julio no coincidiría con el ANTERIOR de
       agosto y la cadena se rompería para siempre.

   2 · El informe se congela al guardarse.
       Se almacenan las filas, no una consulta. Si dentro de
       tres meses alguien corrige un movimiento de julio, el
       informe de julio sigue diciendo lo que decía el papel
       que se firmó.
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { sesionActual } from './auth.js?v=11';
import { escapar, formatearFecha } from './utils.js?v=11';
import { alCrear } from './autoria.js?v=1';
import { imprimirHoja } from './impresion.js?v=11';
import { redactar } from './ia.js?v=1';
import { logoEmpresa } from './logo-empresa.js';

const VERSION = 'v11';
console.info('NEXUS · informe-farmacia', VERSION);

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/* Tipos de movimiento que suman. Lo que no está aquí, resta.
   Se declara así y no al revés porque las salidas se
   multiplican con el tiempo —bajas por caducidad, por daño,
   por pérdida— y olvidar añadir una a la lista de egresos la
   convertiría silenciosamente en un ingreso. */
const ENTRADAS_MED = ['inventario_inicial', 'entrada_compra',
                      'entrada_donacion', 'ajuste_positivo'];
const ENTRADAS_INS = ['entrada', 'ajuste_positivo'];

/* ============================================
   Textos del informe

   Son EDITABLES y se guardan con cada informe, no en una
   plantilla aparte. Si la normativa cambia el año que viene,
   los informes de este año tienen que seguir citando lo que
   citaban cuando se firmaron: un documento firmado no se
   reescribe solo.

   Estos son puntos de partida. Revíselos y ajústelos a lo que
   realmente aplica a su operación antes de firmar el primero.
   ============================================ */

const TEXTOS = {
  objetivo:
    'Presentar el movimiento mensual de medicamentos e insumos médicos del '
  + 'servicio médico de la empresa, detallando las existencias del periodo '
  + 'anterior, los ingresos y egresos registrados durante el mes y el saldo '
  + 'resultante, a fin de mantener el control del inventario y sustentar la '
  + 'reposición oportuna de los artículos requeridos para la atención del '
  + 'personal.',

  alcance:
    'Comprende la totalidad de medicamentos e insumos médicos registrados en '
  + 'el servicio médico de la empresa durante el periodo informado. Las cifras '
  + 'provienen del kardex del sistema y corresponden al corte del último día '
  + 'del mes reportado.',

  normativa:
    'Código del Trabajo, artículo 430, sobre la asistencia médica y '
  + 'farmacéutica a cargo del empleador.\n'
  + 'Ley Orgánica de Salud, respecto del manejo y control de medicamentos.\n'
  + 'Acuerdo Ministerial N.° 00004-2026, Ministerio de Salud Pública, '
  + 'Reglamento de los Servicios Integrales de Salud en el Trabajo (SISAT), '
  + 'que deroga el Acuerdo Ministerial N.° 1404 (Reglamento para el '
  + 'Funcionamiento de los Servicios Médicos de Empresa).\n'
  + 'Decreto Ejecutivo 255, Reglamento de Seguridad y Salud en el Trabajo.',

  metodologia:
    'La información se obtiene del kardex del sistema NEXUS. La columna '
  + 'ANTERIOR corresponde al saldo acumulado al cierre del mes previo; '
  + 'INGRESOS y EGRESOS, a la suma de los movimientos registrados dentro del '
  + 'mes informado; y ACTUAL, al resultado de anterior más ingresos menos '
  + 'egresos. Se incluyen todos los artículos activos del catálogo, incluidos '
  + 'aquellos sin movimiento en el periodo.',

  conclusion:
    'Se mantiene el control del inventario de medicamentos e insumos médicos '
  + 'del servicio médico de la empresa. Se recomienda gestionar la reposición '
  + 'de los artículos cuyo saldo se encuentra por debajo del mínimo '
  + 'establecido.'
};

/* Supabase devuelve como máximo mil filas por consulta.

   Hoy el kardex tiene ciento cincuenta y nueve movimientos y
   el problema no se nota, pero crece cada mes: el día que
   pase de mil, el informe empezaría a dar cifras incompletas
   SIN AVISAR de nada. Un error que se manifiesta como un
   número plausible es el peor de todos, así que se pagina
   desde ahora.

   @param consulta  función que recibe (desde, hasta) y
                    devuelve la consulta ya acotada
*/
async function traerTodo(consulta) {
  const TAMANO = 1000;
  const filas = [];

  for (let desde = 0; ; desde += TAMANO) {
    const { data, error } = await consulta(desde, desde + TAMANO - 1);
    if (error) throw error;

    filas.push(...(data || []));
    if (!data || data.length < TAMANO) return filas;
  }
}

const inf = {
  empresaId: null,
  empresaNombre: '',
  logoUrl: 'logo.png',
  periodo: null,      // primer día del mes que cubre
  logo: null,
  informes: [],       // los ya emitidos
  ultimo: null,       // lo calculado, a la espera de guardarse
  revisor: null       // quien revisa: jefe del departamento
};

/* Quien revisa el informe es quien encabeza el departamento, y
   no cambia con la sesión. Se lee de la misma tabla que usa el
   informe de botiquines para su firma fija, de modo que los
   dos documentos nombren a la misma persona: si mañana cambia
   el responsable, se corrige en un sitio y no en dos. */
async function cargarRevisor() {
  const { data, error } = await supabase
    .from('botiquin_destinatarios')
    .select('nombre, cargo')
    .eq('tipo', 'elabora')
    .eq('activo', true)
    .maybeSingle();

  if (error || !data) {
    console.warn('NEXUS · informe: no hay firmante de revisión configurado '
               + '(botiquin_destinatarios con tipo = elabora).');
    inf.revisor = null;
    return;
  }
  inf.revisor = { nombre: data.nombre, cargo: data.cargo || '' };
}

/* Lee los textos del formulario, cayendo al valor por defecto
   si el campo quedó vacío: un informe sin objetivo ni marco
   normativo no es un informe técnico. */
function textosActuales() {
  const leer = (id, porDefecto) => {
    const $t = document.getElementById(id);
    const v = $t ? $t.value.trim() : '';
    return v || porDefecto;
  };
  return {
    objetivo:    leer('inf-objetivo',    TEXTOS.objetivo),
    alcance:     leer('inf-alcance',     TEXTOS.alcance),
    normativa:   leer('inf-normativa',   TEXTOS.normativa),
    metodologia: TEXTOS.metodologia,
    /* Vacío es válido: el informe sale sin análisis y sigue
       siendo un informe. Por eso no cae a un texto por
       defecto como los demás. */
    analisis:    (document.getElementById('inf-analisis')?.value || '').trim(),
    conclusion:  leer('inf-conclusion',  TEXTOS.conclusion)
  };
}

function pintarTextosPorDefecto() {
  const poner = (id, valor) => {
    const $t = document.getElementById(id);
    if ($t && !$t.value.trim()) $t.value = valor;
  };
  poner('inf-objetivo',   TEXTOS.objetivo);
  poner('inf-alcance',    TEXTOS.alcance);
  poner('inf-normativa',  TEXTOS.normativa);
  poner('inf-conclusion', TEXTOS.conclusion);
}

/* ============================================
   Arranque
   ============================================ */

export async function iniciarInforme(empresaId, empresaNombre) {
  inf.empresaId = empresaId;
  inf.empresaNombre = empresaNombre || '';
  inf.logoUrl = await logoEmpresa(empresaId);

  const $p = document.getElementById('inf-periodo');
  if ($p && !$p.value) $p.value = mesAnterior();

  pintarTextosPorDefecto();
  cargarRevisor();
  cargarInformes().then(pintarInformes);
}

/* Por defecto, el mes pasado: el informe se hace cuando el
   mes ya cerró. Ofrecer el mes en curso invitaría a emitir un
   informe incompleto que después habría que rehacer. */
function mesAnterior() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function limitesDelMes(valor) {
  const [a, m] = valor.split('-').map(Number);
  const inicio = new Date(Date.UTC(a, m - 1, 1));
  const fin = new Date(Date.UTC(a, m, 0));      // día 0 del siguiente = último del actual
  return {
    inicio: inicio.toISOString().slice(0, 10),
    fin: fin.toISOString().slice(0, 10),
    nombre: `${MESES[m - 1]} de ${a}`
  };
}

/* ============================================
   Cálculo
   ============================================ */

/**
 * Arma las filas del informe de medicamentos.
 *
 * Se listan TODOS los medicamentos activos, incluidos los que
 * quedaron en cero y no se movieron: el informe es un
 * inventario, y un artículo que desaparece de la lista se lee
 * como que ya no existe, no como que está agotado.
 */
async function filasMedicamentos(inicio, fin) {
  const [cat, movimientos] = await Promise.all([
    supabase.from('v_stock_medicamentos')
      .select('id, nombre_generico, nombre_comercial, concentracion, forma')
      .eq('empresa_id', inf.empresaId).eq('activo', true)
      /* Ordenado por comercial, que es como se busca la fila
         en el papel. Los que no llevan marca caen al final. */
      .order('nombre_comercial', { nullsFirst: false })
      .order('nombre_generico'),
    traerTodo((d, h) => supabase.from('kardex')
      .select('medicamento_id, tipo, cantidad, fecha')
      .eq('empresa_id', inf.empresaId)
      .lte('fecha', fin)
      .order('fecha')
      .range(d, h))
  ]);

  if (cat.error) throw new Error('No se pudo leer el catálogo de medicamentos');

  const acumulado = new Map();
  movimientos.forEach((k) => {
    const signo = ENTRADAS_MED.includes(k.tipo) ? 1 : -1;
    const cant = Number(k.cantidad) || 0;
    const x = acumulado.get(k.medicamento_id)
           || { anterior: 0, ingresos: 0, egresos: 0 };

    if (k.fecha < inicio) {
      x.anterior += signo * cant;
    } else if (signo > 0) {
      x.ingresos += cant;
    } else {
      x.egresos += cant;
    }
    acumulado.set(k.medicamento_id, x);
  });

  return (cat.data || []).map((m, i) => {
    const x = acumulado.get(m.id) || { anterior: 0, ingresos: 0, egresos: 0 };
    return {
      n: i + 1,
      /* El comercial encabeza y el generico va detras entre
         parentesis.

         Es el nombre impreso en la caja, y quien coteja el
         informe contra la bodega tiene las cajas delante, no
         el vademecum. El generico se conserva porque es lo
         que identifica el principio activo y lo que hace
         comparable el informe entre marcas distintas: sin el,
         un cambio de proveedor pareceria un articulo nuevo. */
      nombre: (m.nombre_comercial
        ? `${m.nombre_comercial} (${m.nombre_generico} ${m.concentracion || ''})`
        : `${m.nombre_generico} ${m.concentracion || ''}`)
        .replace(/\s+/g, ' ').replace(' )', ')').trim().toUpperCase(),
      presentacion: (m.forma || '').toUpperCase(),
      anterior: x.anterior,
      ingresos: x.ingresos,
      egresos: x.egresos,
      actual: x.anterior + x.ingresos - x.egresos
    };
  });
}

/**
 * Lo mismo para insumos.
 *
 * El kardex de insumos no tiene columna de fecha propia: se
 * usa la de creación del movimiento. Es suficiente porque
 * estos se registran el día que ocurren, pero conviene
 * saberlo: un movimiento de julio anotado en agosto contaría
 * como de agosto.
 */
async function filasInsumos(inicio, fin) {
  const [cat, mov] = await Promise.all([
    /* La columna es `unidad`, no `presentacion`: en insumos la
       presentación ES la unidad de despacho (frasco, funda,
       par). */
    supabase.from('insumos')
      .select('id, nombre, unidad, stock_disponible')
      .eq('empresa_id', inf.empresaId).eq('activo', true)
      .order('nombre'),

    /* TODOS los movimientos, sin filtrar por fecha.
       Hacen falta los posteriores al periodo para deducir el
       saldo inicial; ver más abajo. */
    traerTodo((d, h) => supabase.from('insumos_kardex')
      .select('insumo_id, tipo, cantidad, creado_en')
      .order('creado_en')
      .range(d, h))
  ]);

  if (cat.error) throw new Error('No se pudo leer el catálogo de insumos');

  const suyos = new Set((cat.data || []).map((i) => i.id));

  /* Se acumulan tres cosas por insumo:
       total     todos los movimientos de la historia
       anterior  los ocurridos antes del mes informado
       mes       ingresos y egresos dentro del mes */
  const acum = new Map();
  const dame = (id) => {
    if (!acum.has(id)) {
      acum.set(id, { total: 0, anterior: 0, ingresos: 0, egresos: 0 });
    }
    return acum.get(id);
  };

  mov.filter((k) => suyos.has(k.insumo_id)).forEach((k) => {
    const signo = ENTRADAS_INS.includes(k.tipo) ? 1 : -1;
    const cant = Number(k.cantidad) || 0;
    const fecha = String(k.creado_en).slice(0, 10);
    const x = dame(k.insumo_id);

    x.total += signo * cant;

    if (fecha < inicio) {
      x.anterior += signo * cant;
    } else if (fecha <= fin) {
      if (signo > 0) x.ingresos += cant; else x.egresos += cant;
    }
  });

  return (cat.data || []).map((s, i) => {
    const x = acum.get(s.id) || { total: 0, anterior: 0, ingresos: 0, egresos: 0 };
    const declarado = Number(s.stock_disponible) || 0;

    /* SALDO INICIAL NO REGISTRADO.

       Los insumos llevan el stock escrito directamente en la
       ficha desde antes de que existiera el kardex de
       insumos, así que sumar solo los movimientos daba cero
       en todas las columnas aunque la bodega estuviera llena.

       La diferencia entre lo que dice la ficha hoy y lo que
       explican todos los movimientos registrados es
       precisamente el inventario con el que se arrancó y que
       nadie llegó a anotar. Se le atribuye al saldo anterior,
       que es donde corresponde: es existencia previa al
       periodo, no un ingreso del mes.

       Con esto el ACTUAL del mes en curso coincide siempre
       con la ficha, y los meses pasados quedan coherentes
       entre sí.

       Los medicamentos no necesitan esto: su stock se calcula
       desde el kardex, así que la diferencia es cero. */
    const base = declarado - x.total;
    const anterior = base + x.anterior;

    return {
      n: i + 1,
      nombre: (s.nombre || '').toUpperCase(),
      presentacion: (s.unidad || 'UNIDAD').toUpperCase(),
      anterior,
      ingresos: x.ingresos,
      egresos: x.egresos,
      actual: anterior + x.ingresos - x.egresos,
      declarado
    };
  });
}

/* ============================================
   Generar
   ============================================ */

export async function generarInformeMensual() {
  const $p = document.getElementById('inf-periodo');
  if (!$p.value) return avisar('Elija el mes del informe');
  if (!inf.empresaId) return avisar('Elija primero una empresa');

  const { inicio, fin, nombre } = limitesDelMes($p.value);

  const $btn = document.getElementById('inf-btn-generar');
  $btn.disabled = true;

  try {
    /* Las dos tablas se calculan a la vez: el informe es uno
       solo y no tiene sentido poder emitir la mitad. */
    const [medicamentos, insumos] = await Promise.all([
      filasMedicamentos(inicio, fin),
      filasInsumos(inicio, fin)
    ]);

    if (medicamentos.length === 0 && insumos.length === 0) {
      $btn.disabled = false;
      return avisar('No hay artículos activos en el catálogo.');
    }

    /* Red de seguridad. Con el saldo inicial deducido, el
       actual del mes en curso debería coincidir siempre con
       la ficha; si no coincide, hay algo que no entendemos y
       vale más avisar que callar. En meses pasados la
       diferencia es normal y no se comprueba. */
    const desajustes = fin >= hoy()
      ? insumos.filter((f) => f.actual !== f.declarado)
      : [];

    inf.periodo = inicio;
    inf.ultimo = { medicamentos, insumos, inicio, fin, nombre };

    pintarPrevia(inf.ultimo, desajustes);
    document.getElementById('inf-btn-guardar').hidden = false;
    document.getElementById('inf-btn-descargar').hidden = false;

  } catch (e) {
    avisar(e.message);
  }

  $btn.disabled = false;
}

const hoy = () => new Date().toISOString().slice(0, 10);

function pintarPrevia(datos, desajustes) {
  const { medicamentos, insumos, nombre } = datos;

  document.getElementById('inf-previa-titulo').textContent =
    'Informe mensual · ' + nombre;

  const ing = [...medicamentos, ...insumos].reduce((s, f) => s + f.ingresos, 0);
  const egr = [...medicamentos, ...insumos].reduce((s, f) => s + f.egresos, 0);

  document.getElementById('inf-resumen').textContent =
    `${medicamentos.length} medicamentos · ${insumos.length} insumos · `
    + `${ing} unidades ingresadas · ${egr} egresadas`;

  const $a = document.getElementById('inf-desajuste');
  if (desajustes.length > 0) {
    $a.innerHTML = `<b>${desajustes.length} insumo${desajustes.length === 1 ? '' : 's'} `
      + `no cuadra${desajustes.length === 1 ? '' : 'n'}.</b> `
      + 'Los movimientos registrados no explican el stock que figura en la ficha: '
      + escapar(desajustes.slice(0, 5).map((d) =>
          `${d.nombre} (movimientos ${d.actual}, ficha ${d.declarado})`).join('; '))
      + (desajustes.length > 5 ? ' y otros.' : '.')
      + ' Suele deberse a stocks corregidos a mano antes de que existiera el ajuste '
      + 'de inventario. El informe usa la cifra de los movimientos, que es la que '
      + 'se puede justificar.';
    $a.hidden = false;
  } else {
    $a.hidden = true;
  }

  pintarTabla('inf-cuerpo-med', medicamentos);
  pintarTabla('inf-cuerpo-ins', insumos);
  document.getElementById('inf-previa').hidden = false;
}

/* Se escribe 0 y no un guion.

   El guion es la convención del resto del sistema para «no
   hay dato», pero en un informe de inventario el cero SÍ es
   un dato: significa que ese mes no se movió nada, y es lo
   que va firmado en el documento. Además el Word ya imprimía
   0, así que la pantalla decía una cosa y el papel otra.
   El cero va atenuado para que las filas con movimiento
   sigan saltando a la vista. */
function pintarTabla(idCuerpo, filas) {
  const $c = document.getElementById(idCuerpo);
  if (!$c) return;
  $c.innerHTML = '';

  filas.forEach((f) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="celda-centro celda-tenue">${f.n}</td>
      <td>${escapar(f.nombre)}</td>
      <td class="celda-tenue">${escapar(f.presentacion)}</td>
      <td class="celda-centro">${f.anterior}</td>
      <td class="celda-centro${f.ingresos ? '' : ' celda-tenue'}">${f.ingresos}</td>
      <td class="celda-centro${f.egresos ? '' : ' celda-tenue'}">${f.egresos}</td>
      <td class="celda-centro"><strong>${f.actual}</strong></td>
    `;
    $c.appendChild(tr);
  });
}

/* ============================================
   Guardar
   ============================================ */

export async function guardarInforme() {
  if (!inf.ultimo) return;
  const { medicamentos, insumos, inicio, nombre } = inf.ultimo;

  const perfil = sesionActual();
  const quien = perfil
    ? [perfil.titulo, perfil.nombres, perfil.apellidos].filter(Boolean).join(' ').trim()
    : null;

  const $btn = document.getElementById('inf-btn-guardar');
  $btn.disabled = true;

  const todas = [...medicamentos, ...insumos];

  /* upsert y no insert: rehacer el informe de un mes debe
     sustituir al anterior. Dos informes del mismo mes con
     cifras distintas es peor que ninguno. */
  const { error } = await supabase.from('informes_farmacia').upsert(
    alCrear({
      empresa_id: inf.empresaId,
      clase: 'mensual',
      periodo: inicio,
      elaborado_por: quien || 'No identificado',
      elaborado_cargo: perfil?.cargo || null,
      elaborado_el: hoy(),
      lineas: todas.length,
      total_ingresos: todas.reduce((s, f) => s + f.ingresos, 0),
      total_egresos: todas.reduce((s, f) => s + f.egresos, 0),
      detalle: { medicamentos, insumos },
      textos: textosActuales(),
      revisor: inf.revisor
    }),
    { onConflict: 'empresa_id,clase,periodo' });

  $btn.disabled = false;

  if (error) return avisar('No se pudo guardar: ' + error.message);

  avisar(`Informe de ${nombre} guardado.`, true);
  await cargarInformes();
  pintarInformes();
}

async function cargarInformes() {
  if (!inf.empresaId) { inf.informes = []; return; }

  const { data, error } = await supabase
    .from('v_informes_farmacia').select('*')
    .eq('empresa_id', inf.empresaId)
    .order('periodo', { ascending: false })
    .limit(24);

  if (error) {
    console.warn('NEXUS · informes: falta ejecutar 040_informes_farmacia.sql');
    inf.informes = [];
    return;
  }
  inf.informes = data || [];
}

/* Se muestran doce. Los anteriores siguen guardados: la lista
   se acorta por comodidad de lectura, no porque los informes
   caduquen. */
function pintarInformes() {
  const $c = document.getElementById('inf-cuerpo-historial');
  const $v = document.getElementById('inf-vacio-historial');
  if (!$c) return;

  $c.innerHTML = '';
  const lista = inf.informes.slice(0, 12);
  if ($v) $v.hidden = lista.length > 0;

  lista.forEach((r) => {
    const [a, m] = r.periodo.split('-').map(Number);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapar(MESES[m - 1])} ${a}</td>
      <td>${r.clase === 'mensual' ? 'Informe mensual'
           : r.clase === 'medicamentos' ? 'Solo medicamentos' : 'Solo insumos'}</td>
      <td>${escapar(r.elaborado_por || '—')}</td>
      <td>${escapar(formatearFecha(r.elaborado_el))}</td>
      <td class="celda-centro">${r.lineas}</td>
      <td class="celda-centro"></td>
    `;

    const btn = document.createElement('button');
    btn.className = 'boton-icono';
    btn.type = 'button';
    btn.textContent = 'Descargar';
    btn.title = 'Descarga el informe tal como se guardó';
    btn.addEventListener('click', () => descargarGuardado(r));
    tr.lastElementChild.appendChild(btn);

    $c.appendChild(tr);
  });

  const $n = document.getElementById('inf-cuenta-historial');
  if ($n) {
    $n.textContent = inf.informes.length > 12
      ? `Mostrando 12 de ${inf.informes.length} informes guardados`
      : (inf.informes.length ? `${inf.informes.length} informes guardados` : '—');
  }
}

/* Descarga la fotografía guardada, no un recálculo. Si el
   kardex cambió después, este documento sigue diciendo lo que
   decía el papel firmado. */
async function descargarGuardado(resumen) {
  const { data, error } = await supabase
    .from('informes_farmacia').select('detalle, textos, clase, revisor')
    .eq('id', resumen.id).maybeSingle();

  if (error || !data) return avisar('No se pudo recuperar el informe.');

  const [a, m] = resumen.periodo.split('-').map(Number);

  /* Los informes del esquema anterior guardaban una sola
     lista. Se reconocen porque el detalle es un arreglo y no
     un objeto con las dos tablas. */
  const d = Array.isArray(data.detalle)
    ? (data.clase === 'insumos'
        ? { medicamentos: [], insumos: data.detalle }
        : { medicamentos: data.detalle, insumos: [] })
    : data.detalle;

  await generarPdf({
    medicamentos: d.medicamentos || [],
    insumos: d.insumos || [],
    nombre: `${MESES[m - 1]} de ${a}`,
    quien: resumen.elaborado_por,
    cargo: resumen.elaborado_cargo,
    fecha: resumen.elaborado_el,
    textos: data.textos || TEXTOS,
    /* El revisor guardado con el informe, si lo hay. Los
       informes viejos no lo tienen y caen al vigente. */
    revisor: data.revisor || inf.revisor
  });
}

export async function descargarActual() {
  if (!inf.ultimo) return;
  const perfil = sesionActual();
  await generarPdf({
    medicamentos: inf.ultimo.medicamentos,
    insumos: inf.ultimo.insumos,
    nombre: inf.ultimo.nombre,
    quien: perfil
      ? [perfil.titulo, perfil.nombres, perfil.apellidos].filter(Boolean).join(' ').trim()
      : 'No identificado',
    cargo: perfil?.cargo || null,
    fecha: hoy(),
    textos: textosActuales(),
    revisor: inf.revisor
  });
}

/* ============================================
   El documento
   ============================================ */

/* ============================================
   El documento

   Sale en PDF, no en Word.

   Un .doc generado desde HTML depende de cómo lo interprete
   la versión de Word de cada computador: márgenes que se
   corren, tipografías que se sustituyen, tablas que se
   parten donde no deben. El informe se firma y se archiva
   tal cual, así que tiene que verse igual en todas partes.

   Se arma como HTML con reglas de impresión y se manda a
   imprimir: el navegador ofrece «Guardar como PDF» y el
   resultado es idéntico en cualquier equipo.
   ============================================ */

function construirDocumento({ medicamentos, insumos, nombre, quien, cargo, fecha, textos, revisor }) {
  const t = textos || TEXTOS;

  const parrafos = (texto) => String(texto || '')
    .split(/\n+/).map((x) => x.trim()).filter(Boolean)
    .map((x) => `<p>${escapar(x)}</p>`).join('');

  /* La normativa va como lista y no como párrafo corrido: son
     referencias que se consultan una por una, y en prosa hay
     que leerlas enteras para encontrar la que interesa. */
  const listaNormativa = String(t.normativa || '')
    .split(/\n+/).map((x) => x.trim()).filter(Boolean)
    .map((x) => `<li>${escapar(x)}</li>`).join('');

  const tabla = (rotulo, filas) => filas.length === 0
    ? '<p class="if-nota">No hay artículos registrados en el catálogo.</p>'
    : `<table class="if-tabla">
        <colgroup>
          <col style="width:5%"><col style="width:37%"><col style="width:16%">
          <col style="width:10.5%"><col style="width:10.5%">
          <col style="width:10.5%"><col style="width:10.5%">
        </colgroup>
        <thead>
          <tr>
            <th>N°</th><th class="if-izq">${rotulo}</th>
            <th class="if-izq">PRESENTACIÓN</th>
            <th>ANTERIOR</th><th>INGRESOS</th><th>EGRESOS</th><th>ACTUAL</th>
          </tr>
        </thead>
        <tbody>
          ${filas.map((f) => `<tr>
            <td>${f.n}</td>
            <td class="if-izq">${escapar(f.nombre)}</td>
            <td class="if-izq">${escapar(f.presentacion)}</td>
            <td>${f.anterior}</td>
            <td>${f.ingresos}</td>
            <td>${f.egresos}</td>
            <td class="if-fuerte">${f.actual}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

  const todas = [...medicamentos, ...insumos];
  const totalIng = todas.reduce((s, f) => s + Number(f.ingresos || 0), 0);
  const totalEgr = todas.reduce((s, f) => s + Number(f.egresos || 0), 0);

  const anio = String(fecha).slice(0, 4);

  return `
    <!-- ===== Portada ===== -->
    <section class="if-portada">
      <div class="if-portada-banda"></div>

      <div class="if-portada-marca">
        <img src="${escapar(inf.logoUrl)}" class="if-portada-logo" alt="">
      </div>

      <div class="if-portada-centro">
        <p class="if-portada-unidad">Unidad de Seguridad y Salud Ocupacional</p>
        <p class="if-portada-servicio">Servicios Médicos de la Empresa</p>

        <div class="if-portada-regla"></div>

        <h1 class="if-portada-titulo">
          Informe mensual de<br>medicamentos e insumos médicos
        </h1>

        <p class="if-portada-mes">${escapar(nombre)}</p>

        <div class="if-portada-regla"></div>

        <p class="if-portada-empresa">${escapar(inf.empresaNombre || 'Empresa')}</p>
      </div>

      <div class="if-portada-pie">
        <table class="if-portada-datos">
          <tr><th>Elaborado por</th><td>${escapar(quien || 'No identificado')}</td></tr>
          ${cargo ? `<tr><th>Cargo</th><td>${escapar(cargo)}</td></tr>` : ''}
          <tr><th>Revisado por</th><td>${escapar(revisor?.nombre || 'Por definir')}</td></tr>
          <tr><th>Fecha de elaboración</th><td>${escapar(formatearFecha(fecha))}</td></tr>
          <tr><th>Periodo informado</th><td>${escapar(nombre)}</td></tr>
        </table>
        <p class="if-portada-ref">SG-SST-FOR-021 · ${escapar(anio)}</p>
      </div>

      <div class="if-portada-banda if-portada-banda-baja"></div>
    </section>

    <!-- ===== Contenido ===== -->
    <section class="if-contenido">

      <header class="if-membrete">
        <img src="${escapar(inf.logoUrl)}" class="if-membrete-logo" alt="">
        <div class="if-membrete-texto">
          <strong>${escapar(inf.empresaNombre || 'Empresa')}</strong><br>
          Unidad de Seguridad y Salud Ocupacional · Servicios Médicos
        </div>
        <div class="if-membrete-ref">
          Informe mensual<br>${escapar(nombre)}
        </div>
      </header>

      <h2 class="if-seccion">1. Objetivo</h2>
      ${parrafos(t.objetivo)}

      <h2 class="if-seccion">2. Alcance</h2>
      ${parrafos(t.alcance)}

      <h2 class="if-seccion">3. Marco normativo</h2>
      <ul class="if-lista">${listaNormativa}</ul>

      <h2 class="if-seccion">4. Metodología</h2>
      ${parrafos(t.metodologia)}

      <h2 class="if-seccion">5. Medicamentos</h2>
      ${tabla('NOMBRE DEL MEDICAMENTO', medicamentos)}

      <h2 class="if-seccion">6. Insumos médicos</h2>
      ${tabla('DESCRIPCIÓN', insumos)}

      <h2 class="if-seccion">7. Resumen del periodo</h2>
      <p>
        Durante ${escapar(nombre)} se verificaron
        <strong>${medicamentos.length}</strong> medicamentos y
        <strong>${insumos.length}</strong> insumos médicos, con un total de
        <strong>${totalIng}</strong> unidades ingresadas y
        <strong>${totalEgr}</strong> unidades egresadas.
      </p>
      ${parrafos(t.analisis)}

      <h2 class="if-seccion">8. Conclusión</h2>
      ${parrafos(t.conclusion)}

      <!-- Dos firmas: quien lo hizo y quien lo revisa.

           Elabora el profesional que tiene la sesión abierta;
           revisa quien encabeza el departamento, que no
           cambia. Con una sola firma no se distinguía quién
           había hecho el trabajo de quién respondía por él. -->
      <!-- Sin data-firmas a proposito: impresion.js reconoce
           ese atributo e inyecta cinco centimetros de espacio
           antes del bloque. Aqui sobraba, y con ese empujon
           las firmas ya no cabian en la pagina y salian solas
           en una hoja en blanco. El aire lo pone el CSS. -->
      <div class="if-firmas">
        <div class="if-firma">
          <div class="if-firma-linea"></div>
          <p class="if-firma-rotulo">Elaborado por</p>
          <p class="if-firma-nombre">${escapar(quien || 'No identificado')}</p>
          ${cargo ? `<p class="if-firma-cargo">${escapar(cargo)}</p>` : ''}
        </div>
        <div class="if-firma">
          <div class="if-firma-linea"></div>
          <p class="if-firma-rotulo">Revisado por</p>
          <p class="if-firma-nombre">${escapar(revisor?.nombre || 'Por definir')}</p>
          ${revisor?.cargo
            ? `<p class="if-firma-cargo">${escapar(revisor.cargo)}</p>` : ''}
        </div>
      </div>

    </section>`;
}

async function generarPdf(datos) {
  const $z = document.getElementById('inf-impresion');
  if (!$z) {
    avisar('Falta actualizar la página en el servidor para poder imprimir.');
    return;
  }

  $z.innerHTML = construirDocumento(datos);

  /* El aviso sale ANTES de abrir el diálogo: una vez abierto,
     el navegador bloquea la página y ya no se puede decir
     nada. Los gráficos de fondo vienen desactivados en Chrome
     y sin ellos la portada pierde las bandas y el sombreado
     de las cabeceras. */
  avisar('En el diálogo de impresión: active «Gráficos de fondo» para que '
       + 'salgan los colores, y desactive «Encabezado y pie de página» para '
       + 'que Chrome no estampe la fecha y la dirección web.', true);

  await imprimirHoja('inf-impresion', 'imprimiendo-informe',
    `Informe farmacia · ${datos.nombre}`);
}

/* ============================================
   Asistente de redacción

   Rellena el análisis del periodo. Lo que se envía son cifras
   y nombres de artículo: ni un trabajador, ni una cédula, ni
   un diagnóstico. El informe de farmacia no los contiene, y
   este resumen es lo único que sale del navegador.

   El texto se puede corregir antes de generar el PDF, y el
   botón «Generar informe» funciona igual si el campo queda
   vacío: el asistente ayuda, no hace falta.
   ============================================ */

export async function redactarAnalisis() {
  if (!inf.ultimo) {
    return avisar('Genere primero el informe: el análisis se escribe sobre '
                + 'las cifras del mes.');
  }

  const { medicamentos, insumos, nombre } = inf.ultimo;
  const $btn = document.getElementById('inf-btn-ia');
  const $texto = document.getElementById('inf-analisis');

  $btn.disabled = true;
  const rotuloPrevio = $btn.textContent;
  $btn.textContent = 'Redactando…';

  /* Se envían las cifras del periodo y solo los artículos que
     se movieron. Mandar noventa filas en cero no aporta nada
     al análisis y multiplica el costo de cada llamada. */
  const conMovimiento = (lista) => lista
    .filter((f) => f.ingresos > 0 || f.egresos > 0)
    .map((f) => ({
      articulo: f.nombre,
      presentacion: f.presentacion,
      anterior: f.anterior,
      ingresos: f.ingresos,
      egresos: f.egresos,
      actual: f.actual
    }));

  const sinStock = (lista) => lista
    .filter((f) => f.actual === 0 && f.egresos > 0)
    .map((f) => f.nombre);

  const datos = {
    periodo: nombre,
    medicamentos: {
      total_catalogo: medicamentos.length,
      con_movimiento: conMovimiento(medicamentos),
      agotados_tras_consumo: sinStock(medicamentos),
      sin_movimiento: medicamentos.filter(
        (f) => f.ingresos === 0 && f.egresos === 0).length
    },
    insumos: {
      total_catalogo: insumos.length,
      con_movimiento: conMovimiento(insumos),
      agotados_tras_consumo: sinStock(insumos),
      sin_movimiento: insumos.filter(
        (f) => f.ingresos === 0 && f.egresos === 0).length
    }
  };

  const r = await redactar('redactar-analisis', datos);

  $btn.disabled = false;
  $btn.textContent = rotuloPrevio;

  if (!r.ok) return avisar(r.mensaje);

  $texto.value = r.texto;
  document.getElementById('inf-panel-textos').open = true;
  $texto.focus();

  avisar('Borrador listo. Léalo entero y corrija lo que haga falta antes '
       + 'de generar el PDF: usted lo firma.', true);
}

/* ============================================
   Avisos
   ============================================ */

function avisar(texto, exito = false) {
  const $a = document.getElementById('inf-alerta');
  if (!$a) return alert(texto);
  $a.textContent = texto;
  $a.className = exito ? 'alerta alerta-ok' : 'alerta';
  $a.hidden = false;
  setTimeout(() => { $a.hidden = true; }, 6000);
}

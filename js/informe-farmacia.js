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
import {
  fijarEscala, envolverWord, descargarWord, bloqueFirmas,
  seccionDocumento, tablaWord, logoEnBase64
} from './documento.js?v=11';

const VERSION = 'v2';
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
  + 'Reglamento para el Funcionamiento de los Servicios Médicos de Empresa '
  + '(Acuerdo Ministerial N.° 1404).\n'
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

const inf = {
  empresaId: null,
  empresaNombre: '',
  periodo: null,      // primer día del mes que cubre
  logo: null,
  informes: [],       // los ya emitidos
  ultimo: null        // lo calculado, a la espera de guardarse
};

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

export function iniciarInforme(empresaId, empresaNombre) {
  inf.empresaId = empresaId;
  inf.empresaNombre = empresaNombre || '';

  const $p = document.getElementById('inf-periodo');
  if ($p && !$p.value) $p.value = mesAnterior();

  pintarTextosPorDefecto();
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
  const [cat, mov] = await Promise.all([
    supabase.from('v_stock_medicamentos')
      .select('id, nombre_generico, nombre_comercial, concentracion, forma')
      .eq('empresa_id', inf.empresaId).eq('activo', true)
      .order('nombre_generico'),
    supabase.from('kardex')
      .select('medicamento_id, tipo, cantidad, fecha')
      .eq('empresa_id', inf.empresaId)
      .lte('fecha', fin)
  ]);

  if (cat.error) throw new Error('No se pudo leer el catálogo de medicamentos');
  if (mov.error) throw new Error('No se pudo leer el kardex');

  const acumulado = new Map();
  (mov.data || []).forEach((k) => {
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
      nombre: (m.nombre_generico + ' ' + (m.concentracion || '')).trim().toUpperCase(),
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
       par). Pedir una columna inexistente hacía fallar el
       informe entero. */
    supabase.from('insumos')
      .select('id, nombre, unidad, stock_disponible')
      .eq('empresa_id', inf.empresaId).eq('activo', true)
      .order('nombre'),
    supabase.from('insumos_kardex')
      .select('insumo_id, tipo, cantidad, creado_en')
      .lte('creado_en', fin + 'T23:59:59')
  ]);

  if (cat.error) throw new Error('No se pudo leer el catálogo de insumos');
  if (mov.error) throw new Error('No se pudo leer el kardex de insumos');

  const suyos = new Set((cat.data || []).map((i) => i.id));
  const acumulado = new Map();

  (mov.data || []).filter((k) => suyos.has(k.insumo_id)).forEach((k) => {
    const signo = ENTRADAS_INS.includes(k.tipo) ? 1 : -1;
    const cant = Number(k.cantidad) || 0;
    const fecha = String(k.creado_en).slice(0, 10);
    const x = acumulado.get(k.insumo_id)
           || { anterior: 0, ingresos: 0, egresos: 0 };

    if (fecha < inicio) {
      x.anterior += signo * cant;
    } else if (signo > 0) {
      x.ingresos += cant;
    } else {
      x.egresos += cant;
    }
    acumulado.set(k.insumo_id, x);
  });

  return (cat.data || []).map((s, i) => {
    const x = acumulado.get(s.id) || { anterior: 0, ingresos: 0, egresos: 0 };
    return {
      n: i + 1,
      nombre: (s.nombre || '').toUpperCase(),
      presentacion: (s.unidad || 'UNIDAD').toUpperCase(),
      anterior: x.anterior,
      ingresos: x.ingresos,
      egresos: x.egresos,
      actual: x.anterior + x.ingresos - x.egresos,
      /* Lo que dice la ficha hoy, para poder avisar si no
         cuadra con lo que dicen los movimientos. */
      declarado: Number(s.stock_disponible) || 0
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

    /* El descuadre solo tiene sentido comprobarlo cuando el
       informe llega hasta hoy: en uno de hace medio año, la
       diferencia con el stock actual es normal y avisar sería
       ruido. */
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
      <td class="celda-centro">${f.ingresos || '—'}</td>
      <td class="celda-centro">${f.egresos || '—'}</td>
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
      textos: textosActuales()
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
    .from('informes_farmacia').select('detalle, textos, clase')
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

  await construirWord({
    medicamentos: d.medicamentos || [],
    insumos: d.insumos || [],
    nombre: `${MESES[m - 1]} de ${a}`,
    quien: resumen.elaborado_por,
    cargo: resumen.elaborado_cargo,
    fecha: resumen.elaborado_el,
    textos: data.textos || TEXTOS
  });
}

export async function descargarActual() {
  if (!inf.ultimo) return;
  const perfil = sesionActual();
  await construirWord({
    medicamentos: inf.ultimo.medicamentos,
    insumos: inf.ultimo.insumos,
    nombre: inf.ultimo.nombre,
    quien: perfil
      ? [perfil.titulo, perfil.nombres, perfil.apellidos].filter(Boolean).join(' ').trim()
      : 'No identificado',
    cargo: perfil?.cargo || null,
    fecha: hoy(),
    textos: textosActuales()
  });
}

/* ============================================
   El documento
   ============================================ */

async function construirWord({ medicamentos, insumos, nombre, quien, cargo, fecha, textos }) {
  fijarEscala(1);

  if (!inf.logo) inf.logo = await logoEnBase64('logo.png', 300);

  const t = textos || TEXTOS;

  /* --- Portada ---
     Hoja propia, separada por un salto de página forzado: si
     la tabla empezara debajo, la portada dejaría de serlo. */
  const caratula = `
    <div style="text-align:center;padding-top:64pt;">
      ${inf.logo ? `<img src="${inf.logo}" style="width:190pt;" alt="">` : ''}

      <p style="margin-top:32pt;font-size:12pt;letter-spacing:2pt;color:#555555;">
        SERVICIOS MÉDICOS DE LA EMPRESA
      </p>

      <p style="margin-top:4pt;font-size:22pt;font-weight:bold;letter-spacing:1pt;">
        ${escapar(inf.empresaNombre || 'EMPRESA')}
      </p>

      <div style="width:38%;margin:26pt auto;border-top:2pt solid #1F4E79;"></div>

      <p style="font-size:17pt;font-weight:bold;color:#1F4E79;letter-spacing:1pt;">
        INFORME MENSUAL DE MEDICAMENTOS E INSUMOS MÉDICOS
      </p>

      <p style="margin-top:8pt;font-size:15pt;text-transform:uppercase;font-weight:bold;">
        ${escapar(nombre)}
      </p>

      <div style="width:38%;margin:26pt auto;border-top:2pt solid #1F4E79;"></div>

      <p style="margin-top:44pt;font-size:10.5pt;color:#555555;">
        UNIDAD DE SEGURIDAD Y SALUD OCUPACIONAL
      </p>
      <p style="margin-top:2pt;font-size:10.5pt;color:#555555;">
        Elaborado por ${escapar(quien || 'No identificado')}
      </p>
      <p style="font-size:10.5pt;color:#555555;">
        ${escapar(formatearFecha(fecha))}
      </p>
    </div>

    <br style="page-break-before:always;">`;

  const parrafos = (texto) => String(texto || '')
    .split(/\n+/).map((x) => x.trim()).filter(Boolean)
    .map((x) => `<p style="text-align:justify;">${escapar(x)}</p>`).join('');

  /* La normativa va como lista y no como párrafo corrido:
     son referencias que se consultan una por una, y en prosa
     hay que leerlas enteras para encontrar la que interesa. */
  const listaNormativa = String(t.normativa || '')
    .split(/\n+/).map((x) => x.trim()).filter(Boolean)
    .map((x) => `<li style="margin-bottom:3pt;">${escapar(x)}</li>`).join('');

  const cabeceras = (rotulo) => [
    { titulo: 'N°',           ancho: 5,  centrado: true },
    { titulo: rotulo,         ancho: 39 },
    { titulo: 'PRESENTACIÓN', ancho: 16 },
    { titulo: 'ANTERIOR',     ancho: 10, centrado: true },
    { titulo: 'INGRESOS',     ancho: 10, centrado: true },
    { titulo: 'EGRESOS',      ancho: 10, centrado: true },
    { titulo: 'ACTUAL',       ancho: 10, centrado: true }
  ];

  const enFilas = (lista) => lista.map((f) => [
    String(f.n), f.nombre, f.presentacion,
    String(f.anterior), String(f.ingresos), String(f.egresos), String(f.actual)
  ]);

  const todas = [...medicamentos, ...insumos];
  const totalIng = todas.reduce((s, f) => s + Number(f.ingresos || 0), 0);
  const totalEgr = todas.reduce((s, f) => s + Number(f.egresos || 0), 0);

  const cuerpo = `
    ${seccionDocumento('1. Objetivo')}
    ${parrafos(t.objetivo)}

    ${seccionDocumento('2. Alcance')}
    ${parrafos(t.alcance)}

    ${seccionDocumento('3. Marco normativo')}
    <ul style="margin:0 0 8pt 16pt;padding:0;font-size:10pt;">
      ${listaNormativa}
    </ul>

    ${seccionDocumento('4. Metodología')}
    ${parrafos(t.metodologia)}

    ${seccionDocumento('5. Medicamentos')}
    ${medicamentos.length === 0
      ? '<p>No hay medicamentos registrados en el catálogo.</p>'
      : tablaWord(cabeceras('NOMBRE DEL MEDICAMENTO'), enFilas(medicamentos))}

    ${seccionDocumento('6. Insumos médicos')}
    ${insumos.length === 0
      ? '<p>No hay insumos registrados en el catálogo.</p>'
      : tablaWord(cabeceras('DESCRIPCIÓN'), enFilas(insumos))}

    ${seccionDocumento('7. Resumen del periodo')}
    <p style="text-align:justify;">
      Durante ${escapar(nombre)} se verificaron
      <strong>${medicamentos.length}</strong> medicamentos y
      <strong>${insumos.length}</strong> insumos médicos, con un total de
      <strong>${totalIng}</strong> unidades ingresadas y
      <strong>${totalEgr}</strong> unidades egresadas.
    </p>

    ${seccionDocumento('8. Conclusión')}
    ${parrafos(t.conclusion)}

    <div class="no-partir" style="margin-top:26pt;">
      ${bloqueFirmas([
        { rotulo: 'Elaborado por:', nombre: quien || 'No identificado',
          detalle: cargo || '' }
      ], 46)}
      <p style="font-size:6.5pt;color:#999999;text-align:right;margin-top:6pt;">
        NEXUS ${VERSION} · generado el ${new Date().toLocaleString('es-EC')}
      </p>
    </div>`;

  const html = envolverWord(caratula + cuerpo,
    'Informe mensual de farmacia · ' + nombre,
    { superior: 15, inferior: 15, izquierdo: 20, derecho: 15 });

  descargarWord(html, `Informe farmacia ${nombre}`);
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

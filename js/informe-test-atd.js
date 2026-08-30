/* ============================================
   NEXUS · informe-test-atd.js

   Tres salidas, de las dos tablas del test A-T-D:

     · ANUAL         estadística agregada de UN año (cifras, no
                      listado de personas).
     · COMPARATIVO   la misma estadística, dos o más años lado
                      a lado — disponible desde la segunda
                      campaña capturada (ej. 2026 vs 2027).
     · SEGUIMIENTO   listado identificado de quienes pidieron
                      tratamiento, con su estado de gestión.
                      Aparte de los dos anteriores: nunca cruza
                      con los registros, sin listar personas.

   Mismo patrón de maquetación que informe-evaluacion-periodica.js
   (portada, membrete, tablas ".if-*", gráficos SVG a mano).
   ============================================ */

import { sesionActual } from './auth.js?v=11';
import { supabase } from './supabase.js?v=11';
import { escapar, formatearFecha } from './utils.js?v=12';
import { imprimirHoja } from './impresion.js?v=11';
import {
  estadoAtd, avisar,
  CAT_GENERO, CAT_AFILIACION, CAT_ESTADO_CIVIL, CAT_INSTRUCCION, CAT_ETNIA,
  CAT_DISCAPACIDAD, CAT_ENFERMEDAD, CAT_DROGA, CAT_FRECUENCIA, CAT_RECONOCE,
  CAT_FACTOR, CAT_ESTADO_DERIVACION
} from './test-atd.js?v=5';

const VERSION = 'v8';
console.info('NEXUS · informe-test-atd', VERSION);

const inf = { anual: null, comparativo: null };

/* Años ya cerrados: anio -> resumen JSON congelado (ver
   015_test_atd_cierre_anual.sql). Cada 1 de enero, el año que
   terminó pasa por aquí y sus respuestas individuales
   desaparecen de test_atd_respuestas (salvo quien pidió
   tratamiento, que se conserva aparte para el seguimiento). */
let cierresPorAnio = new Map();

function pct(n, total) { return total > 0 ? Math.round((n * 100) / total) : 0; }

/* Dimensiones que se tabulan en ambos informes. El orden aquí
   es el orden en el que salen en el documento. */
const DIMENSIONES = [
  { clave: 'area_cargo', titulo: 'Cargo o área', catalogo: null },
  { clave: 'genero', titulo: 'Género', catalogo: CAT_GENERO },
  { clave: 'estado_civil', titulo: 'Estado civil', catalogo: CAT_ESTADO_CIVIL },
  { clave: 'nivel_instruccion', titulo: 'Nivel de instrucción', catalogo: CAT_INSTRUCCION },
  { clave: 'afiliacion', titulo: 'Afiliación a la seguridad social', catalogo: CAT_AFILIACION },
  { clave: 'etnia', titulo: 'Autoidentificación étnica', catalogo: CAT_ETNIA },
  { clave: 'discapacidad', titulo: 'Discapacidad', catalogo: CAT_DISCAPACIDAD },
  { clave: 'enfermedad_preexistente', titulo: 'Enfermedades pre-existentes', catalogo: CAT_ENFERMEDAD },
  { clave: 'droga_principal', titulo: 'Droga principal que consume', catalogo: CAT_DROGA },
  { clave: 'frecuencia_consumo', titulo: 'Frecuencia de consumo', catalogo: CAT_FRECUENCIA },
  { clave: 'reconoce_problema', titulo: '¿Reconoce tener un problema de consumo?', catalogo: CAT_RECONOCE },
  { clave: 'factor_psicosocial', titulo: 'Factor psicosocial asociado al consumo', catalogo: CAT_FACTOR }
];

const PALETA_PASTEL = ['#1b5e20', '#EB9500', '#2E7D32', '#F4B942', '#0d47a1', '#8e24aa', '#c62828', '#546e7a', '#00838f', '#6d4c41'];

/**
 * Gráfico de pastel en SVG, con leyenda debajo. Usa la paleta
 * de marca (verde/dorado de Agrimroc) primero, y colores de
 * respaldo para categorías adicionales.
 */
function graficoPastel(items, opciones = {}) {
  const visibles = items.filter((i) => i.valor > 0);
  if (visibles.length === 0) return '<p class="if-nota">Sin datos para graficar.</p>';

  const ancho = opciones.ancho || 360;
  const alto = opciones.alto || 260;
  const radio = Math.min(ancho, alto - 70) / 2 - 6;
  const cx = ancho / 2;
  const cy = (alto - 70) / 2 + 6;
  const total = visibles.reduce((s, i) => s + i.valor, 0);

  let anguloActual = -90;
  const trozos = visibles.map((item, idx) => {
    const proporcion = item.valor / total;
    const anguloInicio = anguloActual;
    const anguloFin = anguloActual + proporcion * 360;
    anguloActual = anguloFin;
    const color = PALETA_PASTEL[idx % PALETA_PASTEL.length];

    const rad = (g) => (g * Math.PI) / 180;
    const x1 = cx + radio * Math.cos(rad(anguloInicio));
    const y1 = cy + radio * Math.sin(rad(anguloInicio));
    const x2 = cx + radio * Math.cos(rad(anguloFin));
    const y2 = cy + radio * Math.sin(rad(anguloFin));
    const grandeArco = anguloFin - anguloInicio > 180 ? 1 : 0;

    const pctTrozo = Math.round(proporcion * 100);
    const anguloMedio = rad((anguloInicio + anguloFin) / 2);
    const xEtq = cx + (radio * 0.65) * Math.cos(anguloMedio);
    const yEtq = cy + (radio * 0.65) * Math.sin(anguloMedio);

    const path = visibles.length === 1
      ? `<circle cx="${cx}" cy="${cy}" r="${radio}" fill="${color}"/>`
      : `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} `
        + `A${radio},${radio} 0 ${grandeArco} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}"/>`;

    const etiquetaTrozo = pctTrozo >= 5
      ? `<text x="${xEtq.toFixed(1)}" y="${yEtq.toFixed(1)}" font-size="10" font-weight="bold" `
        + `text-anchor="middle" fill="#fff">${pctTrozo}%</text>`
      : '';

    return { path, etiquetaTrozo, color, etiqueta: item.etiqueta, pct: pctTrozo };
  });

  const leyenda = trozos.map((t) =>
    `<span style="display:inline-flex;align-items:center;gap:3px;margin:0 8px 4px 0;">`
    + `<span style="display:inline-block;width:8px;height:8px;background:${t.color};border-radius:2px;"></span>`
    + `<span style="font-size:8.5px;color:#333;">${escapar(String(t.etiqueta))} (${t.pct}%)</span></span>`
  ).join('');

  return `<svg viewBox="0 0 ${ancho} ${alto - 60}" width="100%" style="max-width:${ancho}px; display:block; margin:0 auto;">
      ${trozos.map((t) => t.path).join('')}
      ${trozos.map((t) => t.etiquetaTrozo).join('')}
    </svg>
    <div style="text-align:center; margin-top:2px;">${leyenda}</div>`;
}

/**
 * Redacta el párrafo interpretativo de un gráfico, con el
 * mismo tono que un informe de diagnóstico inicial redactado a
 * mano: menciona las 1-3 categorías más relevantes con sus
 * porcentajes reales.
 */
function parrafoInterpretativo(dim, datos, numero) {
  if (datos.length === 0) return '';
  const top = datos.slice(0, 3);

  const frasesPorClave = {
    droga_principal: () => {
      const noConsume = datos.find((d) => d.valor === 'no_consume');
      const consumen = datos.filter((d) => d.valor !== 'no_consume').slice(0, 2);
      const partes = consumen.map((d) => `un ${d.pct}% consume ${d.etiqueta.toLowerCase()}`);
      return `El gráfico ${numero} indica la principal droga consumida por el personal: `
        + `${partes.join(', ')}, mientras que un ${noConsume ? noConsume.pct : 100}% `
        + `del personal no consume ningún tipo de droga.`;
    },
    frecuencia_consumo: () => {
      const noConsume = datos.find((d) => d.valor === 'no_consume');
      const consumen = datos.filter((d) => d.valor !== 'no_consume');
      if (consumen.length === 0) return `El gráfico ${numero} indica que ningún trabajador reportó consumo con una frecuencia definida.`;
      const partes = consumen.map((d) => `un ${d.pct}% ${d.etiqueta.toLowerCase()}`);
      return `El gráfico ${numero} muestra la frecuencia de consumo del personal: ${partes.join(', ')}`
        + `${noConsume ? `, y el ${noConsume.pct}% no consume ningún tipo de sustancia.` : '.'}`;
    },
    reconoce_problema: () => {
      const si = datos.find((d) => d.valor === 'si');
      return `El gráfico ${numero} muestra que el ${si ? si.pct : 0}% del personal reconoce `
        + `tener un problema relacionado con el consumo de sustancias.`;
    },
    factor_psicosocial: () => {
      const noAplica = datos.find((d) => d.valor === 'no_aplica');
      const factores = datos.filter((d) => d.valor !== 'no_aplica').slice(0, 2);
      if (factores.length === 0) return `El gráfico ${numero} indica que no se identificaron factores psicosociales asociados al consumo.`;
      const partes = factores.map((d) => `el ${d.pct}% considera "${d.etiqueta.toLowerCase()}"`);
      return `El gráfico ${numero} indica los siguientes factores psicosociales que el personal `
        + `relaciona con el consumo: ${partes.join(', ')} como principal factor`
        + `${noAplica ? `, y el ${noAplica.pct}% "no aplica" debido a que no consume ninguna sustancia.` : '.'}`;
    }
  };

  if (frasesPorClave[dim.clave]) return frasesPorClave[dim.clave]();

  if (top.length === 1) {
    return `El gráfico ${numero} muestra que el ${top[0].pct}% del personal corresponde a `
      + `"${top[0].etiqueta}".`;
  }
  const [primero, ...resto] = top;
  const partesResto = resto.map((d) => `un ${d.pct}% "${d.etiqueta}"`).join(', ');
  return `El gráfico ${numero} muestra que el ${primero.pct}% del personal corresponde a `
    + `"${primero.etiqueta}", mientras que ${partesResto}.`;
}

/**
 * Bloque "Análisis y conclusiones": lee las cifras reales del
 * año e hilvana observaciones, igual que redactaría un
 * profesional al cerrar el informe.
 */
function generarConclusiones(e) {
  const conclusiones = [];
  const buscar = (clave, valor) => {
    const dim = e.dimensiones.find((d) => d.clave === clave);
    return dim ? dim.datos.find((d) => d.valor === valor) : null;
  };

  const noConsume = buscar('droga_principal', 'no_consume');
  if (noConsume) {
    conclusiones.push(`El ${noConsume.pct}% del personal señaló que no consume ningún tipo de `
      + `droga, siendo un porcentaje ${noConsume.pct >= 70 ? 'alto' : noConsume.pct >= 40 ? 'moderado' : 'bajo'} libre de consumo.`);
  }

  const drogaTop = e.dimensiones.find((d) => d.clave === 'droga_principal')
    ?.datos.find((d) => d.valor !== 'no_consume');
  if (drogaTop) {
    conclusiones.push(`La principal sustancia de consumo reportada es ${drogaTop.etiqueta.toLowerCase()}, `
      + `con un ${drogaTop.pct}% del personal evaluado.`);
  }

  const factorTop = e.dimensiones.find((d) => d.clave === 'factor_psicosocial')
    ?.datos.find((d) => d.valor !== 'no_aplica');
  if (factorTop) {
    conclusiones.push(`El ${factorTop.pct}% del personal considera "${factorTop.etiqueta.toLowerCase()}" `
      + `como el principal factor psicosocial asociado al consumo.`);
  }

  if (e.reconocenProblema > 0) {
    conclusiones.push(`El ${e.pctReconocen}% del personal reconoce tener un problema relacionado `
      + `con el consumo de sustancias, población prioritaria para intervención.`);
  }

  if (e.desean > 0) {
    conclusiones.push(`El ${e.pctDesean}% del personal manifestó su deseo de recibir tratamiento, `
      + `casos que se gestionan de forma individual y confidencial en el listado de seguimiento.`);
  }

  const frecBaja = e.dimensiones.find((d) => d.clave === 'frecuencia_consumo')
    ?.datos.find((d) => d.valor === '2_a_12_anio');
  if (frecBaja) {
    conclusiones.push(`El ${frecBaja.pct}% de los trabajadores consume de 2 a 12 veces al año, `
      + `una frecuencia baja dentro del patrón de consumo.`);
  }

  return conclusiones;
}

const RECOMENDACIONES_BASE = [
  'Continuar con acciones preventivas, como programas y charlas para disminuir el riesgo de uso y consumo prolongado de alcohol, tabaco y otras drogas.',
  'Capacitar anualmente al personal de la empresa sobre la prevención y reducción del consumo de alcohol, tabaco y otras drogas en espacios laborales, con la finalidad de establecer un ambiente adecuado.',
  'Sensibilización con enfoque psicoeducativo y preventivo sobre el alcohol, tabaco y otras drogas, que incluya estrategias que promuevan estilos de vida saludables en la población laboral.',
  'Campaña de concientización sobre las secuelas y desventajas del consumo de alcohol, organizada por el personal de la empresa.',
  'Evaluaciones psicológicas individuales dentro de un periodo de corto o mediano plazo (6 o 12 meses), con la finalidad de conocer conflictos personales, familiares, conyugales o laborales que mantenga el personal, y prevenir un consumo de drogas severo.'
];

/* ============================================
   Selectores de año (informe y comparativo)
   ============================================ */

export async function iniciarInformeAtd() {
  await cargarCierres();
  llenarSelectorAnioInforme();
  llenarSelectoresComparativo();
}

/** El médico tocó el texto de recomendaciones: ya no se le
    pisa con el texto por defecto si vuelve a generar la vista
    previa del mismo informe. */
export function marcarRecomendacionesEditadas() {
  const $reco = document.getElementById('atd-inf-recomendaciones');
  if ($reco) $reco.dataset.editado = '1';
}

async function cargarCierres() {
  cierresPorAnio = new Map();
  const { data, error } = await supabase
    .from('test_atd_cierres_anuales')
    .select('anio, resumen')
    .eq('empresa_id', estadoAtd().empresaId);

  if (!error && data) {
    data.forEach((fila) => cierresPorAnio.set(fila.anio, fila.resumen));
  }
}

function aniosDisponibles() {
  const anios = new Set(estadoAtd().respuestas.map((r) => r.anio));
  cierresPorAnio.forEach((_resumen, anio) => anios.add(anio));
  return [...anios].sort((a, b) => b - a);
}

function llenarSelectorAnioInforme() {
  const $s = document.getElementById('atd-inf-anio');
  if (!$s) return;
  const anios = aniosDisponibles();
  $s.innerHTML = anios.length
    ? anios.map((a) => `<option value="${a}">${a}</option>`).join('')
    : '<option value="">— Sin campañas capturadas —</option>';
}

function llenarSelectoresComparativo() {
  const $base = document.getElementById('atd-comp-base');
  const $anios = document.getElementById('atd-comp-anios');
  if (!$base || !$anios) return;

  const anios = aniosDisponibles();
  if (anios.length < 2) {
    $base.innerHTML = '<option value="">— Se necesitan al menos 2 campañas —</option>';
    $anios.innerHTML = '';
    return;
  }

  $base.innerHTML = anios.map((a) => `<option value="${a}">${a}</option>`).join('');
  $base.value = String(anios[0]);
  pintarCheckboxAnios();
  $base.addEventListener('change', pintarCheckboxAnios);
}

function pintarCheckboxAnios() {
  const $base = document.getElementById('atd-comp-base');
  const $anios = document.getElementById('atd-comp-anios');
  const base = parseInt($base.value, 10);
  const otros = aniosDisponibles().filter((a) => a !== base);

  $anios.innerHTML = otros.map((a) => `
    <label><input type="checkbox" value="${a}" checked> ${a}</label>`).join('')
    || '<span class="ayuda">No hay otros años para comparar.</span>';
}

/* ============================================
   Cálculo — estadística de un conjunto de filas
   ============================================ */

function contarDimension(filas, dim) {
  const conteo = new Map();
  filas.forEach((r) => {
    const v = r[dim.clave];
    if (v == null || v === '') return;
    conteo.set(v, (conteo.get(v) || 0) + 1);
  });
  const total = filas.length;
  return [...conteo.entries()]
    .map(([valor, n]) => ({
      valor, etiqueta: dim.catalogo ? (dim.catalogo[valor] || valor) : valor,
      n, pct: pct(n, total)
    }))
    .sort((a, b) => b.n - a.n);
}

function calcularEdades(filas, anio) {
  const edades = filas
    .filter((r) => r.anio_nacimiento)
    .map((r) => anio - r.anio_nacimiento);
  if (edades.length === 0) return null;
  const promedio = (edades.reduce((s, e) => s + e, 0) / edades.length).toFixed(1);
  const buckets = [
    { etiqueta: '< 18 años', n: edades.filter((e) => e < 18).length },
    { etiqueta: '18 – 35 años', n: edades.filter((e) => e >= 18 && e <= 35).length },
    { etiqueta: '36 – 59 años', n: edades.filter((e) => e >= 36 && e <= 59).length },
    { etiqueta: '> 60 años', n: edades.filter((e) => e >= 60).length }
  ].filter((b) => b.n > 0).map((b) => ({ ...b, pct: pct(b.n, edades.length) }));
  return { promedio, buckets, n: edades.length };
}

function calcularEstadisticas(filas, anio) {
  const total = filas.length;
  const dimensiones = DIMENSIONES.map((dim) => ({ ...dim, datos: contarDimension(filas, dim) }));
  const edad = calcularEdades(filas, anio);

  const consumeAlgo = filas.filter((r) => r.droga_principal && r.droga_principal !== 'no_consume').length;
  const desean = filas.filter((r) => r.desea_tratamiento).length;
  const reconocenProblema = filas.filter((r) => r.reconoce_problema === 'si').length;

  return {
    anio, total, dimensiones, edad,
    consumeAlgo, pctConsumeAlgo: pct(consumeAlgo, total),
    desean, pctDesean: pct(desean, total),
    reconocenProblema, pctReconocen: pct(reconocenProblema, total)
  };
}

/**
 * Misma forma de salida que calcularEstadisticas(), pero
 * leyendo un año ya cerrado desde su resumen congelado (JSON)
 * en vez de contar filas individuales, porque esas filas ya
 * no existen.
 */
function estadisticasDesdeResumen(resumen, anio) {
  const total = resumen.total || 0;

  const dimensiones = DIMENSIONES.map((dim) => {
    const conteo = (resumen.dimensiones && resumen.dimensiones[dim.clave]) || {};
    const datos = Object.entries(conteo)
      .map(([valor, n]) => ({
        valor, etiqueta: dim.catalogo ? (dim.catalogo[valor] || valor) : valor,
        n, pct: pct(n, total)
      }))
      .sort((a, b) => b.n - a.n);
    return { ...dim, datos };
  });

  let edad = null;
  if (resumen.edad_n) {
    const buckets = Object.entries(resumen.edad_buckets || {})
      .map(([etiqueta, n]) => ({ etiqueta, n, pct: pct(n, resumen.edad_n) }))
      .filter((b) => b.n > 0);
    edad = { promedio: resumen.edad_promedio, buckets, n: resumen.edad_n };
  }

  const consumeAlgo = resumen.consume_algo || 0;
  const desean = resumen.desean || 0;
  const reconocenProblema = resumen.reconocen_problema || 0;

  return {
    anio, total, dimensiones, edad,
    consumeAlgo, pctConsumeAlgo: pct(consumeAlgo, total),
    desean, pctDesean: pct(desean, total),
    reconocenProblema, pctReconocen: pct(reconocenProblema, total)
  };
}

/**
 * Punto único para pedir las estadísticas de un año: si ya
 * está cerrado (existe un resumen congelado), se usa ese —
 * las respuestas individuales de ese año ya no están, salvo
 * quien pidió tratamiento. Si el año sigue abierto, se calcula
 * en vivo a partir de las respuestas actuales.
 */
function obtenerEstadisticasAnio(anio) {
  const resumen = cierresPorAnio.get(anio);
  if (resumen) return estadisticasDesdeResumen(resumen, anio);

  const filas = estadoAtd().respuestas.filter((r) => r.anio === anio);
  return filas.length > 0 ? calcularEstadisticas(filas, anio) : null;
}

/* ============================================
   Informe anual
   ============================================ */

export function generarInformeAnualAtd() {
  const anio = parseInt(document.getElementById('atd-inf-anio').value, 10);
  if (!anio) return avisar('No hay campañas capturadas todavía.', false, 'atd-inf-alerta');

  const stats = obtenerEstadisticasAnio(anio);
  if (!stats || stats.total === 0) return avisar('No hay registros para ese año.', false, 'atd-inf-alerta');

  inf.anual = stats;

  document.getElementById('atd-inf-previa').hidden = false;
  document.getElementById('atd-inf-previa-resumen').textContent =
    `Año ${anio} · ${inf.anual.total} personas evaluadas · `
    + `${inf.anual.pctConsumeAlgo}% reporta algún consumo`;

  /* Recomendaciones: se precargan con el texto por defecto, pero
     quedan en un textarea editable — lo que esté escrito ahí al
     momento de descargar es lo que sale impreso. */
  const $reco = document.getElementById('atd-inf-recomendaciones');
  if ($reco && !$reco.dataset.editado) {
    $reco.value = RECOMENDACIONES_BASE.map((r, i) => `${i + 1}. ${r}`).join('\n\n');
  }
}

export async function descargarInformeAnualAtd() {
  const e = inf.anual;
  if (!e) return avisar('Genere primero el informe.', false, 'atd-inf-alerta');
  const quien = quienElabora();
  const cargo = cargoElabora();
  const registro = registroElabora();
  const empresaNombre = estadoAtd().empresaNombre;
  const cerrado = cierresPorAnio.has(e.anio);

  const bloqueIntro = `
    <p>La empresa <strong>${escapar(empresaNombre.toUpperCase())}</strong>, en base al Acuerdo
    Interinstitucional expedido por el Ministerio del Trabajo, el Ministerio de Salud Pública y
    la Secretaría Técnica de Drogas (Acuerdo Ministerial MDT-2024-196), realizó durante el año
    ${e.anio} el registro y levantamiento de información con el personal, desarrollando el
    <strong>diagnóstico inicial</strong> de consumo de alcohol, tabaco y otras drogas.</p>
    <p>En el diagnóstico se analizan las diferentes variables que pueden intervenir en el uso y
    consumo de alcohol, tabaco y otras drogas: la principal droga de consumo, su frecuencia, las
    condiciones que motivan al consumo, y las recomendaciones y conclusiones respectivas. A
    continuación se desarrolla el análisis gráfico de las diferentes variables evaluadas.</p>
    ${cerrado ? `<p class="if-nota"><strong>Campaña cerrada.</strong> Las respuestas individuales
    de ${e.anio} ya no están en el sistema (se eliminaron el 1 de enero siguiente, salvo quienes
    pidieron tratamiento); estas cifras vienen del resumen que se guardó antes de ese cierre.</p>` : ''}`;

  const bloqueEdad = e.edad ? `
    <h3 class="if-subseccion">Distribución por edad</h3>
    ${graficoPastel(e.edad.buckets.map((b) => ({ etiqueta: b.etiqueta, valor: b.n })))}
    <p>La edad promedio de las personas evaluadas fue de ${e.edad.promedio} años.</p>` : '';

  let numeroGrafico = 1;
  const bloquesDimension = e.dimensiones.map((dim) => {
    if (dim.datos.length === 0) return '';
    const n = numeroGrafico++;
    return `<h3 class="if-subseccion">${escapar(dim.titulo.toUpperCase())}</h3>
      <p class="if-fuerte">Gráfico ${n}.-</p>
      ${graficoPastel(dim.datos.map((d) => ({ etiqueta: d.etiqueta, valor: d.n })))}
      <p>${parrafoInterpretativo(dim, dim.datos, n)}</p>
      ${fuente(e.anio, empresaNombre)}`;
  }).join('');

  const conclusiones = generarConclusiones(e);
  const bloqueConclusiones = conclusiones.length ? `
    <h2 class="if-seccion">Análisis y conclusiones</h2>
    <ul class="if-lista">${conclusiones.map((c) => `<li>${c}</li>`).join('')}</ul>` : '';

  const textoRecomendaciones = (document.getElementById('atd-inf-recomendaciones')?.value || '')
    .trim();
  const bloqueRecomendaciones = textoRecomendaciones ? `
    <h2 class="if-seccion">Recomendaciones</h2>
    ${textoRecomendaciones.split(/\n\s*\n/).map((p) => `<p>${escapar(p.trim())}</p>`).join('')}` : '';

  const html = `
    ${portadaHtml('Programa integral de prevención y reducción<br>del uso y consumo de '
      + 'alcohol, tabaco y otras drogas', `Diagnóstico inicial · Año ${e.anio}`, quien, empresaNombre)}
    <section class="if-contenido">
      ${membreteHtml('Diagnóstico inicial · Test A-T-D', `Año ${e.anio}`, empresaNombre)}
      ${bloqueIntro}
      <h2 class="if-seccion">Distribución de empleados participantes</h2>
      ${bloqueEdad}
      ${bloquesDimension}
      ${bloqueConclusiones}
      ${bloqueRecomendaciones}
      <p style="margin-top:10mm;">Responsable del Diagnóstico Inicial:</p>
      <div class="if-firmas">
        <div class="if-firma">
          <div class="if-firma-linea"></div>
          <p class="if-firma-nombre if-fuerte">${escapar(quien || 'No identificado')}</p>
          ${cargo ? `<p class="if-firma-rotulo">${escapar(cargo)}</p>` : ''}
          ${registro ? `<p class="if-firma-rotulo">N.° de Registro: ${escapar(registro)}</p>` : ''}
          <p class="if-firma-rotulo">Departamento Médico · ${escapar(empresaNombre)}</p>
        </div>
      </div>
    </section>`;

  await imprimir(html, `Informe A-T-D · ${e.anio}`, 'atd-inf-alerta');
}

/* ============================================
   Informe comparativo
   ============================================ */

export function generarInformeComparativoAtd() {
  const base = parseInt(document.getElementById('atd-comp-base').value, 10);
  const seleccionados = [...document.querySelectorAll('#atd-comp-anios input:checked')]
    .map((c) => parseInt(c.value, 10));

  if (!base || seleccionados.length === 0) {
    return avisar('Seleccione el año base y al menos un año para comparar.', false, 'atd-comp-alerta');
  }

  const anios = [...new Set([base, ...seleccionados])].sort((a, b) => a - b);
  const porAnio = anios
    .map((anio) => ({ anio, stats: obtenerEstadisticasAnio(anio) }))
    .filter((x) => x.stats && x.stats.total > 0);

  if (porAnio.length < 2) {
    return avisar('No hay suficientes registros en los años elegidos para comparar.', false, 'atd-comp-alerta');
  }

  inf.comparativo = { anios: porAnio.map((x) => x.anio), porAnio };

  document.getElementById('atd-comp-previa').hidden = false;
  document.getElementById('atd-comp-previa-resumen').textContent =
    `Comparando ${porAnio.map((x) => `${x.anio} (${x.stats.total})`).join(' vs ')}`;
}

export async function descargarInformeComparativoAtd() {
  const c = inf.comparativo;
  if (!c) return avisar('Genere primero el informe.', false, 'atd-comp-alerta');
  const quien = quienElabora();
  const empresaNombre = estadoAtd().empresaNombre;
  const anios = c.anios;
  const hayAnioCerrado = c.porAnio.some((x) => cierresPorAnio.has(x.anio));

  const bloqueTotales = `
    <h2 class="if-seccion">1. Cobertura por año</h2>
    ${graficoBarras(c.porAnio.map((x) => ({ etiqueta: String(x.anio), valor: x.stats.total })))}
    <table class="if-tabla">
      <thead><tr><th class="if-izq">Año</th><th>Evaluados</th><th>% consume algo</th>
        <th>% reconoce problema</th><th>% desea tratamiento</th></tr></thead>
      <tbody>${c.porAnio.map((x) => `<tr>
        <td class="if-izq">${x.anio}${cierresPorAnio.has(x.anio) ? ' 🔒' : ''}</td><td>${x.stats.total}</td>
        <td>${x.stats.pctConsumeAlgo}%</td><td>${x.stats.pctReconocen}%</td>
        <td>${x.stats.pctDesean}%</td></tr>`).join('')}</tbody>
    </table>
    ${hayAnioCerrado ? '<p class="if-nota">🔒 Campaña cerrada: cifras tomadas del resumen '
      + 'congelado, ya no de respuestas individuales.</p>' : ''}`;

  const bloquesDimension = DIMENSIONES.map((dim, idx) => {
    /* Categorías que aparecieron en cualquiera de los años,
       ordenadas por su peso total, top 6 para que el gráfico
       agrupado no se sature. */
    const pesos = new Map();
    c.porAnio.forEach((x) => {
      x.stats.dimensiones[idx].datos.forEach((d) => {
        pesos.set(d.valor, (pesos.get(d.valor) || 0) + d.n);
      });
    });
    const top = [...pesos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v]) => v);
    if (top.length === 0) return '';

    const series = top.map((valor) => ({
      nombre: dim.catalogo ? (dim.catalogo[valor] || valor) : valor,
      valores: c.porAnio.map((x) =>
        x.stats.dimensiones[idx].datos.find((d) => d.valor === valor)?.n || 0)
    }));

    const filasTabla = top.map((valor) => {
      const etiqueta = dim.catalogo ? (dim.catalogo[valor] || valor) : valor;
      const celdas = c.porAnio.map((x) => {
        const d = x.stats.dimensiones[idx].datos.find((dd) => dd.valor === valor);
        return `<td>${d ? `${d.n} (${d.pct}%)` : '0 (0%)'}</td>`;
      }).join('');
      return `<tr><td class="if-izq">${escapar(etiqueta)}</td>${celdas}</tr>`;
    }).join('');

    return `<h3 class="if-subseccion">${idx + 2}. ${escapar(dim.titulo)}</h3>
      ${graficoBarrasAgrupado(anios, series)}
      <table class="if-tabla">
        <thead><tr><th class="if-izq">Categoría</th>
          ${c.porAnio.map((x) => `<th>${x.anio}</th>`).join('')}</tr></thead>
        <tbody>${filasTabla}</tbody>
      </table>
      ${fuente(anios.join(' – '), empresaNombre)}`;
  }).join('');

  const html = `
    ${portadaHtml('Informe comparativo<br>Test de consumo de alcohol, tabaco y otras drogas',
      `Años ${anios.join(' vs ')}`, quien, empresaNombre)}
    <section class="if-contenido">
      ${membreteHtml('Informe comparativo · Test A-T-D', `Años ${anios.join(' vs ')}`, empresaNombre)}

      <h2 class="if-seccion">Objetivo</h2>
      <p>Comparar los resultados del test de diagnóstico inicial de consumo de alcohol, tabaco y
      otras drogas de ${escapar(empresaNombre)} entre los años ${anios.join(', ')}, para observar
      la evolución de los indicadores de la empresa en el tiempo.</p>
      <p class="if-nota">Estadística agregada: no lista personas de forma individual.</p>

      ${bloqueTotales}
      ${bloquesDimension}

      <div class="if-firmas">
        <div class="if-firma">
          <div class="if-firma-linea"></div>
          <p class="if-firma-rotulo">Elaborado por</p>
          <p class="if-firma-nombre">${escapar(quien || 'No identificado')}</p>
        </div>
      </div>
    </section>`;

  await imprimir(html, `Informe comparativo A-T-D · ${anios.join(' vs ')}`, 'atd-comp-alerta');
}

/* ============================================
   Seguimiento de derivaciones (identificado)
   ============================================ */

export async function imprimirSeguimientoDerivaciones() {
  const anioFiltro = document.getElementById('atd-deriv-filtro-anio')?.value || '';
  const estadoFiltro = document.getElementById('atd-deriv-filtro-estado')?.value || '';
  const empresaNombre = estadoAtd().empresaNombre;
  const quien = quienElabora();

  const filas = estadoAtd().respuestas.filter((d) => d.desea_tratamiento
    && (!anioFiltro || String(d.anio) === anioFiltro)
    && (!estadoFiltro || d.estado_seguimiento === estadoFiltro));

  if (filas.length === 0) {
    return avisar('No hay casos que coincidan con el filtro elegido.', false, 'atd-deriv-alerta');
  }

  const cuerpo = filas.map((d) => `<tr>
    <td class="if-izq">${escapar(d.codigo_cedula || '—')}</td>
    <td class="if-izq">${escapar(d.area_cargo || '—')}</td>
    <td class="if-izq">${escapar(d.telefono || '—')}</td>
    <td class="if-izq">${escapar(d.direccion || '—')}</td>
    <td>${d.anio}</td>
    <td class="if-izq">${escapar(CAT_ESTADO_DERIVACION[d.estado_seguimiento] || d.estado_seguimiento || '—')}</td>
    <td class="if-izq">${escapar(d.notas_seguimiento || '—')}</td>
  </tr>`).join('');

  const html = `
    ${portadaHtml('Listado de seguimiento<br>y derivaciones a tratamiento', 'Casos identificados', quien, empresaNombre)}
    <section class="if-contenido">
      ${membreteHtml('Seguimiento y derivaciones · Test A-T-D', 'Casos identificados', empresaNombre)}

      <p class="if-nota"><strong>Confidencial:</strong> contiene información de salud de personas
      identificadas que solicitaron voluntariamente recibir tratamiento. Su distribución se
      limita al personal médico y de enfermería autorizado.</p>

      <table class="if-tabla">
        <thead><tr>
          <th class="if-izq">Código / cédula</th><th class="if-izq">Cargo / área</th>
          <th class="if-izq">Teléfono</th><th class="if-izq">Dirección</th>
          <th>Año</th><th class="if-izq">Estado</th><th class="if-izq">Notas</th>
        </tr></thead>
        <tbody>${cuerpo}</tbody>
      </table>

      <div class="if-firmas">
        <div class="if-firma">
          <div class="if-firma-linea"></div>
          <p class="if-firma-rotulo">Elaborado por</p>
          <p class="if-firma-nombre">${escapar(quien || 'No identificado')}</p>
        </div>
      </div>
    </section>`;

  await imprimir(html, 'Seguimiento y derivaciones · Test A-T-D', 'atd-deriv-alerta');
}

/* ============================================
   Helpers de maquetación (mismo patrón que
   informe-evaluacion-periodica.js)
   ============================================ */

function graficoBarras(items, opciones = {}) {
  const ancho = opciones.ancho || 460, alto = opciones.alto || 160;
  const color = opciones.color || '#1b5e20';
  if (items.length === 0) return '<p class="if-nota">Sin datos para graficar.</p>';

  const margenIzq = 8, margenInf = 26, margenSup = 14;
  const anchoUtil = ancho - margenIzq - 8;
  const altoUtil = alto - margenInf - margenSup;
  const max = Math.max(...items.map((i) => i.valor), 1);
  const espacio = anchoUtil / items.length;
  const anchoBarra = Math.min(espacio * 0.6, 40);

  const barras = items.map((item, i) => {
    const h = max > 0 ? (item.valor / max) * altoUtil : 0;
    const x = margenIzq + i * espacio + (espacio - anchoBarra) / 2;
    const y = margenSup + (altoUtil - h);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${anchoBarra.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="1"/>
            <text x="${(x + anchoBarra / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" font-size="8" text-anchor="middle" fill="#1F2937">${item.valor}</text>
            <text x="${(x + anchoBarra / 2).toFixed(1)}" y="${alto - margenInf + 12}" font-size="7" text-anchor="middle" fill="#444">${escapar(String(item.etiqueta)).slice(0, 14)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${ancho} ${alto}" width="100%" style="max-width:${ancho}px; display:block; margin:0 auto;">
    <line x1="${margenIzq}" y1="${alto - margenInf}" x2="${ancho - 8}" y2="${alto - margenInf}" stroke="#B0BEC9" stroke-width="0.6"/>
    ${barras}
  </svg>`;
}

function graficoBarrasAgrupado(anios, series, opciones = {}) {
  const ancho = opciones.ancho || 460, alto = opciones.alto || 190;
  const colores = ['#1b5e20', '#1F4E79', '#b5531a', '#7a1f9c', '#a01818', '#666'];

  const margenIzq = 10, margenInf = 36, margenSup = 14;
  const anchoUtil = ancho - margenIzq - 10;
  const altoUtil = alto - margenInf - margenSup;
  const max = Math.max(1, ...series.flatMap((s) => s.valores));
  const grupoAncho = anchoUtil / anios.length;
  const barraAncho = Math.min((grupoAncho / series.length) * 0.7, 20);

  let barras = '';
  anios.forEach((anio, gi) => {
    series.forEach((s, si) => {
      const valor = s.valores[gi] || 0;
      const h = (valor / max) * altoUtil;
      const x = margenIzq + gi * grupoAncho + si * (grupoAncho / series.length) + 3;
      const y = margenSup + (altoUtil - h);
      barras += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barraAncho.toFixed(1)}" height="${h.toFixed(1)}" fill="${colores[si % colores.length]}" rx="1"/>`;
      if (valor > 0) barras += `<text x="${(x + barraAncho / 2).toFixed(1)}" y="${(y - 2).toFixed(1)}" font-size="6.5" text-anchor="middle" fill="#1F2937">${valor}</text>`;
    });
    const xEtq = margenIzq + gi * grupoAncho + grupoAncho / 2;
    barras += `<text x="${xEtq.toFixed(1)}" y="${alto - margenInf + 13}" font-size="8.5" text-anchor="middle" fill="#444">${anio}</text>`;
  });

  const leyenda = series.map((s, i) =>
    `<span style="display:inline-block;width:8px;height:8px;background:${colores[i % colores.length]};margin-right:4px;border-radius:2px;"></span>${escapar(s.nombre)}`
  ).join('&nbsp;&nbsp;&nbsp;');

  return `<svg viewBox="0 0 ${ancho} ${alto}" width="100%" style="max-width:${ancho}px; display:block; margin:0 auto;">
      <line x1="${margenIzq}" y1="${alto - margenInf}" x2="${ancho - 8}" y2="${alto - margenInf}" stroke="#B0BEC9" stroke-width="0.6"/>
      ${barras}
    </svg>
    <p style="text-align:center; font-size:10px; color:#555; margin-top:2px;">${leyenda}</p>`;
}

function tablaSimple(filas) {
  return `<table class="if-tabla">
    <thead><tr><th class="if-izq">Categoría</th><th>N.°</th><th>%</th></tr></thead>
    <tbody>${filas.map((f) => `<tr><td class="if-izq">${escapar(f.etiqueta)}</td><td>${f.n}</td><td>${f.pct}%</td></tr>`).join('')}</tbody>
  </table>`;
}

function fuente(anio, empresaNombre) {
  return `<p class="if-fuente">FUENTE: ${escapar((empresaNombre || '').toUpperCase())}, ${anio}.</p>`;
}

function membreteHtml(titulo, periodo, empresaNombre) {
  return `<header class="if-membrete">
    <img src="logo.png" class="if-membrete-logo" alt="">
    <div class="if-membrete-texto">
      <strong>${escapar(empresaNombre || 'Empresa')}</strong><br>
      Unidad de Seguridad y Salud Ocupacional · Servicios Médicos
    </div>
    <div class="if-membrete-ref">${titulo}<br>${escapar(periodo)}</div>
  </header>`;
}

function portadaHtml(titulo, periodo, quien, empresaNombre) {
  return `<section class="if-portada">
    <div class="if-portada-banda"></div>
    <div class="if-portada-marca"><img src="logo.png" class="if-portada-logo" alt=""></div>
    <div class="if-portada-centro">
      <p class="if-portada-unidad">Unidad de Seguridad y Salud Ocupacional</p>
      <p class="if-portada-servicio">Vigilancia de la Salud en el Trabajo</p>
      <div class="if-portada-regla"></div>
      <h1 class="if-portada-titulo">${titulo}</h1>
      <p class="if-portada-mes">${escapar(periodo)}</p>
      <div class="if-portada-regla"></div>
      <p class="if-portada-empresa">${escapar(empresaNombre || 'Empresa')}</p>
    </div>
    <div class="if-portada-pie">
      <table class="if-portada-datos">
        <tr><th>Elaborado por</th><td>${escapar(quien || 'No identificado')}</td></tr>
        <tr><th>Fecha de elaboración</th><td>${escapar(formatearFecha(new Date().toISOString().slice(0, 10)))}</td></tr>
      </table>
    </div>
    <div class="if-portada-banda if-portada-banda-baja"></div>
  </section>`;
}

function quienElabora() {
  const p = sesionActual();
  if (!p) return null;
  return [p.titulo, p.nombres, p.apellidos].filter(Boolean).join(' ').trim() || null;
}

function cargoElabora() {
  const p = sesionActual();
  return p?.cargo || null;
}

function registroElabora() {
  const p = sesionActual();
  return p?.registro_msp || null;
}

async function imprimir(html, titulo, destino) {
  const $z = document.getElementById('atd-impresion');
  if (!$z) return avisar('Falta actualizar la página para poder imprimir.', false, destino);
  $z.innerHTML = html;
  avisar('En el diálogo de impresión: active «Gráficos de fondo».', true, destino);
  await imprimirHoja('atd-impresion', 'imprimiendo-atd', titulo);
}

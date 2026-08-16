/* ============================================
   NEXUS · informe-evaluacion-periodica.js

   Dos informes, de la MISMA captura (evaluacion_resultados),
   con el formato de casa de C.V.S. Altair: portada, resumen
   institucional, exposición de motivos, aspectos
   organizacionales, distribución clínica examen por examen
   —cada tabla con su "FUENTE" y su párrafo interpretativo—,
   análisis, conclusiones y recomendaciones.

    · EPIDEMIOLÓGICO: agregado, de UN año (como el modelo),
      más una sección de tendencia multianual que el modelo no
      tiene pero que si acumulamos varios años de campañas, es
      donde se ve la evolución real de la empresa.

    · SEGUIMIENTO: nominal. Una tabla por examen que tuvo algún
      resultado anormal alguna vez, con la persona, su cargo y
      el hallazgo. Cuando hay más de un año capturado para esa
      persona en ese examen, se ve su historial completo, año
      por año, en la misma fila —así se lee la evolución de un
      caso, ej. Cobb 0° en 2026 y Cobb 3° en 2027.

   Ninguno de los dos expone datos de personas externas: la
   vigilancia periódica es exclusiva de trabajadores.
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { sesionActual } from './auth.js?v=11';
import { escapar, formatearFecha } from './utils.js?v=12';
import { alCrear } from './autoria.js?v=1';
import { imprimirHoja } from './impresion.js?v=11';

const VERSION = 'v2';
console.info('NEXUS · informe-evaluacion-periodica', VERSION);

const inf = {
  empresaId: null, empresaNombre: '',
  historico: [], recomendaciones: [],
  epidemiologico: null, seguimiento: null
};

/* ============================================
   Textos institucionales fijos — el mismo resumen y
   exposición de motivos que usa el proveedor en todos sus
   informes. Editables, por si un año cambia la redacción.
   ============================================ */

const TEXTOS = {
  resumen:
    'En el presente informe se expone los aspectos relacionados con el proceso de gestión del ' +
    'Servicio de Salud y Seguridad en el Trabajo (SG-SST), en atención a lo establecido en el ' +
    'ordenamiento legal vigente: artículo 326, numeral 5 de la Constitución de la República, ' +
    'Normas Comunitarias Andinas, Convenios Internacionales de la OIT, Código del Trabajo, ' +
    'Decreto Ejecutivo N.° 255 (Reglamento de Seguridad y Salud de los Trabajadores) y Acuerdo ' +
    'Ministerial N.° 00004-2026 (Reglamento de los Servicios Integrales de Salud en el Trabajo — ' +
    'SISAT). Consta de las consideraciones de vigilancia epidemiológica realizadas según los ' +
    'resultados obtenidos de las evaluaciones médico ocupacionales de los trabajadores, y sus ' +
    'comentarios.',

  exposicion:
    'El análisis de todo proceso de trabajo conlleva la elaboración de estrategias que conduzcan ' +
    'a la ejecución de acciones que permitan establecer los parámetros de identificación, ' +
    'reconocimiento e intervención de los riesgos ocupacionales. Por tal razón, el ordenamiento ' +
    'legal ecuatoriano contempla un conjunto de disposiciones que orientan la ejecución de ' +
    'acciones tendentes a preservar la integridad física, psíquica y social de los trabajadores, ' +
    'mediante la implementación de programas de prevención de enfermedades y accidentes ' +
    'vinculados al trabajo, y la realización de jornadas periódicas de evaluación médica ' +
    'ocupacional integradas a planes de vigilancia epidemiológica, con el fin de monitorear la ' +
    'condición de salud de la población trabajadora y detectar tempranamente situaciones que ' +
    'pudieran comprometer su bienestar integral.',

  conclusion:
    'El conjunto de datos aportados por el presente estudio arroja aspectos de interés ' +
    'estadístico que permiten, desde el punto de vista general, acometer iniciativas de control ' +
    'y seguimiento que contribuyan a corregir las desviaciones de los parámetros de salud ' +
    'encontrados en la población analizada.'
};

/* Frases de acción por tipo de examen, para que el párrafo
   interpretativo de cada tabla no salga genérico. Se busca por
   coincidencia de palabras en el nombre del examen; el primer
   patrón que coincide gana. Si ninguno coincide, se usa la
   frase genérica al final. */
const FRASES_EXAMEN = [
  { prueba: /presi[oó]n|tensi[oó]n/i, accion: 'la toma de presión arterial' },
  { prueba: /masa corporal|imc/i, accion: 'la toma de medidas antropométricas' },
  { prueba: /hemograma|biometr[ií]a/i, accion: 'la toma de muestras de sangre para realización de hemograma' },
  { prueba: /l[ií]pid|colesterol|triglic[eé]rid/i, accion: 'la toma de muestras de sangre para determinar el perfil lipídico' },
  { prueba: /glicemia|glucosa/i, accion: 'la toma de muestras de sangre para análisis de glicemia' },
  { prueba: /orina|uroan[aá]lisis/i, accion: 'la toma de muestras de orina para uroanálisis' },
  { prueba: /lumbar|columna|rx|radiograf/i, accion: 'la evaluación radiológica' },
  { prueba: /optometr|visual|agudeza/i, accion: 'la evaluación optométrica' },
  { prueba: /audiometr|auditiv/i, accion: 'la evaluación audiométrica' },
  { prueba: /espirometr|pulmonar|respirator/i, accion: 'la evaluación espirométrica' }
];

function accionParaExamen(nombre) {
  const hallada = FRASES_EXAMEN.find((f) => f.prueba.test(nombre));
  return hallada ? hallada.accion : `la evaluación de ${nombre.toLowerCase()}`;
}

/* Los exámenes de masa corporal se clasifican en tres
   categorías (Normal / Sobrepeso / Obesidad), no en dos como
   el resto: es el único con esa forma en el modelo de casa,
   y clasificarIMC() ya deja escrita la categoría en la
   condición cuando el resultado es anormal. */
function esExamenImc(nombre) {
  return /masa corporal|imc/i.test(nombre);
}

function categoriaImc(fila) {
  if (fila.resultado === 'normal') return 'Normal';
  const c = (fila.condicion || '').toLowerCase();
  if (c.includes('obesidad')) return 'Obesidad';
  if (c.includes('sobrepeso')) return 'Sobrepeso';
  return 'Otro';
}

/* ============================================
   Arranque y carga
   ============================================ */

export async function iniciarInformeEvaluacion(empresaId, empresaNombre) {
  inf.empresaId = empresaId;
  inf.empresaNombre = empresaNombre || '';

  await Promise.all([cargarHistorico(), cargarRecomendaciones()]);
  llenarSelectorAnio();
  pintarTextosPorDefecto();
}

async function cargarHistorico() {
  const { data, error } = await supabase
    .from('v_evaluacion_detalle')
    .select('*')
    .eq('empresa_id', inf.empresaId)
    .neq('resultado', 'no_realizado')
    .order('anio');

  inf.historico = error ? [] : (data || []);
  return inf.historico;
}

function llenarSelectorAnio() {
  const $s = document.getElementById('epi-anio');
  if (!$s) return;
  const anios = [...new Set(inf.historico.map((r) => r.anio))].sort((a, b) => b - a);
  $s.innerHTML = anios.map((a) => `<option value="${a}">${a}</option>`).join('')
    || '<option value="">— Sin campañas capturadas —</option>';
}

function pintarTextosPorDefecto() {
  const poner = (id, valor) => {
    const $t = document.getElementById(id);
    if ($t && !$t.value.trim()) $t.value = valor;
  };
  poner('epi-resumen-texto', TEXTOS.resumen);
  poner('epi-exposicion', TEXTOS.exposicion);
  poner('epi-conclusiones', TEXTOS.conclusion);
}

/* ============================================
   Biblioteca de recomendaciones (mismo patrón que
   planes_accion en informe-atenciones.js)
   ============================================ */

async function cargarRecomendaciones() {
  const { data, error } = await supabase
    .from('recomendaciones_evaluacion')
    .select('id, nombre, texto')
    .eq('activo', true)
    .order('nombre');

  inf.recomendaciones = error ? [] : (data || []);
  pintarSelectRecomendaciones();
}

function pintarSelectRecomendaciones() {
  const $sel = document.getElementById('epi-recomendacion-elegir');
  if (!$sel) return;
  $sel.innerHTML = '<option value="">— Elegir de la biblioteca —</option>'
    + inf.recomendaciones.map((r) => `<option value="${r.id}">${escapar(r.nombre)}</option>`).join('');
}

export function usarRecomendacion() {
  const id = document.getElementById('epi-recomendacion-elegir').value;
  if (!id) return;
  const r = inf.recomendaciones.find((x) => x.id === id);
  if (!r) return;

  const $txt = document.getElementById('epi-recomendaciones');
  $txt.value = $txt.value.trim() ? `${$txt.value.trim()}\n${r.texto}` : r.texto;
  document.getElementById('epi-recomendacion-elegir').value = '';
}

export function abrirNuevaRecomendacion() {
  document.getElementById('epi-rec-nombre').value = '';
  document.getElementById('epi-rec-texto').value = '';
  document.getElementById('epi-rec-error').textContent = '';
  document.getElementById('epi-rec-form').hidden = false;
  document.getElementById('epi-rec-nombre').focus();
}

export function cancelarNuevaRecomendacion() {
  document.getElementById('epi-rec-form').hidden = true;
}

export async function guardarNuevaRecomendacion() {
  const $error = document.getElementById('epi-rec-error');
  $error.textContent = '';

  const nombre = document.getElementById('epi-rec-nombre').value.trim();
  const texto = document.getElementById('epi-rec-texto').value.trim();
  if (!nombre) return $error.textContent = 'Indique un nombre corto';
  if (!texto) return $error.textContent = 'Escriba el texto de la recomendación';

  const { data, error } = await supabase
    .from('recomendaciones_evaluacion').insert(alCrear({ nombre, texto })).select().single();

  if (error) {
    $error.textContent = error.code === '23505'
      ? 'Ya existe una recomendación con ese nombre.' : 'No se pudo guardar: ' + error.message;
    return;
  }

  inf.recomendaciones.push(data);
  inf.recomendaciones.sort((a, b) => a.nombre.localeCompare(b.nombre));
  pintarSelectRecomendaciones();

  const $txt = document.getElementById('epi-recomendaciones');
  $txt.value = $txt.value.trim() ? `${$txt.value.trim()}\n${texto}` : texto;
  document.getElementById('epi-rec-form').hidden = true;
}

/* ============================================
   Cálculo — Informe epidemiológico (de un año)
   ============================================ */

export async function generarInformeEpidemiologico() {
  const anio = parseInt(document.getElementById('epi-anio').value, 10);
  if (!anio) return avisar('No hay campañas capturadas todavía.', false, 'epi-alerta');

  /* El histórico solo se recargaba al ENTRAR a esta pestaña. Si
     se captura un resultado y se genera el informe sin salir y
     volver a entrar, se estaba usando una copia vieja en
     memoria que no incluía lo recién guardado. */
  await cargarHistorico();

  const filasAnio = inf.historico.filter((r) => r.anio === anio);
  if (filasAnio.length === 0) return avisar('No hay resultados capturados para ese año.', false, 'epi-alerta');

  /* --- Aspectos organizacionales: un trabajador cuenta una
     sola vez, aunque tenga diez exámenes ese año. --- */
  const trabajadores = new Map();
  filasAnio.forEach((r) => {
    if (!trabajadores.has(r.trabajador_id)) {
      trabajadores.set(r.trabajador_id, {
        sexo: r.sexo, edad: r.edad, cargo: r.cargo || 'Sin cargo registrado',
        antiguedadAnios: r.meses_antiguedad != null ? r.meses_antiguedad / 12 : null
      });
    }
  });
  const nomina = [...trabajadores.values()];
  const totalTrabajadores = nomina.length;

  const contarBucket = (lista, bucketFn, etiquetas) => {
    const mapa = new Map(etiquetas.map((e) => [e, 0]));
    lista.forEach((x) => {
      const b = bucketFn(x);
      if (mapa.has(b)) mapa.set(b, mapa.get(b) + 1);
    });
    return etiquetas.map((e) => ({ etiqueta: e, n: mapa.get(e), pct: pct(mapa.get(e), lista.length) }));
  };

  const porSexo = contarBucket(nomina, (x) => x.sexo === 'M' ? 'Masculino' : x.sexo === 'F' ? 'Femenino' : 'No registrado',
    ['Masculino', 'Femenino', 'No registrado']).filter((f) => f.n > 0 || f.etiqueta !== 'No registrado');

  const porEdad = contarBucket(nomina.filter((x) => x.edad != null), (x) => {
    if (x.edad < 18) return '< 18 años';
    if (x.edad <= 35) return '18 – 35 años';
    if (x.edad <= 59) return '36 – 59 años';
    return '> 60 años';
  }, ['< 18 años', '18 – 35 años', '36 – 59 años', '> 60 años']).filter((f) => f.n > 0);

  const edades = nomina.filter((x) => x.edad != null).map((x) => x.edad);
  const promedioEdad = edades.length > 0
    ? (edades.reduce((s, e) => s + e, 0) / edades.length).toFixed(1) : null;

  const porAntiguedad = contarBucket(nomina.filter((x) => x.antiguedadAnios != null), (x) => {
    if (x.antiguedadAnios < 1) return '< 1 año';
    if (x.antiguedadAnios <= 5) return '1 – 5 años';
    if (x.antiguedadAnios <= 10) return '6 – 10 años';
    return '> 10 años';
  }, ['< 1 año', '1 – 5 años', '6 – 10 años', '> 10 años']).filter((f) => f.n > 0);

  const porArea = new Map();
  nomina.forEach((x) => porArea.set(x.cargo, (porArea.get(x.cargo) || 0) + 1));
  const listaAreas = [...porArea.entries()].sort((a, b) => b[1] - a[1])
    .map(([cargo, n]) => ({ etiqueta: cargo, n, pct: pct(n, totalTrabajadores) }));

  /* --- Aspectos clínicos: por examen --- */
  const porExamen = new Map();
  filasAnio.forEach((r) => {
    if (!porExamen.has(r.examen)) porExamen.set(r.examen, []);
    porExamen.get(r.examen).push(r);
  });

  const clinico = [...porExamen.entries()].map(([examen, filas]) => {
    if (esExamenImc(examen)) {
      const categorias = contarBucket(filas, categoriaImc, ['Normal', 'Sobrepeso', 'Obesidad', 'Otro'])
        .filter((f) => f.n > 0);
      return { examen, tipo: 'imc', filas, total: filas.length, categorias };
    }
    const normales = filas.filter((f) => f.resultado === 'normal').length;
    const anormales = filas.filter((f) => f.resultado === 'anormal').length;
    const causas = new Map();
    filas.filter((f) => f.resultado === 'anormal' && f.condicion).forEach((f) => {
      const c = f.condicion.trim();
      causas.set(c, (causas.get(c) || 0) + 1);
    });
    return {
      examen, tipo: 'binario', filas, total: normales + anormales, normales, anormales,
      pctNormal: pct(normales, normales + anormales), pctAnormal: pct(anormales, normales + anormales),
      causas: [...causas.entries()]
    };
  });

  inf.epidemiologico = {
    anio, totalTrabajadores, porSexo, porEdad, promedioEdad, porAntiguedad, listaAreas, clinico,
    tendencia: calcularTendencia()
  };

  pintarPreviaEpidemiologico();
}

/* Tendencia multianual: usa TODO el histórico (no solo el año
   elegido), para poder comparar 2025 contra 2026 contra 2027 —
   la idea original de "cuántos con parásitos antes y ahora". */
function calcularTendencia() {
  const anios = [...new Set(inf.historico.map((r) => r.anio))].sort();
  if (anios.length < 2) return null; // no hay nada que comparar todavía

  const porExamenAnio = new Map();
  inf.historico.forEach((r) => {
    if (!porExamenAnio.has(r.examen)) porExamenAnio.set(r.examen, new Map());
    const porAnio = porExamenAnio.get(r.examen);
    if (!porAnio.has(r.anio)) porAnio.set(r.anio, { normal: 0, anormal: 0 });
    const c = porAnio.get(r.anio);
    if (r.resultado === 'anormal') c.anormal++;
    else if (r.resultado === 'normal') c.normal++;
  });

  const topExamenes = [...porExamenAnio.entries()]
    .map(([examen, porAnio]) => ({ examen, total: [...porAnio.values()].reduce((s, c) => s + c.anormal, 0) }))
    .sort((a, b) => b.total - a.total).slice(0, 5).map((x) => x.examen);

  return { anios, porExamenAnio, topExamenes };
}

function pct(n, total) {
  return total > 0 ? Math.round(n * 100 / total) : 0;
}

function pintarPreviaEpidemiologico() {
  const e = inf.epidemiologico;
  document.getElementById('epi-previa').hidden = false;
  document.getElementById('epi-previa-resumen').textContent =
    `Año ${e.anio} · ${e.totalTrabajadores} trabajadores evaluados · ${e.clinico.length} tipos de examen`
    + (e.tendencia ? ` · con tendencia multianual (${e.tendencia.anios.join(', ')})` : '');
}

/* ============================================
   Cálculo — Informe de seguimiento (nominal, multi-año)
   ============================================ */

export async function generarInformeSeguimiento() {
  await cargarHistorico();
  if (inf.historico.length === 0) return avisar('No hay resultados capturados todavía.', false, 'seg-alerta');

  /* Agrupar por trabajador + examen: cada combinación reúne
     todo lo capturado de esa persona en ese examen, sin
     importar en cuántos años. */
  const grupos = new Map();
  inf.historico.forEach((r) => {
    const clave = `${r.trabajador_id}·${r.examen_id}`;
    if (!grupos.has(clave)) {
      grupos.set(clave, {
        codigo: r.codigo, nombre: r.nombre_completo, cargo: r.cargo,
        examen: r.examen, filas: []
      });
    }
    grupos.get(clave).filas.push({ anio: r.anio, resultado: r.resultado, condicion: r.condicion, valor: r.valor });
  });

  const casos = [...grupos.values()]
    .filter((g) => g.filas.some((f) => f.resultado === 'anormal'))
    .map((g) => ({ ...g, filas: g.filas.sort((a, b) => a.anio - b.anio) }));

  if (casos.length === 0) return avisar('No hay ningún trabajador con resultado anormal registrado todavía.', false, 'seg-alerta');

  /* Una tabla por examen, dinámica: si mañana se agrega un
     examen nuevo al catálogo, aparece solo, sin tocar código. */
  const porExamen = new Map();
  casos.forEach((c) => {
    if (!porExamen.has(c.examen)) porExamen.set(c.examen, []);
    porExamen.get(c.examen).push(c);
  });

  inf.seguimiento = {
    tablas: [...porExamen.entries()].map(([examen, lista]) => ({
      examen, esImc: esExamenImc(examen),
      lista: lista.sort((a, b) => (a.codigo ?? 9999) - (b.codigo ?? 9999))
    }))
  };

  pintarPreviaSeguimiento();
}

function pintarPreviaSeguimiento() {
  const totalCasos = inf.seguimiento.tablas.reduce((s, t) => s + t.lista.length, 0);
  document.getElementById('seg-previa').hidden = false;
  document.getElementById('seg-previa-resumen').textContent =
    `${totalCasos} caso(s) en ${inf.seguimiento.tablas.length} tipo(s) de examen`;
}

/* ============================================
   Gráfico de barras (mismo patrón que informe-atenciones.js)
   ============================================ */

function graficoBarras(items, opciones = {}) {
  const ancho = opciones.ancho || 460, alto = opciones.alto || 160;
  const color = opciones.color || '#1F4E79';
  if (items.length === 0) return '<p class="if-nota">Sin datos para graficar.</p>';

  const margenIzq = 8, margenInf = 24, margenSup = 14;
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
            <text x="${(x + anchoBarra / 2).toFixed(1)}" y="${alto - margenInf + 12}" font-size="7.5" text-anchor="middle" fill="#444">${escapar(String(item.etiqueta))}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${ancho} ${alto}" width="100%" style="max-width:${ancho}px; display:block; margin:0 auto;">
    <line x1="${margenIzq}" y1="${alto - margenInf}" x2="${ancho - 8}" y2="${alto - margenInf}" stroke="#B0BEC9" stroke-width="0.6"/>
    ${barras}
  </svg>`;
}

function graficoBarrasAgrupado(anios, series, opciones = {}) {
  const ancho = opciones.ancho || 460, alto = opciones.alto || 180;
  const colores = ['#1F4E79', '#1b5e20', '#b5531a', '#7a1f9c', '#666'];

  const margenIzq = 10, margenInf = 34, margenSup = 14;
  const anchoUtil = ancho - margenIzq - 10;
  const altoUtil = alto - margenInf - margenSup;
  const max = Math.max(1, ...series.flatMap((s) => s.valores));
  const grupoAncho = anchoUtil / anios.length;
  const barraAncho = Math.min((grupoAncho / series.length) * 0.7, 24);

  let barras = '';
  anios.forEach((anio, gi) => {
    series.forEach((s, si) => {
      const valor = s.valores[gi] || 0;
      const h = (valor / max) * altoUtil;
      const x = margenIzq + gi * grupoAncho + si * (grupoAncho / series.length) + 3;
      const y = margenSup + (altoUtil - h);
      barras += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barraAncho.toFixed(1)}" height="${h.toFixed(1)}" fill="${colores[si % colores.length]}" rx="1"/>`;
      barras += `<text x="${(x + barraAncho / 2).toFixed(1)}" y="${(y - 2).toFixed(1)}" font-size="7" text-anchor="middle" fill="#1F2937">${valor}</text>`;
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

function fuente(anio) {
  return `<p class="if-fuente">FUENTE: ${escapar(inf.empresaNombre.toUpperCase())}, ${anio}.</p>`;
}

function membreteHtml(titulo, periodo) {
  return `<header class="if-membrete">
    <img src="logo.png" class="if-membrete-logo" alt="">
    <div class="if-membrete-texto">
      <strong>${escapar(inf.empresaNombre || 'Empresa')}</strong><br>
      Unidad de Seguridad y Salud Ocupacional · Servicios Médicos
    </div>
    <div class="if-membrete-ref">${titulo}<br>${escapar(periodo)}</div>
  </header>`;
}

function portadaHtml(titulo, periodo, quien) {
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
      <p class="if-portada-empresa">${escapar(inf.empresaNombre || 'Empresa')}</p>
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

function tablaSimple(filas) {
  return `<table class="if-tabla">
    <thead><tr><th class="if-izq">Categoría</th><th>N.°</th><th>%</th></tr></thead>
    <tbody>${filas.map((f) => `<tr><td class="if-izq">${escapar(f.etiqueta)}</td><td>${f.n}</td><td>${f.pct}%</td></tr>`).join('')}</tbody>
  </table>`;
}

function prosaDistribucion(filas, sujeto) {
  const partes = filas.map((f) => `el ${f.pct}% (${f.n}) ${f.etiqueta.toLowerCase()}`);
  if (partes.length === 0) return '';
  if (partes.length === 1) return `De ${sujeto}, ${partes[0]}.`;
  return `De ${sujeto}, ${partes.slice(0, -1).join(', ')}, mientras que ${partes[partes.length - 1]}.`;
}

/* ============================================
   Descargar — Informe epidemiológico
   ============================================ */

export async function descargarInformeEpidemiologico() {
  const e = inf.epidemiologico;
  if (!e) return avisar('Genere primero el informe.', false, 'epi-alerta');

  const resumen = document.getElementById('epi-resumen-texto').value;
  const exposicion = document.getElementById('epi-exposicion').value;
  const conclusiones = document.getElementById('epi-conclusiones').value;
  const recomendaciones = document.getElementById('epi-recomendaciones').value;
  const quien = quienElabora();
  const sujeto = `los ${e.totalTrabajadores} trabajadores evaluados en la empresa`;

  const bloqueOrg = `
    <h2 class="if-seccion">1. Aspectos organizacionales</h2>
    <p>Trabajadores evaluados: <strong>${e.totalTrabajadores}</strong></p>

    <h3 class="if-subseccion">1.1 Distribución por sexo</h3>
    ${tablaSimple(e.porSexo)}
    ${fuente(e.anio)}
    <p>${prosaDistribucion(e.porSexo, sujeto)}</p>

    <h3 class="if-subseccion">1.2 Distribución por edad</h3>
    ${tablaSimple(e.porEdad)}
    ${fuente(e.anio)}
    <p>${prosaDistribucion(e.porEdad, sujeto)}${e.promedioEdad ? ` Promedio de edad: ${e.promedioEdad} años.` : ''}</p>

    <h3 class="if-subseccion">1.3 Distribución por tiempo de trabajo</h3>
    ${tablaSimple(e.porAntiguedad)}
    ${fuente(e.anio)}
    <p>${prosaDistribucion(e.porAntiguedad, sujeto)}</p>

    <h3 class="if-subseccion">1.4 Distribución por área de trabajo</h3>
    ${tablaSimple(e.listaAreas)}
    ${fuente(e.anio)}
    <p>${prosaDistribucion(e.listaAreas, sujeto)}</p>`;

  const bloqueClinico = e.clinico.map((c, i) => {
    const accion = accionParaExamen(c.examen);
    let tabla, prosa;

    if (c.tipo === 'imc') {
      tabla = tablaSimple(c.categorias);
      prosa = `Se realizó ${accion} a ${sujeto}. ${prosaDistribucion(c.categorias, sujeto)}`;
    } else {
      const filasTabla = [
        { etiqueta: 'Normal', n: c.normales, pct: c.pctNormal },
        { etiqueta: 'Anormal', n: c.anormales, pct: c.pctAnormal }
      ];
      tabla = tablaSimple(filasTabla);
      const causasTxt = c.causas.length > 0
        ? ` (${c.causas.map(([txt, n]) => `${escapar(txt)} ${n}`).join(' — ')})` : '';
      prosa = `Se realizó ${accion} a ${sujeto}, durante el año ${e.anio}. Se pudo evidenciar que el `
        + `${c.pctNormal}% (${c.normales}) presentaron resultados dentro de parámetros normales, `
        + `mientras que el ${c.pctAnormal}% (${c.anormales}) presentaron alteraciones${causasTxt}.`;
    }

    return `<h3 class="if-subseccion">2.${i + 1} Distribución según ${escapar(c.examen)}</h3>
      ${tabla}
      ${fuente(e.anio)}
      <p>${prosa}</p>`;
  }).join('');

  const bloqueTendencia = e.tendencia ? `
    <h2 class="if-seccion">3. Tendencia multianual</h2>
    <p>Comparación de los hallazgos anormales por examen entre los años ${e.tendencia.anios.join(', ')}, para observar la evolución de la empresa en el tiempo.</p>
    ${graficoBarrasAgrupado(
      e.tendencia.anios,
      e.tendencia.topExamenes.map((examen) => ({
        nombre: examen,
        valores: e.tendencia.anios.map((a) => e.tendencia.porExamenAnio.get(examen).get(a)?.anormal || 0)
      }))
    )}` : '';

  const numeroConclusiones = e.tendencia ? 4 : 3;
  const numeroRecomendaciones = numeroConclusiones + 1;

  const html = `
    ${portadaHtml('Informe epidemiológico<br>de exámenes médicos ocupacionales', `Correspondiente al año ${e.anio}`, quien)}
    <section class="if-contenido">
      ${membreteHtml('Informe epidemiológico', `Año ${e.anio}`)}

      <h2 class="if-seccion">Resumen</h2>
      <p>${escapar(resumen)}</p>

      <h2 class="if-seccion">Exposición de motivos</h2>
      <p>${escapar(exposicion)}</p>

      ${bloqueOrg}

      <h2 class="if-seccion">2. Aspectos clínicos epidemiológicos ocupacionales</h2>
      <p>Se corresponde con los hallazgos clínicos obtenidos en las evaluaciones médicas y su relación con los riesgos ocupacionales identificados, con el objeto de establecer correlaciones con fines diagnósticos y comparativos.</p>
      ${bloqueClinico}

      ${bloqueTendencia}

      <h2 class="if-seccion">${numeroConclusiones}. Conclusiones</h2>
      <p>${escapar(conclusiones)}</p>

      <h2 class="if-seccion">${numeroRecomendaciones}. Recomendaciones</h2>
      <ul class="if-lista">${recomendaciones.split(/\n+/).map((x) => x.trim()).filter(Boolean).map((x) => `<li>${escapar(x)}</li>`).join('')}</ul>

      <div class="if-firmas">
        <div class="if-firma">
          <div class="if-firma-linea"></div>
          <p class="if-firma-rotulo">Elaborado por</p>
          <p class="if-firma-nombre">${escapar(quien || 'No identificado')}</p>
        </div>
      </div>
    </section>`;

  await imprimir(html, `Informe epidemiológico · ${e.anio}`, 'epi-alerta');
}

/* ============================================
   Descargar — Informe de seguimiento
   ============================================ */

export async function descargarInformeSeguimiento() {
  const s = inf.seguimiento;
  if (!s) return avisar('Genere primero el informe.', false, 'seg-alerta');
  const quien = quienElabora();

  const bloques = s.tablas.map((t, i) => {
    if (t.esImc) {
      const filas = t.lista.map((c) => {
        const actual = categoriaImc(c.filas[c.filas.length - 1]);
        const historial = c.filas.length > 1
          ? c.filas.map((f) => `${f.anio}: ${categoriaImc(f)}`).join(' → ')
          : '';
        return `<tr>
          <td class="if-izq">${escapar(c.nombre)}</td>
          <td class="if-izq">${escapar(c.cargo || '—')}</td>
          <td>${actual === 'Sobrepeso' ? 'X' : ''}</td>
          <td>${actual === 'Obesidad' ? 'X' : ''}</td>
          <td class="if-izq">${escapar(historial)}</td>
        </tr>`;
      }).join('');
      return `<h3 class="if-subseccion">${i + 1}. ${escapar(t.examen)}</h3>
        <table class="if-tabla">
          <thead><tr><th class="if-izq">Apellidos y nombres</th><th class="if-izq">Cargo</th><th>Sobrepeso</th><th>Obesidad</th><th class="if-izq">Historial por año</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>`;
    }

    const filas = t.lista.map((c) => {
      const historial = c.filas.map((f) => {
        const detalle = [f.valor, f.condicion].filter(Boolean).join(' · ');
        return `${f.anio}: ${f.resultado}${detalle ? ' (' + escapar(detalle) + ')' : ''}`;
      }).join(' → ');
      return `<tr>
        <td class="if-izq">${escapar(c.nombre)}</td>
        <td class="if-izq">${escapar(c.cargo || '—')}</td>
        <td class="if-izq">${historial}</td>
      </tr>`;
    }).join('');
    return `<h3 class="if-subseccion">${i + 1}. ${escapar(t.examen)}</h3>
      <table class="if-tabla">
        <thead><tr><th class="if-izq">Apellidos y nombres</th><th class="if-izq">Cargo</th><th class="if-izq">Diagnóstico / historial por año</th></tr></thead>
        <tbody>${filas}</tbody>
      </table>`;
  }).join('');

  const html = `
    ${portadaHtml('Informe de seguimiento<br>de casos con resultado anormal', 'Histórico acumulado', quien)}
    <section class="if-contenido">
      ${membreteHtml('Informe de seguimiento', 'Histórico acumulado')}

      <h2 class="if-seccion">Objetivo</h2>
      <p>Dar seguimiento nominal a los trabajadores de ${escapar(inf.empresaNombre)} que han presentado al menos un resultado anormal en alguna evaluación médica ocupacional periódica, mostrando su evolución completa entre campañas cuando hay más de un año capturado.</p>

      <p class="if-nota"><strong>Confidencial:</strong> contiene información de salud de trabajadores identificados; su distribución se limita al personal médico y de Talento Humano autorizado, conforme al artículo 45 del Reglamento SISAT.</p>

      ${bloques}

      <div class="if-firmas">
        <div class="if-firma">
          <div class="if-firma-linea"></div>
          <p class="if-firma-rotulo">Elaborado por</p>
          <p class="if-firma-nombre">${escapar(quien || 'No identificado')}</p>
        </div>
      </div>
    </section>`;

  await imprimir(html, 'Informe de seguimiento · histórico', 'seg-alerta');
}

async function imprimir(html, titulo, destino) {
  const $z = document.getElementById('epi-impresion');
  if (!$z) return avisar('Falta actualizar la página para poder imprimir.', false, destino);
  $z.innerHTML = html;
  avisar('En el diálogo de impresión: active «Gráficos de fondo».', true, destino);
  await imprimirHoja('epi-impresion', 'imprimiendo-informe', titulo);
}

function avisar(texto, exito = false, destino = 'epi-alerta') {
  const $a = document.getElementById(destino);
  if (!$a) return alert(texto);
  $a.textContent = texto;
  $a.className = exito ? 'alerta alerta-ok' : 'alerta';
  $a.hidden = false;
  setTimeout(() => { $a.hidden = true; }, 6000);
}

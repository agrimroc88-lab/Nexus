/* ============================================
   NEXUS · informe-test-atd.js

   Tres salidas, de las dos tablas del test A-T-D:

     · ANUAL         estadística agregada y anónima de UN año.
     · COMPARATIVO   la misma estadística, dos o más años lado
                      a lado — disponible desde la segunda
                      campaña capturada (ej. 2026 vs 2027).
     · SEGUIMIENTO   listado identificado de quienes pidieron
                      tratamiento, con su estado de gestión.
                      Aparte de los dos anteriores: nunca cruza
                      con las respuestas anónimas.

   Mismo patrón de maquetación que informe-evaluacion-periodica.js
   (portada, membrete, tablas ".if-*", gráficos SVG a mano).
   ============================================ */

import { sesionActual } from './auth.js?v=11';
import { escapar, formatearFecha } from './utils.js?v=12';
import { imprimirHoja } from './impresion.js?v=11';
import {
  estadoAtd, avisar,
  CAT_GENERO, CAT_AFILIACION, CAT_ESTADO_CIVIL, CAT_INSTRUCCION, CAT_ETNIA,
  CAT_DISCAPACIDAD, CAT_ENFERMEDAD, CAT_DROGA, CAT_FRECUENCIA, CAT_RECONOCE,
  CAT_FACTOR, CAT_ESTADO_DERIVACION
} from './test-atd.js?v=1';

const VERSION = 'v1';
console.info('NEXUS · informe-test-atd', VERSION);

const inf = { anual: null, comparativo: null };

/* Dimensiones que se tabulan en ambos informes. El orden aquí
   es el orden en el que salen en el documento. */
const DIMENSIONES = [
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

function pct(n, total) { return total > 0 ? Math.round((n * 100) / total) : 0; }

/* ============================================
   Selectores de año (informe y comparativo)
   ============================================ */

export function iniciarInformeAtd() {
  llenarSelectorAnioInforme();
  llenarSelectoresComparativo();
}

function aniosDisponibles() {
  return [...new Set(estadoAtd().respuestas.map((r) => r.anio))].sort((a, b) => b - a);
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
    .map(([valor, n]) => ({ valor, etiqueta: dim.catalogo[valor] || valor, n, pct: pct(n, total) }))
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

/* ============================================
   Informe anual
   ============================================ */

export function generarInformeAnualAtd() {
  const anio = parseInt(document.getElementById('atd-inf-anio').value, 10);
  if (!anio) return avisar('No hay campañas capturadas todavía.', false, 'atd-inf-alerta');

  const filas = estadoAtd().respuestas.filter((r) => r.anio === anio);
  if (filas.length === 0) return avisar('No hay registros para ese año.', false, 'atd-inf-alerta');

  inf.anual = calcularEstadisticas(filas, anio);

  document.getElementById('atd-inf-previa').hidden = false;
  document.getElementById('atd-inf-previa-resumen').textContent =
    `Año ${anio} · ${inf.anual.total} personas evaluadas · `
    + `${inf.anual.pctConsumeAlgo}% reporta algún consumo`;
}

export async function descargarInformeAnualAtd() {
  const e = inf.anual;
  if (!e) return avisar('Genere primero el informe.', false, 'atd-inf-alerta');
  const quien = quienElabora();
  const empresaNombre = estadoAtd().empresaNombre;

  const bloqueResumen = `
    <h2 class="if-seccion">Resumen ejecutivo</h2>
    <p>Durante el año ${e.anio} se aplicó el test de diagnóstico inicial de consumo de alcohol,
    tabaco y otras drogas a <strong>${e.total}</strong> trabajador(es) de ${escapar(empresaNombre)}.
    El ${e.pctConsumeAlgo}% (${e.consumeAlgo}) reportó consumir alguna sustancia como droga
    principal, el ${e.pctReconocen}% (${e.reconocenProblema}) reconoció tener un problema de
    consumo, y el ${e.pctDesean}% (${e.desean}) manifestó su deseo de recibir tratamiento.</p>
    <p class="if-nota">Este informe presenta estadística agregada y anónima: no identifica a
    ninguna persona. Los casos que solicitaron tratamiento se gestionan aparte, en el listado de
    seguimiento de derivaciones.</p>`;

  const bloqueEdad = e.edad ? `
    <h3 class="if-subseccion">Distribución por edad</h3>
    ${tablaSimple(e.edad.buckets)}
    ${graficoBarras(e.edad.buckets.map((b) => ({ etiqueta: b.etiqueta, valor: b.n })))}
    <p>La edad promedio de las personas evaluadas fue de ${e.edad.promedio} años.</p>` : '';

  const bloquesDimension = e.dimensiones.map((dim, i) => {
    if (dim.datos.length === 0) return '';
    return `<h3 class="if-subseccion">${i + 1}. ${escapar(dim.titulo)}</h3>
      ${tablaSimple(dim.datos)}
      ${graficoBarras(dim.datos.slice(0, 8).map((d) => ({ etiqueta: d.etiqueta, valor: d.n })))}
      ${fuente(e.anio, empresaNombre)}`;
  }).join('');

  const html = `
    ${portadaHtml('Informe anual<br>Test de consumo de alcohol, tabaco y otras drogas',
      `Correspondiente al año ${e.anio}`, quien, empresaNombre)}
    <section class="if-contenido">
      ${membreteHtml('Informe anual · Test A-T-D', `Año ${e.anio}`, empresaNombre)}
      ${bloqueResumen}
      ${bloqueEdad}
      <h2 class="if-seccion">Distribución detallada</h2>
      ${bloquesDimension}
      <div class="if-firmas">
        <div class="if-firma">
          <div class="if-firma-linea"></div>
          <p class="if-firma-rotulo">Elaborado por</p>
          <p class="if-firma-nombre">${escapar(quien || 'No identificado')}</p>
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
  const porAnio = anios.map((anio) => {
    const filas = estadoAtd().respuestas.filter((r) => r.anio === anio);
    return { anio, filas, stats: calcularEstadisticas(filas, anio) };
  }).filter((x) => x.filas.length > 0);

  if (porAnio.length < 2) {
    return avisar('No hay suficientes registros en los años elegidos para comparar.', false, 'atd-comp-alerta');
  }

  inf.comparativo = { anios: porAnio.map((x) => x.anio), porAnio };

  document.getElementById('atd-comp-previa').hidden = false;
  document.getElementById('atd-comp-previa-resumen').textContent =
    `Comparando ${porAnio.map((x) => `${x.anio} (${x.filas.length})`).join(' vs ')}`;
}

export async function descargarInformeComparativoAtd() {
  const c = inf.comparativo;
  if (!c) return avisar('Genere primero el informe.', false, 'atd-comp-alerta');
  const quien = quienElabora();
  const empresaNombre = estadoAtd().empresaNombre;
  const anios = c.anios;

  const filaTotales = { etiqueta: 'Total evaluados', n: null,
    valores: c.porAnio.map((x) => x.filas.length) };

  const bloqueTotales = `
    <h2 class="if-seccion">1. Cobertura por año</h2>
    ${graficoBarras(c.porAnio.map((x) => ({ etiqueta: String(x.anio), valor: x.filas.length })))}
    <table class="if-tabla">
      <thead><tr><th class="if-izq">Año</th><th>Evaluados</th><th>% consume algo</th>
        <th>% reconoce problema</th><th>% desea tratamiento</th></tr></thead>
      <tbody>${c.porAnio.map((x) => `<tr>
        <td class="if-izq">${x.anio}</td><td>${x.filas.length}</td>
        <td>${x.stats.pctConsumeAlgo}%</td><td>${x.stats.pctReconocen}%</td>
        <td>${x.stats.pctDesean}%</td></tr>`).join('')}</tbody>
    </table>`;

  const bloquesDimension = DIMENSIONES.map((dim, i) => {
    /* Categorías que aparecieron en cualquiera de los años,
       ordenadas por su peso total, top 6 para que el gráfico
       agrupado no se sature. */
    const pesos = new Map();
    c.porAnio.forEach((x) => {
      contarDimension(x.filas, dim).forEach((d) => {
        pesos.set(d.valor, (pesos.get(d.valor) || 0) + d.n);
      });
    });
    const top = [...pesos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([v]) => v);
    if (top.length === 0) return '';

    const series = top.map((valor) => ({
      nombre: dim.catalogo[valor] || valor,
      valores: c.porAnio.map((x) => contarDimension(x.filas, dim).find((d) => d.valor === valor)?.n || 0)
    }));

    const filasTabla = top.map((valor) => {
      const etiqueta = dim.catalogo[valor] || valor;
      const celdas = c.porAnio.map((x) => {
        const d = contarDimension(x.filas, dim).find((dd) => dd.valor === valor);
        return `<td>${d ? `${d.n} (${d.pct}%)` : '0 (0%)'}</td>`;
      }).join('');
      return `<tr><td class="if-izq">${escapar(etiqueta)}</td>${celdas}</tr>`;
    }).join('');

    return `<h3 class="if-subseccion">${i + 2}. ${escapar(dim.titulo)}</h3>
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
      <p class="if-nota">Estadística agregada y anónima: no identifica a ninguna persona.</p>

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

  const filas = estadoAtd().derivaciones.filter((d) =>
    (!anioFiltro || String(d.anio) === anioFiltro)
    && (!estadoFiltro || d.estado === estadoFiltro));

  if (filas.length === 0) {
    return avisar('No hay casos que coincidan con el filtro elegido.', false, 'atd-deriv-alerta');
  }

  const cuerpo = filas.map((d) => `<tr>
    <td class="if-izq">${escapar(d.nombre_completo)}</td>
    <td class="if-izq">${escapar(d.cedula || '—')}</td>
    <td class="if-izq">${escapar(d.telefono || '—')}</td>
    <td class="if-izq">${escapar(d.direccion || '—')}</td>
    <td>${d.anio}</td>
    <td class="if-izq">${escapar(CAT_ESTADO_DERIVACION[d.estado] || d.estado)}</td>
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
          <th class="if-izq">Nombre</th><th class="if-izq">Cédula</th>
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

async function imprimir(html, titulo, destino) {
  const $z = document.getElementById('atd-impresion');
  if (!$z) return avisar('Falta actualizar la página para poder imprimir.', false, destino);
  $z.innerHTML = html;
  avisar('En el diálogo de impresión: active «Gráficos de fondo».', true, destino);
  await imprimirHoja('atd-impresion', 'imprimiendo-informe', titulo);
}

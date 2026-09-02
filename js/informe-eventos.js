/* ============================================
   NEXUS · informe-eventos.js

   Informe de Incidentes y Accidentes — Seguridad Industrial.
   Mismo formato de casa que los demás informes (portada,
   membrete, tablas con FUENTE y párrafo interpretativo,
   gráfico, conclusiones y recomendaciones de biblioteca).

   De un año específico (como el epidemiológico de evaluación
   periódica), usando lo que ya calculan v_eventos_sst (detalle,
   para área/turno/sexo/causas/gestión) y v_indicadores_eventos
   (agregado, para las cifras generales del periodo).
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { sesionActual } from './auth.js?v=11';
import { escapar, formatearFecha } from './utils.js?v=12';
import { alCrear } from './autoria.js?v=1';
import { imprimirHoja } from './impresion.js?v=11';
import { logoEmpresa } from './logo-empresa.js';

const VERSION = 'v1';
console.info('NEXUS · informe-eventos', VERSION);

const inf = {
  empresaId: null, empresaNombre: '', logoUrl: 'logo.png',
  eventos: [], indicadores: [], recomendaciones: [],
  datos: null
};

const TEXTOS = {
  resumen:
    'En el presente informe se expone el comportamiento de los incidentes y accidentes de ' +
    'trabajo registrados en la empresa, en atención a lo establecido en el ordenamiento legal ' +
    'vigente: Decreto Ejecutivo N.° 255 (Reglamento de Seguridad y Salud de los Trabajadores), ' +
    'Resolución CD 513 del Instituto Ecuatoriano de Seguridad Social (Reglamento del Seguro ' +
    'General de Riesgos del Trabajo) y Decisión 584 de la Comunidad Andina (Instrumento Andino ' +
    'de Seguridad y Salud en el Trabajo). Consta de la distribución de los eventos por tipo, ' +
    'área, turno y sexo, el análisis de sus causas más frecuentes, y el estado de cumplimiento ' +
    'en materia de investigación y notificación a la autoridad competente.',

  exposicion:
    'La investigación sistemática de todo incidente y accidente de trabajo permite identificar ' +
    'las causas inmediatas y básicas que los originan, y constituye la base para diseñar medidas ' +
    'correctivas que impidan su repetición. La normativa ecuatoriana exige que todo accidente de ' +
    'trabajo sea notificado al Seguro General de Riesgos del Trabajo dentro de los diez (10) ' +
    'días hábiles siguientes a su ocurrencia, y que se documente la investigación correspondiente, ' +
    'como parte de la gestión preventiva de la organización.',

  conclusion:
    'El conjunto de datos aportados por el presente estudio permite identificar las áreas, ' +
    'turnos y causas de mayor incidencia, orientando la priorización de las medidas correctivas ' +
    'y preventivas necesarias para reducir la siniestralidad de la empresa.',

  recomendaciones:
    'Investigar todo incidente y accidente dentro de las 24 horas siguientes a su ocurrencia, ' +
    'documentando causas inmediatas y básicas.\n' +
    'Reforzar la inducción y el reentrenamiento en seguridad en las áreas con mayor frecuencia ' +
    'de eventos.\n' +
    'Verificar el uso correcto del equipo de protección personal en las tareas de mayor riesgo ' +
    'identificadas.\n' +
    'Dar seguimiento documentado al cumplimiento de las medidas correctivas derivadas de cada ' +
    'investigación.\n' +
    'Divulgar las lecciones aprendidas de cada evento al personal del área involucrada.'
};

/* ============================================
   Arranque y carga
   ============================================ */

export async function iniciarInformeEventos(empresaId, empresaNombre) {
  inf.empresaId = empresaId;
  inf.empresaNombre = empresaNombre || '';
  inf.logoUrl = await logoEmpresa(empresaId);

  await Promise.all([cargarHistorico(), cargarRecomendaciones()]);
  llenarSelectorAnio();
  pintarTextosPorDefecto();
}

async function cargarHistorico() {
  const [ev, ind] = await Promise.all([
    supabase.from('v_eventos_sst').select('*')
      .eq('empresa_id', inf.empresaId).order('fecha'),
    supabase.from('v_indicadores_eventos').select('*')
      .eq('empresa_id', inf.empresaId)
  ]);

  inf.eventos = ev.error ? [] : (ev.data || []);
  inf.indicadores = ind.error ? [] : (ind.data || []);
}

function llenarSelectorAnio() {
  const $s = document.getElementById('infoev-anio');
  if (!$s) return;
  const anios = [...new Set(inf.eventos.map((e) => e.anio))].sort((a, b) => b - a);
  $s.innerHTML = anios.map((a) => `<option value="${a}">${a}</option>`).join('')
    || '<option value="">— Sin eventos registrados —</option>';
}

function pintarTextosPorDefecto() {
  const poner = (id, valor) => {
    const $t = document.getElementById(id);
    if ($t && !$t.value.trim()) $t.value = valor;
  };
  poner('infoev-resumen-texto', TEXTOS.resumen);
  poner('infoev-exposicion', TEXTOS.exposicion);
  poner('infoev-conclusiones', TEXTOS.conclusion);
  poner('infoev-recomendaciones', TEXTOS.recomendaciones);
}

/* ============================================
   Biblioteca de recomendaciones
   ============================================ */

async function cargarRecomendaciones() {
  const { data, error } = await supabase
    .from('recomendaciones_seguridad')
    .select('id, nombre, texto')
    .eq('activo', true)
    .order('nombre');

  inf.recomendaciones = error ? [] : (data || []);
  pintarSelectRecomendaciones();
}

function pintarSelectRecomendaciones() {
  const $sel = document.getElementById('infoev-recomendacion-elegir');
  if (!$sel) return;
  $sel.innerHTML = '<option value="">— Elegir de la biblioteca —</option>'
    + inf.recomendaciones.map((r) => `<option value="${r.id}">${escapar(r.nombre)}</option>`).join('');
}

export function usarRecomendacionEventos() {
  const id = document.getElementById('infoev-recomendacion-elegir').value;
  if (!id) return;
  const r = inf.recomendaciones.find((x) => x.id === id);
  if (!r) return;

  const $txt = document.getElementById('infoev-recomendaciones');
  $txt.value = $txt.value.trim() ? `${$txt.value.trim()}\n${r.texto}` : r.texto;
  document.getElementById('infoev-recomendacion-elegir').value = '';
}

export function abrirNuevaRecomendacionEventos() {
  document.getElementById('infoev-rec-nombre').value = '';
  document.getElementById('infoev-rec-texto').value = '';
  document.getElementById('infoev-rec-error').textContent = '';
  document.getElementById('infoev-rec-form').hidden = false;
  document.getElementById('infoev-rec-nombre').focus();
}

export function cancelarNuevaRecomendacionEventos() {
  document.getElementById('infoev-rec-form').hidden = true;
}

export async function guardarNuevaRecomendacionEventos() {
  const $error = document.getElementById('infoev-rec-error');
  $error.textContent = '';

  const nombre = document.getElementById('infoev-rec-nombre').value.trim();
  const texto = document.getElementById('infoev-rec-texto').value.trim();
  if (!nombre) return $error.textContent = 'Indique un nombre corto';
  if (!texto) return $error.textContent = 'Escriba el texto de la recomendación';

  const { data, error } = await supabase
    .from('recomendaciones_seguridad').insert(alCrear({ nombre, texto })).select().single();

  if (error) {
    $error.textContent = error.code === '23505'
      ? 'Ya existe una recomendación con ese nombre.' : 'No se pudo guardar: ' + error.message;
    return;
  }

  inf.recomendaciones.push(data);
  inf.recomendaciones.sort((a, b) => a.nombre.localeCompare(b.nombre));
  pintarSelectRecomendaciones();

  const $txt = document.getElementById('infoev-recomendaciones');
  $txt.value = $txt.value.trim() ? `${$txt.value.trim()}\n${texto}` : texto;
  document.getElementById('infoev-rec-form').hidden = true;
}

/* ============================================
   Cálculo del informe (de un año)
   ============================================ */

function pct(n, total) {
  return total > 0 ? Math.round(n * 100 / total) : 0;
}

function contarBucket(lista, bucketFn, etiquetas) {
  const mapa = new Map(etiquetas.map((e) => [e, 0]));
  lista.forEach((x) => {
    const b = bucketFn(x);
    if (mapa.has(b)) mapa.set(b, mapa.get(b) + 1);
  });
  return etiquetas.map((e) => ({ etiqueta: e, n: mapa.get(e), pct: pct(mapa.get(e), lista.length) }));
}

export function generarInformeEventos() {
  const anio = parseInt(document.getElementById('infoev-anio').value, 10);
  if (!anio) return avisar('No hay eventos registrados todavía.');

  const eventosAnio = inf.eventos.filter((e) => e.anio === anio);
  if (eventosAnio.length === 0) return avisar('No hay eventos registrados para ese año.');

  const indAnio = inf.indicadores.filter((i) => i.anio === anio);
  const totales = {};
  ['incidentes', 'accidentes', 'accidentes_baja', 'total_eventos', 'dias_perdidos',
   'hombres', 'mujeres', 'turno_dia', 'turno_tarde', 'turno_noche',
   'sin_investigar', 'sin_reportar'].forEach((campo) => {
    totales[campo] = indAnio.reduce((s, i) => s + (Number(i[campo]) || 0), 0);
  });

  const totalEventos = eventosAnio.length;

  const porTipo = contarBucket(eventosAnio, (e) => e.tipo,
    ['incidente', 'accidente', 'accidente_baja'])
    .map((f) => ({ ...f, etiqueta: { incidente: 'Incidente', accidente: 'Accidente sin baja', accidente_baja: 'Accidente con baja' }[f.etiqueta] }));

  const porTurno = [
    { etiqueta: 'Día', n: totales.turno_dia, pct: pct(totales.turno_dia, totalEventos) },
    { etiqueta: 'Tarde', n: totales.turno_tarde, pct: pct(totales.turno_tarde, totalEventos) },
    { etiqueta: 'Noche', n: totales.turno_noche, pct: pct(totales.turno_noche, totalEventos) }
  ];

  const porSexo = [
    { etiqueta: 'Hombres', n: totales.hombres, pct: pct(totales.hombres, totalEventos) },
    { etiqueta: 'Mujeres', n: totales.mujeres, pct: pct(totales.mujeres, totalEventos) }
  ];

  const porArea = new Map();
  eventosAnio.forEach((e) => {
    const a = e.area || 'Sin especificar';
    porArea.set(a, (porArea.get(a) || 0) + 1);
  });
  const listaAreas = [...porArea.entries()].sort((a, b) => b[1] - a[1])
    .map(([etiqueta, n]) => ({ etiqueta, n, pct: pct(n, totalEventos) }));

  /* Causas: agente material y parte del cuerpo, solo de los
     eventos que sí tienen ese dato registrado. */
  const porAgente = new Map();
  const porParte = new Map();
  eventosAnio.forEach((e) => {
    if (e.agente) porAgente.set(e.agente, (porAgente.get(e.agente) || 0) + 1);
    if (e.parte_cuerpo) porParte.set(e.parte_cuerpo, (porParte.get(e.parte_cuerpo) || 0) + 1);
  });
  const listaAgentes = [...porAgente.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([etiqueta, n]) => ({ etiqueta, n, pct: pct(n, porAgente.size > 0 ? [...porAgente.values()].reduce((s, v) => s + v, 0) : 0) }));
  const listaPartes = [...porParte.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([etiqueta, n]) => ({ etiqueta, n, pct: pct(n, porParte.size > 0 ? [...porParte.values()].reduce((s, v) => s + v, 0) : 0) }));

  const investigados = eventosAnio.filter((e) => e.investigado).length;
  const pendientesInvestigar = eventosAnio.filter((e) => !e.investigado);

  inf.datos = {
    anio, totalEventos, totales, porTipo, porTurno, porSexo, listaAreas,
    listaAgentes, listaPartes, investigados, pendientesInvestigar,
    eventos: eventosAnio
  };

  pintarPreviaEventos();
}

function pintarPreviaEventos() {
  const d = inf.datos;
  document.getElementById('infoev-previa').hidden = false;
  document.getElementById('infoev-previa-resumen').textContent =
    `Año ${d.anio} · ${d.totalEventos} eventos (${d.totales.incidentes} incidentes, `
    + `${d.totales.accidentes} accidentes, ${d.totales.accidentes_baja} con baja) · `
    + `${d.totales.dias_perdidos} días perdidos`;
}

/* ============================================
   Gráfico de barras (mismo patrón que los demás informes)
   ============================================ */

function graficoBarras(items, opciones = {}) {
  const ancho = opciones.ancho || 460, alto = opciones.alto || 160;
  const color = opciones.color || '#1F4E79';
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

/* ============================================
   Documento imprimible
   ============================================ */

function fuente(anio) {
  return `<p class="if-fuente">FUENTE: ${escapar(inf.empresaNombre.toUpperCase())}, ${anio}.</p>`;
}

function membreteHtml(titulo, periodo) {
  return `<header class="if-membrete">
    <img src="${escapar(inf.logoUrl)}" class="if-membrete-logo" alt="">
    <div class="if-membrete-texto">
      <strong>${escapar(inf.empresaNombre || 'Empresa')}</strong><br>
      Unidad de Seguridad y Salud Ocupacional · Seguridad Industrial
    </div>
    <div class="if-membrete-ref">${titulo}<br>${escapar(periodo)}</div>
  </header>`;
}

function portadaHtml(titulo, periodo, quien) {
  return `<section class="if-portada">
    <div class="if-portada-banda"></div>
    <div class="if-portada-marca"><img src="${escapar(inf.logoUrl)}" class="if-portada-logo" alt=""></div>
    <div class="if-portada-centro">
      <p class="if-portada-unidad">Unidad de Seguridad y Salud Ocupacional</p>
      <p class="if-portada-servicio">Seguridad Industrial</p>
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

function tablaSimple(filas, tituloCol = 'Categoría') {
  return `<table class="if-tabla">
    <thead><tr><th class="if-izq">${escapar(tituloCol)}</th><th>N.°</th><th>%</th></tr></thead>
    <tbody>${filas.map((f) => `<tr><td class="if-izq">${escapar(String(f.etiqueta))}</td><td>${f.n}</td><td>${f.pct}%</td></tr>`).join('')}</tbody>
  </table>`;
}

function prosaDistribucion(filas, sujeto) {
  const conDatos = filas.filter((f) => f.n > 0);
  if (conDatos.length === 0) return `No se registraron datos suficientes para esta distribución.`;
  const partes = conDatos.map((f) => `el ${f.pct}% (${f.n}) ${f.etiqueta.toLowerCase()}`);
  if (partes.length === 1) return `De ${sujeto}, ${partes[0]}.`;
  return `De ${sujeto}, ${partes.slice(0, -1).join(', ')}, mientras que ${partes[partes.length - 1]}.`;
}

export async function descargarInformeEventos() {
  const d = inf.datos;
  if (!d) return avisar('Genere primero el informe.');

  const resumen = document.getElementById('infoev-resumen-texto').value;
  const exposicion = document.getElementById('infoev-exposicion').value;
  const conclusiones = document.getElementById('infoev-conclusiones').value;
  const recomendaciones = document.getElementById('infoev-recomendaciones').value;
  const quien = quienElabora();
  const sujeto = `los ${d.totalEventos} eventos registrados en la empresa`;

  const bloqueGeneral = `
    <h2 class="if-seccion">1. Aspectos generales del periodo</h2>
    <table class="if-tabla">
      <thead><tr><th class="if-izq">Indicador</th><th>Valor</th></tr></thead>
      <tbody>
        <tr><td class="if-izq">Incidentes (sin lesión)</td><td>${d.totales.incidentes}</td></tr>
        <tr><td class="if-izq">Accidentes sin baja</td><td>${d.totales.accidentes}</td></tr>
        <tr><td class="if-izq">Accidentes con baja</td><td>${d.totales.accidentes_baja}</td></tr>
        <tr><td class="if-izq">Total de eventos</td><td>${d.totalEventos}</td></tr>
        <tr><td class="if-izq">Días perdidos</td><td>${d.totales.dias_perdidos}</td></tr>
      </tbody>
    </table>
    ${fuente(d.anio)}`;

  const ETIQUETA_TIPO_INFORME = {
    incidente: 'Incidente', accidente: 'Accidente sin baja', accidente_baja: 'Accidente con baja'
  };

  const bloqueDetalle = `
    <h2 class="if-seccion">2. Detalle de eventos registrados</h2>
    <table class="if-tabla">
      <thead><tr><th>Fecha</th><th class="if-izq">Tipo</th><th class="if-izq">Área</th><th class="if-izq">Trabajador</th><th class="if-izq">Descripción</th></tr></thead>
      <tbody>${d.eventos.map((e) => `<tr><td>${formatearFecha(e.fecha)}</td><td class="if-izq">${escapar(ETIQUETA_TIPO_INFORME[e.tipo] || e.tipo || '—')}</td><td class="if-izq">${escapar(e.area || '—')}</td><td class="if-izq">${escapar([e.codigo_trabajador, e.trabajador].filter(Boolean).join(' · ') || '—')}</td><td class="if-izq">${escapar((e.descripcion || '').slice(0, 90))}</td></tr>`).join('')}</tbody>
    </table>
    ${fuente(d.anio)}`;

  const bloqueTipo = `
    <h2 class="if-seccion">3. Distribución por tipo de evento</h2>
    ${tablaSimple(d.porTipo, 'Tipo de evento')}
    ${fuente(d.anio)}
    <p>${prosaDistribucion(d.porTipo, sujeto)}</p>
    ${graficoBarras(d.porTipo.map((t) => ({ etiqueta: t.etiqueta, valor: t.n })), { ancho: 400, alto: 150 })}`;

  const bloqueArea = `
    <h2 class="if-seccion">4. Distribución por área</h2>
    ${tablaSimple(d.listaAreas, 'Área')}
    ${fuente(d.anio)}
    <p>${prosaDistribucion(d.listaAreas, sujeto)}</p>
    ${graficoBarras(d.listaAreas.slice(0, 8).map((a) => ({ etiqueta: a.etiqueta, valor: a.n })), { ancho: 460, alto: 160 })}`;

  const bloqueTurno = `
    <h2 class="if-seccion">5. Distribución por turno</h2>
    ${tablaSimple(d.porTurno, 'Turno')}
    ${fuente(d.anio)}
    <p>${prosaDistribucion(d.porTurno, sujeto)}</p>`;

  const bloqueSexo = `
    <h2 class="if-seccion">6. Distribución por sexo</h2>
    ${tablaSimple(d.porSexo, 'Sexo')}
    ${fuente(d.anio)}
    <p>${prosaDistribucion(d.porSexo, sujeto)}</p>`;

  const bloqueCausas = `
    <h2 class="if-seccion">7. Análisis de causas</h2>
    <h3 class="if-subseccion">7.1 Agente material más frecuente</h3>
    ${d.listaAgentes.length > 0 ? tablaSimple(d.listaAgentes, 'Agente material') : '<p class="if-nota">Sin agente material registrado en el periodo.</p>'}
    ${d.listaAgentes.length > 0 ? fuente(d.anio) : ''}
    <h3 class="if-subseccion">7.2 Parte del cuerpo más afectada</h3>
    ${d.listaPartes.length > 0 ? tablaSimple(d.listaPartes, 'Parte del cuerpo') : '<p class="if-nota">Sin parte del cuerpo registrada en el periodo.</p>'}
    ${d.listaPartes.length > 0 ? fuente(d.anio) : ''}`;

  const bloqueGestion = `
    <h2 class="if-seccion">8. Cumplimiento de gestión</h2>
    <table class="if-tabla">
      <thead><tr><th class="if-izq">Aspecto</th><th>Cumplido</th><th>Pendiente</th><th>%</th></tr></thead>
      <tbody>
        <tr><td class="if-izq">Investigación del evento</td><td>${d.investigados}</td><td>${d.totalEventos - d.investigados}</td><td>${pct(d.investigados, d.totalEventos)}%</td></tr>
      </tbody>
    </table>
    ${fuente(d.anio)}
    <p>Del total de eventos del periodo, el ${pct(d.investigados, d.totalEventos)}% (${d.investigados}) cuenta con investigación documentada, quedando ${d.totalEventos - d.investigados} evento(s) pendiente(s).</p>
    ${d.pendientesInvestigar.length > 0 ? `
    <h3 class="if-subseccion">Eventos pendientes de investigar</h3>
    <table class="if-tabla">
      <thead><tr><th>Fecha</th><th class="if-izq">Área</th><th class="if-izq">Trabajador</th><th class="if-izq">Descripción</th></tr></thead>
      <tbody>${d.pendientesInvestigar.map((e) => `<tr><td>${formatearFecha(e.fecha)}</td><td class="if-izq">${escapar(e.area || '—')}</td><td class="if-izq">${escapar([e.codigo_trabajador, e.trabajador].filter(Boolean).join(' · ') || '—')}</td><td class="if-izq">${escapar((e.descripcion || '').slice(0, 90))}</td></tr>`).join('')}</tbody>
    </table>` : ''}`;

  const html = `
    ${portadaHtml('Informe de incidentes<br>y accidentes de trabajo', `Correspondiente al año ${d.anio}`, quien)}
    <section class="if-contenido">
      ${membreteHtml('Informe de incidentes y accidentes', `Año ${d.anio}`)}

      <h2 class="if-seccion">Resumen</h2>
      <p>${escapar(resumen)}</p>

      <h2 class="if-seccion">Exposición de motivos</h2>
      <p>${escapar(exposicion)}</p>

      ${bloqueGeneral}
      ${bloqueDetalle}
      ${bloqueTipo}
      ${bloqueArea}
      ${bloqueTurno}
      ${bloqueSexo}
      ${bloqueCausas}
      ${bloqueGestion}

      <h2 class="if-seccion">9. Conclusiones</h2>
      <p>${escapar(conclusiones)}</p>

      <h2 class="if-seccion">10. Recomendaciones</h2>
      <ul class="if-lista">${recomendaciones.split(/\n+/).map((x) => x.trim()).filter(Boolean).map((x) => `<li>${escapar(x)}</li>`).join('')}</ul>

      <div class="if-firmas">
        <div class="if-firma">
          <div class="if-firma-linea"></div>
          <p class="if-firma-rotulo">Elaborado por</p>
          <p class="if-firma-nombre">${escapar(quien || 'No identificado')}</p>
        </div>
      </div>
    </section>`;

  await imprimir(html, `Informe de incidentes y accidentes · ${d.anio}`);
}

async function imprimir(html, titulo) {
  const $z = document.getElementById('infoev-impresion');
  if (!$z) return avisar('Falta actualizar la página para poder imprimir.');
  $z.innerHTML = html;
  avisar('En el diálogo de impresión: active «Gráficos de fondo».', true);
  await imprimirHoja('infoev-impresion', 'imprimiendo-informe', titulo);
}

function avisar(texto, exito = false) {
  const $a = document.getElementById('infoev-alerta');
  if (!$a) return alert(texto);
  $a.textContent = texto;
  $a.className = exito ? 'alerta alerta-ok' : 'alerta';
  $a.hidden = false;
  setTimeout(() => { $a.hidden = true; }, 6000);
}

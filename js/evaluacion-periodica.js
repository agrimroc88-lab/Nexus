/* ============================================
   NEXUS · evaluacion-periodica.js

   Evaluación médica ocupacional periódica.

   Sustituye el llenado a mano de dos documentos de Word que
   hoy se hacen por separado:

     · El INFORME, agregado: cuántos normales y anormales en
       cada examen, con su porcentaje.
     · El SEGUIMIENTO, nominal: quién salió alterado, con su
       cargo y su condición.

   Los dos salen del MISMO registro. Se captura una vez por
   trabajador y examen; el informe se suma solo y el
   seguimiento se lista solo.

   Por qué importa que sea una sola captura:
     En el informe que se tomó de modelo, las tablas de
     hemograma y lípidos traían la misma cifra repetida en las
     cinco columnas: se copió una columna de la plantilla y no
     se cambiaron los valores. Eso es lo que pasa cuando los
     números se transcriben a mano de un sitio a otro.
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { escapar, formatearFecha } from './utils.js?v=12';
import { alCrear, alEditar } from './autoria.js?v=1';

const VERSION = 'v1';
console.info('NEXUS · evaluacion-periodica', VERSION);

/* Cortes de la OMS, los mismos que constan en el documento de
   seguimiento. El IMC lo clasifica el sistema y no la
   persona: hacerlo a mano en cuarenta trabajadores es donde
   aparecen las diferencias entre el informe y el
   seguimiento. */
const IMC = [
  { hasta: 18.5, texto: 'Insuficiencia ponderal', normal: false },
  { hasta: 25.0, texto: 'Normal',                 normal: true  },
  { hasta: 30.0, texto: 'Sobrepeso',              normal: false },
  { hasta: 35.0, texto: 'Obesidad clase 1',       normal: false },
  { hasta: 40.0, texto: 'Obesidad clase 2',       normal: false },
  { hasta: Infinity, texto: 'Obesidad clase 3',   normal: false }
];

export function clasificarImc(peso, talla) {
  const p = Number(peso), t = Number(talla);
  if (!p || !t || t <= 0) return null;

  /* La talla se registra en metros; si viene en centímetros
     —1 70 en vez de 1,70— el índice saldría absurdo y nadie
     lo notaría hasta ver el informe. */
  const metros = t > 3 ? t / 100 : t;
  const valor = p / (metros * metros);

  const rango = IMC.find((r) => valor < r.hasta);
  return { valor: Math.round(valor * 10) / 10, ...rango };
}

const ev = {
  empresaId: null,
  empresaNombre: '',
  evaluacion: null,      // campaña abierta
  examenes: [],          // catálogo
  resultados: [],        // de la campaña
  trabajador: null,      // el que se está capturando
  nomina: []
};

/* ============================================
   Carga
   ============================================ */

export async function iniciarEvaluacion(empresaId, empresaNombre) {
  ev.empresaId = empresaId;
  ev.empresaNombre = empresaNombre || '';

  if (!empresaId) return;

  const [cat, nom] = await Promise.all([
    supabase.from('examenes_catalogo').select('*')
      .eq('activo', true)
      .or(`empresa_id.is.null,empresa_id.eq.${empresaId}`)
      .order('orden'),
    supabase.from('v_trabajadores')
      .select('id, codigo, cedula, nombre_completo, cargo, edad')
      .eq('empresa_id', empresaId).eq('activo', true).order('codigo')
  ]);

  if (cat.error) {
    avisar('Falta ejecutar el SQL 044_evaluacion_periodica.sql');
    return;
  }

  ev.examenes = cat.data || [];
  ev.nomina = nom.data || [];

  await cargarCampanas();
}

async function cargarCampanas() {
  const { data } = await supabase
    .from('evaluaciones_periodicas').select('*')
    .eq('empresa_id', ev.empresaId)
    .order('anio', { ascending: false });

  const $s = document.getElementById('ep-campana');
  $s.innerHTML = '<option value="">— Elegir campaña —</option>';

  (data || []).forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.anio}${c.titulo ? ' · ' + c.titulo : ''}`
                  + (c.cerrada ? ' (cerrada)' : '');
    $s.appendChild(o);
  });

  /* Se abre la más reciente: es sobre la que se está
     trabajando en el noventa por ciento de las veces. */
  if (data && data.length > 0) {
    $s.value = data[0].id;
    await elegirCampana();
  } else {
    ev.evaluacion = null;
    pintarTodo();
  }
}

export async function crearCampana() {
  const anio = parseInt(prompt('¿De qué año es la evaluación?',
    String(new Date().getFullYear())), 10);
  if (!Number.isFinite(anio)) return;

  const { error } = await supabase.from('evaluaciones_periodicas')
    .insert(alCrear({
      empresa_id: ev.empresaId,
      anio,
      fecha_inicio: new Date().toISOString().slice(0, 10)
    }));

  if (error) {
    return avisar(error.message.includes('uq_evaluacion_anio')
      ? `Ya existe una evaluación de ${anio} para esta empresa.`
      : error.message);
  }

  await cargarCampanas();
}

export async function elegirCampana() {
  const id = document.getElementById('ep-campana').value;
  if (!id) { ev.evaluacion = null; pintarTodo(); return; }

  const { data } = await supabase
    .from('evaluaciones_periodicas').select('*').eq('id', id).maybeSingle();

  ev.evaluacion = data || null;
  await cargarResultados();
  pintarTodo();
}

async function cargarResultados() {
  if (!ev.evaluacion) { ev.resultados = []; return; }

  const { data } = await supabase
    .from('v_evaluacion_detalle').select('*')
    .eq('evaluacion_id', ev.evaluacion.id);

  ev.resultados = data || [];
}

/* ============================================
   Captura por código de trabajador

   Se busca por código porque es lo que trae la hoja de
   laboratorio en la mano. Al encontrarlo se muestran todos
   los exámenes de una vez: capturar examen por examen
   obligaría a buscar al mismo trabajador diez veces.
   ============================================ */

export function buscarTrabajador() {
  const texto = document.getElementById('ep-buscar').value.trim().toLowerCase();
  const $s = document.getElementById('ep-sugerencias');

  if (texto.length < 2) { $s.hidden = true; return; }

  const hallados = ev.nomina.filter((t) => {
    const campo = `${t.codigo ?? ''} ${t.cedula ?? ''} ${t.nombre_completo}`.toLowerCase();
    return campo.includes(texto);
  }).slice(0, 10);

  if (hallados.length === 0) {
    $s.innerHTML = '<p class="ep-sug-vacia">Sin coincidencias</p>';
    $s.hidden = false;
    return;
  }

  $s.innerHTML = '';
  hallados.forEach((t) => {
    const capturado = ev.resultados.some((r) => r.trabajador_id === t.id);
    const b = document.createElement('button');
    b.className = 'ep-sugerencia';
    b.type = 'button';
    b.innerHTML = `<span class="codigo">${t.codigo ?? 's/c'}</span>
                   <span>${escapar(t.nombre_completo)}</span>
                   ${capturado
                     ? '<span class="ep-marca-hecho">ya capturado</span>' : ''}`;
    b.addEventListener('click', () => abrirCaptura(t));
    $s.appendChild(b);
  });
  $s.hidden = false;
}

function abrirCaptura(t) {
  if (!ev.evaluacion) return avisar('Elija primero la campaña.');

  ev.trabajador = t;
  document.getElementById('ep-buscar').value = '';
  document.getElementById('ep-sugerencias').hidden = true;

  document.getElementById('ep-cap-nombre').textContent = t.nombre_completo;
  document.getElementById('ep-cap-datos').textContent =
    [`Código ${t.codigo ?? 's/c'}`, t.cargo, t.edad ? `${t.edad} años` : null]
      .filter(Boolean).join(' · ');

  pintarCaptura();
  document.getElementById('ep-captura').hidden = false;
}

function pintarCaptura() {
  const $c = document.getElementById('ep-cap-cuerpo');
  $c.innerHTML = '';

  const mios = new Map(
    ev.resultados
      .filter((r) => r.trabajador_id === ev.trabajador.id)
      .map((r) => [r.examen_id, r]));

  ev.examenes.forEach((x) => {
    const r = mios.get(x.id);
    const tr = document.createElement('tr');
    tr.dataset.examen = x.id;

    tr.innerHTML = `
      <td>
        ${escapar(x.nombre)}
        ${!x.universal
          ? '<span class="ep-marca">solo a quien lo requiere</span>' : ''}
      </td>
      <td class="celda-centro">
        <select class="entrada entrada-mini" data-campo="resultado">
          <option value="no_realizado">No realizado</option>
          <option value="normal">Normal</option>
          <option value="anormal">Anormal</option>
        </select>
      </td>
      <td>
        <input class="entrada entrada-mini" data-campo="condicion" type="text"
               placeholder="Condición encontrada" autocomplete="off">
      </td>
      <td class="ep-col-cie">
        <input class="entrada entrada-mini" data-campo="cie" type="text"
               placeholder="CIE-10" maxlength="8" autocomplete="off">
      </td>`;

    const $res = tr.querySelector('[data-campo="resultado"]');
    const $cond = tr.querySelector('[data-campo="condicion"]');
    const $cie = tr.querySelector('[data-campo="cie"]');

    if (r) {
      $res.value = r.resultado;
      $cond.value = r.condicion || '';
      $cie.value = r.codigo_cie10 || '';
    }

    /* La condición solo tiene sentido si el resultado es
       anormal: dejarla escrita en un examen normal produce
       hallazgos fantasma en el informe. */
    const ajustar = () => {
      const anormal = $res.value === 'anormal';
      $cond.disabled = !anormal;
      $cie.disabled = !anormal;
      if (!anormal) { $cond.value = ''; $cie.value = ''; }
    };
    $res.addEventListener('change', ajustar);
    ajustar();

    $c.appendChild(tr);
  });

  pintarImcSugerido();
}

/* El IMC se propone desde el peso y la talla de la última
   atención, si los hay. Se puede corregir; lo que no se hace
   es pedirlo dos veces. */
async function pintarImcSugerido() {
  const $a = document.getElementById('ep-imc-aviso');
  if (!$a || !ev.trabajador) return;

  const { data } = await supabase
    .from('atenciones').select('peso, talla, fecha')
    .eq('trabajador_id', ev.trabajador.id)
    .not('peso', 'is', null).not('talla', 'is', null)
    .order('fecha', { ascending: false }).limit(1).maybeSingle();

  if (!data) { $a.hidden = true; return; }

  const c = clasificarImc(data.peso, data.talla);
  if (!c) { $a.hidden = true; return; }

  $a.innerHTML = `Última medición (${escapar(formatearFecha(data.fecha))}): `
    + `${data.peso} kg · ${data.talla} m · <b>IMC ${c.valor} — ${c.texto}</b>`;
  $a.hidden = false;

  /* Se rellena la fila del IMC si está vacía. */
  const examenImc = ev.examenes.find((x) =>
    x.nombre.toLowerCase().includes('masa corporal'));
  if (!examenImc) return;

  const tr = document.querySelector(`[data-examen="${examenImc.id}"]`);
  if (!tr) return;

  const $res = tr.querySelector('[data-campo="resultado"]');
  if ($res.value !== 'no_realizado') return;

  $res.value = c.normal ? 'normal' : 'anormal';
  $res.dispatchEvent(new Event('change'));
  if (!c.normal) tr.querySelector('[data-campo="condicion"]').value = c.texto;
}

export async function guardarCaptura() {
  if (!ev.evaluacion || !ev.trabajador) return;

  const filas = [...document.querySelectorAll('#ep-cap-cuerpo tr')].map((tr) => ({
    evaluacion_id: ev.evaluacion.id,
    trabajador_id: ev.trabajador.id,
    examen_id: tr.dataset.examen,
    resultado: tr.querySelector('[data-campo="resultado"]').value,
    condicion: tr.querySelector('[data-campo="condicion"]').value.trim() || null,
    codigo_cie10: tr.querySelector('[data-campo="cie"]').value.trim().toUpperCase() || null
  }));

  const anormalSinCondicion = filas.find(
    (f) => f.resultado === 'anormal' && !f.condicion);
  if (anormalSinCondicion) {
    const x = ev.examenes.find((e) => e.id === anormalSinCondicion.examen_id);
    return avisar(`Indique qué se encontró en ${x?.nombre || 'el examen anormal'}: `
                + 'sin la condición, el seguimiento no puede listar el caso.');
  }

  const $btn = document.getElementById('ep-btn-guardar');
  $btn.disabled = true;

  /* upsert: volver a capturar corrige, no duplica. Dos
     resultados del mismo examen harían que los porcentajes
     pasaran del cien por ciento. */
  const { error } = await supabase.from('evaluacion_resultados')
    .upsert(filas.map((f) => alEditar(f)),
      { onConflict: 'evaluacion_id,trabajador_id,examen_id' });

  $btn.disabled = false;
  if (error) return avisar('No se pudo guardar: ' + error.message);

  await cargarResultados();
  document.getElementById('ep-captura').hidden = true;
  ev.trabajador = null;
  pintarTodo();
  avisar('Resultados guardados.', true);
}

export function cerrarCaptura() {
  document.getElementById('ep-captura').hidden = true;
  ev.trabajador = null;
}

/* ============================================
   Pintado
   ============================================ */

function pintarTodo() {
  pintarResumen();
  pintarAvance();
}

function pintarResumen() {
  const $c = document.getElementById('ep-cuerpo-resumen');
  const $v = document.getElementById('ep-vacio');
  if (!$c) return;

  $c.innerHTML = '';

  if (!ev.evaluacion || ev.resultados.length === 0) {
    if ($v) {
      $v.hidden = false;
      $v.textContent = ev.evaluacion
        ? 'Todavía no se ha capturado ningún resultado.'
        : 'Elija o cree una campaña para empezar.';
    }
    return;
  }
  if ($v) $v.hidden = true;

  ev.examenes.forEach((x) => {
    const suyos = ev.resultados.filter((r) => r.examen_id === x.id);
    const hechos = suyos.filter((r) => r.resultado !== 'no_realizado');
    const normales = suyos.filter((r) => r.resultado === 'normal').length;
    const anormales = suyos.filter((r) => r.resultado === 'anormal').length;

    const pct = (n) => hechos.length > 0
      ? Math.round(n * 100 / hechos.length) + '%' : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapar(x.nombre)}
        ${!x.universal ? '<span class="ep-marca">selectivo</span>' : ''}</td>
      <td class="celda-centro">${hechos.length}</td>
      <td class="celda-centro">${normales} <span class="celda-tenue">${pct(normales)}</span></td>
      <td class="celda-centro">${anormales > 0
        ? `<span class="ep-alerta">${anormales} ${pct(anormales)}</span>`
        : '0 —'}</td>`;
    $c.appendChild(tr);
  });
}

function pintarAvance() {
  const $a = document.getElementById('ep-avance');
  if (!$a) return;

  if (!ev.evaluacion) { $a.textContent = '—'; return; }

  const capturados = new Set(ev.resultados.map((r) => r.trabajador_id)).size;
  const total = ev.nomina.length;

  $a.innerHTML = `<b>${capturados}</b> de ${total} trabajadores capturados`
    + (capturados < total
        ? ` · faltan <b>${total - capturados}</b>` : ' · completo');
}

/* ============================================ */

function avisar(texto, exito = false) {
  const $a = document.getElementById('ep-alerta');
  if (!$a) return alert(texto);
  $a.textContent = texto;
  $a.className = exito ? 'alerta alerta-ok' : 'alerta';
  $a.hidden = false;
  setTimeout(() => { $a.hidden = true; }, 6000);
}

/* Para el generador de informes, que vive aparte. */
export function datosEvaluacion() {
  return {
    evaluacion: ev.evaluacion,
    examenes: ev.examenes,
    resultados: ev.resultados,
    empresaNombre: ev.empresaNombre,
    totalNomina: ev.nomina.length
  };
}

/* ============================================
   NEXUS · test-atd.js

   Test de diagnóstico inicial de consumo de alcohol, tabaco
   y otras drogas (D.E. 255 / A.M. MDT-2024-196). Se aplica
   una vez al año por empresa.

   Dos tablas, dos niveles de privacidad:

     test_atd_respuestas    100% anónima. Sin cédula ni
       nombre. Es la que alimenta la estadística de los
       informes anual y comparativo.

     test_atd_derivaciones  Identificada. Solo existe si la
       persona, al responder, pidió tratamiento y dejó sus
       datos de contacto. No lleva ninguna columna que la
       vincule a su fila de respuestas: el enlace desaparece
       a propósito en cuanto se guarda.

   Este archivo cubre captura y seguimiento. Los informes
   (anual y comparativo) viven en informe-test-atd.js, igual
   que evaluacion-periodica.js / informe-evaluacion-periodica.js
   se dividen entre captura e informe.
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { escapar, retrasar } from './utils.js?v=12';
import { alCrear, alEditar, marcarAntesDeBorrar } from './autoria.js?v=1';

const VERSION = 'v1';
console.info('NEXUS · test-atd', VERSION);

/* ============================================
   Catálogos — compartidos con informe-test-atd.js
   ============================================ */

export const CAT_GENERO = {
  masculino: 'Masculino', femenino: 'Femenino', 'lgbtiq+': 'LGBTIQ+'
};
export const CAT_AFILIACION = { publica: 'Pública', privada: 'Privada' };
export const CAT_ESTADO_CIVIL = {
  soltero: 'Soltero', casado: 'Casado', divorciado: 'Divorciado',
  viudo: 'Viudo/a', union_hecho: 'Unión de hecho'
};
export const CAT_INSTRUCCION = {
  educacion_basica: 'Educación básica', bachiller: 'Bachiller',
  tercer_nivel: 'Tercer nivel', cuarto_nivel: 'Cuarto nivel'
};
export const CAT_ETNIA = {
  mestizo: 'Mestizo', blanco: 'Blanco', indigena: 'Indígena',
  montubio: 'Montubio', afroecuatoriano: 'Afroecuatoriano', otro: 'Otro'
};
export const CAT_DISCAPACIDAD = {
  no_aplica: 'No aplica', auditiva: 'Auditiva', fisica: 'Física',
  intelectual: 'Intelectual', lenguaje: 'Lenguaje',
  psicosocial: 'Psicosocial', visual: 'Visual'
};
export const CAT_ENFERMEDAD = {
  catastrofica: 'Catastrófica', cronica_no_transmisible: 'Crónica no transmisible',
  cronica_transmisible: 'Crónica transmisible', aguda: 'Aguda',
  no_diagnosticada: 'No diagnosticada'
};
export const CAT_DROGA = {
  no_consume: 'No consume', alcohol: 'Alcohol', anfetaminas: 'Anfetaminas',
  base_cocaina: 'Base de cocaína', cannabis: 'Cannabis (marihuana, hachís, THC)',
  cocaina: 'Cocaína', drogas_sintesis: 'Drogas de síntesis (Éxtasis, MDMA, Ketamina)',
  hongos: 'Hongos', inhalantes: 'Inhalantes', lsd: 'LSD', mezcalina: 'Mezcalina',
  opiaceos: 'Opiáceos (Heroína, Morfina, Metadona)', psilocibina: 'Psilocibina',
  tabaco: 'Tabaco', otra: 'Otra'
};
export const CAT_FRECUENCIA = {
  no_consume: 'No consume', '5_a_7_semana': 'De 5 a 7 días a la semana',
  '2_a_4_semana': 'De 2 a 4 veces a la semana', '2_a_7_semana': 'De 2 a 7 veces a la semana',
  al_menos_1_semana: 'Al menos una vez a la semana', '2_a_12_anio': 'De 2 a 12 veces al año',
  '1_anio': 'Una vez al año'
};
export const CAT_RECONOCE = { si: 'Sí', no: 'No', no_aplica: 'No aplica' };
export const CAT_FACTOR = {
  no_aplica: 'No aplica', agobio_tension_trabajo: 'Agobio y tensión en el trabajo',
  acoso_laboral: 'Acoso laboral', cansancio_intenso: 'Cansancio intenso, agobio',
  companeros_consumidores: 'Compañeros consumidores', contratos_precarios: 'Contratos precarios',
  curiosidad_efectos: 'Curiosidad sobre los efectos de las drogas',
  dificultad_resolucion_problemas: 'Dificultad en la resolución de problemas',
  elevados_niveles_tension_estres: 'Elevados niveles de tensión y estrés laboral',
  expendio_drogas_trabajo: 'Existencia de expendio de drogas en el trabajo',
  familiares_consumidores: 'Familiares consumidores',
  insatisfaccion_tipo_trabajo: 'Insatisfacción con el tipo de trabajo',
  insatisfaccion_trato_recibido: 'Insatisfacción con el trato recibido',
  inseguridad_futuro_laboral: 'Inseguridad en cuanto al futuro laboral',
  largas_ausencias_hogar: 'Largas ausencias del hogar por motivos laborales',
  mala_situacion_economica: 'Mala situación económica en la familia',
  peligrosidad_tarea: 'Peligrosidad en el desempeño de la tarea',
  problemas_conciliacion: 'Problemas de conciliación trabajo-hogar',
  sentimiento_poco_capacitado: 'Sentimiento de estar poco capacitado',
  sindrome_burnout: 'Síndrome del "Burnout"', tareas_rutinarias: 'Tareas rutinarias o monótonas',
  trabajos_nocturnos: 'Trabajos nocturnos o a destajo',
  turnos_rotativos: 'Turnos rotatorios y cambiantes',
  otro_evento_social: 'Otro (eventos sociales, reuniones, etc.)'
};
export const CAT_ESTADO_DERIVACION = {
  pendiente: 'Pendiente', contactado: 'Contactado',
  en_tratamiento: 'En tratamiento', cerrado: 'Cerrado', declino: 'Declinó'
};

/* ============================================
   Estado del módulo
   ============================================ */

const atd = {
  empresaId: null,
  empresaNombre: '',
  anio: new Date().getFullYear(),
  respuestas: [],       // de TODOS los años de la empresa (para historial/comparativo)
  derivaciones: [],
  editandoId: null
};

export function estadoAtd() { return atd; }

/* ============================================
   Arranque
   ============================================ */

export async function iniciarTestAtd(empresaId, empresaNombre) {
  atd.empresaId = empresaId;
  atd.empresaNombre = empresaNombre || '';
  await Promise.all([cargarRespuestas(), cargarDerivaciones()]);
  llenarSelectorAnioCaptura();
  pintarListadoRespuestas();
  llenarSelectorAnioDerivaciones();
  pintarDerivaciones();
}

async function cargarRespuestas() {
  const { data, error } = await supabase
    .from('test_atd_respuestas')
    .select('*')
    .eq('empresa_id', atd.empresaId)
    .order('anio', { ascending: false })
    .order('creado_en', { ascending: true });

  atd.respuestas = error ? [] : (data || []);
  return atd.respuestas;
}

async function cargarDerivaciones() {
  const { data, error } = await supabase
    .from('test_atd_derivaciones')
    .select('*')
    .eq('empresa_id', atd.empresaId)
    .order('anio', { ascending: false })
    .order('creado_en', { ascending: false });

  atd.derivaciones = error ? [] : (data || []);
  return atd.derivaciones;
}

/* ============================================
   Selector de año — captura
   ============================================ */

function llenarSelectorAnioCaptura() {
  const $s = document.getElementById('atd-anio');
  if (!$s) return;

  const anioActual = new Date().getFullYear();
  const anios = new Set(atd.respuestas.map((r) => r.anio));
  anios.add(anioActual);

  const lista = [...anios].sort((a, b) => b - a);
  const previo = $s.value;
  $s.innerHTML = lista.map((a) => `<option value="${a}">${a}</option>`).join('');
  $s.value = lista.includes(parseInt(previo, 10)) ? previo : String(anioActual);
  atd.anio = parseInt($s.value, 10);

  actualizarAvance();
}

export function cambiarAnioAtd() {
  const $s = document.getElementById('atd-anio');
  atd.anio = parseInt($s.value, 10);
  pintarListadoRespuestas();
  actualizarAvance();
}

function actualizarAvance() {
  const n = atd.respuestas.filter((r) => r.anio === atd.anio).length;
  const $a = document.getElementById('atd-avance');
  if ($a) $a.textContent = `${n} registro(s) capturado(s) para ${atd.anio}.`;
}

/* ============================================
   Formulario de captura
   ============================================ */

export function abrirFormularioAtd() {
  atd.editandoId = null;
  limpiarFormulario();
  document.getElementById('atd-form').hidden = false;
  document.getElementById('atd-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function cancelarFormularioAtd() {
  document.getElementById('atd-form').hidden = true;
  limpiarFormulario();
}

function limpiarFormulario() {
  const ids = [
    'atd-f-genero', 'atd-f-anio-nacimiento', 'atd-f-afiliacion', 'atd-f-estado-civil',
    'atd-f-instruccion', 'atd-f-hijos', 'atd-f-etnia', 'atd-f-discapacidad',
    'atd-f-pct-discapacidad', 'atd-f-enfermedad', 'atd-f-droga-principal',
    'atd-f-droga-otra-texto', 'atd-f-otra-droga', 'atd-f-frecuencia',
    'atd-f-ultimo-consumo', 'atd-f-reconoce', 'atd-f-factor',
    'atd-f-deriv-nombre', 'atd-f-deriv-cedula', 'atd-f-deriv-telefono', 'atd-f-deriv-direccion'
  ];
  ids.forEach((id) => { const $e = document.getElementById(id); if ($e) $e.value = ''; });
  document.getElementById('atd-f-sustituto').checked = false;
  document.getElementById('atd-f-desea-tratamiento').checked = false;
  document.getElementById('atd-deriv-datos').hidden = true;
  document.getElementById('atd-form-error').textContent = '';
}

/** Al marcar "desea tratamiento" se revela el bloque de contacto. */
export function alternarBloqueDerivacion() {
  const marcado = document.getElementById('atd-f-desea-tratamiento').checked;
  document.getElementById('atd-deriv-datos').hidden = !marcado;
}

export async function guardarRespuestaAtd() {
  const $error = document.getElementById('atd-form-error');
  $error.textContent = '';

  const v = (id) => document.getElementById(id).value.trim() || null;
  const vNum = (id) => {
    const t = document.getElementById(id).value;
    return t === '' ? null : parseInt(t, 10);
  };

  const deseaTratamiento = document.getElementById('atd-f-desea-tratamiento').checked;

  if (deseaTratamiento && !v('atd-f-deriv-nombre')) {
    $error.textContent = 'Indique el nombre completo para poder darle seguimiento al caso.';
    return;
  }

  const fila = {
    empresa_id: atd.empresaId,
    anio: atd.anio,
    genero: v('atd-f-genero'),
    anio_nacimiento: vNum('atd-f-anio-nacimiento'),
    afiliacion: v('atd-f-afiliacion'),
    estado_civil: v('atd-f-estado-civil'),
    nivel_instruccion: v('atd-f-instruccion'),
    num_hijos: vNum('atd-f-hijos'),
    etnia: v('atd-f-etnia'),
    discapacidad: v('atd-f-discapacidad'),
    pct_discapacidad: vNum('atd-f-pct-discapacidad'),
    trabajador_sustituto: document.getElementById('atd-f-sustituto').checked,
    enfermedad_preexistente: v('atd-f-enfermedad'),
    droga_principal: v('atd-f-droga-principal'),
    droga_principal_otra: v('atd-f-droga-otra-texto'),
    otra_droga: v('atd-f-otra-droga'),
    frecuencia_consumo: v('atd-f-frecuencia'),
    ultimo_consumo: v('atd-f-ultimo-consumo'),
    reconoce_problema: v('atd-f-reconoce'),
    factor_psicosocial: v('atd-f-factor'),
    desea_tratamiento: deseaTratamiento
  };

  const { error } = await supabase
    .from('test_atd_respuestas').insert(alCrear(fila));

  if (error) {
    $error.textContent = 'No se pudo guardar: ' + error.message;
    return;
  }

  /* La derivación es una inserción aparte, sin ningún campo
     que la enlace a la fila anónima recién creada. */
  if (deseaTratamiento) {
    const derivacion = {
      empresa_id: atd.empresaId,
      anio: atd.anio,
      nombre_completo: v('atd-f-deriv-nombre'),
      cedula: v('atd-f-deriv-cedula'),
      telefono: v('atd-f-deriv-telefono'),
      direccion: v('atd-f-deriv-direccion'),
      estado: 'pendiente'
    };
    const { error: errDeriv } = await supabase
      .from('test_atd_derivaciones').insert(alCrear(derivacion));

    if (errDeriv) {
      avisar('El registro anónimo se guardó, pero no se pudo crear el caso de '
        + 'derivación: ' + errDeriv.message, false, 'atd-alerta');
    }
  }

  await Promise.all([cargarRespuestas(), cargarDerivaciones()]);
  llenarSelectorAnioCaptura();
  document.getElementById('atd-anio').value = String(fila.anio);
  atd.anio = fila.anio;
  pintarListadoRespuestas();
  llenarSelectorAnioDerivaciones();
  pintarDerivaciones();

  cancelarFormularioAtd();
  avisar('Registro guardado.', true, 'atd-alerta');
}

/* ============================================
   Listado de respuestas del año
   ============================================ */

function pintarListadoRespuestas() {
  const $cuerpo = document.getElementById('atd-cuerpo');
  const $vacio = document.getElementById('atd-vacio');
  if (!$cuerpo) return;

  const filas = atd.respuestas
    .filter((r) => r.anio === atd.anio)
    .sort((a, b) => new Date(a.creado_en) - new Date(b.creado_en));

  $vacio.hidden = filas.length > 0;

  $cuerpo.innerHTML = filas.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapar(CAT_GENERO[r.genero] || '—')}</td>
      <td>${escapar(CAT_DROGA[r.droga_principal] || '—')}</td>
      <td>${escapar(CAT_FRECUENCIA[r.frecuencia_consumo] || '—')}</td>
      <td class="celda-centro">${escapar(CAT_RECONOCE[r.reconoce_problema] || '—')}</td>
      <td class="celda-centro">${r.desea_tratamiento ? 'Sí' : 'No'}</td>
      <td class="celda-centro">
        <button class="boton-secundario boton-pequeno" data-borrar-atd="${r.id}" type="button">
          Eliminar
        </button>
      </td>
    </tr>`).join('');

  $cuerpo.querySelectorAll('[data-borrar-atd]').forEach(($b) => {
    $b.addEventListener('click', () => eliminarRespuestaAtd($b.dataset.borrarAtd));
  });
}

async function eliminarRespuestaAtd(id) {
  if (!confirm('¿Eliminar este registro anónimo? No se puede deshacer.')) return;

  await marcarAntesDeBorrar(supabase, 'test_atd_respuestas', id);
  const { error } = await supabase.from('test_atd_respuestas').delete().eq('id', id);

  if (error) return avisar('No se pudo eliminar: ' + error.message, false, 'atd-alerta');

  await cargarRespuestas();
  llenarSelectorAnioCaptura();
  pintarListadoRespuestas();
}

/* ============================================
   Derivaciones — seguimiento
   ============================================ */

function llenarSelectorAnioDerivaciones() {
  const $s = document.getElementById('atd-deriv-filtro-anio');
  if (!$s) return;
  const previo = $s.value;
  const anios = [...new Set(atd.derivaciones.map((d) => d.anio))].sort((a, b) => b - a);
  $s.innerHTML = '<option value="">Todos</option>'
    + anios.map((a) => `<option value="${a}">${a}</option>`).join('');
  $s.value = anios.includes(parseInt(previo, 10)) ? previo : '';
}

export function pintarDerivaciones() {
  const $cuerpo = document.getElementById('atd-deriv-cuerpo');
  const $vacio = document.getElementById('atd-deriv-vacio');
  if (!$cuerpo) return;

  const anioFiltro = document.getElementById('atd-deriv-filtro-anio')?.value || '';
  const estadoFiltro = document.getElementById('atd-deriv-filtro-estado')?.value || '';

  const filas = atd.derivaciones.filter((d) =>
    (!anioFiltro || String(d.anio) === anioFiltro)
    && (!estadoFiltro || d.estado === estadoFiltro));

  $vacio.hidden = filas.length > 0;

  $cuerpo.innerHTML = filas.map((d) => `
    <tr>
      <td>${escapar(d.nombre_completo)}</td>
      <td>${escapar(d.cedula || '—')}</td>
      <td>${escapar(d.telefono || '—')}</td>
      <td>${escapar(d.direccion || '—')}</td>
      <td class="celda-centro">${d.anio}</td>
      <td class="celda-centro">
        <select class="entrada atd-estado" data-deriv-estado="${d.id}">
          ${Object.entries(CAT_ESTADO_DERIVACION).map(([v, txt]) =>
            `<option value="${v}" ${d.estado === v ? 'selected' : ''}>${txt}</option>`).join('')}
        </select>
      </td>
      <td>
        <textarea class="atd-notas" data-deriv-notas="${d.id}"
                  placeholder="Notas de seguimiento…">${escapar(d.notas_seguimiento || '')}</textarea>
      </td>
    </tr>`).join('');

  $cuerpo.querySelectorAll('[data-deriv-estado]').forEach(($sel) => {
    $sel.addEventListener('change', () => actualizarDerivacion($sel.dataset.derivEstado, { estado: $sel.value }));
  });
  $cuerpo.querySelectorAll('[data-deriv-notas]').forEach(($ta) => {
    $ta.addEventListener('input', retrasar(() => {
      actualizarDerivacion($ta.dataset.derivNotas, { notas_seguimiento: $ta.value.trim() || null });
    }, 600));
  });
}

async function actualizarDerivacion(id, cambios) {
  const { error } = await supabase
    .from('test_atd_derivaciones').update(alEditar(cambios)).eq('id', id);

  if (error) {
    avisar('No se pudo guardar el cambio: ' + error.message, false, 'atd-deriv-alerta');
    return;
  }

  const fila = atd.derivaciones.find((d) => d.id === id);
  if (fila) Object.assign(fila, cambios);
}

export function filtrarDerivaciones() {
  pintarDerivaciones();
}

export async function imprimirListadoDerivaciones() {
  const { imprimirSeguimientoDerivaciones } = await import('./informe-test-atd.js?v=1');
  await imprimirSeguimientoDerivaciones();
}

/* ============================================
   Utilidad compartida
   ============================================ */

export function avisar(texto, exito = false, destino = 'atd-alerta') {
  const $a = document.getElementById(destino);
  if (!$a) return alert(texto);
  $a.textContent = texto;
  $a.className = exito ? 'alerta alerta-ok' : 'alerta';
  $a.hidden = false;
  setTimeout(() => { $a.hidden = true; }, 6000);
}

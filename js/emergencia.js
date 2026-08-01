/* ============================================
   NEXUS · emergencia.js

   Ficha de emergencia y medicación habitual.
   Módulo compartido por Atenciones y Trabajadores.

   Qué resuelve:
    · Junto a una persona que se desvanece en planta, saber
      en segundos qué tiene, qué toma y a quién avisar. La
      información existe repartida en tres tablas; aquí se
      reúne en una sola lectura.
    · Antes de prescribir, ver si el trabajador está en
      tratamiento sostenido. Un analgésico sobre un
      anticoagulante no es un detalle.

   Reglas:
    · La medicación habitual no es la de Farmacia. Aquella
      registra lo dispensado en una atención; esta, lo que
      la persona toma de forma sostenida, prescrito fuera.
    · La medicación no se borra: se suspende con fecha y
      motivo. Qué tomaba hasta hace un mes importa.
    · Leer la ficha puede cualquier rol. Prescribir y
      suspender es acto clínico y queda restringido.
   ============================================ */

import { supabase } from './supabase.js?v=8';
import { ROLES } from './auth.js?v=8';
import { escapar, formatearFecha, textoOGuion } from './utils.js?v=8';

const em = {
  perfil: null,
  empresaId: null,
  fichaActual: null,       // ficha abierta en el modal
  medicacion: [],          // medicación del trabajador abierto
  destinoMedicacion: null, // registro en edición
  alVolver: null           // se ejecuta al cerrar la ficha
};

const HOY = () => new Date().toISOString().slice(0, 10);

/* Etiquetas de grupo. Se replican aquí a propósito: este
   módulo debe funcionar en Atenciones y Trabajadores, que
   no cargan grupos.js. */
const GRUPOS_EM = {
  embarazo:                'Embarazo',
  lactancia:               'Lactancia',
  discapacidad:            'Discapacidad',
  sustituto:               'Sustituto',
  adulto_mayor:            'Adulto mayor',
  enfermedad_catastrofica: 'Enfermedad catastrófica',
  adolescente:             'Adolescente trabajador',
  victima_violencia:       'Víctima de violencia',
  vih:                     'VIH',
  otro:                    'Otro'
};

const DISCAPACIDADES_EM = {
  fisica:      'Física',
  visual:      'Visual',
  auditiva:    'Auditiva',
  intelectual: 'Intelectual',
  psicosocial: 'Psicosocial',
  lenguaje:    'Lenguaje',
  multiple:    'Múltiple'
};

/* Grupos que se marcan en la nómina. Embarazo, lactancia y
   violencia quedan fuera: la nómina es la pantalla más
   consultada del sistema y esos tres no aportan nada
   administrativo que justifique exponerlos ahí. */
const GRUPOS_EN_NOMINA = [
  'discapacidad', 'sustituto', 'adulto_mayor',
  'adolescente', 'vih', 'enfermedad_catastrofica'
];

/* ============================================
   Permisos
   ============================================ */

/** Prescribir o suspender medicación es acto clínico */
function puedeMedicar() {
  return [ROLES.ADMIN, ROLES.MEDICO, ROLES.ENFERMERIA].includes(em.perfil?.rol);
}

/* ============================================
   Arranque
   ============================================ */

export function montarEmergencia(perfil, empresaId) {
  em.perfil = perfil;
  em.empresaId = empresaId ?? null;
  conectar();
}

export function fijarEmpresaEmergencia(empresaId) {
  em.empresaId = empresaId ?? null;
}

/* ============================================
   Consulta
   ============================================ */

/** Ficha completa de un trabajador */
export async function traerFicha(trabajadorId) {
  const { data, error } = await supabase
    .from('v_ficha_emergencia')
    .select('*')
    .eq('trabajador_id', trabajadorId)
    .maybeSingle();

  return error ? null : data;
}

/** Marcas ligeras para el listado de nómina */
export async function traerAlertas(empresaId) {
  const { data, error } = await supabase
    .from('v_trabajadores_alertas')
    .select('*')
    .eq('empresa_id', empresaId);

  if (error) return {};

  const mapa = {};
  (data || []).forEach((a) => { mapa[a.trabajador_id] = a; });
  return mapa;
}

async function traerMedicacion(trabajadorId) {
  const { data, error } = await supabase
    .from('v_medicacion_habitual')
    .select('*')
    .eq('trabajador_id', trabajadorId)
    .order('vigente', { ascending: false })
    .order('critico', { ascending: false })
    .order('farmaco');

  return error ? [] : (data || []);
}

/* ============================================
   Panel compacto · Atenciones
   Se inserta bajo alergias, en la ficha del trabajador.
   Solo aparece si hay algo que decir.
   ============================================ */

export async function pintarPanelClinico(trabajadorId, idContenedor = 'panel-clinico') {
  const $c = document.getElementById(idContenedor);
  if (!$c) return;

  const ficha = await traerFicha(trabajadorId);

  if (!ficha || (ficha.num_condiciones === 0 && ficha.num_medicacion === 0)) {
    $c.hidden = true;
    $c.innerHTML = '';
    return;
  }

  const condiciones = leerJson(ficha.condiciones);
  const medicacion  = leerJson(ficha.medicacion);
  const indicaciones = leerJson(ficha.indicaciones);

  /* Un fármaco crítico cambia la conducta inmediata: se
     avisa antes que nada. */
  const critico = ficha.num_medicacion_critica > 0;

  $c.className = 'panel-clinico' + (critico ? ' panel-clinico-critico' : '');
  $c.hidden = false;

  $c.innerHTML = `
    ${condiciones.length > 0 ? `
      <div class="pc-linea">
        <span class="pc-etiqueta">Grupo prioritario</span>
        <span class="pc-valor">
          ${condiciones.map((c) => `<span class="pc-chip">${escapar(textoCondicion(c))}</span>`).join('')}
        </span>
      </div>` : ''}

    ${medicacion.length > 0 ? `
      <div class="pc-linea">
        <span class="pc-etiqueta">Medicación habitual</span>
        <span class="pc-valor">
          ${medicacion.map((m) => `
            <span class="pc-farmaco${m.critico ? ' pc-farmaco-critico' : ''}">
              ${m.critico ? '⚠ ' : ''}${escapar(m.resumen || m.farmaco)}
            </span>`).join('')}
        </span>
      </div>` : ''}

    ${indicaciones.length > 0 ? `
      <div class="pc-linea pc-meta">
        <span>${indicaciones.length} indicación${indicaciones.length === 1 ? '' : 'es'} vigente${indicaciones.length === 1 ? '' : 's'}</span>
        <button class="pc-enlace" type="button" data-abre-ficha="${trabajadorId}">Ver ficha completa</button>
      </div>`
    : `<div class="pc-linea pc-meta">
         <button class="pc-enlace" type="button" data-abre-ficha="${trabajadorId}">Ver ficha completa</button>
       </div>`}
  `;

  const $btn = $c.querySelector('[data-abre-ficha]');
  if ($btn) $btn.addEventListener('click', () => abrirFichaEmergencia(trabajadorId));
}

function textoCondicion(c) {
  if (c.tipo === 'discapacidad') {
    const t = DISCAPACIDADES_EM[c.discapacidad] || '';
    const p = c.porcentaje != null ? ` ${c.porcentaje}%` : '';
    return `Discapacidad ${t}${p}`.trim();
  }
  if (c.tipo === 'embarazo' && c.semanas_gestacion != null) {
    return `Embarazo · ${c.semanas_gestacion} sem`;
  }
  return GRUPOS_EM[c.tipo] || c.tipo;
}

/* ============================================
   Insignias · Trabajadores
   ============================================ */

export function insigniasNomina(alerta) {
  if (!alerta) return '';

  const marcas = [];

  if (alerta.tiene_alergias) {
    marcas.push('<span class="marca marca-alergia" title="Alergias registradas">Alergia</span>');
  }

  (alerta.grupos_visibles || [])
    .filter((g) => GRUPOS_EN_NOMINA.includes(g))
    .forEach((g) => {
      marcas.push(`<span class="marca marca-grupo" title="Grupo de atención prioritaria">${escapar(GRUPOS_EM[g] || g)}</span>`);
    });

  if (alerta.medicacion_critica > 0) {
    marcas.push('<span class="marca marca-critica" title="Medicación crítica">Medicación</span>');
  }

  return marcas.join('');
}

/* ============================================
   Ficha de emergencia
   Buscar y ver. No registra nada: se abre junto a la
   persona, muchas veces desde el celular.
   ============================================ */

export async function abrirFichaEmergencia(trabajadorId, alVolver) {
  em.alVolver = alVolver || null;

  const ficha = await traerFicha(trabajadorId);
  if (!ficha) { alert('No se encontró la ficha del trabajador'); return; }

  em.fichaActual = ficha;
  em.medicacion = await traerMedicacion(trabajadorId);

  pintarFichaEmergencia();
  document.getElementById('modal-emergencia').hidden = false;
}

function pintarFichaEmergencia() {
  const f = em.fichaActual;
  if (!f) return;

  const condiciones  = leerJson(f.condiciones);
  const indicaciones = leerJson(f.indicaciones);
  const vigentes     = em.medicacion.filter((m) => m.vigente);
  const suspendidas  = em.medicacion.filter((m) => !m.vigente);

  document.getElementById('em-nombre').textContent = f.nombre_completo;
  document.getElementById('em-datos').textContent =
    `Código ${f.codigo ?? '—'} · Cédula ${f.cedula ?? '—'} · ${f.edad ?? '—'} años`
    + (f.sexo === 'M' ? ' · Masculino' : f.sexo === 'F' ? ' · Femenino' : '');

  /* Lo vital primero: sangre y alergias son lo que se
     pregunta antes de tocar a nadie. */
  document.getElementById('em-sangre').textContent = textoOGuion(f.tipo_sangre);

  const $al = document.getElementById('em-alergias');
  const hayAlergia = f.alergias && f.alergias.trim();
  $al.textContent = hayAlergia ? f.alergias : 'Ninguna conocida';
  $al.className = 'em-vital-valor' + (hayAlergia ? ' em-alerta' : '');

  /* Condiciones */
  const $cond = document.getElementById('em-condiciones');
  $cond.innerHTML = condiciones.length === 0
    ? '<p class="em-vacio">Sin condiciones registradas</p>'
    : condiciones.map((c) => `
        <div class="em-item">
          <span class="em-item-titulo">${escapar(textoCondicion(c))}</span>
          ${c.tipo === 'embarazo' && c.fpp
            ? `<span class="em-item-meta">FPP ${formatearFecha(c.fpp)}</span>` : ''}
          ${c.detalle ? `<span class="em-item-meta">${escapar(c.detalle)}</span>` : ''}
        </div>`).join('');

  /* Medicación */
  const $med = document.getElementById('em-medicacion');
  $med.innerHTML = '';

  if (vigentes.length === 0) {
    $med.innerHTML = '<p class="em-vacio">Sin medicación habitual registrada</p>';
  }

  vigentes.forEach((m) => {
    const fila = document.createElement('div');
    fila.className = 'em-item' + (m.critico ? ' em-item-critico' : '');
    fila.innerHTML = `
      <div class="em-item-cuerpo">
        <span class="em-item-titulo">
          ${m.critico ? '<span class="em-marca-critica">Crítico</span>' : ''}
          ${escapar(m.farmaco)}${m.dosis ? ' ' + escapar(m.dosis) : ''}
        </span>
        ${m.frecuencia ? `<span class="em-item-meta">${escapar(m.frecuencia)}</span>` : ''}
        ${m.prescrito_por ? `<span class="em-item-meta">Prescrito por ${escapar(m.prescrito_por)}</span>` : ''}
        ${m.observacion ? `<span class="em-item-obs">${escapar(m.observacion)}</span>` : ''}
      </div>
      <div class="em-item-acciones"></div>
    `;

    if (puedeMedicar()) {
      const $acc = fila.querySelector('.em-item-acciones');

      const editar = document.createElement('button');
      editar.className = 'boton-icono';
      editar.type = 'button';
      editar.textContent = 'Editar';
      editar.addEventListener('click', () => abrirMedicacion(m));
      $acc.appendChild(editar);

      const suspender = document.createElement('button');
      suspender.className = 'boton-icono boton-icono-critico';
      suspender.type = 'button';
      suspender.textContent = 'Suspender';
      suspender.addEventListener('click', () => suspenderMedicacion(m));
      $acc.appendChild(suspender);
    }

    $med.appendChild(fila);
  });

  /* Suspendidas: se muestran plegadas. Qué tomaba hasta
     hace poco importa, pero no debe competir con lo vigente. */
  const $susp = document.getElementById('em-suspendidas');
  if (suspendidas.length === 0) {
    $susp.hidden = true;
  } else {
    $susp.hidden = false;
    $susp.innerHTML = `
      <summary>${suspendidas.length} suspendida${suspendidas.length === 1 ? '' : 's'}</summary>
      ${suspendidas.map((m) => `
        <div class="em-item em-item-tenue">
          <span class="em-item-titulo">${escapar(m.resumen || m.farmaco)}</span>
          <span class="em-item-meta">
            Suspendida ${formatearFecha(m.fecha_fin)}${m.motivo_fin ? ' · ' + escapar(m.motivo_fin) : ''}
          </span>
        </div>`).join('')}
    `;
  }

  /* Indicaciones */
  const $ind = document.getElementById('em-indicaciones');
  const $bloqueInd = document.getElementById('em-bloque-indicaciones');
  if (indicaciones.length === 0) {
    $bloqueInd.hidden = true;
  } else {
    $bloqueInd.hidden = false;
    $ind.innerHTML = indicaciones
      .map((t) => `<li>${escapar(t)}</li>`).join('');
  }

  /* Contacto */
  const $cont = document.getElementById('em-contacto');
  if (f.contacto_emergencia) {
    $cont.innerHTML = `
      <span class="em-contacto-nombre">${escapar(f.contacto_emergencia)}</span>
      ${f.contacto_emergencia_parentesco
        ? `<span class="em-item-meta">${escapar(f.contacto_emergencia_parentesco)}</span>` : ''}
      ${f.contacto_emergencia_telefono
        ? `<a class="em-telefono" href="tel:${escapar(f.contacto_emergencia_telefono)}">
             ${escapar(f.contacto_emergencia_telefono)}</a>` : ''}
    `;
  } else {
    $cont.innerHTML = '<p class="em-vacio em-falta">Sin contacto de emergencia registrado</p>';
  }

  const $tel = document.getElementById('em-telefono-propio');
  if (f.telefono) {
    $tel.hidden = false;
    $tel.innerHTML = `Teléfono del trabajador:
      <a class="em-telefono" href="tel:${escapar(f.telefono)}">${escapar(f.telefono)}</a>`;
  } else {
    $tel.hidden = true;
  }

  const $btnMed = document.getElementById('em-btn-medicacion');
  if ($btnMed) $btnMed.hidden = !puedeMedicar();
}

/* ============================================
   Buscador de la ficha
   ============================================ */

export function abrirBuscadorEmergencia() {
  document.getElementById('em_buscar').value = '';
  document.getElementById('em_resultados').innerHTML =
    '<p class="em-vacio">Escriba para buscar un trabajador</p>';
  document.getElementById('modal-buscar-emergencia').hidden = false;
  document.getElementById('em_buscar').focus();
}

async function buscarParaFicha() {
  const texto = document.getElementById('em_buscar').value.trim();
  const $r = document.getElementById('em_resultados');

  if (texto.length < 2) {
    $r.innerHTML = '<p class="em-vacio">Escriba al menos dos caracteres</p>';
    return;
  }
  if (!em.empresaId) {
    $r.innerHTML = '<p class="em-vacio">Seleccione una empresa primero</p>';
    return;
  }

  /* Se busca por código exacto o por texto en nombre y
     cédula: en una urgencia se tiene a mano lo que sea. */
  const esNumero = /^\d+$/.test(texto);

  let consulta = supabase
    .from('v_trabajadores')
    .select('id, codigo, cedula, nombre_completo, activo')
    .eq('empresa_id', em.empresaId)
    .limit(15);

  consulta = esNumero
    ? consulta.or(`codigo.eq.${texto},cedula.ilike.${texto}%`)
    : consulta.ilike('nombre_completo', `%${texto}%`);

  const { data, error } = await consulta;

  if (error || !data || data.length === 0) {
    $r.innerHTML = '<p class="em-vacio">Sin coincidencias</p>';
    return;
  }

  $r.innerHTML = '';
  data.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'em-resultado';
    b.type = 'button';
    b.innerHTML = `
      <span class="codigo">${t.codigo ?? '—'}</span>
      <span class="em-resultado-nombre">${escapar(t.nombre_completo)}</span>
      <span class="em-resultado-meta">${escapar(t.cedula ?? '')}</span>
      ${!t.activo ? '<span class="em-resultado-inactivo">Inactivo</span>' : ''}
    `;
    b.addEventListener('click', () => {
      document.getElementById('modal-buscar-emergencia').hidden = true;
      abrirFichaEmergencia(t.id);
    });
    $r.appendChild(b);
  });
}

/* ============================================
   Medicación · alta y suspensión
   ============================================ */

function abrirMedicacion(registro) {
  if (!em.fichaActual) return;
  em.destinoMedicacion = registro || null;

  document.getElementById('em-m-titulo').textContent =
    registro ? 'Editar medicación' : 'Añadir medicación habitual';

  /* Condición asociada, si tiene alguna vigente */
  const $grupo = document.getElementById('em_m_grupo');
  $grupo.innerHTML = '<option value="">— No asociada a una condición —</option>';

  cargarCondicionesVigentes().then((lista) => {
    lista.forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = GRUPOS_EM[g.tipo] || g.tipo;
      $grupo.appendChild(o);
    });
    $grupo.value = registro?.grupo_id ?? '';
  });

  document.getElementById('em_m_farmaco').value = registro?.farmaco ?? '';
  document.getElementById('em_m_dosis').value = registro?.dosis ?? '';
  document.getElementById('em_m_frecuencia').value = registro?.frecuencia ?? '';
  document.getElementById('em_m_via').value = registro?.via ?? '';
  document.getElementById('em_m_prescrito').value = registro?.prescrito_por ?? '';
  document.getElementById('em_m_inicio').value = registro?.fecha_inicio ?? HOY();
  document.getElementById('em_m_critico').checked = Boolean(registro?.critico);
  document.getElementById('em_m_observacion').value = registro?.observacion ?? '';

  document.getElementById('em-alerta-medicacion').hidden = true;
  document.getElementById('modal-medicacion').hidden = false;
  document.getElementById('em_m_farmaco').focus();
}

async function cargarCondicionesVigentes() {
  if (!em.fichaActual) return [];
  const { data, error } = await supabase
    .from('grupos_prioritarios')
    .select('id, tipo')
    .eq('trabajador_id', em.fichaActual.trabajador_id)
    .is('fecha_fin', null);
  return error ? [] : (data || []);
}

async function guardarMedicacion() {
  const f = em.fichaActual;
  if (!f) return;

  const farmaco = document.getElementById('em_m_farmaco').value.trim();
  if (!farmaco) return alertaMedicacion('Indique el fármaco');

  const inicio = document.getElementById('em_m_inicio').value || HOY();
  if (inicio > HOY()) {
    return alertaMedicacion('La fecha de inicio no puede ser futura');
  }

  const datos = {
    trabajador_id: f.trabajador_id,
    grupo_id: document.getElementById('em_m_grupo').value || null,
    farmaco,
    dosis: document.getElementById('em_m_dosis').value.trim() || null,
    frecuencia: document.getElementById('em_m_frecuencia').value.trim() || null,
    via: document.getElementById('em_m_via').value.trim() || null,
    prescrito_por: document.getElementById('em_m_prescrito').value.trim() || null,
    fecha_inicio: inicio,
    critico: document.getElementById('em_m_critico').checked,
    observacion: document.getElementById('em_m_observacion').value.trim() || null
  };

  const $btn = document.getElementById('em-btn-guardar-medicacion');
  $btn.disabled = true;

  const { error } = em.destinoMedicacion
    ? await supabase.from('medicacion_habitual').update(datos).eq('id', em.destinoMedicacion.id)
    : await supabase.from('medicacion_habitual').insert(datos);

  $btn.disabled = false;
  if (error) return alertaMedicacion(traducirEm(error));

  document.getElementById('modal-medicacion').hidden = true;
  await refrescarFicha();
}

/** Suspender, no borrar: el histórico de tratamiento importa */
async function suspenderMedicacion(m) {
  const motivo = prompt(
    `Suspender ${m.farmaco}.\n\nMotivo (fin de tratamiento, cambio de esquema, reacción adversa):`
  );
  if (motivo === null) return;
  if (!motivo.trim()) { alert('El motivo es obligatorio'); return; }

  const { error } = await supabase
    .from('medicacion_habitual')
    .update({ fecha_fin: HOY(), motivo_fin: motivo.trim() })
    .eq('id', m.id);

  if (error) { alert(traducirEm(error)); return; }
  await refrescarFicha();
}

async function refrescarFicha() {
  const id = em.fichaActual?.trabajador_id;
  if (!id) return;

  em.fichaActual = await traerFicha(id);
  em.medicacion = await traerMedicacion(id);
  pintarFichaEmergencia();

  if (typeof em.alVolver === 'function') em.alVolver();
}

/* ============================================
   Impresión de la ficha
   ============================================ */

function imprimirFichaEmergencia() {
  const f = em.fichaActual;
  if (!f) return;

  const condiciones  = leerJson(f.condiciones);
  const indicaciones = leerJson(f.indicaciones);
  const vigentes     = em.medicacion.filter((m) => m.vigente);

  const html = `
    <div class="em-hoja">
      <header class="em-hoja-cabecera">
        <img src="logo.png" class="em-hoja-logo" alt="">
        <div class="em-hoja-identidad">
          <span class="em-hoja-titulo">Ficha de emergencia</span>
          <span class="em-hoja-unidad">Departamento de Seguridad y Salud Ocupacional</span>
        </div>
        <div class="em-hoja-fecha">${new Date().toLocaleDateString('es-EC')}</div>
      </header>

      <table class="em-hoja-datos">
        <tr>
          <th>Trabajador</th><td colspan="3">${escapar(f.nombre_completo)}</td>
        </tr>
        <tr>
          <th>Código</th><td>${f.codigo ?? '—'}</td>
          <th>Cédula</th><td>${escapar(f.cedula ?? '—')}</td>
        </tr>
        <tr>
          <th>Edad</th><td>${f.edad ?? '—'} años</td>
          <th>Tipo de sangre</th><td>${escapar(f.tipo_sangre || '—')}</td>
        </tr>
        <tr>
          <th>Alergias</th>
          <td colspan="3" class="${f.alergias ? 'em-hoja-alerta' : ''}">
            ${escapar(f.alergias || 'Ninguna conocida')}
          </td>
        </tr>
      </table>

      <h2 class="em-hoja-seccion">Condiciones registradas</h2>
      ${condiciones.length === 0
        ? '<p class="em-hoja-vacio">Sin condiciones registradas</p>'
        : `<ul class="em-hoja-lista">${condiciones
            .map((c) => `<li>${escapar(textoCondicion(c))}</li>`).join('')}</ul>`}

      <h2 class="em-hoja-seccion">Medicación habitual</h2>
      ${vigentes.length === 0
        ? '<p class="em-hoja-vacio">Sin medicación registrada</p>'
        : `<table class="em-hoja-tabla">
             <thead>
               <tr><th>Fármaco</th><th>Dosis</th><th>Frecuencia</th><th>Prescrito por</th></tr>
             </thead>
             <tbody>${vigentes.map((m) => `
               <tr>
                 <td>${m.critico ? '⚠ ' : ''}${escapar(m.farmaco)}</td>
                 <td>${escapar(m.dosis || '—')}</td>
                 <td>${escapar(m.frecuencia || '—')}</td>
                 <td>${escapar(m.prescrito_por || '—')}</td>
               </tr>`).join('')}
             </tbody>
           </table>`}

      ${indicaciones.length > 0 ? `
        <h2 class="em-hoja-seccion">Indicaciones vigentes</h2>
        <ul class="em-hoja-lista">
          ${indicaciones.map((t) => `<li>${escapar(t)}</li>`).join('')}
        </ul>` : ''}

      <h2 class="em-hoja-seccion">Contacto de emergencia</h2>
      ${f.contacto_emergencia
        ? `<p class="em-hoja-contacto">
             <strong>${escapar(f.contacto_emergencia)}</strong>
             ${f.contacto_emergencia_parentesco ? ' · ' + escapar(f.contacto_emergencia_parentesco) : ''}
             ${f.contacto_emergencia_telefono ? ' · ' + escapar(f.contacto_emergencia_telefono) : ''}
           </p>`
        : '<p class="em-hoja-vacio">Sin contacto registrado</p>'}

      <p class="em-hoja-nota">
        Contiene datos personales de carácter sensible. Su tratamiento, custodia y
        difusión se rigen por la Ley Orgánica de Protección de Datos Personales.
        Documento de uso exclusivo para la atención de emergencias.
      </p>
    </div>`;

  const $zona = document.getElementById('em-impresion');
  if (!$zona) return;

  const titulo = document.title;
  document.title = 'Ficha de emergencia · ' + f.nombre_completo;

  $zona.innerHTML = html;
  document.body.classList.add('imprimiendo-emergencia');
  window.print();

  setTimeout(() => {
    document.body.classList.remove('imprimiendo-emergencia');
    document.title = titulo;
  }, 500);
}

/* ============================================
   Utilidad
   ============================================ */

/* Supabase puede devolver el JSON ya parseado o como texto,
   según la versión del cliente. */
function leerJson(valor) {
  if (!valor) return [];
  if (Array.isArray(valor)) return valor;
  try {
    const x = typeof valor === 'string' ? JSON.parse(valor) : valor;
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

function alertaMedicacion(texto) {
  const $a = document.getElementById('em-alerta-medicacion');
  if (!$a) return;
  $a.textContent = texto;
  $a.hidden = false;
}

function traducirEm(error) {
  const m = error.message || '';
  if (error.code === '42501') return 'Su rol no tiene permiso para esta acción';
  if (m.includes('ck_mh_vigencia')) {
    return 'La fecha de suspensión no puede ser anterior al inicio';
  }
  return 'Error: ' + m;
}

/* ============================================
   Eventos
   ============================================ */

function enEmEl(id, evento, fn) {
  const $e = document.getElementById(id);
  if ($e) $e.addEventListener(evento, fn);
}

function conectar() {
  enEmEl('em_buscar', 'input', buscarParaFicha);
  enEmEl('em-btn-medicacion', 'click', () => abrirMedicacion(null));
  enEmEl('em-btn-guardar-medicacion', 'click', guardarMedicacion);
  enEmEl('em-btn-imprimir-ficha', 'click', imprimirFichaEmergencia);
  enEmEl('btn-ficha-emergencia', 'click', abrirBuscadorEmergencia);

  document.querySelectorAll('[data-cierra]').forEach((b) => {
    const destino = b.dataset.cierra;
    if (!['modal-emergencia', 'modal-medicacion', 'modal-buscar-emergencia'].includes(destino)) return;
    b.addEventListener('click', () => {
      document.getElementById(destino).hidden = true;
    });
  });
}

/* ============================================
   NEXUS · grupos.js
   Grupos de atención prioritaria · Art. 35 Constitución

   Módulo compartido por Salud y Seguridad. El ámbito define
   quién escribe qué:
    · Salud registra la condición e indica.
    · Seguridad adapta el puesto y evidencia.
    · Ambos leen todo: el técnico no puede adaptar lo que
      no sabe que existe.

   Reglas de negocio:
    · La indicación se copia del catálogo al aplicarla.
      Editar la biblioteca después no reescribe lo ya
      certificado.
    · 'No requiere adaptaciones' exige motivo escrito.
      Un campo vacío no distingue lo evaluado de lo olvidado.
    · La condición no se borra: se cierra con fecha y motivo.
      El histórico sostiene la trazabilidad.
   ============================================ */

import { supabase } from './supabase.js';
import { ROLES } from './auth.js';
import { escapar, formatearFecha } from './utils.js';
import { imprimirHoja } from './impresion.js';

/* --- Estado --- */
const gp = {
  perfil: null,
  ambito: 'salud',
  empresaId: null,
  empresaNombre: '',
  registros: [],
  indicaciones: {},   // grupo_id → [indicaciones]
  adaptaciones: {},   // grupo_id → [adaptaciones]
  catalogo: [],
  sugeridos: [],
  nomina: [],
  actual: null,       // registro abierto en la ficha
  destino: null       // indicación o adaptación en edición
};

const HOY = () => new Date().toISOString().slice(0, 10);

export const GRUPOS = {
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

const DISCAPACIDADES = {
  fisica:      'Física',
  visual:      'Visual',
  auditiva:    'Auditiva',
  intelectual: 'Intelectual',
  psicosocial: 'Psicosocial',
  lenguaje:    'Lenguaje',
  multiple:    'Múltiple'
};

const ESTADOS_ADAPTACION = {
  pendiente:    ['insignia-inactiva', 'Pendiente'],
  implementada: ['insignia-aviso',    'Implementada'],
  verificada:   ['insignia-activa',   'Verificada in situ'],
  no_aplica:    ['insignia-na',       'No aplica']
};

/* Hitos obstétricos que cambian la conducta preventiva */
const FASES_GESTACION = {
  proximo: ['gp-fase-aviso',   'Semana 34'],
  termino: ['gp-fase-termino', 'A término'],
  revisar: ['gp-fase-revisar', 'Revisar vigencia']
};

const SITUACIONES = {
  sin_adaptacion: ['insignia-critica',  'Sin adaptación'],
  en_proceso:     ['insignia-aviso',    'En proceso'],
  completo:       ['insignia-activa',   'Completo'],
  no_requiere:    ['insignia-na',       'No requiere'],
  cerrado:        ['insignia-inactiva', 'Cerrado']
};

/* ============================================
   Permisos
   ============================================ */

/** Registrar la condición: salud y técnico */
function puedeRegistrar() {
  return [ROLES.ADMIN, ROLES.MEDICO, ROLES.TECNICO].includes(gp.perfil?.rol);
}

/** Indicar es acto clínico. El técnico lee, no prescribe. */
function puedeIndicar() {
  return [ROLES.ADMIN, ROLES.MEDICO].includes(gp.perfil?.rol);
}

/** Adaptar el puesto y evidenciarlo */
function puedeAdaptar() {
  return [ROLES.ADMIN, ROLES.TECNICO, ROLES.MEDICO].includes(gp.perfil?.rol);
}

/* ============================================
   Arranque
   ============================================ */

export function montarGrupos(perfil, ambito) {
  gp.perfil = perfil;
  gp.ambito = ambito;
  conectar();
}

export async function cargarGrupos(empresaId, empresaNombre) {
  gp.empresaId = empresaId;
  gp.empresaNombre = empresaNombre || '';
  if (!empresaId) { gp.registros = []; return; }

  const [reg, sug, nom, cat] = await Promise.all([
    supabase.from('v_grupos_prioritarios').select('*')
      .eq('empresa_id', empresaId).order('codigo'),
    supabase.from('v_grupos_sugeridos').select('*')
      .eq('empresa_id', empresaId).order('edad', { ascending: false }),
    supabase.from('v_trabajadores').select('id, codigo, cedula, nombre_completo, fecha_nacimiento')
      .eq('empresa_id', empresaId).eq('activo', true).order('codigo'),
    supabase.from('indicaciones_catalogo').select('*')
      .eq('activo', true).order('texto')
  ]);

  gp.registros = reg.data || [];
  gp.sugeridos = sug.data || [];
  gp.nomina    = nom.data || [];
  gp.catalogo  = cat.data || [];

  await cargarDetalle();
}

async function cargarDetalle() {
  gp.indicaciones = {};
  gp.adaptaciones = {};
  if (gp.registros.length === 0) return;

  const ids = gp.registros.map((r) => r.id);

  const [ind, ada] = await Promise.all([
    supabase.from('grupo_indicaciones').select('*').in('grupo_id', ids).order('fecha'),
    supabase.from('grupo_adaptaciones').select('*').in('grupo_id', ids).order('creado_en')
  ]);

  (ind.data || []).forEach((i) => (gp.indicaciones[i.grupo_id] ||= []).push(i));
  (ada.data || []).forEach((a) => (gp.adaptaciones[a.grupo_id] ||= []).push(a));
}

/* ============================================
   Listado
   ============================================ */

export function pintarGrupos() {
  pintarResumen();
  pintarSugeridos();
  pintarTabla();

  const $reg = document.getElementById('gp-btn-registrar');
  if ($reg) $reg.hidden = !puedeRegistrar();
}

function pintarResumen() {
  const vig = gp.registros.filter((r) => r.vigente);
  const trabajadores = new Set(vig.map((r) => r.trabajador_id)).size;

  const poner = (id, valor) => {
    const $e = document.getElementById(id);
    if ($e) $e.textContent = valor;
  };

  poner('gp-trabajadores', trabajadores);
  poner('gp-condiciones', vig.length);
  poner('gp-sin-adaptacion', vig.filter((r) => r.situacion === 'sin_adaptacion').length);
  poner('gp-doble', vig.filter((r) => r.doble_vulnerabilidad).length);
}

/* Sugerencia por edad. No registra: solo avisa. */
function pintarSugeridos() {
  const $c = document.getElementById('gp-sugeridos');
  if (!$c) return;

  if (gp.sugeridos.length === 0 || !puedeRegistrar()) { $c.hidden = true; return; }

  $c.hidden = false;
  $c.innerHTML = `
    <span class="gp-sugeridos-titulo">
      ${gp.sugeridos.length === 1
        ? 'Un trabajador pertenece a un grupo prioritario por su edad y no está registrado'
        : `${gp.sugeridos.length} trabajadores pertenecen a un grupo prioritario por su edad y no están registrados`}
    </span>
    <div class="gp-chips">
      ${gp.sugeridos.map((s) => `
        <button class="gp-chip" type="button" data-sugerido="${s.trabajador_id}"
                data-tipo="${s.tipo_sugerido}">
          ${escapar(s.nombre_completo)} · ${s.edad} años
        </button>`).join('')}
    </div>
  `;

  $c.querySelectorAll('[data-sugerido]').forEach((b) => {
    b.addEventListener('click', () =>
      abrirRegistro(null, b.dataset.sugerido, b.dataset.tipo));
  });
}

function filtrar() {
  const texto = (document.getElementById('gp-busqueda')?.value || '').trim().toLowerCase();
  const grupo = document.getElementById('gp-filtro-grupo')?.value || 'todos';
  const sit   = document.getElementById('gp-filtro-situacion')?.value || 'vigentes';

  return gp.registros.filter((r) => {
    if (sit === 'vigentes' && !r.vigente) return false;
    if (sit === 'cerrados' && r.vigente) return false;
    if (!['todos', 'vigentes', 'cerrados'].includes(sit) && r.situacion !== sit) return false;
    if (grupo !== 'todos' && r.tipo !== grupo) return false;
    if (texto) {
      const campo = `${r.codigo} ${r.cedula} ${r.nombre_completo}`.toLowerCase();
      if (!campo.includes(texto)) return false;
    }
    return true;
  });
}

function pintarTabla() {
  const $cuerpo = document.getElementById('gp-cuerpo');
  const $vacio  = document.getElementById('gp-vacio');
  if (!$cuerpo) return;

  const lista = filtrar();
  $cuerpo.innerHTML = '';

  if (lista.length === 0) {
    if ($vacio) {
      $vacio.hidden = false;
      $vacio.textContent = gp.registros.length === 0
        ? 'Todavía no hay trabajadores registrados en grupos de atención prioritaria.'
        : 'Ningún registro coincide con el filtro.';
    }
    return;
  }
  if ($vacio) $vacio.hidden = true;

  lista.forEach((r) => {
    const [clase, texto] = SITUACIONES[r.situacion] || ['insignia-inactiva', '—'];

    const tr = document.createElement('tr');
    if (!r.vigente) tr.classList.add('fila-inactiva');

    tr.innerHTML = `
      <td class="celda-centro"><span class="codigo">${r.codigo ?? '—'}</span></td>
      <td>
        ${escapar(r.nombre_completo)}
        ${r.doble_vulnerabilidad
          ? '<span class="gp-doble-marca" title="Dos o más condiciones vigentes">Doble vulnerabilidad</span>'
          : ''}
      </td>
      <td>${escapar(r.cedula ?? '—')}</td>
      <td class="celda-centro">${r.edad ?? '—'}</td>
      <td>${escapar(GRUPOS[r.tipo] || r.tipo)}</td>
      <td>${detalleGrupo(r)}</td>
      <td class="celda-centro">${r.indicaciones}</td>
      <td class="celda-centro">${r.adaptaciones}</td>
      <td class="celda-centro"><span class="insignia ${clase}">${texto}</span></td>
      <td class="celda-centro"></td>
    `;

    const btn = document.createElement('button');
    btn.className = 'boton-icono';
    btn.type = 'button';
    btn.textContent = 'Abrir ficha';
    btn.addEventListener('click', () => abrirFicha(r));
    tr.lastElementChild.appendChild(btn);

    $cuerpo.appendChild(tr);
  });
}

/** Columna de detalle: el porcentaje solo aplica a discapacidad */
function detalleGrupo(r) {
  if (r.tipo === 'discapacidad') {
    const tipo = DISCAPACIDADES[r.discapacidad] || '—';
    const pct = r.porcentaje != null ? ` · ${r.porcentaje}%` : '';
    return escapar(tipo + pct);
  }
  if (r.tipo === 'embarazo') return gestacionTexto(r);
  return escapar(r.detalle || '—');
}

/* Las semanas se recalculan en la vista cada vez que se
   consulta: nunca quedan desfasadas. */
function gestacionTexto(r) {
  if (r.semanas_gestacion == null) {
    return '<span class="gp-falta-fum">Sin FUM registrada</span>';
  }
  const fase = FASES_GESTACION[r.fase_gestacion];
  const marca = fase ? ` <span class="gp-fase ${fase[0]}">${fase[1]}</span>` : '';
  return `${r.semanas_gestacion}<sup>+${r.dias_gestacion}</sup> sem`
       + ` · FPP ${formatearFecha(r.fpp)}${marca}`;
}

/* ============================================
   Registro de la condición
   ============================================ */

function abrirRegistro(registro, trabajadorId, tipoSugerido) {
  gp.destino = { registro };

  document.getElementById('gp-r-titulo').textContent =
    registro ? 'Editar condición' : 'Añadir a grupos prioritarios';

  /* El trabajador se busca, no se elige de una lista larga.
     Al editar ya está fijado y no se cambia: mover la
     condición de persona rompería su histórico. */
  const idInicial = registro?.trabajador_id ?? trabajadorId ?? '';
  const inicial = gp.nomina.find((t) => t.id === idInicial);

  if (inicial) {
    elegirTrabajador(inicial, Boolean(registro));
  } else {
    limpiarEleccion();
  }

  const $tipo = document.getElementById('gp_tipo');
  $tipo.innerHTML = Object.entries(GRUPOS)
    .map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $tipo.value = registro?.tipo ?? tipoSugerido ?? 'discapacidad';

  document.getElementById('gp_discapacidad').value = registro?.discapacidad ?? '';
  document.getElementById('gp_porcentaje').value = registro?.porcentaje ?? '';
  document.getElementById('gp_carne').value = registro?.carne_conadis ?? '';
  document.getElementById('gp_fum').value = registro?.fum ?? '';
  document.getElementById('gp_fecha_inicio').value = registro?.fecha_inicio ?? HOY();
  document.getElementById('gp_detalle').value = registro?.detalle ?? '';
  document.getElementById('gp_documento').value = registro?.documento_url ?? '';
  document.getElementById('gp_observacion').value = registro?.observacion ?? '';

  alternarCamposDiscapacidad();
  document.getElementById('gp-alerta-registro').hidden = true;
  document.getElementById('gp-modal-registro').hidden = false;

  if (!document.getElementById('gp_trabajador').value) {
    document.getElementById('gp_buscar').focus();
  }
}

/* ============================================
   Buscador de trabajador
   La nómina activa ya está en memoria: filtrar aquí evita
   un viaje al servidor por cada tecla.
   ============================================ */

function buscarTrabajador() {
  const texto = document.getElementById('gp_buscar').value.trim().toLowerCase();
  const $sug = document.getElementById('gp_sugerencias');

  if (texto.length < 2) { $sug.hidden = true; return; }

  const hallados = gp.nomina.filter((t) => {
    const campo = `${t.codigo} ${t.cedula ?? ''} ${t.nombre_completo}`.toLowerCase();
    return campo.includes(texto);
  }).slice(0, 12);

  if (hallados.length === 0) {
    $sug.innerHTML = '<p class="gp-sugerencia-vacia">Sin coincidencias en la nómina activa</p>';
    $sug.hidden = false;
    return;
  }

  $sug.innerHTML = '';
  hallados.forEach((t) => {
    const item = document.createElement('button');
    item.className = 'gp-sugerencia';
    item.type = 'button';
    item.innerHTML = `
      <span class="codigo">${t.codigo ?? '—'}</span>
      <span class="gp-sugerencia-nombre">${escapar(t.nombre_completo)}</span>
      <span class="gp-sugerencia-meta">${escapar(t.cedula ?? '')}</span>
    `;
    item.addEventListener('click', () => elegirTrabajador(t, false));
    $sug.appendChild(item);
  });

  $sug.hidden = false;
}

function elegirTrabajador(t, fijado) {
  document.getElementById('gp_trabajador').value = t.id;

  const $elegido = document.getElementById('gp-elegido');
  $elegido.hidden = false;
  $elegido.querySelector('.gp-elegido-nombre').textContent = t.nombre_completo;
  $elegido.querySelector('.gp-elegido-meta').textContent =
    `Código ${t.codigo ?? '—'} · Cédula ${t.cedula ?? '—'}`;

  document.getElementById('gp-btn-cambiar-trabajador').hidden = fijado;
  document.getElementById('gp-campo-buscar').hidden = true;
  document.getElementById('gp_sugerencias').hidden = true;
  document.getElementById('gp_buscar').value = '';
}

function limpiarEleccion() {
  document.getElementById('gp_trabajador').value = '';
  document.getElementById('gp-elegido').hidden = true;
  document.getElementById('gp-campo-buscar').hidden = false;
  document.getElementById('gp_sugerencias').hidden = true;
  document.getElementById('gp_buscar').value = '';
}

/* Los campos propios de discapacidad no existen para embarazo */
function alternarCamposDiscapacidad() {
  const tipo = document.getElementById('gp_tipo').value;

  const $disc = document.getElementById('gp-bloque-discapacidad');
  if ($disc) $disc.hidden = tipo !== 'discapacidad';

  const $emb = document.getElementById('gp-bloque-embarazo');
  if ($emb) $emb.hidden = tipo !== 'embarazo';

  calcularGestacion();
}

/* Cálculo en vivo mientras se escribe la FUM, para que quien
   registra vea de inmediato si la fecha es plausible. */
function calcularGestacion() {
  const $ayuda = document.getElementById('gp-ayuda-fum');
  if (!$ayuda) return;

  const fum = document.getElementById('gp_fum').value;
  if (!fum || document.getElementById('gp_tipo').value !== 'embarazo') {
    $ayuda.textContent = 'Base del cálculo de semanas y fecha probable de parto';
    $ayuda.className = 'ayuda';
    return;
  }

  const dias = Math.floor(
    (new Date(HOY() + 'T00:00') - new Date(fum + 'T00:00')) / 86400000
  );

  if (dias < 0) {
    $ayuda.textContent = 'La FUM no puede ser una fecha futura';
    $ayuda.className = 'ayuda ayuda-critica';
    return;
  }

  const fpp = new Date(new Date(fum + 'T00:00').getTime() + 280 * 86400000);
  const texto = `${Math.floor(dias / 7)} semanas y ${dias % 7} días · `
              + `FPP ${fpp.toLocaleDateString('es-EC', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  if (dias > 294) {
    $ayuda.textContent = texto + ' · más de 42 semanas, verifique la fecha';
    $ayuda.className = 'ayuda ayuda-critica';
  } else {
    $ayuda.textContent = texto;
    $ayuda.className = 'ayuda';
  }
}

async function guardarRegistro() {
  const { registro } = gp.destino || {};

  const trabajador_id = document.getElementById('gp_trabajador').value;
  const tipo = document.getElementById('gp_tipo').value;

  if (!trabajador_id) return alertaRegistro('Seleccione un trabajador');

  const discapacidad = document.getElementById('gp_discapacidad').value || null;
  if (tipo === 'discapacidad' && !discapacidad) {
    return alertaRegistro('Indique el tipo de discapacidad');
  }

  const pctTexto = document.getElementById('gp_porcentaje').value;
  const porcentaje = pctTexto === '' ? null : parseInt(pctTexto, 10);
  if (porcentaje !== null && (porcentaje < 0 || porcentaje > 100)) {
    return alertaRegistro('El porcentaje debe estar entre 0 y 100');
  }

  const fum = document.getElementById('gp_fum').value;
  const inicio = document.getElementById('gp_fecha_inicio').value || HOY();
  if (tipo === 'embarazo' && fum) {
    if (fum > HOY()) return alertaRegistro('La FUM no puede ser una fecha futura');
    if (fum > inicio) {
      return alertaRegistro('La FUM no puede ser posterior a la fecha de inicio del registro');
    }
  }

  const documento = document.getElementById('gp_documento').value.trim();
  if (documento && !/^https?:\/\//i.test(documento)) {
    return alertaRegistro('El enlace debe comenzar con http:// o https://');
  }

  const datos = {
    trabajador_id,
    tipo,
    discapacidad: tipo === 'discapacidad' ? discapacidad : null,
    porcentaje: tipo === 'discapacidad' ? porcentaje : null,
    carne_conadis: tipo === 'discapacidad'
      ? (document.getElementById('gp_carne').value.trim() || null) : null,
    fum: tipo === 'embarazo' ? (document.getElementById('gp_fum').value || null) : null,
    fecha_inicio: document.getElementById('gp_fecha_inicio').value || HOY(),
    detalle: document.getElementById('gp_detalle').value.trim() || null,
    documento_url: documento || null,
    observacion: document.getElementById('gp_observacion').value.trim() || null
  };

  const $btn = document.getElementById('gp-btn-guardar-registro');
  $btn.disabled = true;

  const { error } = registro
    ? await supabase.from('grupos_prioritarios').update(datos).eq('id', registro.id)
    : await supabase.from('grupos_prioritarios').insert(datos);

  $btn.disabled = false;
  if (error) return alertaRegistro(traducir(error));

  document.getElementById('gp-modal-registro').hidden = true;
  await refrescar();
}

/* ============================================
   Ficha individual
   ============================================ */

function abrirFicha(r) {
  gp.actual = r;

  document.getElementById('gp-f-nombre').textContent = r.nombre_completo;
  document.getElementById('gp-f-datos').textContent =
    `Código ${r.codigo ?? '—'} · Cédula ${r.cedula ?? '—'} · ${r.edad ?? '—'} años`;

  const [clase, texto] = SITUACIONES[r.situacion] || ['insignia-inactiva', '—'];
  const $sit = document.getElementById('gp-f-situacion');
  $sit.className = 'insignia ' + clase;
  $sit.textContent = texto;

  const $grupo = document.getElementById('gp-f-grupo');
  if (r.tipo === 'discapacidad' || r.tipo === 'embarazo') {
    $grupo.innerHTML = `${escapar(GRUPOS[r.tipo] || r.tipo)} · ${detalleGrupo(r)}`;
  } else {
    $grupo.textContent = GRUPOS[r.tipo] || r.tipo;
  }

  document.getElementById('gp-f-vigencia').textContent = r.vigente
    ? `Desde ${formatearFecha(r.fecha_inicio)}`
    : `Cerrado el ${formatearFecha(r.fecha_fin)}${r.motivo_cierre ? ' · ' + r.motivo_cierre : ''}`;

  const $doc = document.getElementById('gp-f-documento');
  if (r.documento_url) {
    $doc.hidden = false;
    $doc.href = r.documento_url;
  } else {
    $doc.hidden = true;
  }

  pintarIndicaciones(r);
  pintarAdaptaciones(r);

  document.getElementById('gp-modal-ficha').hidden = false;
}

function pintarIndicaciones(r) {
  const $c = document.getElementById('gp-f-indicaciones');
  const lista = (gp.indicaciones[r.id] || []).filter((i) => i.vigente);
  $c.innerHTML = '';

  if (lista.length === 0) {
    $c.innerHTML = '<p class="gp-vacio-bloque">Sin indicaciones médicas registradas.</p>';
  }

  lista.forEach((i) => {
    const fila = document.createElement('div');
    fila.className = 'gp-item';
    fila.innerHTML = `
      <div class="gp-item-cuerpo">
        <span class="gp-item-texto">${escapar(i.texto)}</span>
        ${i.normativa ? `<span class="gp-item-norma">${escapar(i.normativa)}</span>` : ''}
        ${i.observacion ? `<span class="gp-item-obs">${escapar(i.observacion)}</span>` : ''}
      </div>
      <div class="gp-item-acciones"></div>
    `;

    if (puedeIndicar()) {
      const quitar = document.createElement('button');
      quitar.className = 'boton-icono boton-icono-critico';
      quitar.type = 'button';
      quitar.textContent = 'Quitar';
      quitar.addEventListener('click', () => quitarIndicacion(i));
      fila.querySelector('.gp-item-acciones').appendChild(quitar);
    }

    $c.appendChild(fila);
  });

  const $btn = document.getElementById('gp-btn-indicacion');
  if ($btn) $btn.hidden = !puedeIndicar();
}

function pintarAdaptaciones(r) {
  const $c = document.getElementById('gp-f-adaptaciones');
  const lista = gp.adaptaciones[r.id] || [];
  $c.innerHTML = '';

  /* Declaración de que el puesto no requiere adaptación */
  const $sin = document.getElementById('gp_sin_adaptaciones');
  const $motivo = document.getElementById('gp-bloque-sin-adaptaciones');
  const $motivoTexto = document.getElementById('gp_motivo_sin');

  if ($sin) {
    $sin.checked = Boolean(r.sin_adaptaciones);
    $sin.disabled = !puedeAdaptar();
    $motivoTexto.value = r.motivo_sin_adaptaciones ?? '';
    $motivoTexto.disabled = !puedeAdaptar();
    $motivo.hidden = !r.sin_adaptaciones;
  }

  if (lista.length === 0 && !r.sin_adaptaciones) {
    $c.innerHTML = '<p class="gp-vacio-bloque">Sin adaptaciones registradas en el puesto.</p>';
  }

  lista.forEach((a) => {
    const [clase, texto] = ESTADOS_ADAPTACION[a.estado] || ['insignia-inactiva', '—'];
    const indicacion = (gp.indicaciones[r.id] || []).find((i) => i.id === a.indicacion_id);

    const fila = document.createElement('div');
    fila.className = 'gp-item';
    fila.innerHTML = `
      <div class="gp-item-cuerpo">
        <span class="gp-item-texto">${escapar(a.descripcion)}</span>
        <span class="gp-item-meta">
          <span class="insignia ${clase}">${texto}</span>
          ${a.fecha_implementacion
            ? `<span class="gp-item-fecha">Implementada ${formatearFecha(a.fecha_implementacion)}</span>` : ''}
          ${a.fecha_verificacion
            ? `<span class="gp-item-fecha">Verificada ${formatearFecha(a.fecha_verificacion)}</span>` : ''}
        </span>
        ${indicacion
          ? `<span class="gp-item-norma">Responde a: ${escapar(indicacion.texto)}</span>` : ''}
        ${a.motivo_no_aplica
          ? `<span class="gp-item-obs">${escapar(a.motivo_no_aplica)}</span>` : ''}
        ${a.evidencia_url
          ? `<a class="gp-item-enlace" href="${escapar(a.evidencia_url)}" target="_blank"
                rel="noopener noreferrer">Ver informe o evidencia</a>`
          : '<span class="gp-item-falta">Sin evidencia enlazada</span>'}
      </div>
      <div class="gp-item-acciones"></div>
    `;

    if (puedeAdaptar()) {
      const $acc = fila.querySelector('.gp-item-acciones');

      const editar = document.createElement('button');
      editar.className = 'boton-icono';
      editar.type = 'button';
      editar.textContent = 'Editar';
      editar.addEventListener('click', () => abrirAdaptacion(a));
      $acc.appendChild(editar);

      const quitar = document.createElement('button');
      quitar.className = 'boton-icono boton-icono-critico';
      quitar.type = 'button';
      quitar.textContent = 'Quitar';
      quitar.addEventListener('click', () => quitarAdaptacion(a));
      $acc.appendChild(quitar);
    }

    $c.appendChild(fila);
  });

  const $btn = document.getElementById('gp-btn-adaptacion');
  if ($btn) $btn.hidden = !puedeAdaptar();
}

/* ============================================
   Indicaciones
   ============================================ */

function abrirIndicacion() {
  const r = gp.actual;
  if (!r) return;

  /* La biblioteca se filtra por grupo y, en discapacidad,
     por tipo: lo de una persona no vidente no sirve a una
     con discapacidad auditiva. */
  const disponibles = gp.catalogo.filter((c) => {
    if (c.tipo !== r.tipo) return false;
    if (r.tipo === 'discapacidad') return c.discapacidad === r.discapacidad;
    return true;
  });

  const yaPuestas = new Set((gp.indicaciones[r.id] || [])
    .filter((i) => i.vigente).map((i) => i.texto));

  const $lista = document.getElementById('gp-i-biblioteca');
  $lista.innerHTML = '';

  const libres = disponibles.filter((c) => !yaPuestas.has(c.texto));

  if (libres.length === 0) {
    $lista.innerHTML = `<p class="gp-vacio-bloque">
      ${disponibles.length === 0
        ? 'La biblioteca aún no tiene indicaciones para este grupo.'
        : 'Todas las indicaciones de la biblioteca ya están aplicadas.'}
    </p>`;
  }

  libres.forEach((c) => {
    const fila = document.createElement('label');
    fila.className = 'gp-opcion';
    fila.innerHTML = `
      <input type="checkbox" value="${c.id}">
      <span class="gp-opcion-cuerpo">
        <span class="gp-opcion-texto">${escapar(c.texto)}</span>
        ${c.normativa ? `<span class="gp-opcion-norma">${escapar(c.normativa)}</span>` : ''}
      </span>
    `;
    $lista.appendChild(fila);
  });

  document.getElementById('gp_indicacion_nueva').value = '';
  document.getElementById('gp_indicacion_norma').value = '';
  document.getElementById('gp-alerta-indicacion').hidden = true;
  document.getElementById('gp-modal-indicacion').hidden = false;
}

async function guardarIndicacion() {
  const r = gp.actual;
  if (!r) return;

  const marcadas = [...document.querySelectorAll('#gp-i-biblioteca input:checked')]
    .map((c) => c.value);

  const nueva = document.getElementById('gp_indicacion_nueva').value.trim();
  const norma = document.getElementById('gp_indicacion_norma').value.trim() || null;

  if (marcadas.length === 0 && !nueva) {
    return alertaIndicacion('Marque una indicación de la biblioteca o escriba una nueva');
  }

  const $btn = document.getElementById('gp-btn-guardar-indicacion');
  $btn.disabled = true;

  /* El texto se copia. Editar la biblioteca después no
     reescribe lo ya certificado para esta persona. */
  const filas = marcadas.map((id) => {
    const c = gp.catalogo.find((x) => x.id === id);
    return {
      grupo_id: r.id,
      catalogo_id: c.id,
      texto: c.texto,
      normativa: c.normativa
    };
  });

  if (nueva) {
    /* Lo escrito a mano se suma a la biblioteca para la
       próxima persona del mismo grupo. */
    const { data: creada } = await supabase
      .from('indicaciones_catalogo')
      .insert({
        tipo: r.tipo,
        discapacidad: r.tipo === 'discapacidad' ? r.discapacidad : null,
        texto: nueva,
        normativa: norma,
        estandar: false
      })
      .select('id')
      .maybeSingle();

    filas.push({
      grupo_id: r.id,
      catalogo_id: creada?.id ?? null,
      texto: nueva,
      normativa: norma
    });
  }

  const { error } = await supabase.from('grupo_indicaciones').insert(filas);

  $btn.disabled = false;
  if (error) return alertaIndicacion(traducir(error));

  document.getElementById('gp-modal-indicacion').hidden = true;
  await refrescarFicha();
}

async function quitarIndicacion(i) {
  if (!confirm('¿Quitar esta indicación de la ficha?')) return;
  const { error } = await supabase.from('grupo_indicaciones').delete().eq('id', i.id);
  if (error) return alert(traducir(error));
  await refrescarFicha();
}

/* ============================================
   Adaptaciones
   ============================================ */

function abrirAdaptacion(adaptacion) {
  const r = gp.actual;
  if (!r) return;

  gp.destino = { adaptacion };

  document.getElementById('gp-a-titulo').textContent =
    adaptacion ? 'Editar adaptación' : 'Añadir adaptación del puesto';

  const $ind = document.getElementById('gp_a_indicacion');
  $ind.innerHTML = '<option value="">— No responde a una indicación concreta —</option>';
  (gp.indicaciones[r.id] || []).filter((i) => i.vigente).forEach((i) => {
    const o = document.createElement('option');
    o.value = i.id;
    o.textContent = i.texto;
    $ind.appendChild(o);
  });
  $ind.value = adaptacion?.indicacion_id ?? '';

  document.getElementById('gp_a_descripcion').value = adaptacion?.descripcion ?? '';
  document.getElementById('gp_a_estado').value = adaptacion?.estado ?? 'pendiente';
  document.getElementById('gp_a_responsable').value = adaptacion?.responsable ?? '';
  document.getElementById('gp_a_implementacion').value = adaptacion?.fecha_implementacion ?? '';
  document.getElementById('gp_a_verificacion').value = adaptacion?.fecha_verificacion ?? '';
  document.getElementById('gp_a_verificada_por').value = adaptacion?.verificada_por ?? '';
  document.getElementById('gp_a_evidencia').value = adaptacion?.evidencia_url ?? '';
  document.getElementById('gp_a_motivo').value = adaptacion?.motivo_no_aplica ?? '';

  alternarCamposAdaptacion();
  document.getElementById('gp-alerta-adaptacion').hidden = true;
  document.getElementById('gp-modal-adaptacion').hidden = false;
}

function alternarCamposAdaptacion() {
  const estado = document.getElementById('gp_a_estado').value;
  document.getElementById('gp-bloque-motivo').hidden = estado !== 'no_aplica';
  document.getElementById('gp-bloque-verificacion').hidden = estado !== 'verificada';
}

async function guardarAdaptacion() {
  const r = gp.actual;
  const { adaptacion } = gp.destino || {};
  if (!r) return;

  const descripcion = document.getElementById('gp_a_descripcion').value.trim();
  if (!descripcion) return alertaAdaptacion('Describa la adaptación');

  const estado = document.getElementById('gp_a_estado').value;

  const motivo = document.getElementById('gp_a_motivo').value.trim();
  if (estado === 'no_aplica' && !motivo) {
    return alertaAdaptacion('Indique por qué no aplica. La exclusión debe quedar justificada.');
  }

  const verificacion = document.getElementById('gp_a_verificacion').value || null;
  if (estado === 'verificada' && !verificacion) {
    return alertaAdaptacion('Indique la fecha de verificación in situ');
  }

  const evidencia = document.getElementById('gp_a_evidencia').value.trim();
  if (evidencia && !/^https?:\/\//i.test(evidencia)) {
    return alertaAdaptacion('El enlace debe comenzar con http:// o https://');
  }

  const datos = {
    grupo_id: r.id,
    indicacion_id: document.getElementById('gp_a_indicacion').value || null,
    descripcion,
    estado,
    motivo_no_aplica: estado === 'no_aplica' ? motivo : null,
    responsable: document.getElementById('gp_a_responsable').value.trim() || null,
    fecha_implementacion: document.getElementById('gp_a_implementacion').value || null,
    fecha_verificacion: verificacion,
    verificada_por: document.getElementById('gp_a_verificada_por').value.trim() || null,
    evidencia_url: evidencia || null
  };

  const $btn = document.getElementById('gp-btn-guardar-adaptacion');
  $btn.disabled = true;

  const { error } = adaptacion
    ? await supabase.from('grupo_adaptaciones').update(datos).eq('id', adaptacion.id)
    : await supabase.from('grupo_adaptaciones').insert(datos);

  $btn.disabled = false;
  if (error) return alertaAdaptacion(traducir(error));

  document.getElementById('gp-modal-adaptacion').hidden = true;
  await refrescarFicha();
}

async function quitarAdaptacion(a) {
  if (!confirm('¿Quitar esta adaptación?')) return;
  const { error } = await supabase.from('grupo_adaptaciones').delete().eq('id', a.id);
  if (error) return alert(traducir(error));
  await refrescarFicha();
}

/** Declarar que el puesto no requiere adaptación */
async function guardarSinAdaptaciones() {
  const r = gp.actual;
  if (!r) return;

  const sin = document.getElementById('gp_sin_adaptaciones').checked;
  const motivo = document.getElementById('gp_motivo_sin').value.trim();

  if (sin && !motivo) {
    alert('Indique por qué este puesto no requiere adaptación. '
        + 'Declararlo sin motivo es indefendible ante una inspección.');
    return;
  }

  const { error } = await supabase
    .from('grupos_prioritarios')
    .update({
      sin_adaptaciones: sin,
      motivo_sin_adaptaciones: sin ? motivo : null
    })
    .eq('id', r.id);

  if (error) return alert(traducir(error));
  await refrescarFicha();
}

/* ============================================
   Cierre de la condición
   ============================================ */

async function cerrarCondicion() {
  const r = gp.actual;
  if (!r || !r.vigente) return;

  const motivo = prompt('Motivo del cierre (fin del embarazo, desvinculación, etc.):');
  if (motivo === null) return;
  if (!motivo.trim()) return alert('El motivo es obligatorio');

  const { error } = await supabase
    .from('grupos_prioritarios')
    .update({ fecha_fin: HOY(), motivo_cierre: motivo.trim() })
    .eq('id', r.id);

  if (error) return alert(traducir(error));

  document.getElementById('gp-modal-ficha').hidden = true;
  await refrescar();
}

/* ============================================
   Impresión
   ============================================ */

/* El orden en que se agrupa el listado impreso. Coincide
   con el enum de la base para que papel y pantalla cuenten
   la misma historia. */
const ORDEN_GRUPOS = [
  'embarazo', 'lactancia', 'discapacidad', 'sustituto', 'adulto_mayor',
  'enfermedad_catastrofica', 'adolescente', 'victima_violencia', 'vih', 'otro'
];

function nombreProfesional() {
  const p = gp.perfil;
  if (!p) return '';
  return [p.nombres, p.apellidos].filter(Boolean).join(' ');
}

function fechaLarga() {
  return new Date().toLocaleDateString('es-EC',
    { year: 'numeric', month: 'long', day: 'numeric' });
}

function fechaCorta() {
  return new Date().toLocaleDateString('es-EC',
    { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * Encabezado del documento impreso.
 * Tres zonas: identidad de la empresa, título del documento
 * y bloque de control. El código del requisito va impreso
 * porque es lo primero que busca un inspector.
 */
function cabeceraImpresion(titulo, codigoDoc, subtitulo) {
  return `
    <header class="gp-cabecera">
      <img src="logo.png" class="gp-logo" alt="">

      <div class="gp-identidad">
        <span class="gp-empresa">${escapar(gp.empresaNombre || 'Empresa')}</span>
        <span class="gp-unidad">Departamento de Seguridad y Salud Ocupacional</span>
      </div>

      <div class="gp-control">
        <span class="gp-control-fila"><b>Anexo 1</b> · ${escapar(codigoDoc)}</span>
        <span class="gp-control-fila">${fechaCorta()}</span>
      </div>
    </header>

    <div class="gp-titulo-banda">
      <h1 class="gp-titulo">${escapar(titulo)}</h1>
      ${subtitulo ? `<p class="gp-subtitulo">${escapar(subtitulo)}</p>` : ''}
    </div>`;
}

function pieFirmas(izq, der) {
  return `
    <div class="gp-firmas">
      <div class="gp-firma">
        <div class="gp-linea"></div>
        <p class="gp-firma-cargo">${escapar(izq)}</p>
        <p class="gp-firma-nota">Nombre, firma y registro profesional</p>
      </div>
      <div class="gp-firma">
        <div class="gp-linea"></div>
        <p class="gp-firma-cargo">${escapar(der)}</p>
        <p class="gp-firma-nota">Nombre, firma y registro profesional</p>
      </div>
    </div>`;
}

const NOTA_LEGAL = `
  <p class="gp-nota-legal">
    Documento elaborado conforme al Art. 35 de la Constitución de la República del
    Ecuador y al Anexo 1 del A.M. MDT-2024-196, requisitos GTH-01 y GTH-02.
    Contiene datos personales de carácter sensible; su tratamiento, custodia y
    difusión se rigen por la Ley Orgánica de Protección de Datos Personales.
  </p>`;

/* En papel no hay insignias de color: el detalle viaja como
   texto llano. */
function detalleImpreso(r) {
  if (r.tipo === 'discapacidad') {
    return escapar(DISCAPACIDADES[r.discapacidad] || '—');
  }
  if (r.tipo === 'embarazo') {
    return r.semanas_gestacion == null
      ? 'Sin FUM'
      : `${r.semanas_gestacion}+${r.dias_gestacion} sem · FPP ${formatearFecha(r.fpp)}`;
  }
  return escapar(r.detalle || '—');
}

/**
 * Listado completo, separado por grupo.
 * Una tabla corrida obliga al lector a reconstruir mentalmente
 * cuántas embarazadas hay; separar por grupo lo responde de
 * un vistazo, que es como se lee en una inspección.
 */
function imprimirListado() {
  const lista = filtrar();
  if (lista.length === 0) {
    alert('No hay registros que imprimir con el filtro actual.');
    return;
  }

  /* Agrupar respetando el orden del catálogo */
  const porGrupo = new Map();
  ORDEN_GRUPOS.forEach((t) => {
    const del = lista.filter((r) => r.tipo === t);
    if (del.length > 0) porGrupo.set(t, del);
  });

  const personas = new Set(lista.map((r) => r.trabajador_id)).size;

  /* Resumen de apertura: el total por grupo antes del detalle */
  const resumen = `
    <table class="gp-resumen">
      <thead>
        <tr><th>Grupo de atención prioritaria</th><th>Trabajadores</th></tr>
      </thead>
      <tbody>
        ${[...porGrupo].map(([t, filas]) => `
          <tr>
            <td>${escapar(GRUPOS[t] || t)}</td>
            <td class="gp-num">${filas.length}</td>
          </tr>`).join('')}
        <tr class="gp-resumen-total">
          <td>Total de condiciones registradas</td>
          <td class="gp-num">${lista.length}</td>
        </tr>
      </tbody>
    </table>`;

  /* Una sección por grupo */
  const secciones = [...porGrupo].map(([tipo, filas]) => {
    const esDisc = tipo === 'discapacidad';
    const esEmb = tipo === 'embarazo';

    const columnaDetalle = esDisc ? 'Tipo' : (esEmb ? 'Gestación' : 'Detalle');

    const cuerpo = filas.map((r, i) => `
      <tr>
        <td class="gp-num">${i + 1}</td>
        <td class="gp-num">${r.codigo ?? '—'}</td>
        <td>${escapar(r.nombre_completo)}</td>
        <td class="gp-num">${escapar(r.cedula ?? '—')}</td>
        <td class="gp-num">${r.edad ?? '—'}</td>
        <td>${detalleImpreso(r)}</td>
        ${esDisc ? `<td class="gp-num">${r.porcentaje != null ? r.porcentaje + '%' : '—'}</td>` : ''}
        <td class="gp-num">${r.indicaciones}</td>
        <td class="gp-num">${r.adaptaciones}</td>
        <td>${(SITUACIONES[r.situacion] || ['', '—'])[1]}</td>
      </tr>`).join('');

    return `
      <section class="gp-grupo">
        <h2 class="gp-seccion">
          ${escapar(GRUPOS[tipo] || tipo)}
          <span class="gp-seccion-cuenta">${filas.length}
            ${filas.length === 1 ? 'trabajador' : 'trabajadores'}</span>
        </h2>
        <table class="gp-tabla">
          <thead>
            <tr>
              <th style="width:4%">#</th>
              <th style="width:7%">Código</th>
              <th style="width:${esDisc ? '24' : '28'}%">Nombres y apellidos</th>
              <th style="width:11%">Cédula</th>
              <th style="width:6%">Edad</th>
              <th style="width:${esDisc ? '16' : '21'}%">${columnaDetalle}</th>
              ${esDisc ? '<th style="width:7%">%</th>' : ''}
              <th style="width:7%">Indic.</th>
              <th style="width:7%">Adapt.</th>
              <th style="width:11%">Situación</th>
            </tr>
          </thead>
          <tbody>${cuerpo}</tbody>
        </table>
      </section>`;
  }).join('');

  const html = `
    <div class="gp-hoja">
      ${cabeceraImpresion(
        'Registro de trabajadores en grupos de atención prioritaria',
        'GTH-01',
        `${personas} ${personas === 1 ? 'trabajador identificado' : 'trabajadores identificados'} · ${fechaLarga()}`)}

      ${resumen}
      ${secciones}
      ${NOTA_LEGAL}
      ${pieFirmas('Médico ocupacional', 'Técnico de seguridad e higiene')}
    </div>`;

  lanzarImpresion(html, 'Registro de grupos de atención prioritaria');
}

/** Ficha individual con indicaciones y adaptaciones */
function imprimirFicha() {
  const r = gp.actual;
  if (!r) return;

  const indicaciones = (gp.indicaciones[r.id] || []).filter((i) => i.vigente);
  const adaptaciones = gp.adaptaciones[r.id] || [];

  const filasInd = indicaciones.length > 0
    ? indicaciones.map((i, n) => `
        <tr>
          <td class="gp-num">${n + 1}</td>
          <td>${escapar(i.texto)}</td>
          <td>${escapar(i.normativa || '—')}</td>
          <td class="gp-num">${formatearFecha(i.fecha)}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="gp-vacio-fila">Sin indicaciones registradas</td></tr>';

  const filasAda = adaptaciones.length > 0
    ? adaptaciones.map((a, n) => `
        <tr>
          <td class="gp-num">${n + 1}</td>
          <td>${escapar(a.descripcion)}</td>
          <td>${(ESTADOS_ADAPTACION[a.estado] || ['', '—'])[1]}</td>
          <td class="gp-num">${a.fecha_implementacion ? formatearFecha(a.fecha_implementacion) : '—'}</td>
          <td class="gp-num">${a.fecha_verificacion ? formatearFecha(a.fecha_verificacion) : '—'}</td>
          <td class="gp-enlace-impreso">${a.evidencia_url ? escapar(a.evidencia_url) : '—'}</td>
        </tr>`).join('')
    : `<tr><td colspan="6" class="gp-vacio-fila">${
        r.sin_adaptaciones
          ? 'Declarado sin necesidad de adaptación · ' + escapar(r.motivo_sin_adaptaciones || '')
          : 'Sin adaptaciones registradas'}</td></tr>`;

  const html = `
    <div class="gp-hoja">
      ${cabeceraImpresion(
        'Ficha de trabajador en grupo de atención prioritaria',
        'GTH-01 · GTH-02',
        `${GRUPOS[r.tipo] || r.tipo} · emitida el ${fechaLarga()}`)}

      <table class="gp-ficha-datos">
        <tr>
          <th>Código</th><td>${r.codigo ?? '—'}</td>
          <th>Cédula</th><td>${escapar(r.cedula ?? '—')}</td>
        </tr>
        <tr>
          <th>Nombres y apellidos</th><td colspan="3">${escapar(r.nombre_completo)}</td>
        </tr>
        <tr>
          <th>Edad</th><td>${r.edad ?? '—'} años</td>
          <th>Grupo prioritario</th><td>${escapar(GRUPOS[r.tipo] || r.tipo)}</td>
        </tr>
        ${r.tipo === 'embarazo' ? `
        <tr>
          <th>FUM</th><td>${r.fum ? formatearFecha(r.fum) : '—'}</td>
          <th>Edad gestacional</th>
          <td>${r.semanas_gestacion != null
                ? r.semanas_gestacion + ' semanas y ' + r.dias_gestacion + ' días'
                : '—'}</td>
        </tr>
        <tr>
          <th>Fecha probable de parto</th>
          <td colspan="3">${r.fpp ? formatearFecha(r.fpp) : '—'}
            ${r.fpp ? '<span class="gp-aclaracion">estimada por regla de Naegele sobre la FUM</span>' : ''}</td>
        </tr>` : ''}
        ${r.tipo === 'discapacidad' ? `
        <tr>
          <th>Tipo de discapacidad</th><td>${escapar(DISCAPACIDADES[r.discapacidad] || '—')}</td>
          <th>Porcentaje</th><td>${r.porcentaje != null ? r.porcentaje + '%' : '—'}</td>
        </tr>
        <tr>
          <th>Carné CONADIS</th><td colspan="3">${escapar(r.carne_conadis || '—')}</td>
        </tr>` : ''}
        <tr>
          <th>Vigencia</th>
          <td colspan="3">${r.vigente
            ? 'Vigente desde ' + formatearFecha(r.fecha_inicio)
            : 'Cerrado el ' + formatearFecha(r.fecha_fin)}</td>
        </tr>
        ${r.detalle ? `<tr><th>Detalle</th><td colspan="3">${escapar(r.detalle)}</td></tr>` : ''}
      </table>

      <h2 class="gp-seccion">Indicaciones médicas
        <span class="gp-seccion-cuenta">${indicaciones.length}</span>
      </h2>
      <table class="gp-tabla">
        <thead>
          <tr>
            <th style="width:5%">#</th>
            <th style="width:48%">Indicación</th>
            <th style="width:32%">Fundamento normativo</th>
            <th style="width:15%">Fecha</th>
          </tr>
        </thead>
        <tbody>${filasInd}</tbody>
      </table>

      <h2 class="gp-seccion">Adaptaciones del puesto de trabajo
        <span class="gp-seccion-cuenta">${adaptaciones.length}</span>
      </h2>
      <table class="gp-tabla">
        <thead>
          <tr>
            <th style="width:5%">#</th>
            <th style="width:31%">Adaptación implementada</th>
            <th style="width:14%">Estado</th>
            <th style="width:12%">Implementada</th>
            <th style="width:12%">Verificada</th>
            <th style="width:26%">Evidencia</th>
          </tr>
        </thead>
        <tbody>${filasAda}</tbody>
      </table>

      ${NOTA_LEGAL}
      ${pieFirmas('Médico ocupacional', 'Técnico de seguridad e higiene')}
    </div>`;

  lanzarImpresion(html, 'Ficha de grupo prioritario · ' + r.nombre_completo);
}

/* El resto de la aplicación se oculta en @media print.
   El ajuste del espacio de firma y el título del margen los
   resuelve impresion.js, compartido con los demás módulos. */
function lanzarImpresion(html, tituloDocumento) {
  const $zona = document.getElementById('gp-impresion');
  if (!$zona) return;

  $zona.innerHTML = html;
  imprimirHoja('gp-impresion', 'imprimiendo-grupos', tituloDocumento);
}

/* ============================================
   Refresco
   ============================================ */

async function refrescar() {
  await cargarGrupos(gp.empresaId, gp.empresaNombre);
  pintarGrupos();
}

async function refrescarFicha() {
  const id = gp.actual?.id;
  await refrescar();

  const actualizado = gp.registros.find((r) => r.id === id);
  if (!actualizado) { document.getElementById('gp-modal-ficha').hidden = true; return; }

  gp.actual = actualizado;
  abrirFicha(actualizado);
}

/* ============================================
   Eventos
   ============================================ */

function enEl(id, evento, fn) {
  const $e = document.getElementById(id);
  if ($e) $e.addEventListener(evento, fn);
}

function conectar() {
  enEl('gp-busqueda', 'input', pintarTabla);
  enEl('gp-filtro-grupo', 'change', pintarTabla);
  enEl('gp-filtro-situacion', 'change', pintarTabla);

  enEl('gp-btn-registrar', 'click', () => abrirRegistro(null));
  enEl('gp-btn-guardar-registro', 'click', guardarRegistro);
  enEl('gp_tipo', 'change', alternarCamposDiscapacidad);
  enEl('gp_buscar', 'input', buscarTrabajador);
  enEl('gp_fum', 'change', calcularGestacion);
  enEl('gp_fum', 'input', calcularGestacion);
  enEl('gp-btn-cambiar-trabajador', 'click', limpiarEleccion);

  enEl('gp-btn-imprimir-listado', 'click', imprimirListado);
  enEl('gp-btn-imprimir-ficha', 'click', imprimirFicha);

  enEl('gp-btn-indicacion', 'click', abrirIndicacion);
  enEl('gp-btn-guardar-indicacion', 'click', guardarIndicacion);

  enEl('gp-btn-adaptacion', 'click', () => abrirAdaptacion(null));
  enEl('gp-btn-guardar-adaptacion', 'click', guardarAdaptacion);
  enEl('gp_a_estado', 'change', alternarCamposAdaptacion);

  enEl('gp-btn-editar-registro', 'click', () => abrirRegistro(gp.actual));
  enEl('gp-btn-cerrar-condicion', 'click', cerrarCondicion);

  enEl('gp_sin_adaptaciones', 'change', () => {
    document.getElementById('gp-bloque-sin-adaptaciones').hidden =
      !document.getElementById('gp_sin_adaptaciones').checked;
  });
  enEl('gp-btn-guardar-sin', 'click', guardarSinAdaptaciones);

  /* Cierre de modales */
  document.querySelectorAll('[data-cierra]').forEach((b) => {
    const destino = b.dataset.cierra;
    if (!destino.startsWith('gp-modal')) return;
    b.addEventListener('click', () => {
      document.getElementById(destino).hidden = true;
    });
  });

  /* Filtro de grupos, poblado una sola vez */
  const $fg = document.getElementById('gp-filtro-grupo');
  if ($fg && $fg.options.length <= 1) {
    Object.entries(GRUPOS).forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      $fg.appendChild(o);
    });
  }
}

/* ============================================
   Utilidad
   ============================================ */

function alertaRegistro(t)   { mostrar('gp-alerta-registro', t); }
function alertaIndicacion(t) { mostrar('gp-alerta-indicacion', t); }
function alertaAdaptacion(t) { mostrar('gp-alerta-adaptacion', t); }

function mostrar(id, texto) {
  const $a = document.getElementById(id);
  if (!$a) return;
  $a.textContent = texto;
  $a.hidden = false;
}

function traducir(error) {
  const m = error.message || '';
  if (error.code === '42501') {
    return 'Su rol no tiene permiso para esta acción';
  }
  if (m.includes('uq_gp_vigente')) {
    return 'Este trabajador ya tiene una condición vigente de ese tipo. '
         + 'Ciérrela antes de abrir una nueva.';
  }
  if (m.includes('ck_gp_fum')) {
    return 'La FUM no puede ser posterior a la fecha de inicio del registro';
  }
  if (m.includes('ck_gp_discapacidad')) return 'Indique el tipo de discapacidad';
  if (m.includes('ck_gp_porcentaje')) return 'El porcentaje debe estar entre 0 y 100';
  if (m.includes('ck_gp_motivo')) return 'Indique el motivo por el que no requiere adaptaciones';
  if (m.includes('ck_ga_no_aplica')) return 'Indique por qué la adaptación no aplica';
  if (m.includes('ck_ga_verificada')) return 'Indique la fecha de verificación';
  if (m.includes('ck_gp_url') || m.includes('ck_ga_url')) {
    return 'El enlace debe comenzar con http:// o https://';
  }
  if (error.code === '23505') return 'Ese registro ya existe';
  return 'Error: ' + m;
}

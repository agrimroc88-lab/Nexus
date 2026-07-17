/* ============================================
   NEXUS · anexo1.js
   Cumplimiento del Anexo 1 · A.M. MDT-2024-196

   Este módulo sirve a Salud y a Seguridad. El ámbito
   se declara en el HTML mediante data-ambito en <body>.
   Un solo motor, dos módulos: nunca se duplica la lógica.

   Reglas de negocio:
    · El estado se deriva de las evidencias entregadas.
      Solo 'no aplica' es decisión humana.
    · 'No aplica' exige motivo y sale del cálculo:
      el porcentaje se mide sobre lo legalmente exigible.
    · El cumplimiento es fraccionario. Un requisito que
      exige dos informes y tiene uno aporta 0.5.
    · Los requisitos condicionados por número de
      trabajadores se abren solos. Nadie los configura.
    · La evidencia es un enlace. El documento vive en su
      repositorio; duplicarlo genera versiones divergentes.
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina, ROLES } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar, textoOGuion, retrasar, formatearFecha } from './utils.js';

/* Ámbito y módulo declarados por el HTML que carga este archivo */
const AMBITO = document.body.dataset.ambito || 'salud';
const MODULO = document.body.dataset.modulo || 'salud_ocup';

/* --- Estado --- */
const estado = {
  perfil: null,
  empresaId: null,
  requisitos: [],
  evidencias: {},      // requisito_codigo → [evidencias esperadas]
  enlaces: {},         // cumplimiento_id → [enlaces]
  indicadores: null,
  consolidado: null,
  vigenciaDocs: null,  // vencimientos contados por documento
  actual: null,        // requisito abierto en el modal
  enlaceDestino: null, // evidencia que se está enlazando
  vista: 'cumplimiento',
  anio: new Date().getFullYear(),
  capacitaciones: [],
  indCapac: null,
  capacActual: null,   // capacitación abierta en el modal
  eventos: [],
  indEventos: null,
  eventoActual: null,
  trabajadorEvento: null,
  ocupacionales: [],
  indOcup: null,
  ocupActual: null
};

const HOY = () => new Date().toISOString().slice(0, 10);

const ETIQUETA_ESTADO = {
  pendiente:  ['insignia-inactiva', 'Pendiente'],
  en_proceso: ['insignia-aviso',    'En proceso'],
  cumplido:   ['insignia-activa',   'Cumplido'],
  no_aplica:  ['insignia-na',       'No aplica']
};

/* --- Referencias --- */
const $empresa  = document.getElementById('empresa-activa');
const $area     = document.getElementById('area-trabajo');
const $avisoIni = document.getElementById('aviso-inicial');

iniciar();

/* ============================================
   Arranque
   ============================================ */

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  estado.perfil = perfil;
  montarNavegacion(perfil, MODULO);

  prepararAnios();
  prepararAniosEventos();
  ocultarPestanasAjenas();
  await cargarEmpresas();
  conectarEventos();
}

/**
 * Un ámbito no declara el cumplimiento del otro.
 * Espeja la política RLS de la base.
 */
function puedeEscribir() {
  const r = estado.perfil.rol;
  if (r === ROLES.ADMIN) return true;
  if (AMBITO === 'salud') return r === ROLES.MEDICO;
  if (AMBITO === 'seguridad') return r === ROLES.TECNICO;
  return false;
}

/* ============================================
   Datos
   ============================================ */

async function cargarEmpresas() {
  const { data, error } = await supabase
    .from('empresas')
    .select('id, razon_social')
    .eq('activo', true)
    .order('razon_social');

  if (error) { alert('No fue posible cargar las empresas: ' + error.message); return; }

  (data || []).forEach((e) => {
    const opcion = document.createElement('option');
    opcion.value = e.id;
    opcion.textContent = e.razon_social;
    $empresa.appendChild(opcion);
  });

  const guardada = sessionStorage.getItem('nexus_empresa');
  if (guardada && (data || []).some((e) => e.id === guardada)) {
    $empresa.value = guardada;
    await seleccionarEmpresa();
  }
}

async function cargarTodo() {
  await cargarRequisitos();
  await Promise.all([cargarEvidencias(), cargarEnlaces(), cargarIndicadores()]);
  pintarMedidor();
  pintarLista();
}

async function cargarRequisitos() {
  const { data, error } = await supabase
    .from('v_cumplimientos')
    .select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('ambito', AMBITO)
    .order('seccion_orden')
    .order('numero');

  estado.requisitos = error ? [] : (data || []);

  /* Si no hay filas, los cumplimientos aún no se abrieron */
  document.getElementById('btn-abrir').hidden =
    estado.requisitos.length > 0 || !puedeEscribir();
}

async function cargarEvidencias() {
  if (estado.requisitos.length === 0) { estado.evidencias = {}; return; }

  const codigos = [...new Set(estado.requisitos.map((r) => r.requisito_codigo))];

  const { data, error } = await supabase
    .from('requisito_evidencias')
    .select('*')
    .in('requisito_codigo', codigos)
    .order('orden');

  estado.evidencias = {};
  if (error) return;

  (data || []).forEach((e) => {
    /* Solo las exigidas a este ámbito.
       Las de GTH-09 nacen del catálogo de temas y ya
       vienen marcadas con su ámbito. */
    if (e.ambito !== null && e.ambito !== AMBITO) return;
    (estado.evidencias[e.requisito_codigo] ||= []).push(e);
  });
}

async function cargarEnlaces() {
  if (estado.requisitos.length === 0) { estado.enlaces = {}; return; }

  const ids = estado.requisitos.map((r) => r.id);

  const { data, error } = await supabase
    .from('v_enlaces')
    .select('*')
    .in('cumplimiento_id', ids);

  estado.enlaces = {};
  if (error) return;

  (data || []).forEach((e) => {
    (estado.enlaces[e.cumplimiento_id] ||= []).push(e);
  });
}

async function cargarIndicadores() {
  const [propio, total, docs] = await Promise.all([
    supabase.from('v_indicadores_anexo1').select('*')
      .eq('empresa_id', estado.empresaId).eq('ambito', AMBITO).maybeSingle(),
    supabase.from('v_indicadores_consolidado').select('*')
      .eq('empresa_id', estado.empresaId).maybeSingle(),
    supabase.from('v_vigencia_documentos').select('*')
      .eq('empresa_id', estado.empresaId).eq('ambito', AMBITO).maybeSingle()
  ]);

  estado.indicadores = propio.data;
  estado.consolidado = total.data;
  estado.vigenciaDocs = docs.data;
}

/** Abre los cumplimientos que correspondan a la empresa */
async function abrirRequisitos() {
  const $btn = document.getElementById('btn-abrir');
  $btn.disabled = true;
  $btn.textContent = 'Abriendo…';

  const { error } = await supabase.rpc('abrir_cumplimientos', { p_empresa: estado.empresaId });

  $btn.disabled = false;
  $btn.textContent = 'Abrir requisitos';

  if (error) { alert('No fue posible abrir los requisitos: ' + error.message); return; }
  await cargarTodo();
}

/* ============================================
   Medidor
   ============================================ */

function pintarMedidor() {
  const i = estado.indicadores;
  const pct = i?.porcentaje != null ? Number(i.porcentaje) : null;

  document.getElementById('medidor-valor').textContent =
    pct != null ? `${pct}%` : '—';

  /* Circunferencia = 2πr con r = 52 */
  const circunferencia = 2 * Math.PI * 52;
  const $trazo = document.getElementById('medidor-trazo');
  $trazo.style.strokeDasharray = circunferencia;
  $trazo.style.strokeDashoffset = pct != null
    ? circunferencia * (1 - pct / 100)
    : circunferencia;

  $trazo.classList.remove('trazo-bajo', 'trazo-medio', 'trazo-alto');
  if (pct != null) {
    $trazo.classList.add(pct < 50 ? 'trazo-bajo' : pct < 85 ? 'trazo-medio' : 'trazo-alto');
  }

  document.getElementById('n-cumplidos').textContent  = i?.cumplidos ?? 0;
  document.getElementById('n-proceso').textContent    = i?.en_proceso ?? 0;
  document.getElementById('n-pendientes').textContent = i?.pendientes ?? 0;
  document.getElementById('n-na').textContent         = i?.no_aplica ?? 0;
  document.getElementById('n-exigibles').textContent  = i?.exigibles ?? 0;

  /* Vencimientos contados por documento: un requisito
     multi-evidencia puede tener uno vencido y otro vigente */
  const vencidos = estado.vigenciaDocs?.docs_vencidos ?? 0;
  const porVencer = estado.vigenciaDocs?.docs_por_vencer ?? 0;

  document.getElementById('n-vencidos').textContent = vencidos;
  document.getElementById('caja-vencidos').hidden = vencidos === 0;
  document.getElementById('n-porvencer').textContent = porVencer;
  document.getElementById('caja-porvencer').hidden = porVencer === 0;

  document.getElementById('n-consolidado').textContent =
    estado.consolidado?.porcentaje != null ? `${estado.consolidado.porcentaje}%` : '—';
}

/* ============================================
   Listado
   ============================================ */

function pintarLista() {
  const texto = document.getElementById('busqueda').value.trim().toLowerCase();
  const filtro = document.getElementById('filtro-estado').value;
  const ocultarNa = document.getElementById('ocultar-na').checked;
  const $lista = document.getElementById('lista-requisitos');

  const visibles = estado.requisitos.filter((r) => {
    if (ocultarNa && r.estado === 'no_aplica') return false;

    if (filtro === 'vencido' && r.vigencia !== 'vencido') return false;
    if (filtro === 'por_vencer' && r.vigencia !== 'por_vencer') return false;
    if (!['todos', 'vencido', 'por_vencer'].includes(filtro) && r.estado !== filtro) return false;

    if (!texto) return true;
    return [r.requisito_codigo, r.descripcion, r.subgrupo]
      .filter(Boolean).some((c) => c.toLowerCase().includes(texto));
  });

  document.getElementById('vacio').hidden = visibles.length > 0;
  $lista.innerHTML = '';

  /* Agrupar por sección */
  const porSeccion = new Map();
  visibles.forEach((r) => {
    if (!porSeccion.has(r.seccion)) porSeccion.set(r.seccion, []);
    porSeccion.get(r.seccion).push(r);
  });

  const frag = document.createDocumentFragment();

  porSeccion.forEach((items, seccion) => {
    const bloque = document.createElement('section');
    bloque.className = 'seccion-bloque';

    const exigibles = items.filter((r) => r.estado !== 'no_aplica');
    const suma = exigibles.reduce((s, r) => s + Number(r.fraccion || 0), 0);
    const pct = exigibles.length > 0 ? Math.round(suma / exigibles.length * 100) : null;

    bloque.innerHTML = `
      <header class="seccion-titulo">
        <h2 class="seccion-nombre">${escapar(seccion)}</h2>
        <span class="seccion-conteo">${items.length}</span>
        ${pct != null ? `<span class="seccion-pct">${pct}%</span>` : ''}
      </header>
    `;

    items.forEach((r) => bloque.appendChild(tarjetaRequisito(r)));
    frag.appendChild(bloque);
  });

  $lista.appendChild(frag);
}

function tarjetaRequisito(r) {
  const [clase, texto] = ETIQUETA_ESTADO[r.estado] || ['insignia-inactiva', '—'];
  const esperadas = r.evidencias_esperadas || 0;
  const entregadas = r.evidencias_entregadas || 0;
  const parcial = r.estado === 'en_proceso' && esperadas > 1;

  const art = document.createElement('article');
  art.className = 'req-tarjeta';
  if (r.estado === 'no_aplica') art.classList.add('req-na');
  if (r.vigencia === 'vencido') art.classList.add('req-vencido');

  art.innerHTML = `
    <div class="req-cuerpo">
      <div class="req-encabezado">
        <span class="req-codigo">${escapar(r.requisito_codigo)}</span>
        ${r.ambito_requisito === 'ambos'
          ? '<span class="req-compartido">Compartido</span>' : ''}
      </div>
      <p class="req-descripcion">${escapar(r.descripcion)}</p>
      <div class="req-meta">
        ${r.fecha_caducidad ? pintarVigencia(r) : ''}
        ${esperadas > 0
          ? `<span class="req-evidencias ${parcial ? 'req-evidencias-parcial' : ''}">
               ${entregadas}/${esperadas} ${esperadas === 1 ? 'documento' : 'documentos'}
             </span>`
          : ''}
        ${r.estado === 'no_aplica' && r.motivo_no_aplica
          ? `<span class="req-motivo">${escapar(r.motivo_no_aplica)}</span>` : ''}
      </div>
    </div>

    <div class="req-acciones">
      <span class="insignia ${clase}">${texto}</span>
    </div>
  `;

  const btn = document.createElement('button');
  btn.className = 'boton-gestionar';
  btn.type = 'button';
  btn.textContent = puedeEscribir() ? 'Gestionar' : 'Ver';
  btn.addEventListener('click', () => abrirRequisito(r));
  art.querySelector('.req-acciones').appendChild(btn);

  return art;
}

function pintarVigencia(r) {
  if (r.vigencia === 'vencido') {
    return `<span class="req-fecha req-fecha-vencida">
              Vencido · ${formatearFecha(r.fecha_caducidad)}
            </span>`;
  }
  if (r.vigencia === 'por_vencer') {
    return `<span class="req-fecha req-fecha-aviso">
              Vence en ${r.dias_para_vencer} días
            </span>`;
  }
  return `<span class="req-fecha">Vence ${formatearFecha(r.fecha_caducidad)}</span>`;
}

/* ============================================
   Modal · Requisito
   ============================================ */

function abrirRequisito(r) {
  estado.actual = r;
  const editable = puedeEscribir();

  document.getElementById('m-codigo').textContent = r.requisito_codigo;
  document.getElementById('m-titulo').textContent = r.descripcion;
  document.getElementById('m-normativa').textContent = textoOGuion(r.normativa);

  const $nota = document.getElementById('m-nota');
  if (r.nota_aplicabilidad) {
    $nota.textContent = r.nota_aplicabilidad;
    $nota.hidden = false;
  } else {
    $nota.hidden = true;
  }

  pintarEstadoModal(r);
  pintarVigenciaModal(r);
  pintarEvidenciasModal(r);

  document.getElementById('m_observacion').value = r.observacion ?? '';
  document.getElementById('m_motivo_na').value = r.motivo_no_aplica ?? '';

  /* Solo el ámbito responsable edita */
  ['m_observacion', 'm_motivo_na'].forEach((id) => {
    document.getElementById(id).disabled = !editable;
  });
  document.getElementById('btn-guardar-req').hidden = !editable;
  document.getElementById('m-plegable-na').hidden = !editable;

  document.getElementById('btn-marcar-na').hidden = r.estado === 'no_aplica';
  document.getElementById('btn-quitar-na').hidden = r.estado !== 'no_aplica';

  document.getElementById('alerta-req').hidden = true;
  document.getElementById('modal-req').hidden = false;
}

function pintarEstadoModal(r) {
  const [clase, texto] = ETIQUETA_ESTADO[r.estado] || ['insignia-inactiva', '—'];
  const $estado = document.getElementById('m-estado');
  $estado.className = 'insignia ' + clase;
  $estado.textContent = texto;

  const esperadas = r.evidencias_esperadas || 0;
  const entregadas = r.evidencias_entregadas || 0;
  const $frac = document.getElementById('m-fraccion');

  if (r.estado === 'no_aplica') {
    $frac.textContent = 'Excluido del cálculo de cumplimiento';
  } else if (esperadas > 1) {
    const pct = Math.round(entregadas / esperadas * 100);
    $frac.textContent = `${entregadas} de ${esperadas} documentos · ${pct}%`;
  } else {
    $frac.textContent = '';
  }
}

/**
 * La vigencia del requisito es derivada: la caducidad más
 * próxima entre sus evidencias. No se edita aquí.
 */
function pintarVigenciaModal(r) {
  const $caja = document.getElementById('m-vigencia');
  const $valor = document.getElementById('m-vigencia-valor');

  if (!r.fecha_caducidad) { $caja.hidden = true; return; }

  $caja.hidden = false;
  $caja.className = 'vigencia-derivada';

  if (r.vigencia === 'vencido') {
    $valor.textContent = `Vencido el ${formatearFecha(r.fecha_caducidad)}`;
    $caja.classList.add('vigencia-vencida');
  } else if (r.vigencia === 'por_vencer') {
    $valor.textContent = `Vence en ${r.dias_para_vencer} días · ${formatearFecha(r.fecha_caducidad)}`;
    $caja.classList.add('vigencia-aviso');
  } else {
    $valor.textContent = `Vigente hasta ${formatearFecha(r.fecha_caducidad)}`;
  }
}

function pintarEvidenciasModal(r) {
  const $cont = document.getElementById('m-evidencias');
  const esperadas = estado.evidencias[r.requisito_codigo] || [];
  const enlaces = estado.enlaces[r.id] || [];
  const editable = puedeEscribir();

  $cont.innerHTML = '';

  esperadas.forEach((ev) => {
    const enlace = enlaces.find((e) => e.evidencia_id === ev.id);

    const fila = document.createElement('div');
    fila.className = 'evidencia' + (enlace ? ' evidencia-lista' : '');
    if (enlace?.vigencia === 'vencido') fila.classList.add('evidencia-vencida');

    fila.innerHTML = `
      <span class="evidencia-marca">${enlace ? '✓' : '○'}</span>
      <div class="evidencia-cuerpo">
        <span class="evidencia-etiqueta">${escapar(ev.etiqueta)}</span>
        ${enlace
          ? `<a class="evidencia-enlace" href="${escapar(enlace.url)}"
                target="_blank" rel="noopener noreferrer">${escapar(acortar(enlace.url))}</a>`
          : '<span class="evidencia-falta">Sin enlace registrado</span>'}
        ${enlace ? pintarVigenciaEvidencia(enlace) : ''}
        ${enlace?.observacion
          ? `<span class="evidencia-obs">${escapar(enlace.observacion)}</span>` : ''}
      </div>
      <div class="evidencia-acciones"></div>
    `;

    const $acciones = fila.querySelector('.evidencia-acciones');

    if (editable) {
      const btn = document.createElement('button');
      btn.className = 'boton-icono';
      btn.type = 'button';
      btn.textContent = enlace ? 'Cambiar' : 'Añadir enlace';
      btn.addEventListener('click', () => abrirEnlace(ev, enlace));
      $acciones.appendChild(btn);

      if (enlace) {
        const quitar = document.createElement('button');
        quitar.className = 'boton-icono boton-icono-critico';
        quitar.type = 'button';
        quitar.textContent = 'Quitar';
        quitar.addEventListener('click', () => quitarEnlace(enlace));
        $acciones.appendChild(quitar);
      }
    }

    $cont.appendChild(fila);
  });

  const $nota = document.getElementById('m-nota-evidencias');
  $nota.textContent = esperadas.length > 1
    ? 'El requisito se cumple al entregar todos los documentos. Entregar parte otorga cumplimiento proporcional.'
    : 'Registre el enlace al documento en Drive.';
}

function pintarVigenciaEvidencia(enlace) {
  if (!enlace.fecha_caducidad) {
    return '<span class="evidencia-vigencia">Sin fecha de caducidad</span>';
  }

  if (enlace.vigencia === 'vencido') {
    return `<span class="evidencia-vigencia evidencia-vigencia-vencida">
              Vencido · ${formatearFecha(enlace.fecha_caducidad)}
            </span>`;
  }
  if (enlace.vigencia === 'por_vencer') {
    return `<span class="evidencia-vigencia evidencia-vigencia-aviso">
              Vence en ${enlace.dias_para_vencer} días · ${formatearFecha(enlace.fecha_caducidad)}
            </span>`;
  }
  return `<span class="evidencia-vigencia">
            Vigente hasta ${formatearFecha(enlace.fecha_caducidad)}
          </span>`;
}

function acortar(url) {
  try {
    const u = new URL(url);
    const cola = u.pathname.length > 24 ? u.pathname.slice(0, 24) + '…' : u.pathname;
    return u.hostname + cola;
  } catch { return url.slice(0, 42) + '…'; }
}

/* ============================================
   Guardar requisito
   ============================================ */

async function guardarRequisito() {
  const r = estado.actual;
  if (!r) return;

  const $btn = document.getElementById('btn-guardar-req');
  $btn.disabled = true;

  /* Las fechas son derivadas: las mantiene el trigger */
  const { error } = await supabase
    .from('cumplimientos')
    .update({
      observacion: document.getElementById('m_observacion').value.trim() || null
    })
    .eq('id', r.id);

  $btn.disabled = false;

  if (error) return alertaReq(traducirBd(error));

  document.getElementById('modal-req').hidden = true;
  await cargarTodo();
}

async function marcarNoAplica() {
  const r = estado.actual;
  const motivo = document.getElementById('m_motivo_na').value.trim();

  if (!motivo) return alertaReq('El motivo es obligatorio para excluir el requisito');

  const { error } = await supabase
    .from('cumplimientos')
    .update({ estado: 'no_aplica', motivo_no_aplica: motivo })
    .eq('id', r.id);

  if (error) return alertaReq(traducirBd(error));

  document.getElementById('modal-req').hidden = true;
  await cargarTodo();
}

async function quitarNoAplica() {
  const r = estado.actual;

  /* El trigger recalcula el estado contra las evidencias */
  const { error } = await supabase
    .from('cumplimientos')
    .update({ estado: 'pendiente' })
    .eq('id', r.id);

  if (error) return alertaReq(traducirBd(error));

  document.getElementById('modal-req').hidden = true;
  await cargarTodo();
}

function alertaReq(texto) {
  const $a = document.getElementById('alerta-req');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Enlaces
   ============================================ */

function abrirEnlace(evidencia, enlaceExistente) {
  estado.enlaceDestino = { evidencia, enlace: enlaceExistente };

  document.getElementById('e-titulo').textContent =
    enlaceExistente ? 'Cambiar enlace' : 'Añadir enlace';
  document.getElementById('e-evidencia').textContent = evidencia.etiqueta;
  document.getElementById('e_url').value = enlaceExistente?.url ?? '';
  document.getElementById('e_observacion').value = enlaceExistente?.observacion ?? '';

  /* Documento nuevo: fecha de hoy y caducidad a un año */
  if (enlaceExistente) {
    document.getElementById('e_fecha_registro').value = enlaceExistente.fecha_registro ?? '';
    document.getElementById('e_fecha_caducidad').value = enlaceExistente.fecha_caducidad ?? '';
  } else {
    document.getElementById('e_fecha_registro').value = HOY();
    document.getElementById('e_fecha_caducidad').value = '';
    aplicarUnAnio();
  }

  evaluarCaducidad();
  document.getElementById('alerta-enlace').hidden = true;
  document.getElementById('modal-enlace').hidden = false;
  document.getElementById('e_url').focus();
}

async function guardarEnlace() {
  const { evidencia, enlace } = estado.enlaceDestino || {};
  const r = estado.actual;
  if (!evidencia || !r) return;

  const url = document.getElementById('e_url').value.trim();
  if (!url) return alertaEnlace('Indique el enlace');
  if (!/^https?:\/\//i.test(url)) {
    return alertaEnlace('El enlace debe comenzar con http:// o https://');
  }

  const registro = document.getElementById('e_fecha_registro').value || null;
  const caducidad = document.getElementById('e_fecha_caducidad').value || null;

  if (registro && caducidad && caducidad < registro) {
    return alertaEnlace('La caducidad no puede ser anterior a la fecha del documento');
  }

  const $btn = document.getElementById('btn-guardar-enlace');
  $btn.disabled = true;

  const datos = {
    cumplimiento_id: r.id,
    evidencia_id: evidencia.id,
    etiqueta: evidencia.etiqueta,
    url,
    fecha_registro: registro,
    fecha_caducidad: caducidad,
    observacion: document.getElementById('e_observacion').value.trim() || null
  };

  const { error } = enlace
    ? await supabase.from('cumplimiento_enlaces').update(datos).eq('id', enlace.id)
    : await supabase.from('cumplimiento_enlaces').insert(datos);

  $btn.disabled = false;

  if (error) return alertaEnlace(traducirBd(error));

  document.getElementById('modal-enlace').hidden = true;
  await refrescarModal();
}

async function quitarEnlace(enlace) {
  if (!confirm('¿Quitar este enlace? El requisito volverá a estado pendiente o en proceso.')) return;

  const { error } = await supabase
    .from('cumplimiento_enlaces')
    .delete()
    .eq('id', enlace.id);

  if (error) return alertaReq(traducirBd(error));
  await refrescarModal();
}

/** Recarga datos y repinta el modal sin cerrarlo */
async function refrescarModal() {
  const id = estado.actual?.id;
  await cargarTodo();

  const actualizado = estado.requisitos.find((r) => r.id === id);
  if (!actualizado) { document.getElementById('modal-req').hidden = true; return; }

  estado.actual = actualizado;
  pintarEstadoModal(actualizado);
  pintarEvidenciasModal(actualizado);
}

function alertaEnlace(texto) {
  const $a = document.getElementById('alerta-enlace');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Fechas
   ============================================ */

function aplicarUnAnio() {
  const registro = document.getElementById('e_fecha_registro').value;
  if (!registro) return;

  const f = new Date(registro + 'T00:00');
  f.setFullYear(f.getFullYear() + 1);
  document.getElementById('e_fecha_caducidad').value = f.toISOString().slice(0, 10);
  evaluarCaducidad();
}

function evaluarCaducidad() {
  const valor = document.getElementById('e_fecha_caducidad').value;
  const $ayuda = document.getElementById('ayuda-caducidad');

  if (!valor) { $ayuda.textContent = 'Avisará 30 días antes'; $ayuda.className = 'ayuda'; return; }

  const dias = Math.round((new Date(valor + 'T00:00') - new Date(HOY() + 'T00:00')) / 86400000);

  if (dias < 0) {
    $ayuda.textContent = `Vencido hace ${Math.abs(dias)} días`;
    $ayuda.className = 'ayuda ayuda-error';
  } else if (dias <= 30) {
    $ayuda.textContent = `Vence en ${dias} días`;
    $ayuda.className = 'ayuda ayuda-aviso';
  } else {
    $ayuda.textContent = `Vigente · ${dias} días`;
    $ayuda.className = 'ayuda ayuda-ok';
  }
}

/* ============================================
   Capacitaciones
   El tema persiste entre años; su ejecución no.
   ============================================ */

function prepararAnios() {
  const $sel = document.getElementById('capac-anio');
  const actual = new Date().getFullYear();

  for (let a = actual + 1; a >= actual - 5; a--) {
    const opcion = document.createElement('option');
    opcion.value = a;
    opcion.textContent = a;
    $sel.appendChild(opcion);
  }
  $sel.value = actual;
}

async function cargarCapacitaciones() {
  const [filas, indicador] = await Promise.all([
    supabase.from('v_capacitaciones').select('*')
      .eq('empresa_id', estado.empresaId)
      .eq('ambito', AMBITO)
      .eq('anio', estado.anio)
      .order('orden'),
    supabase.from('v_indicadores_capacitacion').select('*')
      .eq('empresa_id', estado.empresaId)
      .eq('ambito', AMBITO)
      .eq('anio', estado.anio)
      .maybeSingle()
  ]);

  estado.capacitaciones = filas.data || [];
  estado.indCapac = indicador.data;

  /* Sin filas: el año no se ha abierto */
  document.getElementById('btn-abrir-anio').hidden =
    estado.capacitaciones.length > 0 || !puedeEscribir();
  document.getElementById('btn-nuevo-tema').hidden = !puedeEscribir();
}

async function abrirAnio() {
  const $btn = document.getElementById('btn-abrir-anio');
  $btn.disabled = true;

  const { error } = await supabase.rpc('abrir_capacitaciones', {
    p_empresa: estado.empresaId,
    p_ambito: AMBITO,
    p_anio: estado.anio
  });

  $btn.disabled = false;

  if (error) { alert('No fue posible abrir el año: ' + error.message); return; }
  await cargarCapacitaciones();
  pintarCapacitaciones();
}

function pintarCapacitaciones() {
  const i = estado.indCapac;

  document.getElementById('c-programadas').textContent  = i?.programadas ?? 0;
  document.getElementById('c-ejecutadas').textContent   = i?.ejecutadas ?? 0;
  document.getElementById('c-documentadas').textContent = i?.documentadas ?? 0;
  document.getElementById('c-asistentes').textContent   = i?.total_asistentes ?? 0;
  document.getElementById('c-porcentaje').textContent =
    i?.porcentaje_ejecucion != null ? `${i.porcentaje_ejecucion}%` : '—';

  const $cuerpo = document.getElementById('cuerpo-capacitaciones');
  $cuerpo.innerHTML = '';
  document.getElementById('vacio-capac').hidden = estado.capacitaciones.length > 0;

  const frag = document.createDocumentFragment();
  estado.capacitaciones.forEach((c) => frag.appendChild(filaCapacitacion(c)));
  $cuerpo.appendChild(frag);
}

function filaCapacitacion(c) {
  const fila = document.createElement('tr');
  if (!c.tema_activo) fila.classList.add('fila-inactiva');

  fila.innerHTML = `
    <td>
      <span class="principal">${escapar(c.tema)}</span>
      ${!c.tema_activo ? '<span class="secundario">Tema retirado</span>' : ''}
      ${c.tema_descripcion ? `<span class="secundario">${escapar(c.tema_descripcion)}</span>` : ''}
    </td>
    <td class="celda-centro celda-mono">
      ${c.fecha_inicio ? formatearFecha(c.fecha_inicio) : '<span class="celda-tenue">—</span>'}
    </td>
    <td class="celda-centro celda-tenue">${c.dias ?? '—'}</td>
    <td class="celda-centro">
      ${c.asistentes != null
        ? `<span class="asistentes">${c.asistentes}</span>`
        : '<span class="celda-tenue">—</span>'}
    </td>
    <td class="celda-tenue">${escapar(textoOGuion(c.facilitador))}</td>
    <td class="celda-centro"></td>
    <td class="celda-derecha"></td>
  `;

  /* Registro de asistencia */
  const $reg = fila.querySelector('td:nth-child(6)');
  if (c.url_registro) {
    const a = document.createElement('a');
    a.className = 'chip-registro';
    a.href = c.url_registro;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Ver';
    $reg.appendChild(a);
  } else if (c.ejecutada) {
    const s = document.createElement('span');
    s.className = 'chip-falta';
    s.textContent = 'Falta';
    s.title = 'GTH-09 exige el registro de asistencia firmado';
    $reg.appendChild(s);
  } else {
    $reg.innerHTML = '<span class="celda-tenue">—</span>';
  }

  /* Acciones */
  const $acc = fila.querySelector('td:last-child');
  if (puedeEscribir()) {
    const editar = document.createElement('button');
    editar.className = 'boton-icono';
    editar.type = 'button';
    editar.textContent = c.ejecutada ? 'Editar' : 'Registrar';
    editar.addEventListener('click', () => abrirCapacitacion(c));
    $acc.appendChild(editar);

    if (c.tema_activo) {
      const quitar = document.createElement('button');
      quitar.className = 'boton-icono boton-icono-critico';
      quitar.type = 'button';
      quitar.textContent = 'Quitar tema';
      quitar.addEventListener('click', () => quitarTema(c));
      $acc.appendChild(quitar);
    }
  } else {
    $acc.innerHTML = '<span class="celda-tenue">—</span>';
  }

  return fila;
}

/* --- Modal de capacitación --- */

function abrirCapacitacion(c) {
  estado.capacActual = c;

  document.getElementById('c-titulo').textContent = c.tema;
  document.getElementById('c-anio-marca').textContent = c.anio;
  document.getElementById('c_fecha_inicio').value = c.fecha_inicio ?? '';
  document.getElementById('c_fecha_fin').value = c.fecha_fin ?? '';
  document.getElementById('c_asistentes').value = c.asistentes ?? '';
  document.getElementById('c_facilitador').value = c.facilitador ?? '';
  document.getElementById('c_url').value = c.url_registro ?? '';
  document.getElementById('c_observacion').value = c.observacion ?? '';

  document.getElementById('alerta-capac').hidden = true;
  document.getElementById('modal-capac').hidden = false;
  document.getElementById('c_fecha_inicio').focus();
}

async function guardarCapacitacion() {
  const c = estado.capacActual;
  if (!c) return;

  const inicio = document.getElementById('c_fecha_inicio').value || null;
  const fin = document.getElementById('c_fecha_fin').value || null;
  const url = document.getElementById('c_url').value.trim() || null;
  const asistentes = document.getElementById('c_asistentes').value;

  if (fin && !inicio) {
    return alertaCapac('Indique primero la fecha de realización');
  }
  if (inicio && fin && fin < inicio) {
    return alertaCapac('La fecha de cierre no puede ser anterior a la de realización');
  }
  if (url && !/^https?:\/\//i.test(url)) {
    return alertaCapac('El enlace debe comenzar con http:// o https://');
  }
  if (url && !inicio) {
    return alertaCapac('Indique la fecha: el registro de asistencia la necesita para calcular vigencia');
  }

  const $btn = document.getElementById('btn-guardar-capac');
  $btn.disabled = true;

  const { error } = await supabase
    .from('capacitaciones')
    .update({
      fecha_inicio: inicio,
      fecha_fin: fin,
      asistentes: asistentes === '' ? null : parseInt(asistentes, 10),
      facilitador: document.getElementById('c_facilitador').value.trim() || null,
      url_registro: url,
      observacion: document.getElementById('c_observacion').value.trim() || null
    })
    .eq('id', c.id);

  $btn.disabled = false;

  if (error) return alertaCapac(traducirBd(error));

  document.getElementById('modal-capac').hidden = true;
  await cargarCapacitaciones();
  pintarCapacitaciones();

  /* El registro alimenta GTH-09: refrescar el cumplimiento */
  await cargarTodo();
}

function alertaCapac(texto) {
  const $a = document.getElementById('alerta-capac');
  $a.textContent = texto;
  $a.hidden = false;
}

/* --- Temas --- */

function abrirTema() {
  document.getElementById('t_nombre').value = '';
  document.getElementById('t_descripcion').value = '';
  document.getElementById('alerta-tema').hidden = true;
  document.getElementById('modal-tema').hidden = false;
  document.getElementById('t_nombre').focus();
}

async function guardarTema() {
  const nombre = document.getElementById('t_nombre').value.trim();
  if (!nombre) return alertaTema('Indique el nombre del tema');

  const $btn = document.getElementById('btn-guardar-tema');
  $btn.disabled = true;

  /* Orden al final de la lista */
  const orden = estado.capacitaciones.length > 0
    ? Math.max(...estado.capacitaciones.map((c) => c.orden || 0)) + 1
    : 1;

  const { data, error } = await supabase
    .from('capacitacion_temas')
    .insert({
      ambito: AMBITO,
      nombre,
      descripcion: document.getElementById('t_descripcion').value.trim() || null,
      orden
    })
    .select()
    .single();

  if (error) { $btn.disabled = false; return alertaTema(traducirBd(error)); }

  /* Abrir la fila del año en curso para el tema nuevo */
  await supabase.from('capacitaciones').insert({
    empresa_id: estado.empresaId,
    tema_id: data.id,
    anio: estado.anio
  });

  $btn.disabled = false;
  document.getElementById('modal-tema').hidden = true;

  await cargarCapacitaciones();
  pintarCapacitaciones();
  await cargarTodo();
}

/**
 * Baja lógica: el tema desaparece de la lista y de GTH-09,
 * pero los años ya cerrados conservan su registro.
 */
async function quitarTema(c) {
  const aviso = c.ejecutada
    ? `¿Retirar "${c.tema}"?\n\nTiene registro en ${c.anio}. El historial se conserva, ` +
      'pero el tema dejará de exigirse y saldrá de GTH-09.'
    : `¿Retirar "${c.tema}"?\n\nSaldrá de la lista y de GTH-09 en todas las empresas.`;

  if (!confirm(aviso)) return;

  const { error } = await supabase
    .from('capacitacion_temas')
    .update({ activo: false })
    .eq('id', c.tema_id);

  if (error) { alert(traducirBd(error)); return; }

  await cargarCapacitaciones();
  pintarCapacitaciones();
  await cargarTodo();
}

function alertaTema(texto) {
  const $a = document.getElementById('alerta-tema');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Eventos
   Seguridad: incidentes y accidentes.
   Salud: enfermedades profesionales.
   Mismo motor; la tabla y las columnas cambian.
   ============================================ */

/* Configuración por ámbito: evita duplicar la lógica */
const EVENTOS = AMBITO === 'seguridad'
  ? {
      tabla: 'eventos_sst',
      vista: 'v_eventos_sst',
      indicadores: 'v_indicadores_eventos',
      titulo: 'Registrar evento',
      etiquetaFecha: 'Fecha del evento',
      textoReporte: 'Reportado al IESS',
      pista: 'Los accidentes sin investigar ni reportar incumplen POB-08 y POB-09.'
    }
  : {
      tabla: 'enfermedades_profesionales',
      vista: 'v_enfermedades_profesionales',
      indicadores: 'v_indicadores_ep',
      titulo: 'Registrar enfermedad profesional',
      etiquetaFecha: 'Fecha de presunción',
      textoReporte: 'Presunción reportada',
      pista: 'La presunción sin reportar a la autoridad incumple POB-12.'
    };

const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function prepararAniosEventos() {
  const actual = new Date().getFullYear();
  ['ev-anio', 'ao-anio'].forEach((id) => {
    const $sel = document.getElementById(id);
    if (!$sel) return;
    for (let a = actual; a >= actual - 5; a--) {
      const opcion = document.createElement('option');
      opcion.value = a;
      opcion.textContent = a;
      $sel.appendChild(opcion);
    }
  });
}

async function cargarEventos() {
  const anio = parseInt(document.getElementById('ev-anio').value, 10);
  const mes = parseInt(document.getElementById('ev-mes').value, 10);

  let consulta = supabase.from(EVENTOS.vista).select('*')
    .eq('empresa_id', estado.empresaId)
    .eq('anio', anio)
    .order('fecha', { ascending: false });

  if (mes !== 0) consulta = consulta.eq('mes', mes);

  const { data, error } = await consulta;
  estado.eventos = error ? [] : (data || []);

  /* Indicadores del período */
  let ind = supabase.from(EVENTOS.indicadores).select('*')
    .eq('empresa_id', estado.empresaId).eq('anio', anio);
  if (mes !== 0) ind = ind.eq('mes', mes);

  const { data: filas } = await ind;
  estado.indEventos = agregarIndicadores(filas || []);

  document.getElementById('btn-nuevo-evento').hidden = !puedeEscribir();
  document.getElementById('ev-pista').textContent = EVENTOS.pista;
}

/** Suma los meses del período seleccionado */
function agregarIndicadores(filas) {
  if (filas.length === 0) return null;

  const suma = {};
  const campos = Object.keys(filas[0]).filter(
    (k) => !['empresa_id', 'anio', 'mes', 'ambito'].includes(k)
  );

  campos.forEach((c) => {
    suma[c] = filas.reduce((s, f) => s + (Number(f[c]) || 0), 0);
  });

  return suma;
}

function pintarEventos() {
  pintarTarjetasEventos();
  pintarDistribuciones();
  pintarTablaEventos();
}

function pintarTarjetasEventos() {
  const i = estado.indEventos;
  const $cont = document.getElementById('ev-tarjetas');

  const tarjetas = AMBITO === 'seguridad'
    ? [
        { etiqueta: 'Incidentes', valor: i?.incidentes ?? 0 },
        { etiqueta: 'Accidentes', valor: i?.accidentes ?? 0 },
        { etiqueta: 'Con baja', valor: i?.accidentes_baja ?? 0, alerta: true },
        { etiqueta: 'Días perdidos', valor: i?.dias_perdidos ?? 0, alerta: true }
      ]
    : [
        { etiqueta: 'Presunciones', valor: i?.presunciones ?? 0 },
        { etiqueta: 'Calificadas', valor: i?.calificadas ?? 0, alerta: true },
        { etiqueta: 'Descartadas', valor: i?.descartadas ?? 0 },
        { etiqueta: 'Días perdidos', valor: i?.dias_perdidos ?? 0 }
      ];

  $cont.innerHTML = tarjetas.map((t) => `
    <article class="resumen-item ${t.alerta && t.valor > 0 ? 'resumen-alerta' : ''}">
      <span class="resumen-etiqueta">${t.etiqueta}</span>
      <span class="resumen-valor">${t.valor}</span>
    </article>
  `).join('');
}

function pintarDistribuciones() {
  const i = estado.indEventos;

  pintarBarras('ev-sexo', [
    { etiqueta: 'Hombres', valor: i?.hombres ?? 0 },
    { etiqueta: 'Mujeres', valor: i?.mujeres ?? 0 }
  ]);

  pintarBarras('ev-turno', [
    { etiqueta: 'Día', valor: i?.turno_dia ?? 0 },
    { etiqueta: 'Tarde', valor: i?.turno_tarde ?? 0 },
    { etiqueta: 'Noche', valor: i?.turno_noche ?? 0 }
  ]);

  /* Por área: se calcula del listado, no hay vista agregada */
  const porArea = new Map();
  estado.eventos.forEach((e) => {
    const a = e.area || 'Sin especificar';
    porArea.set(a, (porArea.get(a) || 0) + 1);
  });

  const areas = [...porArea.entries()]
    .map(([etiqueta, valor]) => ({ etiqueta, valor }))
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 6);

  pintarBarras('ev-area', areas);
}

function pintarBarras(id, datos) {
  const $cont = document.getElementById(id);
  const total = datos.reduce((s, d) => s + d.valor, 0);

  if (total === 0) {
    $cont.innerHTML = '<p class="barras-vacio">Sin registros</p>';
    return;
  }

  $cont.innerHTML = datos.map((d) => {
    const pct = Math.round(d.valor / total * 100);
    return `
      <div class="barra-fila">
        <span class="barra-etiqueta">${escapar(d.etiqueta)}</span>
        <div class="barra-pista">
          <div class="barra-relleno" style="width:${pct}%"></div>
        </div>
        <span class="barra-valor">${d.valor}</span>
        <span class="barra-pct">${pct}%</span>
      </div>
    `;
  }).join('');
}

function pintarTablaEventos() {
  const $cab = document.getElementById('ev-cabecera');
  const $cuerpo = document.getElementById('cuerpo-eventos');

  $cab.innerHTML = AMBITO === 'seguridad'
    ? `<th class="celda-centro">Fecha</th>
       <th class="celda-centro">Tipo</th>
       <th>Área</th>
       <th class="celda-centro">Turno</th>
       <th class="celda-centro">Sexo</th>
       <th>Descripción</th>
       <th class="celda-centro">Baja</th>
       <th class="celda-centro">Gestión</th>
       <th class="celda-derecha">Acciones</th>`
    : `<th class="celda-centro">Fecha</th>
       <th class="celda-centro">Estado</th>
       <th>Área</th>
       <th class="celda-centro">Turno</th>
       <th class="celda-centro">Sexo</th>
       <th>Diagnóstico</th>
       <th class="celda-centro">Baja</th>
       <th class="celda-centro">Reporte</th>
       <th class="celda-derecha">Acciones</th>`;

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-eventos').hidden = estado.eventos.length > 0;

  const frag = document.createDocumentFragment();
  estado.eventos.forEach((e) => frag.appendChild(filaEvento(e)));
  $cuerpo.appendChild(frag);
}

const ETIQUETA_TIPO = {
  incidente:      ['insignia-inactiva', 'Incidente'],
  accidente:      ['insignia-aviso',    'Accidente'],
  accidente_baja: ['insignia-critica',  'Con baja']
};

const ETIQUETA_EP = {
  presuncion: ['insignia-aviso',    'Presunción'],
  calificada: ['insignia-critica',  'Calificada'],
  descartada: ['insignia-inactiva', 'Descartada']
};

function filaEvento(e) {
  const fila = document.createElement('tr');

  const [clase, texto] = AMBITO === 'seguridad'
    ? (ETIQUETA_TIPO[e.tipo] || ['insignia-inactiva', '—'])
    : (ETIQUETA_EP[e.estado] || ['insignia-inactiva', '—']);

  const detalle = AMBITO === 'seguridad'
    ? escapar(e.descripcion || '')
    : `${e.codigo_cie10 ? `<span class="cie-chip">${escapar(e.codigo_cie10)}</span> ` : ''}${escapar(e.diagnostico || '')}`;

  fila.innerHTML = `
    <td class="celda-centro celda-mono">${formatearFecha(e.fecha)}</td>
    <td class="celda-centro"><span class="insignia ${clase}">${texto}</span></td>
    <td>${escapar(textoOGuion(e.area))}</td>
    <td class="celda-centro celda-tenue">${turnoTexto(e.turno)}</td>
    <td class="celda-centro">${e.sexo === 'M' ? 'H' : 'M'}</td>
    <td class="celda-detalle">
      ${detalle}
      ${e.trabajador ? `<span class="secundario">${escapar(e.trabajador)}</span>` : ''}
    </td>
    <td class="celda-centro">
      ${e.dias_baja > 0 ? `<span class="reposo">${e.dias_baja}</span>` : '—'}
    </td>
    <td class="celda-centro"></td>
    <td class="celda-derecha"></td>
  `;

  /* Gestión */
  const $g = fila.querySelector('td:nth-child(8)');
  if (e.gestion === 'sin_investigar') {
    $g.innerHTML = '<span class="chip-falta" title="POB-08 exige el informe de investigación">Sin investigar</span>';
  } else if (e.gestion === 'sin_reportar') {
    $g.innerHTML = `<span class="chip-falta" title="${AMBITO === 'seguridad' ? 'POB-09' : 'POB-12'} exige el reporte a la autoridad">Sin reportar</span>`;
  } else if (e.gestion) {
    $g.innerHTML = '<span class="chip-registro-est">Gestionado</span>';
  } else {
    $g.innerHTML = '<span class="celda-tenue">—</span>';
  }

  /* Acciones */
  const $a = fila.querySelector('td:last-child');
  if (puedeEscribir()) {
    const btn = document.createElement('button');
    btn.className = 'boton-icono';
    btn.type = 'button';
    btn.textContent = 'Editar';
    btn.addEventListener('click', () => abrirEvento(e));
    $a.appendChild(btn);
  } else {
    $a.innerHTML = '<span class="celda-tenue">—</span>';
  }

  return fila;
}

function turnoTexto(t) {
  return { dia: 'Día', tarde: 'Tarde', noche: 'Noche' }[t] || '—';
}

/* --- Modal de evento --- */

async function abrirEvento(e) {
  estado.eventoActual = e || null;

  document.getElementById('ev-titulo').textContent =
    e ? 'Editar registro' : EVENTOS.titulo;
  document.getElementById('ev-etiqueta-fecha').textContent = EVENTOS.etiquetaFecha;
  document.getElementById('ev-texto-reporte').textContent = EVENTOS.textoReporte;

  /* Campos propios de cada ámbito */
  const esSeguridad = AMBITO === 'seguridad';
  document.getElementById('ev-campo-tipo').hidden = !esSeguridad;
  document.getElementById('ev-campo-hora').hidden = !esSeguridad;
  document.getElementById('ev-campo-investigado').hidden = !esSeguridad;
  document.getElementById('ev-bloque-desc').hidden = !esSeguridad;
  document.getElementById('ev-campo-estado').hidden = esSeguridad;
  document.getElementById('ev-bloque-dx').hidden = esSeguridad;

  await cargarAreas();

  if (e) {
    document.getElementById('ev_fecha').value = e.fecha ?? '';
    document.getElementById('ev_hora').value = e.hora?.slice(0, 5) ?? '';
    document.getElementById('ev_turno').value = e.turno ?? 'dia';
    document.getElementById('ev_area').value = e.area_id ?? '';
    document.getElementById('ev_area_texto').value = e.area_id ? '' : (e.area ?? '');
    document.getElementById('ev_codigo').value = e.codigo_trabajador ?? '';
    document.getElementById('ev_sexo').value = e.sexo ?? 'M';
    document.getElementById('ev_dias').value = e.dias_baja ?? 0;
    document.getElementById('ev_reportado').checked = e.reportado_iess ?? false;
    document.getElementById('ev_fecha_reporte').value = e.fecha_reporte ?? '';
    document.getElementById('ev_url').value = e.url_informe ?? '';
    document.getElementById('ev_medidas').value = e.medidas ?? '';
    document.getElementById('ev_observacion').value = e.observacion ?? '';

    if (esSeguridad) {
      marcarRadio('ev_tipo', e.tipo);
      document.getElementById('ev_investigado').checked = e.investigado ?? false;
      document.getElementById('ev_descripcion').value = e.descripcion ?? '';
      document.getElementById('ev_parte').value = e.parte_cuerpo ?? '';
      document.getElementById('ev_agente').value = e.agente ?? '';
    } else {
      marcarRadio('ev_estado', e.estado);
      document.getElementById('ev_cie').value = e.codigo_cie10 ?? '';
      document.getElementById('ev_diagnostico').value = e.diagnostico ?? '';
      document.getElementById('ev_agente_causal').value = e.agente_causal ?? '';
      document.getElementById('ev_fecha_dictamen').value = e.fecha_dictamen ?? '';
    }
  } else {
    limpiarFormEvento();
  }

  document.getElementById('btn-eliminar-evento').hidden = !e || !puedeEscribir();
  document.getElementById('alerta-evento').hidden = true;
  ajustarCamposEvento();
  document.getElementById('modal-evento').hidden = false;
  document.getElementById('ev_fecha').focus();
}

function limpiarFormEvento() {
  ['ev_fecha', 'ev_hora', 'ev_area_texto', 'ev_codigo', 'ev_url', 'ev_medidas',
   'ev_observacion', 'ev_descripcion', 'ev_parte', 'ev_agente', 'ev_cie',
   'ev_diagnostico', 'ev_agente_causal', 'ev_fecha_dictamen', 'ev_fecha_reporte'
  ].forEach((id) => {
    const $e = document.getElementById(id);
    if ($e) $e.value = '';
  });

  document.getElementById('ev_fecha').value = HOY();
  document.getElementById('ev_turno').value = 'dia';
  document.getElementById('ev_area').value = '';
  document.getElementById('ev_sexo').value = 'M';
  document.getElementById('ev_dias').value = 0;
  document.getElementById('ev_investigado').checked = false;
  document.getElementById('ev_reportado').checked = false;
  document.getElementById('ev-ayuda-trabajador').textContent = '';
  marcarRadio('ev_tipo', 'incidente');
  marcarRadio('ev_estado', 'presuncion');
}

function marcarRadio(nombre, valor) {
  const $r = document.querySelector(`input[name="${nombre}"][value="${valor}"]`);
  if ($r) $r.checked = true;
}

function leerRadio(nombre) {
  return document.querySelector(`input[name="${nombre}"]:checked`)?.value;
}

/** Muestra u oculta campos según el tipo o estado elegido */
function ajustarCamposEvento() {
  if (AMBITO === 'seguridad') {
    const tipo = leerRadio('ev_tipo');
    const conBaja = tipo === 'accidente_baja';
    document.getElementById('ev-campo-dias').hidden = !conBaja;
    if (!conBaja) document.getElementById('ev_dias').value = 0;
  } else {
    const est = leerRadio('ev_estado');
    document.getElementById('ev-campo-dictamen').hidden = est === 'presuncion';
  }

  document.getElementById('ev-campo-freporte').hidden =
    !document.getElementById('ev_reportado').checked;
}

/** Las áreas cuelgan de sucursal; se unen por empresa */
async function cargarAreas() {
  const $sel = document.getElementById('ev_area');
  if ($sel.dataset.empresa === estado.empresaId) return;

  const { data, error } = await supabase
    .from('areas')
    .select('id, nombre, sucursales!inner(empresa_id, nombre)')
    .eq('sucursales.empresa_id', estado.empresaId)
    .eq('activo', true)
    .order('nombre');

  $sel.innerHTML = '<option value="">— Seleccione —</option>';
  if (error) return;

  (data || []).forEach((a) => {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.nombre;
    $sel.appendChild(o);
  });

  $sel.dataset.empresa = estado.empresaId;
}

/** Busca el trabajador por código y autocompleta el sexo */
const buscarTrabajadorEvento = retrasar(async () => {
  const codigo = parseInt(document.getElementById('ev_codigo').value, 10);
  const $ayuda = document.getElementById('ev-ayuda-trabajador');

  if (!codigo) { $ayuda.textContent = ''; estado.trabajadorEvento = null; return; }

  const { data } = await supabase
    .from('v_trabajadores')
    .select('id, nombre_completo, sexo')
    .eq('empresa_id', estado.empresaId)
    .eq('codigo', codigo)
    .maybeSingle();

  if (!data) {
    $ayuda.textContent = 'Código no encontrado';
    $ayuda.className = 'ayuda ayuda-error';
    estado.trabajadorEvento = null;
    return;
  }

  $ayuda.textContent = data.nombre_completo;
  $ayuda.className = 'ayuda ayuda-ok';
  estado.trabajadorEvento = data;
  if (data.sexo) document.getElementById('ev_sexo').value = data.sexo;
}, 400);

/* --- Buscador CIE-10 para enfermedad profesional --- */

const buscarCieEvento = retrasar(async () => {
  const texto = document.getElementById('ev_cie').value.trim();
  const $sug = document.getElementById('ev_cie_sug');

  if (texto.length < 2) { $sug.hidden = true; return; }

  const { data } = await supabase
    .from('cie10')
    .select('codigo, descripcion')
    .or(`codigo.ilike.${texto}%,descripcion.ilike.%${texto}%`)
    .order('codigo')
    .limit(8);

  if (!data || data.length === 0) { $sug.hidden = true; return; }

  $sug.innerHTML = '';
  data.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'sugerencia';
    b.type = 'button';
    b.innerHTML = `<span class="cie-chip">${escapar(c.codigo)}</span>
                   <span class="sugerencia-nombre">${escapar(c.descripcion)}</span>`;
    b.addEventListener('click', () => {
      document.getElementById('ev_cie').value = c.codigo;
      document.getElementById('ev_diagnostico').value = c.descripcion;
      $sug.hidden = true;
    });
    $sug.appendChild(b);
  });
  $sug.hidden = false;
}, 300);

/* --- Guardar --- */

async function guardarEvento() {
  const fecha = document.getElementById('ev_fecha').value;
  if (!fecha) return alertaEvento('Indique la fecha');

  const areaId = document.getElementById('ev_area').value || null;
  const areaTexto = document.getElementById('ev_area_texto').value.trim() || null;
  if (!areaId && !areaTexto) return alertaEvento('Indique el área o escriba el lugar');

  const url = document.getElementById('ev_url').value.trim() || null;
  if (url && !/^https?:\/\//i.test(url)) {
    return alertaEvento('El enlace debe comenzar con http:// o https://');
  }

  const base = {
    empresa_id: estado.empresaId,
    fecha,
    turno: document.getElementById('ev_turno').value,
    area_id: areaId,
    area_texto: areaId ? null : areaTexto,
    trabajador_id: estado.trabajadorEvento?.id ?? null,
    sexo: document.getElementById('ev_sexo').value,
    reportado_iess: document.getElementById('ev_reportado').checked,
    fecha_reporte: document.getElementById('ev_fecha_reporte').value || null,
    url_informe: url,
    medidas: document.getElementById('ev_medidas').value.trim() || null,
    observacion: document.getElementById('ev_observacion').value.trim() || null
  };

  let datos;

  if (AMBITO === 'seguridad') {
    const tipo = leerRadio('ev_tipo');
    const dias = parseInt(document.getElementById('ev_dias').value, 10) || 0;
    const desc = document.getElementById('ev_descripcion').value.trim();

    if (!desc) return alertaEvento('Describa lo ocurrido');
    if (tipo === 'accidente_baja' && dias < 1) {
      return alertaEvento('El accidente con baja requiere al menos un día perdido');
    }

    datos = {
      ...base,
      tipo,
      hora: document.getElementById('ev_hora').value || null,
      descripcion: desc,
      parte_cuerpo: document.getElementById('ev_parte').value.trim() || null,
      agente: document.getElementById('ev_agente').value.trim() || null,
      dias_baja: tipo === 'accidente_baja' ? dias : 0,
      investigado: document.getElementById('ev_investigado').checked
    };
  } else {
    const est = leerRadio('ev_estado');
    const dx = document.getElementById('ev_diagnostico').value.trim();
    const dictamen = document.getElementById('ev_fecha_dictamen').value || null;

    if (!dx) return alertaEvento('Indique el diagnóstico');
    if (est !== 'presuncion' && !dictamen) {
      return alertaEvento('Un caso calificado o descartado exige la fecha del dictamen');
    }

    datos = {
      ...base,
      estado: est,
      codigo_cie10: document.getElementById('ev_cie').value.trim() || null,
      diagnostico: dx,
      agente_causal: document.getElementById('ev_agente_causal').value.trim() || null,
      fecha_dictamen: dictamen,
      dias_baja: parseInt(document.getElementById('ev_dias').value, 10) || 0
    };
  }

  const $btn = document.getElementById('btn-guardar-evento');
  $btn.disabled = true;

  const { error } = estado.eventoActual
    ? await supabase.from(EVENTOS.tabla).update(datos).eq('id', estado.eventoActual.id)
    : await supabase.from(EVENTOS.tabla).insert(datos);

  $btn.disabled = false;

  if (error) return alertaEvento(traducirBd(error));

  document.getElementById('modal-evento').hidden = true;
  await cargarEventos();
  pintarEventos();
}

async function eliminarEvento() {
  const e = estado.eventoActual;
  if (!e) return;
  if (!confirm('¿Eliminar este registro? La acción no se puede deshacer.')) return;

  const { error } = await supabase.from(EVENTOS.tabla).delete().eq('id', e.id);
  if (error) return alertaEvento(traducirBd(error));

  document.getElementById('modal-evento').hidden = true;
  await cargarEventos();
  pintarEventos();
}

function alertaEvento(texto) {
  const $a = document.getElementById('alerta-evento');
  $a.textContent = texto;
  $a.hidden = false;
}

/* ============================================
   Atenciones ocupacionales · solo salud
   Conteo mensual: el expediente individual ya
   vive en el módulo clínico.
   ============================================ */

const TIPOS_AO = [
  { id: 'ingreso',   texto: 'Ingreso' },
  { id: 'periodica', texto: 'Periódica' },
  { id: 'reintegro', texto: 'Reintegro' },
  { id: 'egreso',    texto: 'Egreso' }
];

async function cargarOcupacionales() {
  if (AMBITO !== 'salud') return;

  const anio = parseInt(document.getElementById('ao-anio').value, 10);

  const [filas, ind] = await Promise.all([
    supabase.from('v_atenciones_ocupacionales').select('*')
      .eq('empresa_id', estado.empresaId).eq('anio', anio)
      .order('mes'),
    supabase.from('v_indicadores_atenciones_ocup').select('*')
      .eq('empresa_id', estado.empresaId).eq('anio', anio).maybeSingle()
  ]);

  estado.ocupacionales = filas.data || [];
  estado.indOcup = ind.data;

  document.getElementById('btn-abrir-ao').hidden =
    estado.ocupacionales.length > 0 || !puedeEscribir();
}

function pintarOcupacionales() {
  const i = estado.indOcup;

  document.getElementById('ao-ingreso').textContent   = i?.ingreso ?? 0;
  document.getElementById('ao-periodica').textContent = i?.periodica ?? 0;
  document.getElementById('ao-reintegro').textContent = i?.reintegro ?? 0;
  document.getElementById('ao-egreso').textContent    = i?.egreso ?? 0;
  document.getElementById('ao-total').textContent     = i?.total ?? 0;

  pintarBarras('ao-sexo', [
    { etiqueta: 'Hombres', valor: i?.hombres ?? 0 },
    { etiqueta: 'Mujeres', valor: i?.mujeres ?? 0 }
  ]);

  const $cuerpo = document.getElementById('cuerpo-ocupacionales');
  const $pie = document.getElementById('pie-ocupacionales');
  $cuerpo.innerHTML = '';
  $pie.innerHTML = '';

  document.getElementById('vacio-ao').hidden = estado.ocupacionales.length > 0;
  if (estado.ocupacionales.length === 0) return;

  /* Indexar por mes y tipo */
  const mapa = new Map();
  estado.ocupacionales.forEach((a) => {
    if (!mapa.has(a.mes)) mapa.set(a.mes, {});
    mapa.get(a.mes)[a.tipo] = a;
  });

  const frag = document.createDocumentFragment();
  const totales = {};
  TIPOS_AO.forEach((t) => { totales[t.id] = { h: 0, m: 0 }; });

  for (let mes = 1; mes <= 12; mes++) {
    const datos = mapa.get(mes) || {};
    const fila = document.createElement('tr');
    fila.className = 'fila-mes';

    let celdas = `<td class="celda-mes">${MESES[mes]}</td>`;
    let totalMes = 0;

    TIPOS_AO.forEach((t) => {
      const d = datos[t.id];
      const h = d?.hombres ?? 0;
      const m = d?.mujeres ?? 0;
      totalMes += h + m;
      totales[t.id].h += h;
      totales[t.id].m += m;

      celdas += `
        <td class="celda-centro ${h ? '' : 'celda-cero'}">${h}</td>
        <td class="celda-centro ${m ? '' : 'celda-cero'}">${m}</td>
        <td class="celda-centro celda-subtotal">${h + m || '—'}</td>
      `;
    });

    celdas += `<td class="celda-centro celda-total">${totalMes || '—'}</td>`;
    fila.innerHTML = celdas;

    if (puedeEscribir()) {
      fila.classList.add('fila-editable');
      fila.addEventListener('click', () => abrirOcupacional(mes, datos));
    }

    frag.appendChild(fila);
  }

  $cuerpo.appendChild(frag);

  /* Pie con totales */
  let pie = '<tr class="fila-totales"><td class="celda-mes">Total</td>';
  let granTotal = 0;

  TIPOS_AO.forEach((t) => {
    const { h, m } = totales[t.id];
    granTotal += h + m;
    pie += `<td class="celda-centro">${h}</td>
            <td class="celda-centro">${m}</td>
            <td class="celda-centro celda-subtotal">${h + m}</td>`;
  });

  pie += `<td class="celda-centro celda-total">${granTotal}</td></tr>`;
  $pie.innerHTML = pie;
}

async function abrirAnioOcupacional() {
  const $btn = document.getElementById('btn-abrir-ao');
  $btn.disabled = true;

  const { error } = await supabase.rpc('abrir_atenciones_ocupacionales', {
    p_empresa: estado.empresaId,
    p_anio: parseInt(document.getElementById('ao-anio').value, 10)
  });

  $btn.disabled = false;
  if (error) { alert('No fue posible abrir el año: ' + error.message); return; }

  await cargarOcupacionales();
  pintarOcupacionales();
}

function abrirOcupacional(mes, datos) {
  estado.ocupActual = { mes, datos };

  document.getElementById('ao-titulo').textContent = MESES[mes];
  document.getElementById('ao-marca').textContent = document.getElementById('ao-anio').value;

  const $campos = document.getElementById('ao-campos');
  $campos.innerHTML = TIPOS_AO.map((t) => {
    const d = datos[t.id];
    return `
      <div class="ao-grupo">
        <span class="ao-tipo">${t.texto}</span>
        <div class="ao-entradas">
          <div class="campo campo-mini">
            <label class="etiqueta" for="ao_${t.id}_h">Hombres</label>
            <input class="entrada" id="ao_${t.id}_h" type="number" min="0"
                   value="${d?.hombres ?? 0}">
          </div>
          <div class="campo campo-mini">
            <label class="etiqueta" for="ao_${t.id}_m">Mujeres</label>
            <input class="entrada" id="ao_${t.id}_m" type="number" min="0"
                   value="${d?.mujeres ?? 0}">
          </div>
        </div>
      </div>
    `;
  }).join('');

  const primero = datos[TIPOS_AO[0].id];
  document.getElementById('ao_observacion').value = primero?.observacion ?? '';

  document.getElementById('alerta-ao').hidden = true;
  document.getElementById('modal-ao').hidden = false;
}

async function guardarOcupacional() {
  const { mes, datos } = estado.ocupActual || {};
  if (!mes) return;

  const anio = parseInt(document.getElementById('ao-anio').value, 10);
  const observacion = document.getElementById('ao_observacion').value.trim() || null;

  const $btn = document.getElementById('btn-guardar-ao');
  $btn.disabled = true;

  const filas = TIPOS_AO.map((t) => ({
    empresa_id: estado.empresaId,
    anio,
    mes,
    tipo: t.id,
    hombres: parseInt(document.getElementById(`ao_${t.id}_h`).value, 10) || 0,
    mujeres: parseInt(document.getElementById(`ao_${t.id}_m`).value, 10) || 0,
    observacion
  }));

  const { error } = await supabase
    .from('atenciones_ocupacionales')
    .upsert(filas, { onConflict: 'empresa_id,anio,mes,tipo' });

  $btn.disabled = false;

  if (error) {
    const $a = document.getElementById('alerta-ao');
    $a.textContent = traducirBd(error);
    $a.hidden = false;
    return;
  }

  document.getElementById('modal-ao').hidden = true;
  await cargarOcupacionales();
  pintarOcupacionales();
}

/* ============================================
   Pestañas
   ============================================ */

function cambiarVista(vista) {
  estado.vista = vista;
  document.querySelectorAll('.pestana').forEach((p) => {
    p.classList.toggle('activa', p.dataset.vista === vista);
  });
  ['cumplimiento', 'capacitaciones', 'eventos', 'ocupacionales'].forEach((v) => {
    const $v = document.getElementById('vista-' + v);
    if ($v) $v.hidden = v !== vista;
  });
  if (vista === 'capacitaciones') pintarCapacitaciones();
  if (vista === 'eventos') pintarEventos();
  if (vista === 'ocupacionales') pintarOcupacionales();
}

/** Atenciones ocupacionales solo existen en salud */
function ocultarPestanasAjenas() {
  if (AMBITO === 'salud') return;
  const $p = document.querySelector('.pestana[data-vista="ocupacionales"]');
  const $v = document.getElementById('vista-ocupacionales');
  if ($p) $p.remove();
  if ($v) $v.remove();
}

async function cambiarAnio() {
  estado.anio = parseInt(document.getElementById('capac-anio').value, 10);
  await cargarCapacitaciones();
  pintarCapacitaciones();
}

/* ============================================
   Empresa
   ============================================ */

async function seleccionarEmpresa() {
  estado.empresaId = $empresa.value || null;

  if (!estado.empresaId) {
    sessionStorage.removeItem('nexus_empresa');
    $area.hidden = true;
    $avisoIni.hidden = false;
    return;
  }

  sessionStorage.setItem('nexus_empresa', estado.empresaId);
  $area.hidden = false;
  $avisoIni.hidden = true;

  await cargarTodo();
  await Promise.all([cargarCapacitaciones(), cargarEventos(), cargarOcupacionales()]);

  if (estado.vista === 'capacitaciones') pintarCapacitaciones();
  if (estado.vista === 'eventos') pintarEventos();
  if (estado.vista === 'ocupacionales') pintarOcupacionales();
}

/* ============================================
   Utilidad
   ============================================ */

function traducirBd(error) {
  const m = error.message || '';
  if (error.code === '42501') {
    return AMBITO === 'salud'
      ? 'Solo el médico ocupacional o el administrador pueden registrar cumplimiento de salud'
      : 'Solo el técnico de SST o el administrador pueden registrar cumplimiento de seguridad';
  }
  if (m.includes('ck_motivo_no_aplica')) return 'El motivo es obligatorio al marcar no aplica';
  if (m.includes('ck_url')) return 'El enlace debe comenzar con http:// o https://';
  if (m.includes('ck_caducidad')) return 'La caducidad no puede ser anterior al registro';
  if (error.code === '23505') return 'Ya existe un enlace para esa evidencia';
  return 'Error: ' + m;
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  $empresa.addEventListener('change', seleccionarEmpresa);

  document.querySelectorAll('[data-cierra]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.cierra).hidden = true;
    });
  });

  document.getElementById('btn-abrir').addEventListener('click', abrirRequisitos);
  document.getElementById('btn-guardar-req').addEventListener('click', guardarRequisito);
  document.getElementById('btn-marcar-na').addEventListener('click', marcarNoAplica);
  document.getElementById('btn-quitar-na').addEventListener('click', quitarNoAplica);
  document.getElementById('btn-guardar-enlace').addEventListener('click', guardarEnlace);
  document.getElementById('btn-un-anio').addEventListener('click', aplicarUnAnio);

  document.getElementById('e_fecha_caducidad').addEventListener('change', evaluarCaducidad);
  document.getElementById('e_fecha_registro').addEventListener('change', () => {
    if (!document.getElementById('e_fecha_caducidad').value) aplicarUnAnio();
  });

  document.getElementById('busqueda').addEventListener('input', retrasar(pintarLista, 200));
  document.getElementById('filtro-estado').addEventListener('change', pintarLista);
  document.getElementById('ocultar-na').addEventListener('change', pintarLista);

  /* Pestañas */
  document.querySelectorAll('.pestana').forEach((p) => {
    p.addEventListener('click', () => cambiarVista(p.dataset.vista));
  });

  /* Capacitaciones */
  document.getElementById('capac-anio').addEventListener('change', cambiarAnio);
  document.getElementById('btn-abrir-anio').addEventListener('click', abrirAnio);
  document.getElementById('btn-nuevo-tema').addEventListener('click', abrirTema);
  document.getElementById('btn-guardar-capac').addEventListener('click', guardarCapacitacion);
  document.getElementById('btn-guardar-tema').addEventListener('click', guardarTema);

  /* Cierre por defecto: un año cubre a todo el personal */
  document.getElementById('c_fecha_inicio').addEventListener('change', () => {
    const $fin = document.getElementById('c_fecha_fin');
    if (!$fin.value) $fin.value = document.getElementById('c_fecha_inicio').value;
  });

  /* Eventos */
  document.getElementById('ev-anio').addEventListener('change', recargarEventos);
  document.getElementById('ev-mes').addEventListener('change', recargarEventos);
  document.getElementById('btn-nuevo-evento').addEventListener('click', () => abrirEvento(null));
  document.getElementById('btn-guardar-evento').addEventListener('click', guardarEvento);
  document.getElementById('btn-eliminar-evento').addEventListener('click', eliminarEvento);
  document.getElementById('ev_codigo').addEventListener('input', buscarTrabajadorEvento);
  document.getElementById('ev_reportado').addEventListener('change', ajustarCamposEvento);

  document.querySelectorAll('input[name="ev_tipo"], input[name="ev_estado"]')
    .forEach((r) => r.addEventListener('change', ajustarCamposEvento));

  /* El área escrita y la seleccionada se excluyen */
  document.getElementById('ev_area').addEventListener('change', () => {
    if (document.getElementById('ev_area').value) {
      document.getElementById('ev_area_texto').value = '';
    }
  });

  const $cie = document.getElementById('ev_cie');
  if ($cie) {
    $cie.addEventListener('input', buscarCieEvento);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#ev_cie') && !e.target.closest('#ev_cie_sug')) {
        document.getElementById('ev_cie_sug').hidden = true;
      }
    });
  }

  /* Atenciones ocupacionales */
  const $aoAnio = document.getElementById('ao-anio');
  if ($aoAnio) {
    $aoAnio.addEventListener('change', async () => {
      await cargarOcupacionales();
      pintarOcupacionales();
    });
    document.getElementById('btn-abrir-ao').addEventListener('click', abrirAnioOcupacional);
    document.getElementById('btn-guardar-ao').addEventListener('click', guardarOcupacional);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const orden = ['modal-ao', 'modal-evento', 'modal-tema', 'modal-capac',
                   'modal-enlace', 'modal-req'];
    for (const id of orden) {
      const $m = document.getElementById(id);
      if ($m && !$m.hidden) { $m.hidden = true; return; }
    }
  });
}

async function recargarEventos() {
  await cargarEventos();
  pintarEventos();
}

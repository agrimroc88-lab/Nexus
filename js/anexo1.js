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
  capacActual: null    // capacitación abierta en el modal
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
   Pestañas
   ============================================ */

function cambiarVista(vista) {
  estado.vista = vista;
  document.querySelectorAll('.pestana').forEach((p) => {
    p.classList.toggle('activa', p.dataset.vista === vista);
  });
  ['cumplimiento', 'capacitaciones'].forEach((v) => {
    document.getElementById('vista-' + v).hidden = v !== vista;
  });
  if (vista === 'capacitaciones') pintarCapacitaciones();
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
  await cargarCapacitaciones();
  if (estado.vista === 'capacitaciones') pintarCapacitaciones();
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

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const orden = ['modal-tema', 'modal-capac', 'modal-enlace', 'modal-req'];
    for (const id of orden) {
      const $m = document.getElementById(id);
      if (!$m.hidden) { $m.hidden = true; return; }
    }
  });
}

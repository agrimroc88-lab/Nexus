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
  actual: null,        // requisito abierto en el modal
  enlaceDestino: null  // evidencia que se está enlazando
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
    /* Solo las exigidas a este ámbito */
    if (e.ambito !== null && e.ambito !== AMBITO) return;
    (estado.evidencias[e.requisito_codigo] ||= []).push(e);
  });
}

async function cargarEnlaces() {
  if (estado.requisitos.length === 0) { estado.enlaces = {}; return; }

  const ids = estado.requisitos.map((r) => r.id);

  const { data, error } = await supabase
    .from('cumplimiento_enlaces')
    .select('*')
    .in('cumplimiento_id', ids);

  estado.enlaces = {};
  if (error) return;

  (data || []).forEach((e) => {
    (estado.enlaces[e.cumplimiento_id] ||= []).push(e);
  });
}

async function cargarIndicadores() {
  const [propio, total] = await Promise.all([
    supabase.from('v_indicadores_anexo1').select('*')
      .eq('empresa_id', estado.empresaId).eq('ambito', AMBITO).maybeSingle(),
    supabase.from('v_indicadores_consolidado').select('*')
      .eq('empresa_id', estado.empresaId).maybeSingle()
  ]);

  estado.indicadores = propio.data;
  estado.consolidado = total.data;
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

  const vencidos = i?.vencidos ?? 0;
  const porVencer = i?.por_vencer ?? 0;

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
  pintarEvidenciasModal(r);

  document.getElementById('m_fecha_registro').value = r.fecha_registro ?? '';
  document.getElementById('m_fecha_caducidad').value = r.fecha_caducidad ?? '';
  document.getElementById('m_observacion').value = r.observacion ?? '';
  document.getElementById('m_motivo_na').value = r.motivo_no_aplica ?? '';

  /* Solo el ámbito responsable edita */
  ['m_fecha_registro', 'm_fecha_caducidad', 'm_observacion', 'm_motivo_na'].forEach((id) => {
    document.getElementById(id).disabled = !editable;
  });
  document.getElementById('btn-guardar-req').hidden = !editable;
  document.getElementById('btn-un-anio').hidden = !editable;
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

    fila.innerHTML = `
      <span class="evidencia-marca">${enlace ? '✓' : '○'}</span>
      <div class="evidencia-cuerpo">
        <span class="evidencia-etiqueta">${escapar(ev.etiqueta)}</span>
        ${enlace
          ? `<a class="evidencia-enlace" href="${escapar(enlace.url)}"
                target="_blank" rel="noopener noreferrer">${escapar(acortar(enlace.url))}</a>`
          : '<span class="evidencia-falta">Sin enlace registrado</span>'}
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

  const registro = document.getElementById('m_fecha_registro').value || null;
  const caducidad = document.getElementById('m_fecha_caducidad').value || null;

  if (registro && caducidad && caducidad < registro) {
    return alertaReq('La caducidad no puede ser anterior al registro');
  }

  const $btn = document.getElementById('btn-guardar-req');
  $btn.disabled = true;

  const { error } = await supabase
    .from('cumplimientos')
    .update({
      fecha_registro: registro,
      fecha_caducidad: caducidad,
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

  const $btn = document.getElementById('btn-guardar-enlace');
  $btn.disabled = true;

  const datos = {
    cumplimiento_id: r.id,
    evidencia_id: evidencia.id,
    etiqueta: evidencia.etiqueta,
    url,
    observacion: document.getElementById('e_observacion').value.trim() || null
  };

  const { error } = enlace
    ? await supabase.from('cumplimiento_enlaces').update(datos).eq('id', enlace.id)
    : await supabase.from('cumplimiento_enlaces').insert(datos);

  $btn.disabled = false;

  if (error) return alertaEnlace(traducirBd(error));

  /* Fecha de registro por defecto al primer enlace */
  if (!enlace && !document.getElementById('m_fecha_registro').value) {
    document.getElementById('m_fecha_registro').value = HOY();
    aplicarUnAnio();
    await supabase.from('cumplimientos').update({
      fecha_registro: document.getElementById('m_fecha_registro').value,
      fecha_caducidad: document.getElementById('m_fecha_caducidad').value
    }).eq('id', r.id);
  }

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
  const registro = document.getElementById('m_fecha_registro').value;
  if (!registro) return;

  const f = new Date(registro + 'T00:00');
  f.setFullYear(f.getFullYear() + 1);
  document.getElementById('m_fecha_caducidad').value = f.toISOString().slice(0, 10);
  evaluarCaducidad();
}

function evaluarCaducidad() {
  const valor = document.getElementById('m_fecha_caducidad').value;
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

  document.getElementById('m_fecha_caducidad').addEventListener('change', evaluarCaducidad);

  document.getElementById('busqueda').addEventListener('input', retrasar(pintarLista, 200));
  document.getElementById('filtro-estado').addEventListener('change', pintarLista);
  document.getElementById('ocultar-na').addEventListener('change', pintarLista);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const orden = ['modal-enlace', 'modal-req'];
    for (const id of orden) {
      const $m = document.getElementById(id);
      if (!$m.hidden) { $m.hidden = true; return; }
    }
  });
}

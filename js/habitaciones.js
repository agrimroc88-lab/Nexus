/* ============================================
   NEXUS · habitaciones.js
   Pestaña «Habitaciones» de Trabajo Social (etapa 1).

   Quién duerme dónde, cama por cama, como el tablero de un
   hotel:  Centro de trabajo → Base → Edificio → Planta →
   Frente → Espacio → Cama o litera.

   - Lo pueden VER todos los roles que entran a Trabajo Social.
   - Lo pueden MODIFICAR solo admin y trabajo social.
   - Nada se borra: quitar marca como retirado y el historial
     de ocupantes y colchones se conserva.

   Tablas: sql/habitaciones.sql (viv_*).

   Este archivo se carga solo cuando alguien abre la pestaña,
   así un error aquí nunca afecta a Ficha, Registros ni
   Atenciones.
   ============================================ */

import { alCrear, alEditar } from './autoria.js?v=1';

const VERSION = 'v1';
console.info('NEXUS · habitaciones', VERSION);

const EDITORES = ['admin', 'trabajo_social'];

const TIPOS_ESPACIO = {
  habitacion: 'Habitación',
  comedor: 'Comedor',
  bodega: 'Bodega',
  garita: 'Garita',
  oficina: 'Oficina',
  banos: 'Baños',
  lavanderia: 'Lavandería',
  otro: 'Otro'
};
const ANCHO_INICIAL = { habitacion: 1, comedor: 3, bodega: 1, garita: 1, oficina: 1, banos: 1, lavanderia: 1, otro: 1 };
const ANCHO_MAX = 6;
const TAMANOS = ['', 'Pequeño', 'Mediano', 'Grande', 'Muy grande', 'Extra grande', 'Máximo'];

const PLAZAS_SIN_AVISO = 4;
const PLAZAS_MAX = 8;

const COLCHONES = { esponja: 'Esponja', simbra: 'Simbra' };
const MOTIVOS_SALIDA = ['Salida de la empresa', 'Traslado a otro campamento', 'Otro'];

/* ============================================
   Estado
   ============================================ */

let S = null;

function estadoInicial(supabase, perfil, empresaId, contenedor) {
  return {
    sb: supabase,
    perfil,
    empresaId,
    raiz: contenedor,
    editor: EDITORES.includes(perfil?.rol),
    sucursales: [],
    bases: [],
    edificios: [],
    espacios: [],
    camas: [],
    asig: [],              // asignaciones abiertas
    trab: new Map(),       // trabajador_id → datos
    nav: { sucursalId: null, baseId: null, edificioId: null },
    soloLibres: false,
    editando: false,
    selEspacio: null,
    resaltar: null         // id de cama a resaltar tras una búsqueda
  };
}

/* ============================================
   Utilidades
   ============================================ */

function esc(t) {
  return String(t ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fecha(iso) {
  if (!iso) return '—';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return a && m && d ? `${d}/${m}/${a}` : '—';
}

function iniciales(nombre) {
  return String(nombre || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

function porId(lista, id) { return lista.find((x) => x.id === id) || null; }

function faltaSql(error) {
  const m = `${error?.code || ''} ${error?.message || ''}`;
  return /42P01|PGRST205|PGRST202|does not exist|Could not find the (table|function)/i.test(m);
}

/** Traduce los errores de la base a algo que se entienda. */
function mensajeError(error) {
  const m = error?.message || String(error || '');
  if (/uq_viv_habitacion_numero/.test(m)) return 'Ya existe una habitación con ese número en este edificio y frente.';
  if (/uq_viv_bases_codigo/.test(m)) return 'Ya existe una base con ese código en este centro de trabajo.';
  if (/uq_viv_edificios_codigo/.test(m)) return 'Ya existe un edificio con ese código en esta base.';
  if (/uq_viv_trabajador_con_cama/.test(m)) return 'Este trabajador ya tiene una cama asignada.';
  if (/uq_viv_cama_ocupada|ya está ocupada/.test(m)) return 'Esa cama acaba de ser ocupada por otra persona. Actualice y elija otra.';
  if (/retirada/.test(m)) return 'Esa cama ya no existe.';
  if (faltaSql(error)) return 'Falta ejecutar sql/habitaciones.sql en Supabase.';
  return 'No se pudo guardar: ' + m;
}

function toast(texto) {
  document.querySelector('.hab-toast')?.remove();
  const t = document.createElement('div');
  t.className = 'hab-toast';
  t.setAttribute('role', 'status');
  t.textContent = texto;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

async function traerTodo(consulta) {
  const paso = 1000;
  let desde = 0;
  let filas = [];
  for (;;) {
    const { data, error } = await consulta().range(desde, desde + paso - 1);
    if (error) throw error;
    filas = filas.concat(data || []);
    if (!data || data.length < paso) break;
    desde += paso;
  }
  return filas;
}

async function enTrozos(ids, fn, tam = 150) {
  const salida = [];
  for (let i = 0; i < ids.length; i += tam) {
    const r = await fn(ids.slice(i, i + tam));
    salida.push(...r);
  }
  return salida;
}

/* ============================================
   Relaciones y conteos
   ============================================ */

const basesDe = (sucId) => S.bases.filter((b) => b.sucursal_id === sucId)
  .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));
const edificiosDe = (baseId) => S.edificios.filter((e) => e.base_id === baseId)
  .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));
const espaciosDe = (edifId) => S.espacios.filter((x) => x.edificio_id === edifId);
const filaDe = (edifId, planta, frente) => espaciosDe(edifId)
  .filter((x) => x.planta === planta && (x.frente || null) === (frente || null))
  .sort((a, b) => a.orden - b.orden || a.creado_en.localeCompare(b.creado_en));
const ordenNivel = { superior: 0, unico: 1, inferior: 2 };
const camasDe = (espId) => S.camas.filter((c) => c.espacio_id === espId)
  .sort((a, b) => a.numero - b.numero || ordenNivel[a.nivel] - ordenNivel[b.nivel]);
const asigDeCama = (camaId) => S.asig.find((a) => a.cama_id === camaId) || null;
const asigDeTrabajador = (tId) => S.asig.find((a) => a.trabajador_id === tId) || null;

function camasDeEdificio(edifId) {
  const ids = new Set(espaciosDe(edifId).filter((x) => x.tipo === 'habitacion').map((x) => x.id));
  return S.camas.filter((c) => ids.has(c.espacio_id));
}
function camasDeBase(baseId) { return edificiosDe(baseId).flatMap((e) => camasDeEdificio(e.id)); }
function camasDeSucursal(sucId) { return basesDe(sucId).flatMap((b) => camasDeBase(b.id)); }

function conteo(camas) {
  const ocupadas = camas.filter((c) => asigDeCama(c.id)).length;
  const cambio = camas.filter((c) => c.colchon_por_cambiar).length;
  return { total: camas.length, ocupadas, libres: camas.length - ocupadas, cambio };
}

function nombrePlanta(n, total) {
  if (n === 1) return total === 1 ? 'Planta única' : 'Planta baja';
  if (n === 2 && total === 2) return 'Planta alta';
  return `Planta ${n}`;
}

/** Cadena completa de una cama: sus padres y su código. */
function ubicar(cama) {
  const esp = porId(S.espacios, cama.espacio_id);
  const edif = esp && porId(S.edificios, esp.edificio_id);
  const base = edif && porId(S.bases, edif.base_id);
  const suc = base && porId(S.sucursales, base.sucursal_id);
  if (!esp || !edif || !base) return null;
  const pieza = cama.tipo === 'litera'
    ? `L${cama.numero}-${cama.nivel === 'superior' ? 'SUP' : 'INF'}`
    : `C${cama.numero}`;
  const codigo = [base.codigo, edif.codigo, esp.frente, esp.nombre, pieza].filter(Boolean).join('-').toUpperCase();
  const nombreCama = cama.tipo === 'litera'
    ? `litera ${cama.numero}, nivel ${cama.nivel}`
    : `cama ${cama.numero}`;
  return { esp, edif, base, suc, codigo, nombreCama };
}

function rutaTexto(cama) {
  const u = ubicar(cama);
  if (!u) return '';
  return [u.suc?.nombre, u.base.nombre, u.edif.nombre, u.esp.frente ? `Frente ${u.esp.frente}` : null,
    `Habitación ${u.esp.nombre}, ${u.nombreCama}`].filter(Boolean).join(' › ');
}

/** Estado visual de una cama. */
function estadoCama(cama) {
  const a = asigDeCama(cama.id);
  if (!a) return cama.colchon_por_cambiar ? 'cambio' : 'libre';
  const t = S.trab.get(a.trabajador_id);
  if (t && t.activo === false) return 'salio';
  return cama.colchon_por_cambiar ? 'cambio' : 'ocupada';
}

/* ============================================
   Dibujos (SVG propios, sin archivos externos)
   ============================================ */

const C = {
  muro: '#5d6b62', estructura: '#8d9a91', claro: '#f4f5f3', blanco: '#ffffff',
  techo: '#9aa79e', ventana: '#f3c14b', ventanaBorde: '#b98a14', apagada: '#e9ecea'
};

function svgCama(ocupada) {
  return `<svg viewBox="0 0 120 50" aria-hidden="true">
    <rect x="6" y="6" width="7" height="38" rx="2" fill="${C.estructura}"/>
    <rect x="107" y="22" width="7" height="22" rx="2" fill="${C.estructura}"/>
    <rect x="11" y="28" width="98" height="11" rx="3" fill="${C.blanco}" stroke="${C.estructura}"/>
    <rect x="15" y="20" width="24" height="9" rx="4.5" fill="${C.blanco}" stroke="${C.estructura}"/>
    ${ocupada
      ? `<circle cx="29" cy="19" r="6.5" style="fill:var(--f);stroke:var(--c)"/>
         <path d="M35 23 H106 V35 Q70 39 35 35 Z" style="fill:var(--f);stroke:var(--c)"/>
         <text x="44" y="12" font-size="9" style="fill:var(--c)">z</text>
         <text x="51" y="7" font-size="11" style="fill:var(--c)">z</text>`
      : `<path d="M74 23 H106 V35 H74 Z" style="fill:var(--f);stroke:var(--c)"/>
         <line x1="74" y1="23" x2="74" y2="35" style="stroke:var(--c)"/>`}
    <rect x="13" y="39" width="4" height="7" fill="${C.estructura}"/>
    <rect x="103" y="39" width="4" height="7" fill="${C.estructura}"/>
  </svg>`;
}

function svgLiteraIcono() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">
    <path d="M3 3v18M17 3v18M3 9h14M3 17h14"/><path d="M20 8v13M20 11h-3M20 15h-3M20 19h-3"/>
  </svg>`;
}

const ICONOS = {
  comedor: 'M6 3v8M4 3v4a2 2 0 0 0 4 0V3M6 11v10M16 3c-2 0-3 3-3 6s1 4 3 4v8',
  bodega: 'M3 12h8v8H3zM13 12h8v8h-8zM8 4h8v8H8z',
  garita: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z',
  oficina: 'M3 8h18v12H3zM9 8V5h6v3M3 13h18',
  banos: 'M5 4h14v16H5zM12 4v16M8 10h1M15 10h1',
  lavanderia: 'M4 3h16v18H4zM4 7h16M12 14m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
  otro: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M12 8v5M12 16v.5'
};
function svgIcono(tipo) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONOS[tipo] || ICONOS.otro}"/></svg>`;
}

function svgCentro(nombre) {
  const n = String(nombre || '').toLowerCase();
  if (/mina|socav|bocamina/.test(n)) {
    return `<svg viewBox="0 0 160 70" aria-hidden="true">
      <path d="M0 66 L42 18 L64 40 L92 8 L160 66 Z" fill="${C.claro}" stroke="${C.muro}"/>
      <path d="M82 20 L92 8 L102 20 Q92 16 82 20 Z" fill="${C.blanco}"/>
      <path d="M60 66 Q60 48 72 48 Q84 48 84 66 Z" fill="${C.muro}"/>
      <rect x="104" y="42" width="34" height="24" rx="2" fill="${C.blanco}" stroke="${C.muro}"/>
      <rect x="110" y="48" width="8" height="6" fill="${C.ventana}" stroke="${C.ventanaBorde}"/>
      <rect x="124" y="48" width="8" height="6" fill="${C.ventana}" stroke="${C.ventanaBorde}"/>
      <path d="M16 66 L20 58 L30 58 L34 66" fill="none" stroke="${C.muro}" stroke-width="1.5"/>
      <circle cx="20" cy="66" r="2.5" fill="${C.muro}"/><circle cx="30" cy="66" r="2.5" fill="${C.muro}"/>
    </svg>`;
  }
  if (/planta|beneficio|proceso|laborat/.test(n)) {
    return `<svg viewBox="0 0 160 70" aria-hidden="true">
      <rect x="20" y="30" width="70" height="36" rx="2" fill="${C.blanco}" stroke="${C.muro}"/>
      <path d="M20 30 L38 18 V30 L56 18 V30 L74 18 V30 H90" fill="${C.claro}" stroke="${C.muro}"/>
      <rect x="100" y="14" width="10" height="52" fill="${C.estructura}"/>
      <circle cx="108" cy="8" r="4" fill="${C.claro}"/><circle cx="116" cy="4" r="3" fill="${C.claro}"/>
      <circle cx="134" cy="54" r="12" fill="${C.claro}" stroke="${C.muro}"/>
      <rect x="30" y="40" width="10" height="8" fill="${C.ventana}" stroke="${C.ventanaBorde}"/>
      <rect x="50" y="40" width="10" height="8" fill="${C.apagada}" stroke="${C.estructura}"/>
      <rect x="70" y="40" width="10" height="8" fill="${C.ventana}" stroke="${C.ventanaBorde}"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 160 70" aria-hidden="true">
    <path d="M10 66 L50 40 L90 66 Z" fill="${C.claro}" stroke="${C.muro}"/>
    <rect x="80" y="36" width="58" height="30" fill="${C.blanco}" stroke="${C.muro}"/>
    <path d="M74 36 L109 18 L144 36 Z" fill="${C.techo}" stroke="${C.muro}"/>
    <rect x="88" y="44" width="10" height="8" fill="${C.ventana}" stroke="${C.ventanaBorde}"/>
    <rect x="104" y="44" width="10" height="8" fill="${C.apagada}" stroke="${C.estructura}"/>
    <rect x="120" y="44" width="10" height="8" fill="${C.ventana}" stroke="${C.ventanaBorde}"/>
    <line x1="0" y1="66" x2="160" y2="66" stroke="${C.muro}"/>
  </svg>`;
}

/** Varios edificios pequeños, uno por cada edificio de la base. */
function svgBase(base) {
  const eds = edificiosDe(base.id).slice(0, 4);
  if (eds.length === 0) {
    return `<svg viewBox="0 0 160 70" aria-hidden="true">
      <rect x="30" y="30" width="100" height="36" fill="none" stroke="${C.estructura}" stroke-dasharray="4 3"/>
      <line x1="0" y1="66" x2="160" y2="66" stroke="${C.muro}"/></svg>`;
  }
  const ancho = 150 / eds.length;
  let s = '';
  eds.forEach((e, i) => {
    const w = Math.min(ancho - 8, 46);
    const x = 5 + i * ancho + (ancho - w) / 2;
    const h = 14 * e.num_plantas + 6;
    const y = 66 - h;
    const c = conteo(camasDeEdificio(e.id));
    s += `<path d="M${x - 3} ${y} L${x + w / 2} ${y - 9} L${x + w + 3} ${y} Z" fill="${C.techo}" stroke="${C.muro}"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${C.blanco}" stroke="${C.muro}"/>`;
    for (let p = 0; p < e.num_plantas; p++) {
      for (let k = 0; k < 3; k++) {
        const on = c.total > 0 && (p * 3 + k) / (e.num_plantas * 3) < c.ocupadas / c.total;
        s += `<rect x="${x + 4 + k * ((w - 8) / 3)}" y="${y + 4 + p * 14}" width="${(w - 8) / 3 - 3}" height="7" fill="${on ? C.ventana : C.apagada}" stroke="${on ? C.ventanaBorde : C.estructura}" stroke-width="0.6"/>`;
      }
    }
  });
  return `<svg viewBox="0 0 160 70" aria-hidden="true">${s}<line x1="0" y1="66" x2="160" y2="66" stroke="${C.muro}"/></svg>`;
}

/** Fachada en miniatura: cada planta con sus espacios a escala
    y una ventana por cama (encendida si está ocupada). */
function svgFachada(edif) {
  const W = 180, H = 26, x0 = 10, top = 16;
  const n = edif.num_plantas;
  let s = `<path d="M${x0 - 6} ${top} L${x0 + W / 2} 2 L${x0 + W + 6} ${top} Z" fill="${C.techo}" stroke="${C.muro}"/>`;
  for (let p = n; p >= 1; p--) {
    const y = top + (n - p) * H;
    s += `<rect x="${x0}" y="${y}" width="${W}" height="${H}" fill="${C.blanco}" stroke="${C.muro}"/>`;
    let fila = filaDe(edif.id, p, edif.tiene_frentes ? 'A' : null);
    if (fila.length === 0 && edif.tiene_frentes) fila = filaDe(edif.id, p, 'B');
    const total = fila.reduce((a, e) => a + e.ancho, 0);
    let x = x0;
    fila.forEach((esp) => {
      const w = W * esp.ancho / total;
      if (esp.tipo === 'habitacion') {
        const camas = camasDe(esp.id);
        const nv = Math.max(1, Math.min(camas.length, Math.floor((w - 4) / 8)));
        const paso = (w - 4) / nv;
        for (let k = 0; k < nv; k++) {
          const on = camas[k] && asigDeCama(camas[k].id);
          s += `<rect x="${x + 2 + k * paso + (paso - 6) / 2}" y="${y + 8}" width="6" height="9" rx="0.5" fill="${on ? C.ventana : C.apagada}" stroke="${on ? C.ventanaBorde : C.estructura}" stroke-width="0.6"/>`;
        }
      } else {
        s += `<rect x="${x}" y="${y}" width="${w}" height="${H}" fill="${C.claro}"/>`;
        if (w > 16) s += `<g transform="translate(${x + w / 2 - 6},${y + 7}) scale(0.5)" stroke="${C.muro}" fill="none" stroke-width="1.8"><path d="${ICONOS[esp.tipo] || ICONOS.otro}"/></g>`;
      }
      s += `<line x1="${x + w}" y1="${y}" x2="${x + w}" y2="${y + H}" stroke="${C.estructura}" stroke-width="0.8"/>`;
      x += w;
    });
  }
  const base = top + n * H;
  s += `<rect x="${x0 + W / 2 - 7}" y="${base - 13}" width="14" height="13" fill="${C.muro}"/>
    <line x1="0" y1="${base}" x2="${W + 20}" y2="${base}" stroke="${C.muro}" stroke-width="1.5"/>`;
  return `<svg viewBox="0 0 ${W + 20} ${base + 4}" aria-hidden="true">${s}</svg>`;
}

/* ============================================
   Carga
   ============================================ */

async function cargar() {
  const e = S.empresaId;
  const sb = S.sb;

  let sucursales;
  try {
    sucursales = await traerTodo(() => sb.from('v_sucursales_reales').select('id, nombre').eq('empresa_id', e).order('nombre'));
  } catch {
    sucursales = await traerTodo(() => sb.from('sucursales').select('id, nombre').eq('empresa_id', e).eq('activo', true).order('nombre'));
  }

  const [bases, edificios, espacios, camas, asig] = await Promise.all([
    traerTodo(() => sb.from('viv_bases').select('*').eq('empresa_id', e).eq('activo', true).order('id')),
    traerTodo(() => sb.from('viv_edificios').select('*').eq('empresa_id', e).eq('activo', true).order('id')),
    traerTodo(() => sb.from('viv_espacios').select('*').eq('empresa_id', e).eq('activo', true).order('id')),
    traerTodo(() => sb.from('viv_camas').select('*').eq('empresa_id', e).eq('activo', true).order('id')),
    traerTodo(() => sb.from('viv_asignaciones').select('id, cama_id, trabajador_id, fecha_ingreso')
      .eq('empresa_id', e).is('fecha_salida', null).order('id'))
  ]);

  S.sucursales = sucursales;
  S.bases = bases;
  S.edificios = edificios;
  S.espacios = espacios;
  S.camas = camas;
  const idsCamas = new Set(camas.map((c) => c.id));
  S.asig = asig.filter((a) => idsCamas.has(a.cama_id));

  await cargarTrabajadores(S.asig.map((a) => a.trabajador_id));
}

async function cargarTrabajadores(ids) {
  const faltan = [...new Set(ids)].filter((id) => !S.trab.has(id));
  if (faltan.length === 0) return;

  const datos = await enTrozos(faltan, async (trozo) => {
    const { data } = await S.sb.from('v_trabajadores')
      .select('id, codigo, nombre_completo, cedula, edad, cargo, activo').in('id', trozo);
    return data || [];
  });

  /* El cargo vive en el periodo laboral: primero el abierto
     (igual que en el módulo Trabajadores) y, para quien ya
     salió, el último que tuvo. */
  const periodos = await enTrozos(faltan, async (trozo) => {
    const { data } = await S.sb.from('periodos_laborales')
      .select('trabajador_id, cargo_texto, fecha_ingreso, fecha_salida').in('trabajador_id', trozo)
      .order('fecha_ingreso', { ascending: false });
    return data || [];
  });
  const cargo = new Map();
  periodos.forEach((p) => {
    if (!p.cargo_texto) return;
    const previo = cargo.get(p.trabajador_id);
    if (!previo || (previo.fecha_salida && !p.fecha_salida)) cargo.set(p.trabajador_id, p);
  });
  cargo.forEach((p, id) => cargo.set(id, p.cargo_texto));
  datos.forEach((t) => S.trab.set(t.id, { ...t, cargo: cargo.get(t.id) || t.cargo || null }));
}

async function recargar() {
  S.trab.clear();
  await cargar();
  pintar();
}

/* ============================================
   Montaje
   ============================================ */

export async function montarHabitaciones({ supabase, perfil, empresaId, contenedor }) {
  S = estadoInicial(supabase, perfil, empresaId, contenedor);
  contenedor.innerHTML = '<p class="aviso-inicial">Cargando habitaciones…</p>';

  try {
    await cargar();
  } catch (error) {
    console.error('NEXUS · habitaciones:', error);
    contenedor.innerHTML = faltaSql(error)
      ? `<div class="hab-vacio"><strong>Falta preparar la base de datos.</strong><br>
         El administrador debe ejecutar una vez el archivo <code>sql/habitaciones.sql</code> en Supabase (SQL Editor).</div>`
      : `<div class="hab-vacio">No se pudieron cargar las habitaciones: ${esc(error.message || error)}</div>`;
    return;
  }

  contenedor.innerHTML = `
    <div class="hab">
      <section class="hab-buscador" aria-label="Buscar dónde duerme un trabajador">
        <div class="campo">
          <label class="etiqueta" for="hab-q">Buscar dónde duerme un trabajador</label>
          <input class="entrada" id="hab-q" type="search" autocomplete="off" placeholder="Código, nombre o cédula">
          <div class="sugerencias" id="hab-sug" hidden></div>
        </div>
        <button class="boton-primario" id="hab-buscar" type="button">Buscar</button>
      </section>
      <div id="hab-resultado"></div>
      <div id="hab-alerta"></div>
      <nav class="hab-migas" id="hab-migas" aria-label="Ubicación"></nav>
      <div id="hab-vista"></div>
    </div>`;

  conectarBuscador();
  pintar();
}

/* ============================================
   Buscador
   ============================================ */

function conectarBuscador() {
  const $q = document.getElementById('hab-q');
  const $sug = document.getElementById('hab-sug');
  let temporizador = null;

  const ejecutar = async () => {
    const texto = $q.value.trim();
    $sug.hidden = true;
    if (!texto) return;
    if (/^\d+$/.test(texto) && texto.length < 10) {
      const { data } = await S.sb.from('v_trabajadores')
        .select('id, codigo, nombre_completo, cedula, edad, cargo, activo')
        .eq('empresa_id', S.empresaId).eq('codigo', parseInt(texto, 10)).maybeSingle();
      if (data) mostrarResultado(data);
      else pintarResultadoVacio(`No existe un trabajador con el código ${texto}.`);
      return;
    }
    const lista = await sugerir(texto);
    if (lista.length === 1) mostrarResultado(lista[0]);
    else if (lista.length === 0) pintarResultadoVacio('No se encontró ningún trabajador con ese nombre o cédula.');
    else pintarSugerencias(lista);
  };

  document.getElementById('hab-buscar').addEventListener('click', ejecutar);
  $q.addEventListener('keydown', (e) => { if (e.key === 'Enter') ejecutar(); });
  $q.addEventListener('input', () => {
    clearTimeout(temporizador);
    const texto = $q.value.trim();
    if (texto.length < 2 || /^\d{1,4}$/.test(texto)) { $sug.hidden = true; return; }
    temporizador = setTimeout(async () => pintarSugerencias(await sugerir(texto)), 220);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#hab-q') && !e.target.closest('#hab-sug')) $sug.hidden = true;
  });
}

async function sugerir(texto, soloActivos = false) {
  const limpio = texto.replace(/[,%()]/g, ' ').trim();
  let q = S.sb.from('v_trabajadores')
    .select('id, codigo, nombre_completo, cedula, edad, cargo, activo')
    .eq('empresa_id', S.empresaId)
    .or(`nombres.ilike.%${limpio}%,apellidos.ilike.%${limpio}%,cedula.ilike.%${limpio}%`)
    .limit(8);
  if (soloActivos) q = q.eq('activo', true);
  const { data } = await q;
  return data || [];
}

function pintarSugerencias(lista) {
  const $sug = document.getElementById('hab-sug');
  if (!lista.length) { $sug.hidden = true; return; }
  $sug.innerHTML = '';
  lista.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sugerencia';
    b.innerHTML = `<span class="cie-chip">${esc(t.codigo ?? 'S/C')}</span> ${esc(t.nombre_completo)}${t.activo === false ? ' · <em>ya no labora</em>' : ''}`;
    b.addEventListener('click', () => { $sug.hidden = true; mostrarResultado(t); });
    $sug.appendChild(b);
  });
  $sug.hidden = false;
}

function pintarResultadoVacio(texto) {
  document.getElementById('hab-resultado').innerHTML =
    `<div class="hab-resultado hab-resultado--sin"><div class="hab-resultado-datos">${esc(texto)}</div></div>`;
}

async function mostrarResultado(t) {
  const $r = document.getElementById('hab-resultado');
  let cargo = t.cargo;
  const { data: per } = await S.sb.from('periodos_laborales')
    .select('cargo_texto, fecha_salida').eq('trabajador_id', t.id)
    .order('fecha_ingreso', { ascending: false }).limit(1);
  if (per?.[0]?.cargo_texto) cargo = per[0].cargo_texto;
  const salida = t.activo === false ? per?.[0]?.fecha_salida : null;

  S.trab.set(t.id, { ...t, cargo });
  const a = asigDeTrabajador(t.id);
  const cama = a && porId(S.camas, a.cama_id);
  const meta = [t.codigo != null ? `#${t.codigo}` : null, cargo, t.edad != null ? `${t.edad} años` : null]
    .filter(Boolean).map(esc).join(' · ');
  const avisoSalida = t.activo === false
    ? `<span class="hab-nota hab-nota--error">Ya no labora en la empresa${salida ? ` (salió el ${fecha(salida)})` : ''}.</span>` : '';

  if (!cama) {
    $r.innerHTML = `<div class="hab-resultado hab-resultado--sin">
      <div class="hab-resultado-datos">
        <span class="hab-resultado-nombre">${esc(t.nombre_completo)}</span>
        <span class="hab-resultado-ruta">${meta}</span>
        ${avisoSalida}
        <span>No tiene cama asignada.${S.editor && t.activo !== false ? ' Para asignarle una, toque una cama libre en el mapa.' : ''}</span>
      </div></div>`;
    return;
  }

  const u = ubicar(cama);
  $r.innerHTML = `<div class="hab-resultado ${t.activo === false ? 'hab-resultado--salio' : ''}">
    <div class="hab-resultado-datos">
      <span class="hab-resultado-nombre">${esc(t.nombre_completo)} duerme en ${esc(u.codigo)}</span>
      <span class="hab-resultado-ruta">${esc(rutaTexto(cama))}</span>
      <span class="hab-resultado-ruta">${meta}</span>
      ${avisoSalida}
    </div>
    <div class="hab-resultado-acciones">
      <button class="boton-secundario" type="button" data-accion="ver">Ver en el mapa</button>
      ${S.editor ? '<button class="boton-secundario boton-critico" type="button" data-accion="liberar">Liberar cama</button>' : ''}
    </div></div>`;

  $r.querySelector('[data-accion="ver"]').addEventListener('click', () => irACama(cama));
  $r.querySelector('[data-accion="liberar"]')?.addEventListener('click', () =>
    abrirCama(cama, 'liberar', t.activo === false ? 'Salida de la empresa' : null));
}

function irACama(cama) {
  const u = ubicar(cama);
  if (!u) return;
  S.nav = { sucursalId: u.base.sucursal_id, baseId: u.base.id, edificioId: u.edif.id };
  S.soloLibres = false;
  S.editando = false;
  S.resaltar = cama.id;
  pintar();
}

/* ============================================
   Pintado general
   ============================================ */

function pintar() {
  pintarAlerta();
  pintarMigas();
  const $v = document.getElementById('hab-vista');
  if (!$v) return;
  const { sucursalId, baseId, edificioId } = S.nav;
  if (edificioId && porId(S.edificios, edificioId)) vistaEdificio($v);
  else if (baseId && porId(S.bases, baseId)) { S.nav.edificioId = null; vistaBase($v); }
  else if (sucursalId && porId(S.sucursales, sucursalId)) { S.nav.baseId = null; vistaBases($v); }
  else { S.nav = { sucursalId: null, baseId: null, edificioId: null }; vistaCentros($v); }
}

function ir(nav) {
  S.nav = { sucursalId: null, baseId: null, edificioId: null, ...nav };
  S.editando = false;
  S.selEspacio = null;
  S.resaltar = null;
  pintar();
  document.getElementById('hab-migas')?.scrollIntoView({ block: 'nearest' });
}

function pintarAlerta() {
  const $a = document.getElementById('hab-alerta');
  const salieron = S.asig.filter((a) => S.trab.get(a.trabajador_id)?.activo === false);
  if (salieron.length === 0) { $a.innerHTML = ''; return; }
  $a.innerHTML = `<div class="hab-alerta" role="status">
    <span>${salieron.length === 1 ? '1 cama sigue asignada' : `${salieron.length} camas siguen asignadas`}
      a personal que ya no labora en la empresa.</span>
    <button class="boton-secundario" type="button">Revisar</button></div>`;
  $a.querySelector('button').addEventListener('click', () => modalSalieron());
}

function pintarMigas() {
  const $m = document.getElementById('hab-migas');
  const { sucursalId, baseId, edificioId } = S.nav;
  const partes = [['Centros de trabajo', {}]];
  const suc = porId(S.sucursales, sucursalId);
  const base = porId(S.bases, baseId);
  const edif = porId(S.edificios, edificioId);
  if (suc) partes.push([suc.nombre, { sucursalId }]);
  if (base) partes.push([base.nombre, { sucursalId, baseId }]);
  if (edif) partes.push([edif.nombre, { sucursalId, baseId, edificioId }]);

  $m.innerHTML = '';
  partes.forEach(([texto, nav], i) => {
    if (i > 0) $m.insertAdjacentHTML('beforeend', '<span aria-hidden="true">›</span>');
    if (i === partes.length - 1) {
      $m.insertAdjacentHTML('beforeend', `<span class="hab-miga-actual" aria-current="page">${esc(texto)}</span>`);
    } else {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'hab-miga'; b.textContent = texto;
      b.addEventListener('click', () => ir(nav));
      $m.appendChild(b);
    }
  });
}

function cifras(c, conCambio = false) {
  return `<div class="hab-cifras">
    <div class="hab-cifra"><span>Camas</span><strong>${c.total}</strong></div>
    <div class="hab-cifra"><span>Ocupadas</span><strong>${c.ocupadas}</strong></div>
    <div class="hab-cifra hab-cifra--libre"><span>Libres</span><strong>${c.libres}</strong></div>
    ${conCambio ? `<div class="hab-cifra hab-cifra--cambio"><span>Colchón por cambiar</span><strong>${c.cambio}</strong></div>` : ''}
  </div>`;
}

function textoLibres(c) {
  if (c.total === 0) return 'Sin camas registradas';
  return c.libres === 0 ? 'Lleno' : `<b>${c.libres} ${c.libres === 1 ? 'libre' : 'libres'}</b> de ${c.total}`;
}

function barra(c) {
  const p = c.total ? Math.round(c.ocupadas / c.total * 100) : 0;
  return `<div class="hab-barra" aria-hidden="true"><i style="width:${p}%"></i></div>`;
}

/* ---------- Nivel 1 · Centros de trabajo ---------- */

function vistaCentros($v) {
  if (S.sucursales.length === 0) {
    $v.innerHTML = `<div class="hab-vacio">Esta empresa todavía no tiene centros de trabajo.<br>
      Se crean en el módulo <strong>Estructura</strong> (sucursales).</div>`;
    return;
  }
  $v.innerHTML = '<div class="hab-rejilla" id="hab-g"></div>';
  const $g = document.getElementById('hab-g');
  S.sucursales.forEach((s) => {
    const nb = basesDe(s.id).length;
    const c = conteo(camasDeSucursal(s.id));
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'hab-tarjeta';
    b.innerHTML = `${svgCentro(s.nombre)}
      <span class="hab-tarjeta-nombre">${esc(s.nombre)}</span>
      <span class="hab-tarjeta-sub">${nb === 0 ? 'Sin bases todavía' : `${nb} ${nb === 1 ? 'base' : 'bases'}`}</span>
      <span class="hab-tarjeta-libres">${textoLibres(c)}</span>${c.total ? barra(c) : ''}`;
    b.addEventListener('click', () => ir({ sucursalId: s.id }));
    $g.appendChild(b);
  });
}

/* ---------- Nivel 2 · Bases de un centro ---------- */

function vistaBases($v) {
  const suc = porId(S.sucursales, S.nav.sucursalId);
  const bases = basesDe(suc.id);
  $v.innerHTML = `
    <div class="hab-cabeza"><h2 class="hab-titulo">${esc(suc.nombre)}</h2>
      <div class="hab-cabeza-acciones">${S.editor ? '<button class="boton-primario" id="hab-nueva-base" type="button">+ Nueva base</button>' : ''}</div></div>
    ${bases.length ? cifras(conteo(camasDeSucursal(suc.id))) : ''}
    <div class="hab-rejilla" id="hab-g"></div>`;
  document.getElementById('hab-nueva-base')?.addEventListener('click', () => modalBase(null));

  const $g = document.getElementById('hab-g');
  if (bases.length === 0) {
    $g.outerHTML = `<div class="hab-vacio">Este centro aún no tiene bases.${S.editor ? '<br>Cree la primera con «+ Nueva base», por ejemplo «Base 2».' : ''}</div>`;
    return;
  }
  bases.forEach((b) => {
    const ne = edificiosDe(b.id).length;
    const c = conteo(camasDeBase(b.id));
    const t = document.createElement('button');
    t.type = 'button'; t.className = 'hab-tarjeta';
    t.innerHTML = `${svgBase(b)}
      <span class="hab-tarjeta-nombre">${esc(b.nombre)}</span>
      <span class="hab-tarjeta-sub">Código ${esc(b.codigo)} · ${ne === 0 ? 'sin edificios' : `${ne} ${ne === 1 ? 'edificio' : 'edificios'}`}</span>
      <span class="hab-tarjeta-libres">${textoLibres(c)}</span>${c.total ? barra(c) : ''}`;
    t.addEventListener('click', () => ir({ sucursalId: suc.id, baseId: b.id }));
    $g.appendChild(t);
  });
}

/* ---------- Nivel 3 · Edificios de una base ---------- */

function vistaBase($v) {
  const base = porId(S.bases, S.nav.baseId);
  const eds = edificiosDe(base.id);
  $v.innerHTML = `
    <div class="hab-cabeza"><h2 class="hab-titulo">${esc(base.nombre)} <small>código ${esc(base.codigo)}</small></h2>
      <div class="hab-cabeza-acciones">${S.editor ? `
        <button class="boton-secundario" id="hab-editar-base" type="button">Editar base</button>
        <button class="boton-primario" id="hab-nuevo-edif" type="button">+ Nuevo edificio</button>` : ''}</div></div>
    ${eds.length ? cifras(conteo(camasDeBase(base.id))) : ''}
    <div class="hab-rejilla" id="hab-g"></div>`;
  document.getElementById('hab-editar-base')?.addEventListener('click', () => modalBase(base));
  document.getElementById('hab-nuevo-edif')?.addEventListener('click', () => modalEdificio(null));

  const $g = document.getElementById('hab-g');
  if (eds.length === 0) {
    $g.outerHTML = `<div class="hab-vacio">Esta base aún no tiene edificios.${S.editor ? '<br>Agregue el primero con «+ Nuevo edificio».' : ''}</div>`;
    return;
  }
  eds.forEach((e) => {
    const c = conteo(camasDeEdificio(e.id));
    const t = document.createElement('button');
    t.type = 'button'; t.className = 'hab-tarjeta';
    t.innerHTML = `${svgFachada(e)}
      <span class="hab-tarjeta-nombre">${esc(e.nombre)}</span>
      <span class="hab-tarjeta-sub">${e.num_plantas} ${e.num_plantas === 1 ? 'planta' : 'plantas'}${e.tiene_frentes ? ' · frentes A y B' : ''}</span>
      <span class="hab-tarjeta-libres">${textoLibres(c)}</span>${c.total ? barra(c) : ''}`;
    t.addEventListener('click', () => ir({ sucursalId: base.sucursal_id, baseId: base.id, edificioId: e.id }));
    $g.appendChild(t);
  });
}

/* ---------- Nivel 4 · El edificio por dentro ---------- */

function vistaEdificio($v) {
  const edif = porId(S.edificios, S.nav.edificioId);
  const c = conteo(camasDeEdificio(edif.id));
  const sel = S.editando && S.selEspacio ? porId(S.espacios, S.selEspacio) : null;

  $v.innerHTML = `
    <div class="hab-cabeza">
      <h2 class="hab-titulo">${esc(edif.nombre)} <small>código ${esc(edif.codigo)}</small></h2>
      <div class="hab-cabeza-acciones">${S.editor ? `
        <button class="boton-secundario" id="hab-config-edif" type="button">Configurar edificio</button>
        <button class="${S.editando ? 'boton-primario' : 'boton-secundario'}" id="hab-modo" type="button" aria-pressed="${S.editando}">
          ${S.editando ? 'Terminar edición' : 'Editar plantas y espacios'}</button>` : ''}
      </div>
    </div>
    ${cifras(c, true)}
    <div class="hab-cabeza">
      <div class="hab-leyenda" aria-label="Colores de las camas">
        <span style="--c:var(--hab-libre);--f:var(--hab-libre-f)">Libre</span>
        <span style="--c:var(--hab-ocupada);--f:var(--hab-ocupada-f)">Ocupada</span>
        <span style="--c:var(--hab-cambio);--f:var(--hab-cambio-f)">Colchón por cambiar</span>
        <span style="--c:var(--hab-salio);--f:var(--hab-salio-f)">Ya no labora</span>
      </div>
      <div class="hab-filtros">
        <button class="hab-chip" id="hab-libres" type="button" aria-pressed="${S.soloLibres}">Solo habitaciones con camas libres</button>
      </div>
    </div>
    ${S.editando ? herramientasHtml(sel) : ''}
    <div class="hab-fachada ${S.editando ? 'hab-editando' : ''}" id="hab-fachada"></div>`;

  document.getElementById('hab-config-edif')?.addEventListener('click', () => modalEdificio(edif));
  document.getElementById('hab-modo')?.addEventListener('click', () => {
    S.editando = !S.editando; S.selEspacio = null; pintar();
  });
  document.getElementById('hab-libres').addEventListener('click', () => { S.soloLibres = !S.soloLibres; pintar(); });
  if (S.editando) conectarHerramientas(sel);

  const $f = document.getElementById('hab-fachada');
  $f.insertAdjacentHTML('beforeend', `<svg class="hab-techo" viewBox="0 0 400 34" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 34 L200 2 L400 34 Z" fill="${C.techo}" stroke="${C.muro}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`);

  const frentes = edif.tiene_frentes ? ['A', 'B'] : [null];
  for (let p = edif.num_plantas; p >= 1; p--) {
    const planta = document.createElement('section');
    planta.className = 'hab-planta';
    planta.setAttribute('aria-label', nombrePlanta(p, edif.num_plantas));
    planta.innerHTML = `<div class="hab-planta-nombre">${nombrePlanta(p, edif.num_plantas)}</div>`;
    frentes.forEach((fr) => {
      if (fr) planta.insertAdjacentHTML('beforeend', `<div class="hab-frente-nombre">Frente ${fr}</div>`);
      planta.appendChild(filaHtml(edif, p, fr));
    });
    $f.appendChild(planta);
  }
  $f.insertAdjacentHTML('beforeend', '<div class="hab-suelo" aria-hidden="true"></div>');

  if (S.resaltar) {
    const el = $f.querySelector(`[data-cama="${S.resaltar}"]`);
    if (el) { el.classList.add('hab-cama--resaltada'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    S.resaltar = null;
  }
}

function filaHtml(edif, planta, frente) {
  const fila = document.createElement('div');
  fila.className = 'hab-fila';
  const espacios = filaDe(edif.id, planta, frente);

  if (espacios.length === 0 && !S.editando) {
    fila.innerHTML = `<div class="hab-fila-vacia">Sin espacios registrados${S.editor ? '. Use «Editar plantas y espacios» para agregarlos.' : '.'}</div>`;
    return fila;
  }

  espacios.forEach((esp) => fila.appendChild(espacioHtml(esp)));

  if (S.editando) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'hab-agregar-esp';
    b.textContent = '+ Espacio';
    b.setAttribute('aria-label', `Agregar espacio en ${nombrePlanta(planta, edif.num_plantas)}${frente ? ' frente ' + frente : ''}`);
    b.addEventListener('click', () => modalEspacio(null, { edif, planta, frente }));
    fila.appendChild(b);
  }
  return fila;
}

function espacioHtml(esp) {
  const d = document.createElement('div');
  d.style.setProperty('--ancho', esp.ancho);
  const seleccionado = S.editando && S.selEspacio === esp.id;

  if (esp.tipo !== 'habitacion') {
    d.className = 'hab-esp hab-esp--otro' + (seleccionado ? ' hab-esp--sel' : '');
    d.innerHTML = `${svgIcono(esp.tipo)}<span>${esc(esp.nombre)}</span>`;
  } else {
    const camas = camasDe(esp.id);
    const ocup = camas.filter((c) => asigDeCama(c.id)).length;
    const tenue = S.soloLibres && !S.editando && (camas.length === 0 || ocup === camas.length);
    d.className = 'hab-esp' + (tenue ? ' hab-esp--tenue' : '') + (seleccionado ? ' hab-esp--sel' : '');
    d.innerHTML = `<div class="hab-esp-cabeza"><b>Hab. ${esc(esp.nombre)}</b>
      <span>${camas.length ? `${ocup}/${camas.length}` : ''}</span></div>`;
    const $camas = document.createElement('div');
    $camas.className = 'hab-camas';
    if (camas.length === 0) {
      $camas.innerHTML = `<div class="hab-sin-camas">Sin camas${S.editor ? '. Agréguelas en modo edición.' : ''}</div>`;
    }
    const vistos = new Set();
    camas.forEach((cama) => {
      if (cama.tipo === 'litera') {
        if (vistos.has(cama.numero)) return;
        vistos.add(cama.numero);
        const niveles = camas.filter((x) => x.tipo === 'litera' && x.numero === cama.numero);
        const grupo = document.createElement('div');
        grupo.className = 'hab-litera';
        grupo.innerHTML = `<div class="hab-litera-nombre">${svgLiteraIcono()} Litera ${cama.numero}</div>`;
        niveles.forEach((n) => grupo.appendChild(camaHtml(n)));
        $camas.appendChild(grupo);
      } else {
        $camas.appendChild(camaHtml(cama));
      }
    });
    d.appendChild($camas);
  }

  if (S.editando) {
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    d.setAttribute('aria-pressed', String(seleccionado));
    d.setAttribute('aria-label', `${TIPOS_ESPACIO[esp.tipo]} ${esp.nombre}`);
    const elegir = () => { S.selEspacio = seleccionado ? null : esp.id; pintar(); };
    d.addEventListener('click', elegir);
    d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elegir(); } });
  }
  return d;
}

function camaHtml(cama) {
  const est = estadoCama(cama);
  const a = asigDeCama(cama.id);
  const t = a && S.trab.get(a.trabajador_id);
  const etiqueta = cama.tipo === 'litera' ? (cama.nivel === 'superior' ? 'Superior' : 'Inferior') : `C${cama.numero}`;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `hab-cama hab-cama--${est}`;
  b.dataset.cama = cama.id;
  const u = ubicar(cama);

  if (a) {
    const nombre = t?.nombre_completo || 'Trabajador';
    b.setAttribute('aria-label', `${u?.codigo}: ocupada por ${nombre}`);
    b.innerHTML = `${svgCama(true)}
      <span class="hab-cama-fila"><span>${etiqueta}</span><span>#${esc(t?.codigo ?? '—')}</span></span>
      <span class="hab-cama-nombre" title="${esc(nombre)}">${esc(nombre)}</span>
      <span class="hab-cama-cargo" title="${esc(t?.cargo || '')}">${esc(t?.cargo || 'Sin cargo')}</span>
      <span class="hab-cama-linea">${t?.edad != null ? `${t.edad} años` : ''}</span>
      ${est === 'salio' ? '<span class="hab-cama-cargo"><b>Ya no labora</b></span>' : ''}
      ${cama.colchon_por_cambiar ? '<span class="hab-cama-cargo"><b>Colchón por cambiar</b></span>' : ''}`;
  } else {
    b.setAttribute('aria-label', `${u?.codigo}: libre${S.editor ? ', toque para asignar' : ''}`);
    b.innerHTML = `${svgCama(false)}
      <span class="hab-cama-fila"><span>${etiqueta}</span><span>Libre</span></span>
      <span class="hab-cama-linea" title="Colchón">${cama.colchon_tipo ? COLCHONES[cama.colchon_tipo] : 'Sin colchón'}</span>
      ${est === 'cambio' ? '<span class="hab-cama-cargo"><b>Colchón por cambiar</b></span>' : ''}`;
  }

  b.addEventListener('click', (e) => {
    if (S.editando) return; // en edición el clic selecciona el espacio
    e.stopPropagation();
    abrirCama(cama);
  });
  return b;
}

/* ============================================
   Ventanas (usa los estilos .modal de NEXUS)
   ============================================ */

let modalActual = null;

function modal(titulo) {
  modalActual?.cerrar();
  const m = document.createElement('div');
  m.className = 'modal hab-modal';
  m.innerHTML = `<div class="modal-caja" role="dialog" aria-modal="true" aria-labelledby="hab-modal-titulo">
      <header class="modal-cabecera">
        <h2 class="modal-titulo" id="hab-modal-titulo"></h2>
        <button class="modal-cerrar" type="button" aria-label="Cerrar">×</button>
      </header>
      <div class="modal-cuerpo"></div>
      <footer class="modal-pie"></footer>
    </div>`;
  m.querySelector('.modal-titulo').textContent = titulo;
  // Dentro de .hab para heredar sus colores de estado
  (document.querySelector('.hab') || document.body).appendChild(m);

  const previo = document.activeElement;
  const tecla = (e) => { if (e.key === 'Escape') api.cerrar(); };
  const api = {
    m,
    cuerpo: m.querySelector('.modal-cuerpo'),
    pie: m.querySelector('.modal-pie'),
    titulo(t) { m.querySelector('.modal-titulo').textContent = t; },
    cerrar() {
      m.remove();
      document.removeEventListener('keydown', tecla);
      if (modalActual === api) modalActual = null;
      previo?.focus?.();
    },
    botones(lista) {
      api.pie.innerHTML = '';
      lista.forEach(([texto, clase, fn]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = clase; b.textContent = texto;
        b.addEventListener('click', () => fn(b));
        api.pie.appendChild(b);
      });
    },
    error(texto) {
      api.cuerpo.querySelector('.hab-nota--error')?.remove();
      if (texto) api.cuerpo.insertAdjacentHTML('afterbegin', `<div class="hab-nota hab-nota--error" role="alert">${esc(texto)}</div>`);
    },
    enfocar() { setTimeout(() => api.cuerpo.querySelector('input:not([type=hidden]),select,textarea')?.focus(), 30); }
  };
  document.addEventListener('keydown', tecla);
  m.querySelector('.modal-cerrar').addEventListener('click', api.cerrar);
  m.addEventListener('mousedown', (e) => { if (e.target === m) api.cerrar(); });
  modalActual = api;
  return api;
}

/** Ejecuta una acción con el botón bloqueado para evitar doble clic. */
async function conBoton(boton, fn) {
  if (boton.disabled) return;
  const texto = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Guardando…';
  try { await fn(); } finally {
    if (boton.isConnected) { boton.disabled = false; boton.textContent = texto; }
  }
}

const valor = (m, id) => m.cuerpo.querySelector('#' + id)?.value?.trim() ?? '';

function codigoSugerido(nombre, prefijo) {
  const num = String(nombre).match(/\d+/);
  if (num) return prefijo + num[0];
  return String(nombre).normalize('NFD').replace(/[^A-Za-z0-9 ]/g, '')
    .split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 4).toUpperCase() || prefijo;
}

/* ---------- Base ---------- */

function modalBase(base) {
  const nueva = !base;
  const m = modal(nueva ? 'Nueva base' : `Editar ${base.nombre}`);
  m.cuerpo.innerHTML = `<div class="hab-form">
    <div class="campo"><label class="etiqueta" for="hb-nombre">Nombre</label>
      <input class="entrada" id="hb-nombre" maxlength="40" placeholder="Base 2" value="${esc(base?.nombre || '')}"></div>
    <div class="campo"><label class="etiqueta" for="hb-codigo">Código corto (va al inicio del código de cada cama)</label>
      <input class="entrada" id="hb-codigo" maxlength="6" placeholder="B2" value="${esc(base?.codigo || '')}">
      <span class="ayuda">Solo letras y números, hasta 6. Ejemplo: B2 para «Base 2».</span></div>
    ${nueva ? '' : '<div class="hab-nota">Si cambia el código, cambian los códigos de todas las camas de esta base.</div>'}
  </div>`;
  const $n = m.cuerpo.querySelector('#hb-nombre');
  const $c = m.cuerpo.querySelector('#hb-codigo');
  let codigoTocado = !nueva;
  $c.addEventListener('input', () => { codigoTocado = true; });
  $n.addEventListener('input', () => { if (!codigoTocado) $c.value = codigoSugerido($n.value, 'B'); });

  const guardar = (b) => conBoton(b, async () => {
    const nombre = valor(m, 'hb-nombre');
    const codigo = valor(m, 'hb-codigo').toUpperCase();
    if (!nombre) return m.error('Escriba el nombre de la base.');
    if (!/^[A-Z0-9]{1,6}$/.test(codigo)) return m.error('El código debe tener de 1 a 6 letras o números, sin espacios.');
    const fila = { nombre, codigo };
    const { error } = nueva
      ? await S.sb.from('viv_bases').insert(alCrear({ ...fila, empresa_id: S.empresaId, sucursal_id: S.nav.sucursalId }))
      : await S.sb.from('viv_bases').update(alEditar(fila)).eq('id', base.id);
    if (error) return m.error(mensajeError(error));
    m.cerrar();
    toast(nueva ? `Base «${nombre}» creada` : 'Base actualizada');
    await recargar();
  });

  const botones = [['Cancelar', 'boton-secundario', () => m.cerrar()]];
  if (!nueva) botones.push(['Eliminar base', 'boton-secundario boton-critico', (b) => eliminarBase(m, base, b)]);
  botones.push([nueva ? 'Crear base' : 'Guardar', 'boton-primario', guardar]);
  m.botones(botones);
  m.enfocar();
}

async function eliminarBase(m, base, boton) {
  if (edificiosDe(base.id).length > 0) {
    return m.error('Esta base todavía tiene edificios. Elimínelos primero desde cada edificio (Configurar edificio).');
  }
  if (boton.dataset.confirmar !== '1') {
    boton.dataset.confirmar = '1';
    boton.textContent = 'Confirmar eliminación';
    return;
  }
  await conBoton(boton, async () => {
    const { error } = await S.sb.from('viv_bases').update(alEditar({ activo: false })).eq('id', base.id);
    if (error) return m.error(mensajeError(error));
    m.cerrar();
    toast('Base eliminada');
    S.nav.baseId = null;
    await recargar();
  });
}

/* ---------- Edificio ---------- */

function modalEdificio(edif) {
  const nuevo = !edif;
  const n = edificiosDe(S.nav.baseId).length + 1;
  const m = modal(nuevo ? 'Nuevo edificio' : `Configurar ${edif.nombre}`);
  m.cuerpo.innerHTML = `<div class="hab-form">
    <div class="hab-form-fila">
      <div class="campo"><label class="etiqueta" for="he-nombre">Nombre</label>
        <input class="entrada" id="he-nombre" maxlength="40" value="${esc(edif?.nombre || `Edificio ${n}`)}"></div>
      <div class="campo"><label class="etiqueta" for="he-codigo">Código corto</label>
        <input class="entrada" id="he-codigo" maxlength="6" value="${esc(edif?.codigo || `E${n}`)}"></div>
    </div>
    <div class="campo"><label class="etiqueta" for="he-plantas">Número de plantas</label>
      <select class="entrada" id="he-plantas">
        ${[1, 2, 3].map((k) => `<option value="${k}" ${(edif?.num_plantas || 1) === k ? 'selected' : ''}>${k} ${k === 1 ? 'planta' : 'plantas'}</option>`).join('')}
      </select></div>
    <div class="hab-opciones">
      <label><input type="checkbox" id="he-frentes" ${edif?.tiene_frentes ? 'checked' : ''}>
        Tiene habitaciones en ambos frentes (A y B)</label>
    </div>
    <span class="ayuda">Luego, con «Editar plantas y espacios», agrega en cada planta sus habitaciones, comedor, bodegas, garita, etc.</span>
  </div>`;

  const guardar = (b) => conBoton(b, async () => {
    const nombre = valor(m, 'he-nombre');
    const codigo = valor(m, 'he-codigo').toUpperCase();
    const plantas = parseInt(valor(m, 'he-plantas'), 10);
    const frentes = m.cuerpo.querySelector('#he-frentes').checked;
    if (!nombre) return m.error('Escriba el nombre del edificio.');
    if (!/^[A-Z0-9]{1,6}$/.test(codigo)) return m.error('El código debe tener de 1 a 6 letras o números, sin espacios.');

    if (nuevo) {
      const { data, error } = await S.sb.from('viv_edificios').insert(alCrear({
        empresa_id: S.empresaId, base_id: S.nav.baseId, nombre, codigo, num_plantas: plantas, tiene_frentes: frentes
      })).select().single();
      if (error) return m.error(mensajeError(error));
      m.cerrar();
      toast(`${nombre} creado. Ahora agregue sus espacios.`);
      await recargar();
      S.nav.edificioId = data.id;
      S.editando = true;
      pintar();
      return;
    }

    const esps = espaciosDe(edif.id);
    const altas = esps.filter((x) => x.planta > plantas);
    if (altas.length) {
      return m.error(`${nombrePlanta(altas[0].planta, edif.num_plantas)} todavía tiene ${altas.length} espacio(s). Quítelos antes de reducir las plantas.`);
    }
    if (edif.tiene_frentes && !frentes) {
      if (esps.some((x) => x.frente === 'B')) return m.error('El frente B todavía tiene espacios. Quítelos antes de desactivar los frentes.');
      const { error } = await S.sb.from('viv_espacios').update(alEditar({ frente: null })).eq('edificio_id', edif.id).eq('frente', 'A');
      if (error) return m.error(mensajeError(error));
    }
    if (!edif.tiene_frentes && frentes) {
      const { error } = await S.sb.from('viv_espacios').update(alEditar({ frente: 'A' })).eq('edificio_id', edif.id).is('frente', null);
      if (error) return m.error(mensajeError(error));
    }
    const { error } = await S.sb.from('viv_edificios')
      .update(alEditar({ nombre, codigo, num_plantas: plantas, tiene_frentes: frentes })).eq('id', edif.id);
    if (error) return m.error(mensajeError(error));
    m.cerrar();
    toast('Edificio actualizado');
    await recargar();
  });

  const botones = [['Cancelar', 'boton-secundario', () => m.cerrar()]];
  if (!nuevo) botones.push(['Eliminar edificio', 'boton-secundario boton-critico', (b) => eliminarEdificio(m, edif, b)]);
  botones.push([nuevo ? 'Crear edificio' : 'Guardar', 'boton-primario', guardar]);
  m.botones(botones);
  m.enfocar();
}

async function eliminarEdificio(m, edif, boton) {
  const camas = camasDeEdificio(edif.id);
  const ocupadas = camas.filter((c) => asigDeCama(c.id));
  if (ocupadas.length) {
    return m.error(`No se puede eliminar: ${ocupadas.length} cama(s) están ocupadas. Libérelas o traslade a esas personas primero.`);
  }
  if (boton.dataset.confirmar !== '1') {
    boton.dataset.confirmar = '1';
    boton.textContent = 'Confirmar eliminación';
    m.error(`Se retirarán ${espaciosDe(edif.id).length} espacio(s) y ${camas.length} cama(s). El historial se conserva. Pulse de nuevo para confirmar.`);
    return;
  }
  await conBoton(boton, async () => {
    const hoyIso = hoy();
    const idsEsp = espaciosDe(edif.id).map((x) => x.id);
    if (idsEsp.length) {
      const r1 = await S.sb.from('viv_camas').update(alEditar({ activo: false, retirada_en: hoyIso })).in('espacio_id', idsEsp).eq('activo', true);
      if (r1.error) return m.error(mensajeError(r1.error));
      const r2 = await S.sb.from('viv_espacios').update(alEditar({ activo: false, retirado_en: hoyIso })).in('id', idsEsp);
      if (r2.error) return m.error(mensajeError(r2.error));
    }
    const r3 = await S.sb.from('viv_edificios').update(alEditar({ activo: false })).eq('id', edif.id);
    if (r3.error) return m.error(mensajeError(r3.error));
    m.cerrar();
    toast('Edificio eliminado');
    S.nav.edificioId = null;
    await recargar();
  });
}

/* ---------- Herramientas del modo edición ---------- */

function herramientasHtml(sel) {
  if (!sel) {
    return `<div class="hab-herramientas" role="toolbar" aria-label="Edición de plantas">
      <span class="hab-herramientas-nombre">Toque un espacio para moverlo, cambiar su tamaño o quitarlo. Use «+ Espacio» al final de cada fila para agregar uno.</span>
    </div>`;
  }
  const hab = sel.tipo === 'habitacion';
  const fila = filaDe(sel.edificio_id, sel.planta, sel.frente);
  const i = fila.findIndex((x) => x.id === sel.id);
  const btn = (h, texto, extra = '', des = false) =>
    `<button class="boton-secundario boton-compacto ${extra}" type="button" data-h="${h}" ${des ? 'disabled' : ''}>${texto}</button>`;
  return `<div class="hab-herramientas" role="toolbar" aria-label="Editar ${esc(sel.nombre)}">
    <span class="hab-herramientas-nombre">${hab ? 'Habitación ' : ''}${esc(sel.nombre)} · ${TAMANOS[sel.ancho]}</span>
    ${btn('izq', '← Mover', '', i <= 0)}
    ${btn('der', 'Mover →', '', i >= fila.length - 1)}
    ${btn('menos', '− Angosto', '', sel.ancho <= 1)}
    ${btn('mas', '+ Ancho', '', sel.ancho >= ANCHO_MAX)}
    ${hab ? btn('cama', '+ Cama o litera') : ''}
    ${btn('editar', 'Nombre o tipo')}
    ${btn('quitar', 'Quitar', 'boton-critico')}
  </div>`;
}

function conectarHerramientas(sel) {
  if (!sel) return;
  const h = (k) => document.querySelector(`.hab-herramientas [data-h="${k}"]`);
  h('izq')?.addEventListener('click', () => moverEspacio(sel, -1));
  h('der')?.addEventListener('click', () => moverEspacio(sel, 1));
  h('menos')?.addEventListener('click', () => cambiarAncho(sel, -1));
  h('mas')?.addEventListener('click', () => cambiarAncho(sel, 1));
  h('cama')?.addEventListener('click', () => modalAgregarCama(sel));
  h('editar')?.addEventListener('click', () => {
    const edif = porId(S.edificios, sel.edificio_id);
    modalEspacio(sel, { edif, planta: sel.planta, frente: sel.frente });
  });
  h('quitar')?.addEventListener('click', () => modalQuitarEspacio(sel));
}

async function moverEspacio(esp, dir) {
  const fila = filaDe(esp.edificio_id, esp.planta, esp.frente);
  const i = fila.findIndex((x) => x.id === esp.id);
  const j = i + dir;
  if (j < 0 || j >= fila.length) return;
  [fila[i], fila[j]] = [fila[j], fila[i]];
  const cambios = fila.map((x, k) => ({ x, orden: (k + 1) * 10 })).filter(({ x, orden }) => x.orden !== orden);
  const res = await Promise.all(cambios.map(({ x, orden }) =>
    S.sb.from('viv_espacios').update(alEditar({ orden })).eq('id', x.id)));
  const fallo = res.find((r) => r.error);
  if (fallo) { toast(mensajeError(fallo.error)); await recargar(); return; }
  cambios.forEach(({ x, orden }) => { x.orden = orden; });
  pintar();
}

async function cambiarAncho(esp, delta) {
  const ancho = Math.max(1, Math.min(ANCHO_MAX, esp.ancho + delta));
  if (ancho === esp.ancho) return;
  const { error } = await S.sb.from('viv_espacios').update(alEditar({ ancho })).eq('id', esp.id);
  if (error) { toast(mensajeError(error)); return; }
  esp.ancho = ancho;
  pintar();
}

/* ---------- Espacio: crear, renombrar, cambiar tipo ---------- */

function nombrePorDefecto(tipo, edifId) {
  if (tipo === 'habitacion') return '';
  const iguales = espaciosDe(edifId).filter((x) => x.tipo === tipo).length;
  return iguales ? `${TIPOS_ESPACIO[tipo]} ${iguales + 1}` : TIPOS_ESPACIO[tipo];
}

function modalEspacio(esp, { edif, planta, frente }) {
  const nuevo = !esp;
  const lugar = `${nombrePlanta(planta, edif.num_plantas)}${frente ? ` · frente ${frente}` : ''}`;
  const m = modal(nuevo ? `Agregar espacio · ${lugar}` : `Editar ${esp.nombre}`);
  const tipoIni = esp?.tipo || 'habitacion';

  m.cuerpo.innerHTML = `<div class="hab-form">
    <div class="campo"><label class="etiqueta" for="hs-tipo">Tipo de espacio</label>
      <select class="entrada" id="hs-tipo">
        ${Object.entries(TIPOS_ESPACIO).map(([k, v]) => `<option value="${k}" ${k === tipoIni ? 'selected' : ''}>${v}</option>`).join('')}
      </select></div>
    <div class="campo"><label class="etiqueta" for="hs-nombre" id="hs-nombre-etq"></label>
      <input class="entrada" id="hs-nombre" maxlength="30" value="${esc(esp?.nombre || '')}">
      <span class="ayuda" id="hs-nombre-ayuda"></span></div>
    ${nuevo ? `<div id="hs-camas-bloque" class="hab-form-fila">
      <div class="campo"><label class="etiqueta" for="hs-camas">Camas iniciales</label>
        <select class="entrada" id="hs-camas">${[0, 1, 2, 3, 4].map((k) => `<option value="${k}" ${k === 1 ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="campo"><label class="etiqueta" for="hs-colchon">Colchón</label>
        <select class="entrada" id="hs-colchon"><option value="esponja">Esponja</option><option value="simbra">Simbra</option><option value="">Sin registrar</option></select></div>
      <div class="campo"><label class="etiqueta" for="hs-fecha">Entregado el</label>
        <input class="entrada" id="hs-fecha" type="date" value="${hoy()}"></div>
    </div><span class="ayuda" id="hs-camas-ayuda">Las literas se agregan después con «+ Cama o litera».</span>` : ''}
    ${!nuevo && esp.tipo === 'habitacion' ? '<div class="hab-nota" id="hs-aviso-tipo" hidden>Al dejar de ser habitación, sus camas dejarán de aparecer en el mapa. Su historial se conserva.</div>' : ''}
  </div>`;

  const $tipo = m.cuerpo.querySelector('#hs-tipo');
  const $nombre = m.cuerpo.querySelector('#hs-nombre');
  let nombreTocado = !nuevo;
  $nombre.addEventListener('input', () => { nombreTocado = true; });
  const ajustar = () => {
    const t = $tipo.value;
    const hab = t === 'habitacion';
    m.cuerpo.querySelector('#hs-nombre-etq').textContent = hab ? 'Número o nombre de la habitación' : 'Nombre';
    m.cuerpo.querySelector('#hs-nombre-ayuda').textContent = hab
      ? 'Forma parte del código de cada cama. Ejemplo: 104 o 201.'
      : 'Ejemplo: Bodega de limpieza, Garita principal.';
    $nombre.placeholder = hab ? '104' : TIPOS_ESPACIO[t];
    if (!nombreTocado) $nombre.value = nombrePorDefecto(t, edif.id);
    const $bloque = m.cuerpo.querySelector('#hs-camas-bloque');
    if ($bloque) { $bloque.hidden = !hab; m.cuerpo.querySelector('#hs-camas-ayuda').hidden = !hab; }
    const $aviso = m.cuerpo.querySelector('#hs-aviso-tipo');
    if ($aviso) $aviso.hidden = hab;
  };
  $tipo.addEventListener('change', ajustar);
  ajustar();

  const guardar = (b) => conBoton(b, async () => {
    const tipo = $tipo.value;
    const nombre = valor(m, 'hs-nombre');
    if (!nombre) return m.error(tipo === 'habitacion' ? 'Escriba el número de la habitación.' : 'Escriba un nombre para el espacio.');
    if (tipo === 'habitacion' && !/^[A-Za-z0-9]{1,12}$/.test(nombre)) {
      return m.error('El número de habitación solo puede tener letras y números, sin espacios (hasta 12).');
    }

    if (nuevo) {
      const fila = filaDe(edif.id, planta, frente);
      const orden = (fila.length ? Math.max(...fila.map((x) => x.orden)) : 0) + 10;
      const { data, error } = await S.sb.from('viv_espacios').insert(alCrear({
        empresa_id: S.empresaId, edificio_id: edif.id, planta, frente: frente || null,
        orden, ancho: ANCHO_INICIAL[tipo], tipo, nombre
      })).select().single();
      if (error) return m.error(mensajeError(error));

      const n = tipo === 'habitacion' ? parseInt(valor(m, 'hs-camas'), 10) || 0 : 0;
      if (n > 0) {
        const colchon = valor(m, 'hs-colchon') || null;
        const f = valor(m, 'hs-fecha') || hoy();
        const err = await crearCamas(data, Array.from({ length: n }, (_, k) => ({ tipo: 'cama', numero: k + 1, nivel: 'unico' })), colchon, f);
        if (err) { m.error(err); await recargar(); return; }
      }
      m.cerrar();
      toast(`${TIPOS_ESPACIO[tipo]} ${tipo === 'habitacion' ? nombre + ' ' : ''}agregada`);
      await recargar();
      S.selEspacio = data.id;
      pintar();
      return;
    }

    if (esp.tipo === 'habitacion' && tipo !== 'habitacion') {
      const ocupadas = camasDe(esp.id).filter((c) => asigDeCama(c.id));
      if (ocupadas.length) return m.error(`No se puede cambiar el tipo: ${ocupadas.length} cama(s) están ocupadas. Libérelas primero.`);
      const r = await S.sb.from('viv_camas').update(alEditar({ activo: false, retirada_en: hoy() })).eq('espacio_id', esp.id).eq('activo', true);
      if (r.error) return m.error(mensajeError(r.error));
    }
    const { error } = await S.sb.from('viv_espacios').update(alEditar({ tipo, nombre })).eq('id', esp.id);
    if (error) return m.error(mensajeError(error));
    m.cerrar();
    toast('Espacio actualizado');
    await recargar();
  });

  m.botones([['Cancelar', 'boton-secundario', () => m.cerrar()], [nuevo ? 'Agregar' : 'Guardar', 'boton-primario', guardar]]);
  m.enfocar();
}

/** Inserta camas y deja registrada la entrega inicial de su colchón. */
async function crearCamas(esp, piezas, colchon, fechaEntrega) {
  const filas = piezas.map((p) => alCrear({
    empresa_id: S.empresaId, espacio_id: esp.id, tipo: p.tipo, numero: p.numero, nivel: p.nivel,
    colchon_tipo: colchon, colchon_fecha: colchon ? fechaEntrega : null
  }));
  const { data, error } = await S.sb.from('viv_camas').insert(filas).select('id');
  if (error) return mensajeError(error);
  if (colchon && data?.length) {
    const hist = data.map((c) => alCrear({
      empresa_id: S.empresaId, cama_id: c.id, tipo: colchon, fecha: fechaEntrega, motivo: 'Entrega inicial'
    }));
    const r = await S.sb.from('viv_colchones').insert(hist);
    if (r.error) console.warn('NEXUS · habitaciones: no se guardó el historial inicial de colchón', r.error.message);
  }
  return null;
}

/* ---------- Espacio: quitar ---------- */

const nombreEspacio = (x) => (x.tipo === 'habitacion' ? `Habitación ${x.nombre}` : x.nombre);

function modalQuitarEspacio(esp) {
  const m = modal(`Quitar ${esp.tipo === 'habitacion' ? 'habitación ' : ''}${esp.nombre}`);
  const camas = esp.tipo === 'habitacion' ? camasDe(esp.id) : [];
  const ocupadas = camas.filter((c) => asigDeCama(c.id));

  if (ocupadas.length) {
    m.cuerpo.innerHTML = `<div class="hab-nota hab-nota--error">No se puede quitar: hay personas asignadas. Libérelas o trasládelas primero.</div>
      <div class="hab-filas-lista" id="hq-lista"></div>`;
    const $l = m.cuerpo.querySelector('#hq-lista');
    ocupadas.forEach((c) => {
      const t = S.trab.get(asigDeCama(c.id).trabajador_id);
      const fila = document.createElement('div');
      fila.innerHTML = `<span><b>${esc(ubicar(c)?.codigo)}</b> · #${esc(t?.codigo ?? '—')} ${esc(t?.nombre_completo || '')}</span>
        <button class="boton-secundario boton-compacto" type="button">Ver cama</button>`;
      fila.querySelector('button').addEventListener('click', () => abrirCama(c));
      $l.appendChild(fila);
    });
    m.botones([['Cerrar', 'boton-secundario', () => m.cerrar()]]);
    return;
  }

  const fila = filaDe(esp.edificio_id, esp.planta, esp.frente);
  const i = fila.findIndex((x) => x.id === esp.id);
  const izq = fila[i - 1];
  const der = fila[i + 1];
  m.cuerpo.innerHTML = `
    ${camas.length ? `<p>Sus ${camas.length} cama(s) libres dejarán de aparecer en el mapa. Su historial de ocupantes y colchones se conserva.</p>` : ''}
    <p class="etiqueta">¿Qué hacer con el lugar que queda?</p>
    <div class="hab-opciones">
      ${izq ? `<label><input type="radio" name="hq-uso" value="izq" checked> Agrandar «${esc(nombreEspacio(izq))}» (a la izquierda)</label>` : ''}
      ${der ? `<label><input type="radio" name="hq-uso" value="der" ${izq ? '' : 'checked'}> Agrandar «${esc(nombreEspacio(der))}» (a la derecha)</label>` : ''}
      <label><input type="radio" name="hq-uso" value="todos" ${izq || der ? '' : 'checked'}> Repartir el espacio entre todos</label>
    </div>`;

  m.botones([
    ['Cancelar', 'boton-secundario', () => m.cerrar()],
    ['Quitar', 'boton-primario boton-critico', (b) => conBoton(b, async () => {
      const uso = m.cuerpo.querySelector('input[name="hq-uso"]:checked')?.value;
      const hoyIso = hoy();
      if (camas.length) {
        const r = await S.sb.from('viv_camas').update(alEditar({ activo: false, retirada_en: hoyIso })).eq('espacio_id', esp.id).eq('activo', true);
        if (r.error) return m.error(mensajeError(r.error));
      }
      const r2 = await S.sb.from('viv_espacios').update(alEditar({ activo: false, retirado_en: hoyIso })).eq('id', esp.id);
      if (r2.error) return m.error(mensajeError(r2.error));
      const vecino = uso === 'izq' ? izq : uso === 'der' ? der : null;
      if (vecino) {
        await S.sb.from('viv_espacios').update(alEditar({ ancho: Math.min(ANCHO_MAX, vecino.ancho + esp.ancho) })).eq('id', vecino.id);
      }
      m.cerrar();
      toast(`${esp.nombre} quitado`);
      S.selEspacio = vecino?.id || null;
      await recargar();
    })]
  ]);
}

/* ---------- Camas: agregar ---------- */

function modalAgregarCama(esp) {
  const actuales = camasDe(esp.id).length;
  const m = modal(`Agregar a la habitación ${esp.nombre}`);
  m.cuerpo.innerHTML = `<div class="hab-form">
    <div class="hab-opciones" role="radiogroup" aria-label="Qué agregar">
      <label><input type="radio" name="hc-tipo" value="cama" checked> Cama (1 plaza)</label>
      <label><input type="radio" name="hc-tipo" value="litera"> Litera (2 plazas: inferior y superior)</label>
    </div>
    <div class="hab-form-fila">
      <div class="campo"><label class="etiqueta" for="hc-colchon">Colchón</label>
        <select class="entrada" id="hc-colchon"><option value="esponja">Esponja</option><option value="simbra">Simbra</option><option value="">Sin registrar</option></select></div>
      <div class="campo"><label class="etiqueta" for="hc-fecha">Entregado el</label>
        <input class="entrada" id="hc-fecha" type="date" value="${hoy()}"></div>
    </div>
    <div id="hc-aviso"></div>
  </div>`;

  const plazas = () => (m.cuerpo.querySelector('input[name="hc-tipo"]:checked').value === 'litera' ? 2 : 1);
  const revisar = () => {
    const total = actuales + plazas();
    const $a = m.cuerpo.querySelector('#hc-aviso');
    if (total > PLAZAS_MAX) {
      $a.innerHTML = `<div class="hab-nota hab-nota--error">La habitación tendría ${total} camas y el máximo es ${PLAZAS_MAX}.</div>`;
    } else if (total > PLAZAS_SIN_AVISO) {
      $a.innerHTML = `<div class="hab-nota">La habitación pasará a tener ${total} camas, más de lo habitual.</div>
        <label class="hab-opciones"><span><input type="checkbox" id="hc-confirma"> Confirmo que esta habitación tendrá ${total} camas</span></label>`;
    } else {
      $a.innerHTML = `<div class="hab-nota hab-nota--info">La habitación quedará con ${total} ${total === 1 ? 'cama' : 'camas'}.</div>`;
    }
  };
  m.cuerpo.querySelectorAll('input[name="hc-tipo"]').forEach((r) => r.addEventListener('change', revisar));
  revisar();

  m.botones([
    ['Cancelar', 'boton-secundario', () => m.cerrar()],
    ['Agregar', 'boton-primario', (b) => conBoton(b, async () => {
      const tipo = m.cuerpo.querySelector('input[name="hc-tipo"]:checked').value;
      const total = actuales + (tipo === 'litera' ? 2 : 1);
      if (total > PLAZAS_MAX) return m.error(`El máximo es ${PLAZAS_MAX} camas por habitación.`);
      if (total > PLAZAS_SIN_AVISO && !m.cuerpo.querySelector('#hc-confirma')?.checked) {
        return m.error('Marque la casilla de confirmación para continuar.');
      }
      /* El número nunca se reutiliza: se busca el mayor, incluso
         entre camas retiradas, para que los códigos no cambien. */
      const { data: ult, error: e1 } = await S.sb.from('viv_camas').select('numero')
        .eq('espacio_id', esp.id).order('numero', { ascending: false }).limit(1);
      if (e1) return m.error(mensajeError(e1));
      const numero = (ult?.[0]?.numero || 0) + 1;
      const piezas = tipo === 'litera'
        ? [{ tipo, numero, nivel: 'inferior' }, { tipo, numero, nivel: 'superior' }]
        : [{ tipo, numero, nivel: 'unico' }];
      const err = await crearCamas(esp, piezas, valor(m, 'hc-colchon') || null, valor(m, 'hc-fecha') || hoy());
      if (err) return m.error(err);
      m.cerrar();
      toast(tipo === 'litera' ? `Litera ${numero} agregada` : `Cama ${numero} agregada`);
      await recargar();
    })]
  ]);
}

/* ============================================
   Ventana de una cama
   ============================================ */

const COLORES_ESTADO = {
  libre: ['var(--hab-libre)', 'var(--hab-libre-f)', 'Libre'],
  ocupada: ['var(--hab-ocupada)', 'var(--hab-ocupada-f)', 'Ocupada'],
  cambio: ['var(--hab-cambio)', 'var(--hab-cambio-f)', 'Colchón por cambiar'],
  salio: ['var(--hab-salio)', 'var(--hab-salio-f)', 'Ya no labora']
};

function fichaTrabajador(t) {
  const meta = [t.codigo != null ? `#${t.codigo}` : null, t.cargo, t.edad != null ? `${t.edad} años` : null]
    .filter(Boolean).map(esc).join(' · ');
  return `<div class="hab-ficha">
    <div class="hab-iniciales" aria-hidden="true">${esc(iniciales(t.nombre_completo))}</div>
    <div><strong>${esc(t.nombre_completo)}</strong><br><span class="ayuda">${meta || '—'}${t.cedula ? ` · C.I. ${esc(t.cedula)}` : ''}</span></div>
  </div>`;
}

function abrirCama(camaEntrada, modo = 'detalle', motivoInicial = null) {
  const cama = porId(S.camas, camaEntrada.id) || camaEntrada;
  const u = ubicar(cama);
  const m = modal(u ? u.codigo : 'Cama');

  const pantallas = { detalle, asignar, liberar, colchon, historial, quitar };
  const ir = (p, extra) => { m.error(null); pantallas[p](extra); m.enfocar(); };
  ir(PANTALLA_VALIDA(modo));

  function PANTALLA_VALIDA(p) {
    if (!S.editor && p !== 'historial') return 'detalle';
    return pantallas[p] ? p : 'detalle';
  }

  function detalle() {
    const a = asigDeCama(cama.id);
    const t = a && S.trab.get(a.trabajador_id);
    const est = estadoCama(cama);
    const [c, f, texto] = COLORES_ESTADO[est];
    const pieza = cama.tipo === 'litera' ? `Litera ${cama.numero}, nivel ${cama.nivel}` : `Cama ${cama.numero}`;

    m.cuerpo.innerHTML = `
      <p><span class="hab-modal-estado" style="--c:${c};--f:${f}">${texto}</span></p>
      <p class="ayuda">${esc(rutaTexto(cama))}</p>
      ${t ? fichaTrabajador(t) : ''}
      ${t && t.activo === false ? '<div class="hab-nota hab-nota--error">Esta persona ya no labora en la empresa. Libere la cama si ya no la ocupa.</div>' : ''}
      <table class="hab-datos">
        <tr><td>Tipo</td><td>${esc(pieza)}</td></tr>
        ${a ? `<tr><td>Ocupa la cama desde</td><td>${fecha(a.fecha_ingreso)}</td></tr>` : ''}
        <tr><td>Colchón</td><td>${cama.colchon_tipo ? COLCHONES[cama.colchon_tipo] : 'Sin registrar'}${cama.colchon_por_cambiar ? ' · <strong>por cambiar</strong>' : ''}</td></tr>
        <tr><td>Entregado o cambiado</td><td>${fecha(cama.colchon_fecha)}</td></tr>
      </table>`;

    const b = [['Historial', 'boton-secundario', () => ir('historial')]];
    if (S.editor) {
      b.push([cama.colchon_por_cambiar ? 'Quitar «por cambiar»' : 'Marcar por cambiar', 'boton-secundario', (btn) => conBoton(btn, async () => {
        const { error } = await S.sb.from('viv_camas').update(alEditar({ colchon_por_cambiar: !cama.colchon_por_cambiar })).eq('id', cama.id);
        if (error) return m.error(mensajeError(error));
        cama.colchon_por_cambiar = !cama.colchon_por_cambiar;
        pintar();
        detalle();
      })]);
      b.push(['Cambiar colchón', 'boton-secundario', () => ir('colchon')]);
      if (a) b.push(['Liberar cama', 'boton-secundario boton-critico', () => ir('liberar')]);
      else {
        b.push(['Quitar cama', 'boton-secundario boton-critico', () => ir('quitar')]);
        b.push(['Asignar trabajador', 'boton-primario', () => ir('asignar')]);
      }
    } else {
      b.push(['Cerrar', 'boton-primario', () => m.cerrar()]);
    }
    m.botones(b);
  }

  function asignar() {
    let elegido = null;
    m.cuerpo.innerHTML = `<div class="hab-form">
      <div class="campo"><label class="etiqueta" for="ha-q">Código, nombre o cédula del trabajador</label>
        <input class="entrada" id="ha-q" type="search" autocomplete="off" placeholder="1830"></div>
      <div id="ha-lista"></div>
      <div id="ha-elegido"></div>
    </div>`;
    const $q = m.cuerpo.querySelector('#ha-q');
    const $lista = m.cuerpo.querySelector('#ha-lista');
    const $eleg = m.cuerpo.querySelector('#ha-elegido');
    let temporizador = null;

    const elegir = (t) => {
      elegido = t;
      $lista.innerHTML = '';
      S.trab.set(t.id, { ...(S.trab.get(t.id) || {}), ...t });
      const previa = asigDeTrabajador(t.id);
      const camaPrevia = previa && porId(S.camas, previa.cama_id);
      $eleg.innerHTML = `${fichaTrabajador(t)}
        ${camaPrevia ? `<div class="hab-nota">Ya ocupa la cama ${esc(ubicar(camaPrevia)?.codigo)}. Si continúa, se trasladará aquí y esa cama quedará libre.</div>` : ''}
        <div class="campo"><label class="etiqueta" for="ha-fecha">Fecha de ingreso a la cama</label>
          <input class="entrada" id="ha-fecha" type="date" value="${hoy()}"></div>`;
      m.pie.querySelector('.boton-primario').textContent = camaPrevia ? 'Trasladar aquí' : 'Asignar cama';
    };

    const buscar = async () => {
      const texto = $q.value.trim();
      elegido = null; $eleg.innerHTML = ''; m.error(null);
      if (!texto) { $lista.innerHTML = ''; return; }
      let lista = [];
      if (/^\d+$/.test(texto) && texto.length < 10) {
        const { data } = await S.sb.from('v_trabajadores')
          .select('id, codigo, nombre_completo, cedula, edad, cargo, activo')
          .eq('empresa_id', S.empresaId).eq('activo', true).eq('codigo', parseInt(texto, 10));
        lista = data || [];
      } else if (texto.length >= 2) {
        lista = await sugerir(texto, true);
      }
      if (lista.length === 0) { $lista.innerHTML = '<p class="ayuda">No hay trabajadores activos con ese dato.</p>'; return; }
      if (lista.length === 1 && /^\d+$/.test(texto)) { elegir(lista[0]); return; }
      $lista.innerHTML = '<div class="hab-lista-sug" role="listbox"></div>';
      lista.forEach((t) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'option');
        const tiene = asigDeTrabajador(t.id);
        b.innerHTML = `<b>#${esc(t.codigo ?? 'S/C')}</b> ${esc(t.nombre_completo)} <small>${esc(t.cargo || '')}${tiene ? ' · ya tiene cama' : ''}</small>`;
        b.addEventListener('click', () => elegir(t));
        $lista.firstChild.appendChild(b);
      });
    };
    $q.addEventListener('input', () => { clearTimeout(temporizador); temporizador = setTimeout(buscar, 250); });
    $q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(temporizador); buscar(); } });

    m.botones([
      ['Volver', 'boton-secundario', () => ir('detalle')],
      ['Asignar cama', 'boton-primario', (b) => conBoton(b, async () => {
        if (!elegido) return m.error('Busque y elija a un trabajador primero.');
        const f = valor(m, 'ha-fecha') || hoy();
        const { error } = await S.sb.rpc('viv_asignar', {
          p_cama: cama.id, p_trabajador: elegido.id, p_fecha: f, p_autor: S.perfil?.id ?? null
        });
        if (error) return m.error(mensajeError(error));
        m.cerrar();
        toast(`Cama asignada a ${elegido.nombre_completo}`);
        await recargar();
        document.getElementById('hab-resultado').innerHTML = '';
      })]
    ]);
  }

  function liberar() {
    const a = asigDeCama(cama.id);
    if (!a) { detalle(); return; }
    const t = S.trab.get(a.trabajador_id);
    const motivoIni = motivoInicial || MOTIVOS_SALIDA[0];
    m.cuerpo.innerHTML = `${t ? fichaTrabajador(t) : ''}
      <div class="hab-form">
        <div class="campo"><label class="etiqueta" for="hl-motivo">Motivo</label>
          <select class="entrada" id="hl-motivo">${MOTIVOS_SALIDA.map((x) => `<option ${x === motivoIni ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div class="campo" id="hl-otro-campo" hidden><label class="etiqueta" for="hl-otro">Detalle el motivo</label>
          <input class="entrada" id="hl-otro" maxlength="120"></div>
        <div class="campo"><label class="etiqueta" for="hl-fecha">Fecha de salida de la cama</label>
          <input class="entrada" id="hl-fecha" type="date" value="${hoy()}" min="${a.fecha_ingreso}"></div>
        <span class="ayuda">La cama quedará libre. Queda en el historial quién la ocupó, desde cuándo, hasta cuándo y por qué salió.</span>
      </div>`;
    const $mot = m.cuerpo.querySelector('#hl-motivo');
    const ajustar = () => { m.cuerpo.querySelector('#hl-otro-campo').hidden = $mot.value !== 'Otro'; };
    $mot.addEventListener('change', ajustar);
    ajustar();

    m.botones([
      ['Volver', 'boton-secundario', () => ir('detalle')],
      ['Liberar cama', 'boton-primario boton-critico', (b) => conBoton(b, async () => {
        const f = valor(m, 'hl-fecha');
        let motivo = $mot.value;
        if (motivo === 'Otro') {
          motivo = valor(m, 'hl-otro');
          if (!motivo) return m.error('Detalle el motivo de la salida.');
        }
        if (!f) return m.error('Indique la fecha de salida.');
        if (f < a.fecha_ingreso) return m.error(`La fecha de salida no puede ser anterior al ingreso (${fecha(a.fecha_ingreso)}).`);
        const { error } = await S.sb.from('viv_asignaciones')
          .update(alEditar({ fecha_salida: f, motivo_salida: motivo })).eq('id', a.id).is('fecha_salida', null);
        if (error) return m.error(mensajeError(error));
        m.cerrar();
        toast(`Cama ${ubicar(cama)?.codigo} liberada`);
        await recargar();
        document.getElementById('hab-resultado').innerHTML = '';
      })]
    ]);
  }

  function colchon() {
    m.cuerpo.innerHTML = `<div class="hab-form">
      <div class="hab-form-fila">
        <div class="campo"><label class="etiqueta" for="hk-tipo">Colchón entregado</label>
          <select class="entrada" id="hk-tipo">${Object.entries(COLCHONES).map(([k, v]) => `<option value="${k}" ${k === cama.colchon_tipo ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="campo"><label class="etiqueta" for="hk-fecha">Fecha de entrega</label>
          <input class="entrada" id="hk-fecha" type="date" value="${hoy()}"></div>
      </div>
      <div class="campo"><label class="etiqueta" for="hk-motivo">Motivo del cambio</label>
        <input class="entrada" id="hk-motivo" maxlength="160" placeholder="Desgaste, daño, solicitud del trabajador…"></div>
      <div class="campo"><label class="etiqueta" for="hk-rec">Recomendación médica (si aplica)</label>
        <textarea class="entrada" id="hk-rec" rows="2" maxlength="400" placeholder="Ej.: colchón firme por lumbalgia, según Dpto. Médico"></textarea></div>
    </div>`;
    m.botones([
      ['Volver', 'boton-secundario', () => ir('detalle')],
      ['Registrar entrega', 'boton-primario', (b) => conBoton(b, async () => {
        const tipo = valor(m, 'hk-tipo');
        const f = valor(m, 'hk-fecha') || hoy();
        const r1 = await S.sb.from('viv_colchones').insert(alCrear({
          empresa_id: S.empresaId, cama_id: cama.id, tipo, fecha: f,
          motivo: valor(m, 'hk-motivo') || null, recomendacion: valor(m, 'hk-rec') || null
        }));
        if (r1.error) return m.error(mensajeError(r1.error));
        const r2 = await S.sb.from('viv_camas').update(alEditar({
          colchon_tipo: tipo, colchon_fecha: f, colchon_por_cambiar: false
        })).eq('id', cama.id);
        if (r2.error) return m.error(mensajeError(r2.error));
        m.cerrar();
        toast('Entrega de colchón registrada');
        await recargar();
      })]
    ]);
  }

  async function historial() {
    m.cuerpo.innerHTML = '<p class="ayuda">Cargando historial…</p>';
    m.botones([['Volver', 'boton-secundario', () => ir('detalle')]]);
    const [ra, rc] = await Promise.all([
      S.sb.from('viv_asignaciones').select('trabajador_id, fecha_ingreso, fecha_salida, motivo_salida')
        .eq('cama_id', cama.id).order('fecha_ingreso', { ascending: false }),
      S.sb.from('viv_colchones').select('tipo, fecha, motivo, recomendacion')
        .eq('cama_id', cama.id).order('fecha', { ascending: false })
    ]);
    if (!m.m.isConnected) return;
    const asig = ra.data || [];
    await cargarTrabajadores(asig.map((a) => a.trabajador_id));
    const col = rc.data || [];

    const ocupantes = asig.length === 0 ? '<p class="ayuda">Nadie ha ocupado esta cama todavía.</p>'
      : `<ul class="hab-historia">${asig.map((a) => {
        const t = S.trab.get(a.trabajador_id);
        return `<li><time>${fecha(a.fecha_ingreso)} → ${a.fecha_salida ? fecha(a.fecha_salida) : 'actualidad'}</time>
          #${esc(t?.codigo ?? '—')} ${esc(t?.nombre_completo || 'Trabajador')}${a.motivo_salida ? ` · ${esc(a.motivo_salida)}` : ''}</li>`;
      }).join('')}</ul>`;
    const colchones = col.length === 0 ? '<p class="ayuda">No hay entregas de colchón registradas.</p>'
      : `<ul class="hab-historia">${col.map((x) => `<li><time>${fecha(x.fecha)}</time>
          Colchón ${esc(COLCHONES[x.tipo]?.toLowerCase() || x.tipo)}${x.motivo ? ` · ${esc(x.motivo)}` : ''}
          ${x.recomendacion ? `<br><span class="ayuda">Recomendación médica: ${esc(x.recomendacion)}</span>` : ''}</li>`).join('')}</ul>`;

    m.cuerpo.innerHTML = `<h3 class="hab-subtitulo">Ocupantes</h3>${ocupantes}<h3 class="hab-subtitulo">Colchones</h3>${colchones}`;
  }

  function quitar() {
    const hermanas = cama.tipo === 'litera'
      ? S.camas.filter((x) => x.espacio_id === cama.espacio_id && x.tipo === 'litera' && x.numero === cama.numero)
      : [cama];
    const ocupada = hermanas.find((x) => asigDeCama(x.id));
    if (ocupada) {
      m.cuerpo.innerHTML = `<div class="hab-nota hab-nota--error">No se puede quitar la litera: el nivel ${esc(ocupada.nivel)} está ocupado. Libérelo primero.</div>`;
      m.botones([['Volver', 'boton-secundario', () => ir('detalle')]]);
      return;
    }
    m.cuerpo.innerHTML = `<p>${cama.tipo === 'litera'
      ? `Se quitará la litera ${cama.numero} completa (sus dos niveles).`
      : `Se quitará la cama ${cama.numero}.`} Los códigos de las demás camas no cambian y el historial se conserva.</p>`;
    m.botones([
      ['Volver', 'boton-secundario', () => ir('detalle')],
      ['Quitar', 'boton-primario boton-critico', (b) => conBoton(b, async () => {
        const { error } = await S.sb.from('viv_camas')
          .update(alEditar({ activo: false, retirada_en: hoy() })).in('id', hermanas.map((x) => x.id));
        if (error) return m.error(mensajeError(error));
        m.cerrar();
        toast(cama.tipo === 'litera' ? `Litera ${cama.numero} quitada` : `Cama ${cama.numero} quitada`);
        await recargar();
      })]
    ]);
  }
}

/* ============================================
   Personal que ya salió y sigue con cama
   ============================================ */

function modalSalieron() {
  const m = modal('Camas de personal que ya no labora');
  const lista = S.asig.filter((a) => S.trab.get(a.trabajador_id)?.activo === false);
  m.cuerpo.innerHTML = `<p class="ayuda">Estas personas tienen salida registrada en Trabajadores pero su cama sigue asignada.</p>
    <div class="hab-filas-lista" id="hx-lista"></div>`;
  const $l = m.cuerpo.querySelector('#hx-lista');
  lista.forEach((a) => {
    const cama = porId(S.camas, a.cama_id);
    const t = S.trab.get(a.trabajador_id);
    const fila = document.createElement('div');
    fila.innerHTML = `<span><b>${esc(ubicar(cama)?.codigo)}</b><br>#${esc(t?.codigo ?? '—')} ${esc(t?.nombre_completo || '')}</span>
      <span style="display:flex;gap:.4rem;flex-wrap:wrap">
        <button class="boton-secundario boton-compacto" type="button" data-a="ver">Ver</button>
        ${S.editor ? '<button class="boton-secundario boton-compacto boton-critico" type="button" data-a="liberar">Liberar</button>' : ''}
      </span>`;
    fila.querySelector('[data-a="ver"]').addEventListener('click', () => { m.cerrar(); irACama(cama); });
    fila.querySelector('[data-a="liberar"]')?.addEventListener('click', () => abrirCama(cama, 'liberar', 'Salida de la empresa'));
    $l.appendChild(fila);
  });
  m.botones([['Cerrar', 'boton-secundario', () => m.cerrar()]]);
}

/* ============================================
   Para la Ficha de Trabajo Social: «Vive en: …»
   Independiente del estado de la pestaña. Si las tablas aún
   no existen, devuelve null en silencio.
   ============================================ */

export async function ubicacionTrabajador(supabase, empresaId, trabajadorId) {
  try {
    const { data: a, error } = await supabase.from('viv_asignaciones')
      .select('cama_id').eq('empresa_id', empresaId).eq('trabajador_id', trabajadorId)
      .is('fecha_salida', null).maybeSingle();
    if (error || !a) return null;
    const { data: cama } = await supabase.from('viv_camas').select('*').eq('id', a.cama_id).maybeSingle();
    if (!cama) return null;
    const { data: esp } = await supabase.from('viv_espacios').select('*').eq('id', cama.espacio_id).maybeSingle();
    if (!esp) return null;
    const { data: edif } = await supabase.from('viv_edificios').select('*').eq('id', esp.edificio_id).maybeSingle();
    if (!edif) return null;
    const { data: base } = await supabase.from('viv_bases').select('*').eq('id', edif.base_id).maybeSingle();
    if (!base) return null;
    const { data: suc } = await supabase.from('sucursales').select('nombre').eq('id', base.sucursal_id).maybeSingle();

    const pieza = cama.tipo === 'litera' ? `L${cama.numero}-${cama.nivel === 'superior' ? 'SUP' : 'INF'}` : `C${cama.numero}`;
    const codigo = [base.codigo, edif.codigo, esp.frente, esp.nombre, pieza].filter(Boolean).join('-').toUpperCase();
    const nombreCama = cama.tipo === 'litera' ? `litera ${cama.numero}, nivel ${cama.nivel}` : `cama ${cama.numero}`;
    return `${[suc?.nombre, base.nombre, edif.nombre, esp.frente ? `Frente ${esp.frente}` : null].filter(Boolean).join(' › ')} › Habitación ${esp.nombre}, ${nombreCama} (${codigo})`;
  } catch {
    return null;
  }
}

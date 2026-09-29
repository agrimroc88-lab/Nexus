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
import { esperarImagenes } from './impresion.js?v=11';

const VERSION = 'v15';
console.info('NEXUS · habitaciones', VERSION);

/* Dos permisos distintos:
   - ESTRUCTURA: bases, edificios, plantas, espacios, camas y
     literas (agregar o quitar) y el croquis → admin y técnico
     de seguridad (desde el módulo Seguridad Industrial).
   - ASIGNACIÓN: asignar, trasladar y liberar camas, y los
     colchones → admin y trabajo social.
   Los demás roles que abren la pestaña solo consultan. */
const ROLES_ESTRUCTURA = ['admin', 'tecnico_sst'];
const ROLES_ASIGNACION = ['admin', 'trabajo_social'];
const EDITORES_SEG = ['admin', 'tecnico_sst'];
const QUIEN_ESTRUCTURA = 'Las registra el técnico de seguridad o el administrador desde el módulo Seguridad Industrial.';

const TIPOS_ESPACIO = {
  habitacion: 'Habitación',
  comedor: 'Comedor',
  bodega: 'Bodega',
  garita: 'Garita',
  oficina: 'Oficina',
  banos: 'Baños',
  lavanderia: 'Lavandería',
  escaleras: 'Escaleras',
  sin_construir: 'Sin construcción (terreno abierto)',
  otro: 'Otro'
};
const ANCHO_INICIAL = { habitacion: 1, comedor: 3, bodega: 1, garita: 1, oficina: 1, banos: 1, lavanderia: 1, escaleras: 1, sin_construir: 2, otro: 1 };
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
    estructura: ROLES_ESTRUCTURA.includes(perfil?.rol),
    asigna: ROLES_ASIGNACION.includes(perfil?.rol),
    sucursales: [],
    bases: [],
    edificios: [],
    espacios: [],
    camas: [],
    asig: [],              // asignaciones abiertas
    trab: new Map(),       // trabajador_id → datos
    nav: { sucursalId: null, baseId: null, edificioId: null },
    soloLibres: false,
    detalle: false,        // false = vista panorámica (camas pequeñas)
    editando: false,
    croquis: [],           // viv_croquis de la empresa
    croquisFalta: false,   // true si aún no se ejecutó habitaciones_etapa2.sql
    vistaBase: 'croquis',  // 'croquis' | 'edificios'
    seguridad: [],         // viv_seguridad de la empresa
    seguridadFalta: false, // true si aún no se ejecutó habitaciones_etapa3.sql
    segVisible: EDITORES_SEG.includes(perfil?.rol),
    segOcultas: new Set(),
    segEdit: false,
    segColocar: null,
    cq: null,              // edición del croquis en curso
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
  return /42P01|42703|PGRST204|PGRST205|PGRST202|does not exist|Could not find the (table|function|'.+' column)/i.test(m);
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
/* Un espacio con frente 'AB' atraviesa el edificio: se ve en
   la fila A y en la B. Para moverlo se usa la fila A. */
function enFila(x, frente) {
  const f = x.frente || null;
  const pedida = frente === 'AB' ? 'A' : (frente || null);
  return f === pedida || (f === 'AB' && (pedida === 'A' || pedida === 'B'));
}
const filaDe = (edifId, planta, frente) => espaciosDe(edifId)
  .filter((x) => x.planta === planta && enFila(x, frente))
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

const PASILLOS = {
  central: 'En medio (entre el frente A y el B)',
  frente: 'Al frente de cada lado (A y B espalda con espalda)',
  lado: 'Delante de la fila de cuartos',
  ninguno: 'Sin pasillo interior'
};
function pasilloDe(edif) {
  const p = edif.pasillo || (edif.tiene_frentes ? 'central' : 'lado');
  if (!edif.tiene_frentes && (p === 'central' || p === 'frente')) return 'lado';
  if (edif.tiene_frentes && p === 'lado') return 'central';
  return p;
}
function pasilloHtml(clave, texto = 'Pasillo') {
  const d = document.createElement('div');
  d.className = 'hab-pasillo';
  d.dataset.pasillo = clave;
  d.innerHTML = `<span>${texto}</span>`;
  return d;
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
  escaleras: 'M3 21h5v-5h5v-5h5V6h3M3 21V3',
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
      if (esp.tipo === 'sin_construir') {
        s += `<rect x="${x}" y="${y - 1}" width="${w}" height="${H + 2}" fill="#f3f5f1"/>
          <rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${H - 2}" fill="none" stroke="${C.estructura}" stroke-dasharray="3 2" stroke-width="0.8"/>`;
        x += w;
        return;
      } else if (esp.tipo === 'habitacion') {
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
  await cargarCroquis();
  await cargarSeguridad();
}

/* Aparte: si falta el SQL de la etapa 2, el resto de la
   pestaña sigue funcionando y solo el croquis lo avisa. */
async function cargarCroquis() {
  try {
    S.croquis = await traerTodo(() => S.sb.from('viv_croquis').select('*')
      .eq('empresa_id', S.empresaId).eq('activo', true).order('id'));
    S.croquisFalta = false;
  } catch (error) {
    S.croquis = [];
    S.croquisFalta = faltaSql(error);
    if (!S.croquisFalta) console.warn('NEXUS · croquis:', error.message);
  }
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
        <span>No tiene cama asignada.${S.asigna && t.activo !== false ? ' Para asignarle una, toque una cama libre en el mapa.' : ''}</span>
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
      ${S.asigna ? '<button class="boton-secundario boton-critico" type="button" data-accion="liberar">Liberar cama</button>' : ''}
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
  S.cq = null;
  S.segEdit = false;
  S.segColocar = null;
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
      <div class="hab-cabeza-acciones">${S.estructura ? '<button class="boton-primario" id="hab-nueva-base" type="button">+ Nueva base</button>' : ''}</div></div>
    ${bases.length ? cifras(conteo(camasDeSucursal(suc.id))) : ''}
    <div class="hab-rejilla" id="hab-g"></div>`;
  document.getElementById('hab-nueva-base')?.addEventListener('click', () => modalBase(null));

  const $g = document.getElementById('hab-g');
  if (bases.length === 0) {
    $g.outerHTML = `<div class="hab-vacio">Este centro aún no tiene bases.<br>${S.estructura ? 'Cree la primera con «+ Nueva base», por ejemplo «Base 2».' : QUIEN_ESTRUCTURA}</div>`;
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
  const enCroquis = S.vistaBase === 'croquis';
  $v.innerHTML = `
    <div class="hab-cabeza"><h2 class="hab-titulo">${esc(base.nombre)} <small>código ${esc(base.codigo)}</small></h2>
      <div class="hab-cabeza-acciones">${S.estructura && !S.cq ? `
        <button class="boton-secundario" id="hab-editar-base" type="button">Editar base</button>
        <button class="boton-primario" id="hab-nuevo-edif" type="button">+ Nuevo edificio</button>` : ''}</div></div>
    ${eds.length ? cifras(conteo(camasDeBase(base.id))) : ''}
    <div class="hab-filtros" role="group" aria-label="Forma de ver la base">
      <button class="hab-chip" type="button" data-vb="croquis" aria-pressed="${enCroquis}" ${S.cq ? 'disabled' : ''}>Croquis</button>
      <button class="hab-chip" type="button" data-vb="edificios" aria-pressed="${!enCroquis}" ${S.cq ? 'disabled' : ''}>Edificios</button>
    </div>
    <div id="hab-g" class="hab-rejilla"></div>`;
  document.getElementById('hab-editar-base')?.addEventListener('click', () => modalBase(base));
  document.getElementById('hab-nuevo-edif')?.addEventListener('click', () => modalEdificio(null));
  $v.querySelectorAll('[data-vb]').forEach((b) => b.addEventListener('click', () => { S.vistaBase = b.dataset.vb; pintar(); }));

  const $g = document.getElementById('hab-g');
  if (enCroquis) { vistaCroquis($g, base); return; }
  if (eds.length === 0) {
    $g.outerHTML = `<div class="hab-vacio">Esta base aún no tiene edificios.<br>${S.estructura ? 'Agregue el primero con «+ Nuevo edificio».' : QUIEN_ESTRUCTURA}</div>`;
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
      <div class="hab-cabeza-acciones">
        ${!S.editando && !S.segEdit ? '<button class="boton-secundario" id="hab-imprimir" type="button">Imprimir planos</button>' : ''}
        ${S.estructura ? `
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
        <button class="hab-chip" id="hab-detalle" type="button" aria-pressed="${S.detalle}">Ver camas en detalle</button>
        <button class="hab-chip" id="hab-libres" type="button" aria-pressed="${S.soloLibres}">Solo habitaciones con camas libres</button>
      </div>
    </div>
    ${barraSeguridadHtml(edif)}
    ${S.editando ? herramientasHtml(sel) : ''}
    <div class="hab-fachada ${S.editando ? 'hab-editando' : ''} ${S.detalle ? '' : 'hab-compacta'}" id="hab-fachada"></div>`;

  document.getElementById('hab-config-edif')?.addEventListener('click', () => modalEdificio(edif));
  document.getElementById('hab-imprimir')?.addEventListener('click', () => modalImprimir(edif));
  document.getElementById('hab-modo')?.addEventListener('click', () => {
    S.editando = !S.editando; S.selEspacio = null;
    if (S.editando) { S.segEdit = false; S.segColocar = null; }
    pintar();
  });
  document.getElementById('hab-libres').addEventListener('click', () => { S.soloLibres = !S.soloLibres; pintar(); });
  document.getElementById('hab-detalle').addEventListener('click', () => { S.detalle = !S.detalle; pintar(); });
  if (S.editando) conectarHerramientas(sel);
  conectarBarraSeguridad(edif);

  const $f = document.getElementById('hab-fachada');
  $f.insertAdjacentHTML('beforeend', `<svg class="hab-techo" viewBox="0 0 400 34" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 34 L200 2 L400 34 Z" fill="${C.techo}" stroke="${C.muro}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`);

  for (let p = edif.num_plantas; p >= 1; p--) {
    const planta = document.createElement('section');
    planta.className = 'hab-planta';
    planta.dataset.planta = p;
    planta.setAttribute('aria-label', nombrePlanta(p, edif.num_plantas));
    planta.innerHTML = `<div class="hab-planta-nombre">${nombrePlanta(p, edif.num_plantas)}</div>`;
    planta.appendChild(edif.tiene_frentes ? plantaConFrentes(edif, p) : filaHtml(edif, p, null));
    if (!edif.tiene_frentes && pasilloDe(edif) === 'lado') planta.appendChild(pasilloHtml('lado'));
    $f.appendChild(planta);
  }
  $f.insertAdjacentHTML('beforeend', '<div class="hab-suelo" aria-hidden="true"></div>');
  pintarSeguridad($f, edif);
  conectarColocar($f, edif);

  if (S.resaltar) {
    const el = $f.querySelector(`[data-cama="${S.resaltar}"]`);
    if (el) { el.classList.add('hab-cama--resaltada'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    S.resaltar = null;
  }
}

/* ---------- Plantas con frentes A y B ----------
   Cuadrícula de dos filas (A arriba, B abajo). Un espacio de
   ambos frentes ('AB') es una columna que ocupa las dos filas;
   entre esas columnas quedan «tramos» donde cada frente acomoda
   libremente sus propios espacios. */

const porOrden = (a, b) => a.orden - b.orden || a.creado_en.localeCompare(b.creado_en);

function tramosDe(edifId, planta) {
  const todos = espaciosDe(edifId).filter((x) => x.planta === planta).sort(porOrden);
  const res = [];
  let tramo = { tipo: 'tramo', A: [], B: [] };
  todos.forEach((x) => {
    if (x.frente === 'AB') {
      res.push(tramo, { tipo: 'ab', esp: x });
      tramo = { tipo: 'tramo', A: [], B: [] };
    } else {
      tramo[x.frente === 'B' ? 'B' : 'A'].push(x);
    }
  });
  res.push(tramo);
  return res.filter((t) => t.tipo === 'ab' || t.A.length || t.B.length);
}

function plantaConFrentes(edif, planta) {
  const scroll = document.createElement('div');
  scroll.className = 'hab-fila-scroll';
  const tramos = tramosDe(edif.id, planta);
  if (tramos.length === 0 && !S.editando) {
    scroll.innerHTML = `<div class="hab-fila-vacia">Sin espacios registrados${S.estructura ? '. Use «Editar plantas y espacios» para agregarlos.' : '.'}</div>`;
    return scroll;
  }

  const rejilla = document.createElement('div');
  rejilla.className = 'hab-rejilla-frentes';
  const columnas = ['auto'];
  /* Filas según el pasillo: central → A, pasillo, B;
     frente → pasillo A, A, B, pasillo B; ninguno → A, B. */
  const tipoPasillo = pasilloDe(edif);
  /* El frente de arriba es A, salvo que el edificio indique
     «B arriba y A abajo». */
  const [arriba, abajo] = edif.frentes_invertidos ? ['B', 'A'] : ['A', 'B'];
  const FILA = tipoPasillo === 'central' ? { [arriba]: 1, [abajo]: 3 }
    : tipoPasillo === 'frente' ? { [arriba]: 2, [abajo]: 3 } : { [arriba]: 1, [abajo]: 2 };
  const pasillos = tipoPasillo === 'central' ? [['central', 2, 'Pasillo']]
    : tipoPasillo === 'frente' ? [[arriba, 1, `Pasillo frente ${arriba}`], [abajo, 4, `Pasillo frente ${abajo}`]] : [];
  const filaArriba = Math.min(FILA.A, FILA.B), filaAbajo = Math.max(FILA.A, FILA.B);
  rejilla.innerHTML = `<div class="hab-frente-etq" style="grid-row:${FILA.A};grid-column:1" title="Frente A">A</div>
    <div class="hab-frente-etq" style="grid-row:${FILA.B};grid-column:1" title="Frente B">B</div>`;
  let col = 2;
  const suma = (l) => l.reduce((a, x) => a + x.ancho, 0);

  tramos.forEach((t) => {
    if (t.tipo === 'ab') {
      columnas.push(`minmax(min-content, ${t.esp.ancho}fr)`);
      const el = espacioHtml(t.esp);
      el.classList.add('hab-esp--ab');
      el.style.gridRow = `${filaArriba} / ${filaAbajo + 1}`;
      el.style.gridColumn = String(col++);
      rejilla.appendChild(el);
      return;
    }
    columnas.push(`minmax(min-content, ${Math.max(suma(t.A), suma(t.B), 1)}fr)`);
    [arriba, abajo].forEach((f) => {
      const celda = document.createElement('div');
      celda.className = 'hab-celda';
      celda.style.gridRow = String(FILA[f]);
      celda.style.gridColumn = String(col);
      if (t[f].length) t[f].forEach((x) => celda.appendChild(espacioHtml(x)));
      else celda.innerHTML = '<div class="hab-hueco" aria-hidden="true"></div>';
      rejilla.appendChild(celda);
    });
    col++;
  });

  if (S.editando) {
    columnas.push('auto');
    [arriba, abajo].forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'hab-agregar-esp';
      b.textContent = '+ Espacio';
      b.style.gridRow = String(FILA[f]);
      b.style.gridColumn = String(col);
      b.setAttribute('aria-label', `Agregar espacio en ${nombrePlanta(planta, edif.num_plantas)} frente ${f}`);
      b.addEventListener('click', () => modalEspacio(null, { edif, planta, frente: f }));
      rejilla.appendChild(b);
    });
  }
  rejilla.style.gridTemplateColumns = columnas.join(' ');
  pasillos.forEach(([clave, fila, texto]) => {
    const band = pasilloHtml(clave, texto);
    band.style.gridRow = String(fila);
    band.style.gridColumn = `2 / ${col + (S.editando ? 1 : 0)}`;
    rejilla.appendChild(band);
  });
  scroll.appendChild(rejilla);
  return scroll;
}

function filaHtml(edif, planta, frente) {
  const fila = document.createElement('div');
  fila.className = 'hab-fila';
  const espacios = filaDe(edif.id, planta, frente);

  if (espacios.length === 0 && !S.editando) {
    fila.innerHTML = `<div class="hab-fila-vacia">Sin espacios registrados${S.estructura ? '. Use «Editar plantas y espacios» para agregarlos.' : '.'}</div>`;
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
  d.dataset.esp = esp.id;
  d.style.setProperty('--ancho', esp.ancho);
  const seleccionado = S.editando && S.selEspacio === esp.id;

  if (esp.tipo === 'sin_construir') {
    d.className = 'hab-esp hab-esp--abierto' + (seleccionado ? ' hab-esp--sel' : '');
    d.innerHTML = `<span>${esc(esp.nombre)}</span>`;
  } else if (esp.tipo !== 'habitacion') {
    d.className = 'hab-esp hab-esp--otro' + (seleccionado ? ' hab-esp--sel' : '');
    d.innerHTML = `${svgIcono(esp.tipo)}<span>${esc(esp.nombre)}</span>${esp.frente === 'AB' ? '<span class="hab-ab">Frentes A y B</span>' : ''}`;
  } else {
    const camas = camasDe(esp.id);
    const ocup = camas.filter((c) => asigDeCama(c.id)).length;
    const tenue = S.soloLibres && !S.editando && (camas.length === 0 || ocup === camas.length);
    d.className = 'hab-esp' + (tenue ? ' hab-esp--tenue' : '') + (seleccionado ? ' hab-esp--sel' : '');
    d.innerHTML = `<div class="hab-esp-cabeza"><b>Hab. ${esc(esp.nombre)}</b>
      <span>${esp.frente === 'AB' ? 'A y B · ' : ''}${camas.length ? `${ocup}/${camas.length}` : ''}</span></div>`;
    const $camas = document.createElement('div');
    $camas.className = 'hab-camas';
    if (camas.length === 0) {
      $camas.innerHTML = `<div class="hab-sin-camas">Sin camas${S.estructura ? '. Agréguelas en modo edición.' : ''}</div>`;
    }
    const vistos = new Set();
    camas.forEach((cama) => {
      if (cama.tipo === 'litera') {
        if (vistos.has(cama.numero)) return;
        vistos.add(cama.numero);
        const niveles = camas.filter((x) => x.tipo === 'litera' && x.numero === cama.numero);
        const grupo = document.createElement('div');
        grupo.className = 'hab-litera';
        grupo.innerHTML = `<div class="hab-litera-nombre" title="Litera ${cama.numero}">${svgLiteraIcono()} ${S.detalle ? 'Litera ' : 'L'}${cama.numero}</div>`;
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

/** Vista panorámica: casilla pequeña con el código; el detalle
    va en la descripción emergente y al tocarla. */
function camaMini(cama) {
  const est = estadoCama(cama);
  const a = asigDeCama(cama.id);
  const t = a && S.trab.get(a.trabajador_id);
  const u = ubicar(cama);
  const etiqueta = cama.tipo === 'litera' ? (cama.nivel === 'superior' ? 'Sup' : 'Inf') : `C${cama.numero}`;
  const texto = a
    ? `${u?.codigo} · #${t?.codigo ?? '—'} ${t?.nombre_completo || ''}${t?.cargo ? ' · ' + t.cargo : ''}${t?.edad != null ? ' · ' + t.edad + ' años' : ''}${est === 'salio' ? ' · ya no labora' : ''}${cama.colchon_por_cambiar ? ' · colchón por cambiar' : ''}`
    : `${u?.codigo} · libre${cama.colchon_tipo ? ' · colchón ' + COLCHONES[cama.colchon_tipo].toLowerCase() : ''}${cama.colchon_por_cambiar ? ' · colchón por cambiar' : ''}`;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `hab-cama hab-cama--mini hab-cama--${est}`;
  b.dataset.cama = cama.id;
  b.title = texto;
  b.setAttribute('aria-label', texto);
  b.innerHTML = `${svgCama(!!a)}<span>${etiqueta}</span>${a && t?.codigo != null ? `<span class="hab-mini-cod">#${esc(t.codigo)}</span>` : ''}`;
  b.addEventListener('click', (e) => {
    if (S.editando || S.segEdit) return;
    e.stopPropagation();
    abrirCama(cama);
  });
  return b;
}

function camaHtml(cama) {
  if (!S.detalle) return camaMini(cama);
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
    b.setAttribute('aria-label', `${u?.codigo}: libre${S.asigna ? ', toque para asignar' : ''}`);
    b.innerHTML = `${svgCama(false)}
      <span class="hab-cama-fila"><span>${etiqueta}</span><span>Libre</span></span>
      <span class="hab-cama-linea" title="Colchón">${cama.colchon_tipo ? COLCHONES[cama.colchon_tipo] : 'Sin colchón'}</span>
      ${est === 'cambio' ? '<span class="hab-cama-cargo"><b>Colchón por cambiar</b></span>' : ''}`;
  }

  b.addEventListener('click', (e) => {
    if (S.editando || S.segEdit) return; // en edición el clic selecciona el espacio o coloca
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
    <div class="campo" id="he-orden-campo"><label class="etiqueta" for="he-orden">Orden de los frentes en el plano</label>
      <select class="entrada" id="he-orden">
        <option value="0" ${edif?.frentes_invertidos ? '' : 'selected'}>A arriba y B abajo</option>
        <option value="1" ${edif?.frentes_invertidos ? 'selected' : ''}>B arriba y A abajo</option>
      </select></div>
    <div class="campo"><label class="etiqueta" for="he-pasillo">Pasillo</label>
      <select class="entrada" id="he-pasillo"></select>
      <span class="ayuda">Se dibuja en el plano de cada planta; ahí se pueden ubicar extintores, luces y señalética.</span></div>
    <span class="ayuda">Luego, con «Editar plantas y espacios», agrega en cada planta sus habitaciones, comedor, bodegas, garita, etc.</span>
  </div>`;
  const $fr = m.cuerpo.querySelector('#he-frentes');
  const $pa = m.cuerpo.querySelector('#he-pasillo');
  const opcionesPasillo = () => {
    const conFrentes = $fr.checked;
    const claves = conFrentes ? ['central', 'frente', 'ninguno'] : ['lado', 'ninguno'];
    const actual = pasilloDe({ tiene_frentes: conFrentes, pasillo: $pa.value || edif?.pasillo });
    $pa.innerHTML = claves.map((k) => `<option value="${k}" ${k === actual ? 'selected' : ''}>${PASILLOS[k]}</option>`).join('');
  };
  const ordenCampo = () => { m.cuerpo.querySelector('#he-orden-campo').hidden = !$fr.checked; };
  $fr.addEventListener('change', () => { opcionesPasillo(); ordenCampo(); });
  opcionesPasillo();
  ordenCampo();
  /* La columna existe solo si se ejecutó habitaciones_frentes.sql
     (o la versión nueva de habitaciones_etapa3.sql). */
  const hayOrden = S.edificios.length === 0 || S.edificios.some((x) => 'frentes_invertidos' in x);
  if (!hayOrden) m.cuerpo.querySelector('#he-orden-campo').remove();
  const extraOrden = () => (hayOrden && m.cuerpo.querySelector('#he-orden')
    ? { frentes_invertidos: m.cuerpo.querySelector('#he-orden').value === '1' } : {});

  const guardar = (b) => conBoton(b, async () => {
    const nombre = valor(m, 'he-nombre');
    const codigo = valor(m, 'he-codigo').toUpperCase();
    const plantas = parseInt(valor(m, 'he-plantas'), 10);
    const frentes = m.cuerpo.querySelector('#he-frentes').checked;
    if (!nombre) return m.error('Escriba el nombre del edificio.');
    if (!/^[A-Z0-9]{1,6}$/.test(codigo)) return m.error('El código debe tener de 1 a 6 letras o números, sin espacios.');

    if (nuevo) {
      const { data, error } = await S.sb.from('viv_edificios').insert(alCrear({
        empresa_id: S.empresaId, base_id: S.nav.baseId, nombre, codigo, num_plantas: plantas, tiene_frentes: frentes,
        ...(S.seguridadFalta ? {} : { pasillo: valor(m, 'he-pasillo') }), ...extraOrden()
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
      const { error } = await S.sb.from('viv_espacios').update(alEditar({ frente: null })).eq('edificio_id', edif.id).in('frente', ['A', 'AB']);
      if (error) return m.error(mensajeError(error));
    }
    if (!edif.tiene_frentes && frentes) {
      const { error } = await S.sb.from('viv_espacios').update(alEditar({ frente: 'A' })).eq('edificio_id', edif.id).is('frente', null);
      if (error) return m.error(mensajeError(error));
    }
    const { error } = await S.sb.from('viv_edificios')
      .update(alEditar({ nombre, codigo, num_plantas: plantas, tiene_frentes: frentes,
        ...(S.seguridadFalta ? {} : { pasillo: valor(m, 'he-pasillo') }), ...extraOrden() })).eq('id', edif.id);
    if (error) return m.error(mensajeError(error));
    m.cerrar();
    toast('Edificio actualizado');
    await recargar();
  });

  const botones = [['Cancelar', 'boton-secundario', () => m.cerrar()]];
  if (!nuevo) botones.push(['Eliminar edificio', 'boton-secundario boton-critico', (b) => eliminarEdificio(m, edif, b)]);
  if (!nuevo && edif.tiene_frentes) botones.push(['Intercambiar letras A ↔ B', 'boton-secundario', (b) => intercambiarFrentes(m, edif, b)]);
  botones.push([nuevo ? 'Crear edificio' : 'Guardar', 'boton-primario', guardar]);
  m.botones(botones);
  m.enfocar();
}

/** Lo que era frente A pasa a llamarse B y viceversa, sin
    mover nada de lugar en el plano (función viv_intercambiar_frentes). */
async function intercambiarFrentes(m, edif, boton) {
  if (boton.dataset.confirmar !== '1') {
    boton.dataset.confirmar = '1';
    boton.textContent = 'Confirmar intercambio';
    const ejemplo = camasDeEdificio(edif.id).map((c) => ubicar(c)).find((u) => u?.esp.frente === 'A' || u?.esp.frente === 'B');
    m.error(null);
    m.cuerpo.insertAdjacentHTML('afterbegin', `<div class="hab-nota" id="he-aviso-letras">
      Lo que hoy es frente A pasará a llamarse B y viceversa. Nada se mueve de lugar en el plano, pero
      <strong>cambian los códigos de las camas</strong>${ejemplo ? ` (por ejemplo, ${esc(ejemplo.codigo)} pasará a ${esc(ejemplo.codigo.replace(/-(A|B)-/, (x, l) => `-${l === 'A' ? 'B' : 'A'}-`))})` : ''}.
      Las personas siguen en sus mismas camas. Pulse «Confirmar intercambio» para continuar.</div>`);
    return;
  }
  await conBoton(boton, async () => {
    const { error } = await S.sb.rpc('viv_intercambiar_frentes', { p_edificio: edif.id, p_autor: S.perfil?.id ?? null });
    if (error) {
      return m.error(faltaSql(error)
        ? 'Para esta opción, el administrador debe ejecutar de nuevo sql/habitaciones_frentes.sql en Supabase.'
        : mensajeError(error));
    }
    m.cerrar();
    toast('Letras de los frentes intercambiadas');
    await recargar();
  });
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
  const [puedeIzq, puedeDer] = limitesMover(sel);
  const btn = (h, texto, extra = '', des = false) =>
    `<button class="boton-secundario boton-compacto ${extra}" type="button" data-h="${h}" ${des ? 'disabled' : ''}>${texto}</button>`;
  return `<div class="hab-herramientas" role="toolbar" aria-label="Editar ${esc(sel.nombre)}">
    <span class="hab-herramientas-nombre">${hab ? 'Habitación ' : ''}${esc(sel.nombre)} · ${TAMANOS[sel.ancho]}</span>
    ${btn('izq', '← Mover', '', !puedeIzq)}
    ${btn('der', 'Mover →', '', !puedeDer)}
    ${btn('menos', '− Angosto', '', sel.ancho <= 1)}
    ${btn('mas', '+ Ancho', '', sel.ancho >= ANCHO_MAX)}
    ${hab ? btn('cama', '+ Cama o litera') : ''}
    ${hab ? btn('quitar-cama', '− Cama o litera', '', camasDe(sel.id).length === 0) : ''}
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
  h('quitar-cama')?.addEventListener('click', () => modalQuitarCamas(sel));
  h('editar')?.addEventListener('click', () => {
    const edif = porId(S.edificios, sel.edificio_id);
    modalEspacio(sel, { edif, planta: sel.planta, frente: sel.frente });
  });
  h('quitar')?.addEventListener('click', () => modalQuitarEspacio(sel));
}

function limitesMover(esp) {
  if (esp.frente === 'AB') {
    const todos = espaciosDe(esp.edificio_id).filter((x) => x.planta === esp.planta).sort(porOrden);
    const i = todos.indexOf(esp);
    return [i > 0, i < todos.length - 1];
  }
  const fila = filaDe(esp.edificio_id, esp.planta, esp.frente);
  const i = fila.findIndex((x) => x.id === esp.id);
  return [i > 0, i < fila.length - 1];
}

/* Con frentes: un espacio de un frente cruza por delante del
   baño de ambos frentes; el baño se mueve una columna entera
   (el espacio vecino de cada frente pasa al otro lado). */
async function moverEnFrentes(esp, dir) {
  const todos = espaciosDe(esp.edificio_id).filter((x) => x.planta === esp.planta).sort(porOrden);
  const nuevo = new Map(todos.map((x, k) => [x, (k + 1) * 10]));
  const o = (x) => nuevo.get(x);

  if (esp.frente !== 'AB') {
    const fila = todos.filter((x) => x.frente === esp.frente || x.frente === 'AB');
    const j = fila.indexOf(esp) + dir;
    if (j < 0 || j >= fila.length) return;
    const vecino = fila[j];
    if (vecino.frente === 'AB') nuevo.set(esp, o(vecino) + dir * 5);
    else { const t = o(esp); nuevo.set(esp, o(vecino)); nuevo.set(vecino, t); }
  } else {
    const i = todos.indexOf(esp);
    const tramo = [];
    for (let k = i + dir; k >= 0 && k < todos.length && todos[k].frente !== 'AB'; k += dir) tramo.push(todos[k]);
    if (tramo.length === 0) {
      const otro = todos[i + dir];
      if (!otro) return;
      const t = o(esp); nuevo.set(esp, o(otro)); nuevo.set(otro, t);
    } else {
      // el más cercano de cada frente pasa al otro lado
      ['A', 'B'].forEach((f, n) => {
        const x = tramo.find((y) => y.frente === f);
        if (x) nuevo.set(x, o(esp) + (dir < 0 ? n + 1 : -(2 - n)));
      });
    }
  }

  const cambios = todos.filter((x) => o(x) !== x.orden);
  const res = await Promise.all(cambios.map((x) =>
    S.sb.from('viv_espacios').update(alEditar({ orden: o(x) })).eq('id', x.id)));
  const fallo = res.find((r) => r.error);
  if (fallo) { toast(mensajeError(fallo.error)); await recargar(); return; }
  cambios.forEach((x) => { x.orden = o(x); });
  pintar();
}

async function moverEspacio(esp, dir) {
  if (porId(S.edificios, esp.edificio_id)?.tiene_frentes) return moverEnFrentes(esp, dir);
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
  if (tipo === 'banos') return `Baño ${iguales + 1}`;
  if (tipo === 'sin_construir') return 'Sin construcción';
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
    ${edif.tiene_frentes ? `<div class="hab-opciones">
      <label><input type="checkbox" id="hs-ab" ${esp?.frente === 'AB' ? 'checked' : ''}>
        Ocupa ambos frentes (A y B)</label>
      <span class="ayuda">Para un espacio que atraviesa el edificio, como un baño que da a los dos lados. Se registra una sola vez y se ve en las dos filas.</span>
    </div>` : ''}
    ${nuevo && edif.num_plantas > 1 ? `<div class="hab-opciones" id="hs-todas-bloque" hidden>
      <label><input type="checkbox" id="hs-todas" checked>
        Agregar también en las demás plantas${frente ? ` (frente ${frente})` : ''}</label>
      <span class="ayuda">Quedan al final de cada fila. Luego muévalas con «← Mover» para alinearlas con las de esta planta.</span>
    </div>` : ''}
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
    const $todas = m.cuerpo.querySelector('#hs-todas-bloque');
    if ($todas) $todas.hidden = t !== 'escaleras';
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

    const ambos = !!m.cuerpo.querySelector('#hs-ab')?.checked;
    if (nuevo) {
      const fila = ambos
        ? espaciosDe(edif.id).filter((x) => x.planta === planta)
        : filaDe(edif.id, planta, frente);
      const orden = (fila.length ? Math.max(...fila.map((x) => x.orden)) : 0) + 10;
      const { data, error } = await S.sb.from('viv_espacios').insert(alCrear({
        empresa_id: S.empresaId, edificio_id: edif.id, planta, frente: ambos ? 'AB' : (frente || null),
        orden, ancho: ANCHO_INICIAL[tipo], tipo, nombre
      })).select().single();
      if (error) return m.error(mensajeError(error));

      /* Escaleras: también en las demás plantas, mismo frente. */
      if (tipo === 'escaleras' && m.cuerpo.querySelector('#hs-todas')?.checked) {
        const otras = [];
        for (let p = 1; p <= edif.num_plantas; p++) {
          if (p === planta) continue;
          const filaP = filaDe(edif.id, p, ambos ? 'A' : frente);
          otras.push(alCrear({
            empresa_id: S.empresaId, edificio_id: edif.id, planta: p, frente: ambos ? 'AB' : (frente || null),
            orden: (filaP.length ? Math.max(...filaP.map((x) => x.orden)) : 0) + 10,
            ancho: ANCHO_INICIAL.escaleras, tipo, nombre
          }));
        }
        if (otras.length) {
          const r = await S.sb.from('viv_espacios').insert(otras);
          if (r.error) { m.error(mensajeError(r.error)); await recargar(); return; }
        }
      }

      const n = tipo === 'habitacion' ? parseInt(valor(m, 'hs-camas'), 10) || 0 : 0;
      if (n > 0) {
        const colchon = valor(m, 'hs-colchon') || null;
        const f = valor(m, 'hs-fecha') || hoy();
        const err = await crearCamas(data, Array.from({ length: n }, (_, k) => ({ tipo: 'cama', numero: k + 1, nivel: 'unico' })), colchon, f);
        if (err) { m.error(err); await recargar(); return; }
      }
      m.cerrar();
      toast(tipo === 'habitacion' ? `Habitación ${nombre} agregada` : `${nombre} agregado`);
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
    const cambios = { tipo, nombre };
    if (edif.tiene_frentes) {
      if (ambos && esp.frente !== 'AB') cambios.frente = 'AB';
      if (!ambos && esp.frente === 'AB') cambios.frente = 'A';
    }
    const { error } = await S.sb.from('viv_espacios').update(alEditar(cambios)).eq('id', esp.id);
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
    if (!pantallas[p]) return 'detalle';
    if (['asignar', 'liberar', 'colchon'].includes(p) && !S.asigna) return 'detalle';
    if (p === 'quitar' && !S.estructura) return 'detalle';
    return p;
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
      </table>
      ${a && S.estructura ? `<p class="ayuda">${S.asigna
        ? 'Para quitar esta cama de la habitación, primero libérela.'
        : 'Para quitar esta cama, Trabajo Social debe liberarla primero.'}</p>` : ''}`;

    const b = [['Historial', 'boton-secundario', () => ir('historial')]];
    if (S.estructura && !a) b.push(['Quitar cama', 'boton-secundario boton-critico', () => ir('quitar')]);
    if (S.asigna) {
      b.push([cama.colchon_por_cambiar ? 'Quitar «por cambiar»' : 'Marcar por cambiar', 'boton-secundario', (btn) => conBoton(btn, async () => {
        const { error } = await S.sb.from('viv_camas').update(alEditar({ colchon_por_cambiar: !cama.colchon_por_cambiar })).eq('id', cama.id);
        if (error) return m.error(mensajeError(error));
        cama.colchon_por_cambiar = !cama.colchon_por_cambiar;
        pintar();
        detalle();
      })]);
      b.push(['Cambiar colchón', 'boton-secundario', () => ir('colchon')]);
      if (a) b.push(['Liberar cama', 'boton-secundario boton-critico', () => ir('liberar')]);
      else b.push(['Asignar trabajador', 'boton-primario', () => ir('asignar')]);
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
    const hermanas = piezasDe(cama);
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
        const error = await retirarCama(cama);
        if (error) return m.error(error);
        m.cerrar();
        toast(cama.tipo === 'litera' ? `Litera ${cama.numero} quitada` : `Cama ${cama.numero} quitada`);
        await recargar();
      })]
    ]);
  }
}

/* ---------- Quitar camas ---------- */

/** Una cama suelta, o los dos niveles de una litera. */
function piezasDe(cama) {
  return cama.tipo === 'litera'
    ? S.camas.filter((x) => x.espacio_id === cama.espacio_id && x.tipo === 'litera' && x.numero === cama.numero)
    : [cama];
}

/** Marca como retirada la cama (o la litera completa). El
    historial se conserva y el número no se reutiliza. */
async function retirarCama(cama) {
  const piezas = piezasDe(cama);
  if (piezas.some((x) => asigDeCama(x.id))) return 'Está ocupada. Libérela primero.';
  const { error } = await S.sb.from('viv_camas')
    .update(alEditar({ activo: false, retirada_en: hoy() })).in('id', piezas.map((x) => x.id));
  return error ? mensajeError(error) : null;
}

/** Desde el modo edición: elegir qué cama o litera quitar. */
function modalQuitarCamas(esp) {
  const m = modal(`Quitar cama de la habitación ${esp.nombre}`);
  const pintarLista = () => {
    const camas = camasDe(esp.id);
    const vistas = new Set();
    const grupos = camas.filter((c) => {
      if (c.tipo !== 'litera') return true;
      if (vistas.has(c.numero)) return false;
      vistas.add(c.numero);
      return true;
    });
    if (grupos.length === 0) {
      m.cuerpo.innerHTML = '<p class="ayuda">Esta habitación ya no tiene camas.</p>';
      m.botones([['Cerrar', 'boton-primario', () => m.cerrar()]]);
      return;
    }
    m.cuerpo.innerHTML = `<p class="ayuda">Solo se pueden quitar camas libres${S.asigna ? '' : ' (las ocupadas las libera Trabajo Social)'}. Los códigos de las demás no cambian y el historial se conserva.</p>
      <div class="hab-filas-lista" id="hqc-lista"></div>`;
    const $l = m.cuerpo.querySelector('#hqc-lista');
    grupos.forEach((c) => {
      const piezas = piezasDe(c);
      const ocupadas = piezas.filter((x) => asigDeCama(x.id));
      const nombre = c.tipo === 'litera' ? `Litera ${c.numero} (inferior y superior)` : `Cama ${c.numero}`;
      const quien = ocupadas.map((x) => {
        const t = S.trab.get(asigDeCama(x.id).trabajador_id);
        return `${x.tipo === 'litera' ? `${x.nivel}: ` : ''}#${t?.codigo ?? '—'} ${t?.nombre_completo || ''}`;
      }).join(' · ');
      const fila = document.createElement('div');
      fila.innerHTML = `<span><b>${esc(nombre)}</b><br><span class="ayuda">${ocupadas.length
        ? `Ocupada · ${esc(quien)}` : `Libre · colchón ${esc(COLCHONES[c.colchon_tipo]?.toLowerCase() || 'sin registrar')}`}</span></span>
        ${ocupadas.length
          ? `<button class="boton-secundario boton-compacto" type="button" data-a="ver">${S.asigna ? 'Liberar primero' : 'Ver cama'}</button>`
          : '<button class="boton-secundario boton-compacto boton-critico" type="button" data-a="quitar">Quitar</button>'}`;
      fila.querySelector('[data-a="ver"]')?.addEventListener('click', () => abrirCama(ocupadas[0]));
      fila.querySelector('[data-a="quitar"]')?.addEventListener('click', (e) => conBoton(e.currentTarget, async () => {
        const error = await retirarCama(c);
        if (error) return m.error(error);
        toast(`${c.tipo === 'litera' ? `Litera ${c.numero}` : `Cama ${c.numero}`} quitada`);
        await recargar();
        pintarLista();
      }));
      $l.appendChild(fila);
    });
    m.botones([['Listo', 'boton-primario', () => m.cerrar()]]);
  };
  pintarLista();
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
        ${S.asigna ? '<button class="boton-secundario boton-compacto boton-critico" type="button" data-a="liberar">Liberar</button>' : ''}
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

/* ============================================
   CROQUIS DE LA BASE (etapa 2)
   Plano visto desde arriba, en una cuadrícula de 40 × 25.
   - Normal: se toca un edificio para entrar.
   - Edición (admin y trabajo social): se arrastra para mover,
     la esquina para cambiar el tamaño; nada se guarda hasta
     pulsar «Guardar croquis».
   ============================================ */

const CQ_COLS = 40;
const CQ_FILAS = 25;
const TIPOS_CROQUIS = {
  cancha: 'Cancha',
  estacionamiento: 'Estacionamiento',
  punto_encuentro: 'Punto de encuentro',
  comedor: 'Comedor',
  garita: 'Garita',
  entrada: 'Entrada',
  area_verde: 'Área verde',
  gimnasio: 'Gimnasio',
  tanque_agua: 'Tanque de agua',
  otro: 'Otro'
};
const TAM_CROQUIS = {
  edificio: [8, 4], cancha: [8, 5], estacionamiento: [7, 4], punto_encuentro: [3, 3],
  comedor: [6, 4], garita: [2, 2], entrada: [3, 2], area_verde: [6, 4], gimnasio: [5, 3],
  tanque_agua: [2, 2], otro: [4, 3]
};
const ICONOS_CQ = {
  cancha: 'M3 5h18v14H3zM12 5v14M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0',
  estacionamiento: 'M4 3h16v18H4zM9 17V7h4a3 3 0 0 1 0 6H9',
  punto_encuentro: 'M12 3v5M12 16v5M3 12h5M16 12h5M12 8l-2 2M12 8l2 2M12 16l-2-2M12 16l2-2M8 12l2-2M8 12l2 2M16 12l-2-2M16 12l-2 2',
  comedor: ICONOS.comedor,
  garita: ICONOS.garita,
  entrada: 'M10 3h9v18h-9M3 12h11M10 8l4 4-4 4',
  area_verde: 'M12 21v-6M7 15a5 5 0 1 1 10 0zM9 9a3 3 0 1 1 6 0',
  gimnasio: 'M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10',
  tanque_agua: 'M6 5c0-1.5 12-1.5 12 0v14c0 1.5-12 1.5-12 0zM6 5c0 1.5 12 1.5 12 0',
  otro: ICONOS.otro
};
function svgIconoCq(tipo) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONOS_CQ[tipo] || ICONOS.otro}"/></svg>`;
}

const claveCq = (x) => x.id || x.tmp;
let tmpSeq = 0;

/** Elementos del croquis de una base. Los edificios que aún no
    tienen lugar se acomodan solos en filas (sin guardar). */
function elementosCroquis(base) {
  const eds = edificiosDe(base.id);
  const idsEds = new Set(eds.map((e) => e.id));
  const lista = S.croquis
    .filter((c) => c.base_id === base.id && (c.tipo !== 'edificio' || idsEds.has(c.edificio_id)))
    .map((c) => ({ ...c }));
  let x = 1, y = 1;
  eds.forEach((e) => {
    if (lista.some((c) => c.edificio_id === e.id)) return;
    const [w, h] = TAM_CROQUIS.edificio;
    while (lista.some((c) => choca({ x, y, w, h }, c))) {
      x += w + 1;
      if (x + w > CQ_COLS) { x = 1; y += h + 1; }
      if (y + h > CQ_FILAS) { y = CQ_FILAS - h; break; }
    }
    lista.push({ tmp: `t${++tmpSeq}`, tipo: 'edificio', edificio_id: e.id, nombre: e.nombre, x, y, w, h, nuevo: true });
    x += w + 1;
    if (x + w > CQ_COLS) { x = 1; y += h + 1; }
  });
  return lista;
}

function choca(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function vistaCroquis($g, base) {
  $g.className = 'hab-cq-zona';
  if (S.croquisFalta) {
    $g.innerHTML = `<div class="hab-vacio"><strong>El croquis necesita preparar la base de datos.</strong><br>
      El administrador debe ejecutar una vez <code>sql/habitaciones_etapa2.sql</code> en Supabase.
      Mientras tanto puede usar la vista «Edificios».</div>`;
    return;
  }
  if (!S.cq || S.cq.baseId !== base.id) S.cq = null;
  const editando = !!S.cq;
  const elems = editando ? S.cq.elems : elementosCroquis(base);

  if (elems.length === 0) {
    $g.innerHTML = `<div class="hab-vacio">Esta base aún no tiene edificios.<br>${S.estructura ? 'Cree el primero con «+ Nuevo edificio» y luego ubíquelo en el croquis.' : QUIEN_ESTRUCTURA}</div>`;
    return;
  }

  $g.innerHTML = `
    ${editando ? herramientasCroquisHtml() : (S.estructura ? `<div class="hab-cabeza">
      <span class="ayuda">Toque un edificio para entrar a sus habitaciones.</span>
      <button class="boton-secundario" id="cq-editar" type="button">Editar croquis</button></div>`
      : '<span class="ayuda">Toque un edificio para entrar a sus habitaciones.</span>')}
    <div class="hab-cq-marco">
      <div class="hab-cq ${editando ? 'hab-cq--editando' : ''}" id="hab-cq" role="${editando ? 'application' : 'group'}"
        aria-label="Croquis de ${esc(base.nombre)}"></div>
    </div>`;

  document.getElementById('cq-editar')?.addEventListener('click', () => {
    S.cq = { baseId: base.id, elems: elementosCroquis(base), sel: null, quitados: [] };
    pintar();
  });

  const $cq = document.getElementById('hab-cq');
  elems.forEach((el) => $cq.appendChild(elementoCq(el, editando, $cq)));
  if (editando) conectarHerramientasCroquis(base);
}

function posicionar(d, el) {
  d.style.left = `${el.x / CQ_COLS * 100}%`;
  d.style.top = `${el.y / CQ_FILAS * 100}%`;
  d.style.width = `${el.w / CQ_COLS * 100}%`;
  d.style.height = `${el.h / CQ_FILAS * 100}%`;
}

function elementoCq(el, editando, $cq) {
  const d = document.createElement('div');
  d.className = `hab-cq-el hab-cq-el--${el.tipo}`;
  d.dataset.clave = claveCq(el);
  posicionar(d, el);

  if (el.tipo === 'edificio') {
    const edif = porId(S.edificios, el.edificio_id);
    const c = conteo(camasDeEdificio(el.edificio_id));
    const tono = c.total === 0 ? '' : c.libres === 0 ? 'lleno' : c.libres / c.total < 0.15 ? 'pocas' : 'hay';
    d.innerHTML = `${edif ? `<span class="hab-cq-fachada" aria-hidden="true">${svgFachada(edif)}</span>` : ''}
      <span class="hab-cq-pie"><span class="hab-cq-nombre">${esc(edif?.nombre || el.nombre)}</span>
      ${c.total ? `<span class="hab-cq-libres hab-cq-libres--${tono}">${c.libres === 0 ? 'Lleno' : `${c.libres} libres`}</span>` : ''}</span>`;
    d.setAttribute('aria-label', `${edif?.nombre}: ${c.total ? `${c.libres} camas libres de ${c.total}` : 'sin camas'}`);
  } else {
    d.innerHTML = `${el.tipo === 'cancha' ? '<span class="hab-cq-lineas" aria-hidden="true"></span>' : ''}
      ${svgIconoCq(el.tipo)}<span class="hab-cq-nombre">${esc(el.nombre)}</span>`;
    d.setAttribute('aria-label', el.nombre);
  }

  if (!editando) {
    if (el.tipo === 'edificio') {
      d.setAttribute('role', 'button');
      d.tabIndex = 0;
      const entrar = () => {
        const base = porId(S.bases, S.nav.baseId);
        ir({ sucursalId: base.sucursal_id, baseId: base.id, edificioId: el.edificio_id });
      };
      d.addEventListener('click', entrar);
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); entrar(); } });
    }
    return d;
  }

  /* ----- Edición: seleccionar, arrastrar, cambiar tamaño ----- */
  d.tabIndex = 0;
  d.setAttribute('role', 'button');
  d.setAttribute('aria-pressed', String(S.cq.sel === claveCq(el)));
  if (S.cq.sel === claveCq(el)) d.classList.add('hab-cq-el--sel');
  d.insertAdjacentHTML('beforeend', '<span class="hab-cq-asa" aria-hidden="true"></span>');

  let modo = null, ix, iy, ox, oy, ow, oh;
  d.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    modo = e.target.classList.contains('hab-cq-asa') ? 'tam' : 'mover';
    ix = e.clientX; iy = e.clientY; ox = el.x; oy = el.y; ow = el.w; oh = el.h;
    d.setPointerCapture(e.pointerId);
    if (S.cq.sel !== claveCq(el)) seleccionarCq(claveCq(el));
  });
  d.addEventListener('pointermove', (e) => {
    if (!modo) return;
    const r = $cq.getBoundingClientRect();
    const dx = Math.round((e.clientX - ix) / r.width * CQ_COLS);
    const dy = Math.round((e.clientY - iy) / r.height * CQ_FILAS);
    if (modo === 'mover') {
      el.x = Math.max(0, Math.min(CQ_COLS - el.w, ox + dx));
      el.y = Math.max(0, Math.min(CQ_FILAS - el.h, oy + dy));
    } else {
      el.w = Math.max(1, Math.min(CQ_COLS - el.x, ow + dx));
      el.h = Math.max(1, Math.min(CQ_FILAS - el.y, oh + dy));
    }
    posicionar(d, el);
  });
  const soltar = () => { if (modo) { modo = null; S.cq.cambios = true; } };
  d.addEventListener('pointerup', soltar);
  d.addEventListener('pointercancel', soltar);

  /* Teclado: flechas mueven, Mayús + flechas cambian el tamaño. */
  d.addEventListener('keydown', (e) => {
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!k) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); seleccionarCq(claveCq(el)); } return; }
    e.preventDefault();
    if (e.shiftKey) {
      el.w = Math.max(1, Math.min(CQ_COLS - el.x, el.w + k[0]));
      el.h = Math.max(1, Math.min(CQ_FILAS - el.y, el.h + k[1]));
    } else {
      el.x = Math.max(0, Math.min(CQ_COLS - el.w, el.x + k[0]));
      el.y = Math.max(0, Math.min(CQ_FILAS - el.h, el.y + k[1]));
    }
    S.cq.cambios = true;
    posicionar(d, el);
  });
  return d;
}

function seleccionarCq(clave) {
  S.cq.sel = clave;
  document.querySelectorAll('.hab-cq-el').forEach((x) => {
    const si = x.dataset.clave === clave;
    x.classList.toggle('hab-cq-el--sel', si);
    x.setAttribute('aria-pressed', String(si));
  });
  const $h = document.getElementById('cq-herr-sel');
  if ($h) { $h.outerHTML = herramientasSelHtml(); conectarHerramientasSel(); }
}

function herramientasCroquisHtml() {
  return `<div class="hab-herramientas" role="toolbar" aria-label="Edición del croquis">
    <label class="etiqueta" for="cq-tipo" style="margin:0">Agregar</label>
    <select class="entrada" id="cq-tipo" style="width:auto">
      ${Object.entries(TIPOS_CROQUIS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
    </select>
    <button class="boton-secundario boton-compacto" id="cq-agregar" type="button">+ Agregar</button>
    ${herramientasSelHtml()}
    <span style="flex:1 1 auto"></span>
    <button class="boton-secundario boton-compacto" id="cq-cancelar" type="button">Cancelar</button>
    <button class="boton-primario boton-compacto" id="cq-guardar" type="button">Guardar croquis</button>
  </div>
  <p class="ayuda">Arrastre para mover · arrastre la esquina inferior derecha para cambiar el tamaño · con el teclado: flechas para mover, Mayús + flechas para el tamaño.</p>`;
}

function herramientasSelHtml() {
  const el = S.cq?.elems.find((x) => claveCq(x) === S.cq.sel);
  if (!el) return '<span id="cq-herr-sel" class="ayuda">Toque un elemento para girarlo, renombrarlo o quitarlo.</span>';
  const esEdif = el.tipo === 'edificio';
  return `<span id="cq-herr-sel" style="display:inline-flex;gap:.4rem;flex-wrap:wrap;align-items:center">
    <b style="color:var(--color-acento-oscuro)">${esc(esEdif ? porId(S.edificios, el.edificio_id)?.nombre : el.nombre)}</b>
    <button class="boton-secundario boton-compacto" id="cq-girar" type="button">Girar</button>
    ${esEdif ? '' : `<button class="boton-secundario boton-compacto" id="cq-renombrar" type="button">Renombrar</button>
    <button class="boton-secundario boton-compacto boton-critico" id="cq-quitar" type="button">Quitar</button>`}
  </span>`;
}

function conectarHerramientasSel() {
  const el = S.cq?.elems.find((x) => claveCq(x) === S.cq.sel);
  if (!el) return;
  document.getElementById('cq-girar')?.addEventListener('click', () => {
    const w = Math.min(el.h, CQ_COLS), h = Math.min(el.w, CQ_FILAS);
    el.w = w; el.h = h;
    el.x = Math.min(el.x, CQ_COLS - w); el.y = Math.min(el.y, CQ_FILAS - h);
    S.cq.cambios = true;
    pintar();
  });
  document.getElementById('cq-renombrar')?.addEventListener('click', () => {
    const m = modal(`Renombrar ${el.nombre}`);
    m.cuerpo.innerHTML = `<div class="hab-form"><div class="campo"><label class="etiqueta" for="cq-nombre">Nombre</label>
      <input class="entrada" id="cq-nombre" maxlength="40" value="${esc(el.nombre)}"></div></div>`;
    m.botones([['Cancelar', 'boton-secundario', () => m.cerrar()], ['Aplicar', 'boton-primario', () => {
      const n = valor(m, 'cq-nombre');
      if (!n) return m.error('Escriba un nombre.');
      el.nombre = n; S.cq.cambios = true; m.cerrar(); pintar();
    }]]);
    m.enfocar();
  });
  document.getElementById('cq-quitar')?.addEventListener('click', () => {
    S.cq.elems = S.cq.elems.filter((x) => x !== el);
    if (el.id) S.cq.quitados.push(el.id);
    S.cq.sel = null; S.cq.cambios = true;
    pintar();
  });
}

function conectarHerramientasCroquis(base) {
  conectarHerramientasSel();
  document.getElementById('cq-agregar').addEventListener('click', () => {
    const tipo = document.getElementById('cq-tipo').value;
    const [w, h] = TAM_CROQUIS[tipo];
    let x = 0, y = 0, ok = false;
    for (y = 0; y + h <= CQ_FILAS && !ok; y++) {
      for (x = 0; x + w <= CQ_COLS; x++) {
        if (!S.cq.elems.some((c) => choca({ x, y, w, h }, c))) { ok = true; break; }
      }
      if (ok) break;
    }
    if (!ok) { x = 0; y = 0; }
    const iguales = S.cq.elems.filter((c) => c.tipo === tipo).length;
    const el = { tmp: `t${++tmpSeq}`, tipo, nombre: iguales ? `${TIPOS_CROQUIS[tipo]} ${iguales + 1}` : TIPOS_CROQUIS[tipo], x, y, w, h, nuevo: true };
    S.cq.elems.push(el);
    S.cq.sel = claveCq(el);
    S.cq.cambios = true;
    pintar();
    toast(`${el.nombre} agregado. Arrástrelo a su lugar.`);
  });
  document.getElementById('cq-cancelar').addEventListener('click', () => {
    if (S.cq.cambios && !document.getElementById('cq-cancelar').dataset.confirmar) {
      const b = document.getElementById('cq-cancelar');
      b.dataset.confirmar = '1';
      b.textContent = 'Descartar cambios';
      return;
    }
    S.cq = null; pintar();
  });
  document.getElementById('cq-guardar').addEventListener('click', (e) => conBoton(e.currentTarget, () => guardarCroquis(base)));
}

async function guardarCroquis(base) {
  const { elems, quitados } = S.cq;
  const nuevos = elems.filter((x) => !x.id).map((x) => alCrear({
    empresa_id: S.empresaId, base_id: base.id, tipo: x.tipo, edificio_id: x.edificio_id || null,
    nombre: x.tipo === 'edificio' ? (porId(S.edificios, x.edificio_id)?.nombre || x.nombre) : x.nombre,
    x: x.x, y: x.y, w: x.w, h: x.h
  }));
  const originales = new Map(S.croquis.map((c) => [c.id, c]));
  const cambiados = elems.filter((x) => {
    const o = x.id && originales.get(x.id);
    return o && (o.x !== x.x || o.y !== x.y || o.w !== x.w || o.h !== x.h || o.nombre !== x.nombre);
  });

  const ops = [];
  if (nuevos.length) ops.push(S.sb.from('viv_croquis').insert(nuevos));
  cambiados.forEach((x) => ops.push(S.sb.from('viv_croquis')
    .update(alEditar({ x: x.x, y: x.y, w: x.w, h: x.h, nombre: x.nombre })).eq('id', x.id)));
  if (quitados.length) ops.push(S.sb.from('viv_croquis').update(alEditar({ activo: false })).in('id', quitados));

  const res = await Promise.all(ops);
  const fallo = res.find((r) => r.error);
  if (fallo) { toast(mensajeError(fallo.error)); return; }
  S.cq = null;
  await cargarCroquis();
  pintar();
  toast('Croquis guardado');
}

/* ============================================
   SEGURIDAD DEL EDIFICIO (etapa 3)
   Extintores, botiquines, detectores, luces y señalética,
   ubicados en el plano de cada planta. Cada elemento se ancla
   al espacio o pasillo donde se colocó (posición en % dentro
   de él), así acompaña a su cuarto si este se mueve.
   Lo coloca y edita: admin y técnico de seguridad.
   Lo ven todos; los avisos marcan lo vencido o por vencer.
   ============================================ */

const CAPAS_SEG = {
  incendio: 'Contra incendios',
  auxilios: 'Primeros auxilios',
  luz: 'Iluminación',
  senal: 'Señalética'
};
/* Catálogo de señalética y equipos (ISO 7010 / INEN).
   e = estilo del símbolo: rojo (contra incendios), verde
   (evacuación y salvamento), advertencia (triángulo amarillo),
   prohibicion (círculo rojo con franja), obligacion (círculo
   azul), botiquin, luz (iluminación) o neutro.
   g = grupo en el que aparece al elegirlo. i = pictograma.
   Para agregar una señal nueva basta con sumarla aquí: la base
   de datos acepta cualquier tipo (habitaciones_senales.sql). */
const G_INC = 'Contra incendios', G_EVA = 'Evacuación y salvamento', G_AUX = 'Primeros auxilios',
  G_LUZ = 'Iluminación', G_ADV = 'Advertencia (peligro)', G_PRO = 'Prohibición', G_OBL = 'Obligación';
const LLAMA = 'M12 21c-4 0-6-3-6-6 0-4 4-6 3-11 3 2 5 5 5 8 1-1 1.5-2.5 1.5-4 2 2 2.5 4.5 2.5 7 0 3-2 6-6 6z';
const TIPOS_SEG = {
  // Contra incendios
  extintor:            { n: 'Extintor', capa: 'incendio', g: G_INC, e: 'rojo', i: 'M9 8h6v13H9zM10 8V5h4M14 5l4-2M9 12h6' },
  detector_humo:       { n: 'Detector de humo', capa: 'incendio', g: G_INC, e: 'rojo', i: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M6.5 7a7.5 7.5 0 0 0 0 10M17.5 7a7.5 7.5 0 0 1 0 10' },
  alarma:              { n: 'Alarma o pulsador', capa: 'incendio', g: G_INC, e: 'rojo', i: 'M6 17h12l-1.5-2v-4a4.5 4.5 0 0 0-9 0v4zM10 19.5a2 2 0 0 0 4 0' },
  gabinete_incendio:   { n: 'Gabinete o manguera contra incendios', capa: 'incendio', g: G_INC, e: 'rojo', i: 'M12 12m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M17 16l3 4' },
  telefono_emergencia: { n: 'Teléfono de emergencia', capa: 'incendio', g: G_INC, e: 'rojo', i: 'M6 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 4 6a2 2 0 0 1 2-2z' },
  // Evacuación y salvamento
  salida_emergencia:   { n: 'Salida de emergencia', capa: 'senal', g: G_EVA, e: 'verde', i: 'M13 4h6v16h-6M3 12h10M9 8l4 4-4 4' },
  ruta_evacuacion:     { n: 'Ruta de evacuación', capa: 'senal', g: G_EVA, e: 'verde', i: 'M4 12h14M13 7l5 5-5 5' },
  escaleras:           { n: 'Escaleras de evacuación', capa: 'senal', g: G_EVA, e: 'verde', i: 'M3 21h5v-5h5v-5h5V6h3' },
  ducha_emergencia:    { n: 'Ducha de emergencia', capa: 'auxilios', g: G_EVA, e: 'verde', i: 'M6 21V5h8v3M11 11l1 2M14 11v2M17 11l-1 2M12 17m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0' },
  lavaojos:            { n: 'Lavaojos', capa: 'auxilios', g: G_EVA, e: 'verde', i: 'M3 12s3-5 9-5 9 5 9 5-3 5-9 5-9-5-9-5zM12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0' },
  // Primeros auxilios
  botiquin:            { n: 'Botiquín', capa: 'auxilios', g: G_AUX, e: 'botiquin', i: '' },
  // Iluminación
  foco:                { n: 'Foco', capa: 'luz', g: G_LUZ, e: 'luz', i: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z' },
  luz_emergencia:      { n: 'Luz de emergencia', capa: 'luz', g: G_LUZ, e: 'luz', i: 'M3 10h18v6H3zM7 13h10M12 4v3M5 5.5l1.8 1.8M19 5.5l-1.8 1.8' },
  // Advertencia
  peligro_intoxicacion:{ n: 'Peligro de intoxicación (sustancia tóxica)', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M7 11a5 5 0 1 1 10 0c0 2-1 3-2 3.5V17H9v-2.5C8 14 7 13 7 11zM10 11h.01M14 11h.01M5 20l14-3M5 17l14 3' },
  peligro_derrumbe:    { n: 'Peligro de derrumbe o caída de rocas', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M3 21h18M5 21l4-6 4 6M13 8l3-2 2 3-3 2zM7 6l2-2 2 2-2 2zM17 14v2M20 12v2' },
  inflamable:          { n: 'Material inflamable', capa: 'senal', g: G_ADV, e: 'advertencia', i: LLAMA },
  gas_presion:         { n: 'Gas o cilindros a presión', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M9 9a3 3 0 0 1 6 0v12H9zM11 5h2M12 3v3' },
  explosion:           { n: 'Riesgo de explosión', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M12 3l2 5 5-2-2 5 5 2-5 2 2 5-5-2-2 5-2-5-5 2 2-5-5-2 5-2-2-5 5 2z' },
  riesgo_electrico:    { n: 'Riesgo eléctrico', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M13 3l-5 9h5l-3 9' },
  corrosivo:           { n: 'Sustancia corrosiva', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M5 4l5 5M4 9h6l-2 3M8 14v2M10 13v3M13 18h8v3h-8zM16 14v2' },
  riesgo_biologico:    { n: 'Riesgo biológico', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M12 7m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M7.5 15m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M16.5 15m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0' },
  piso_resbaladizo:    { n: 'Piso resbaladizo', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M3 21c3-1 6 1 9 0s6-1 9 0M10 4m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M10 7l3 4-2 5M13 11l4-1M11 16l-5 1' },
  caida_desnivel:      { n: 'Riesgo de caída o desnivel', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M3 12h8v9h10M15 4m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M15 7l-2 4 3 3M13 11l-3 1' },
  superficie_caliente: { n: 'Superficie caliente', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M4 21h16M8 17c-1-2 1-3 0-5s1-3 0-5M12 17c-1-2 1-3 0-5s1-3 0-5M16 17c-1-2 1-3 0-5s1-3 0-5' },
  transito_vehiculos:  { n: 'Tránsito de vehículos o maquinaria', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M3 16V9h9v7M12 11h4l3 3v2M3 16h16M7 18m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M16 18m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0' },
  ruido:               { n: 'Ruido', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M4 10h3l4-3v10l-4-3H4zM15 9a4 4 0 0 1 0 6M17.5 7a7 7 0 0 1 0 10' },
  carga_suspendida:    { n: 'Carga suspendida', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M12 3v5M10 8a2 2 0 1 0 4 0M8 12h8l2 8H6z' },
  espacio_confinado:   { n: 'Espacio confinado', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M4 17h16M7 17a5 2 0 0 1 10 0M12 4m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M12 7v5M9 10l3 2 3-2' },
  excavacion:          { n: 'Excavación', capa: 'senal', g: G_ADV, e: 'advertencia', i: 'M3 13h6l3 6 3-6h6M5 5l6 6M9 3l2 2-4 4-2-2z' },
  // Prohibición
  no_fumar:            { n: 'No fumar', capa: 'senal', g: G_PRO, e: 'prohibicion', i: 'M4 13h12v3H4zM17 13h3v3h-3zM17 11c0-2 2-2 2-4' },
  no_fuego:            { n: 'Prohibido encender fuego o llamas abiertas', capa: 'senal', g: G_PRO, e: 'prohibicion', i: LLAMA },
  prohibido_paso:      { n: 'Prohibido el paso a personal no autorizado', capa: 'senal', g: G_PRO, e: 'prohibicion', i: 'M12 4m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M12 7v6l-3 7M12 13l3 7M8 10h8' },
  no_ascensor:         { n: 'No usar el ascensor en caso de incendio', capa: 'senal', g: G_PRO, e: 'prohibicion', i: 'M6 3h12v18H6zM9 9l3-3 3 3M9 15l3 3 3-3' },
  no_celular:          { n: 'Prohibido el uso del celular', capa: 'senal', g: G_PRO, e: 'prohibicion', i: 'M8 3h8v18H8zM11 18h2' },
  no_alimentos:        { n: 'Prohibido el ingreso con alimentos', capa: 'senal', g: G_PRO, e: 'prohibicion', i: 'M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 0-3 3-3 6s1 4 3 4v8' },
  no_alcohol:          { n: 'Prohibidas las bebidas alcohólicas', capa: 'senal', g: G_PRO, e: 'prohibicion', i: 'M9 3h2v4l2 3v11H7V10l2-3zM16 9h4l-1 5h-2zM18 14v5M16.5 19h3' },
  // Obligación
  usar_casco:          { n: 'Uso obligatorio de casco', capa: 'senal', g: G_OBL, e: 'obligacion', i: 'M4 16h16M5 16a7 7 0 0 1 14 0M12 9V7M9 16v-4M15 16v-4' },
  usar_calzado:        { n: 'Uso obligatorio de calzado de seguridad', capa: 'senal', g: G_OBL, e: 'obligacion', i: 'M6 5v10h13v-2c0-2-4-3-6-3l-2-5zM6 15v3h13v-3' },
  usar_guantes:        { n: 'Uso obligatorio de guantes', capa: 'senal', g: G_OBL, e: 'obligacion', i: 'M8 21v-7l-3-3 1-1 3 2V6a1 1 0 0 1 2 0v5V5a1 1 0 0 1 2 0v6V6a1 1 0 0 1 2 0v6V8a1 1 0 0 1 2 0v7l-2 6z' },
  usar_gafas:          { n: 'Uso obligatorio de protección para los ojos', capa: 'senal', g: G_OBL, e: 'obligacion', i: 'M3 11h18M4 11a3.5 3.5 0 1 0 7 0M13 11a3.5 3.5 0 1 0 7 0' },
  usar_mascarilla:     { n: 'Uso obligatorio de mascarilla', capa: 'senal', g: G_OBL, e: 'obligacion', i: 'M5 10c3-2 11-2 14 0v3c-2 4-12 4-14 0zM5 11H3M19 11h2M9 12h6' },
  usar_auditiva:       { n: 'Uso obligatorio de protección auditiva', capa: 'senal', g: G_OBL, e: 'obligacion', i: 'M5 13a7 7 0 0 1 14 0M4 13h3v6H4zM17 13h3v6h-3z' },
  usar_chaleco:        { n: 'Uso obligatorio de chaleco reflectivo', capa: 'senal', g: G_OBL, e: 'obligacion', i: 'M8 3L4 6v14h16V6l-4-3-2 4h-4zM4 12h16M12 7v13' },
  lavar_manos:         { n: 'Lavado obligatorio de manos', capa: 'senal', g: G_OBL, e: 'obligacion', i: 'M4 11h8a2 2 0 0 1 0 4H9M4 15h6l4 3H4zM17 4c0 2-2 3-2 5a2 2 0 0 0 4 0c0-2-2-3-2-5z' },
  // Cualquier otra
  otra_senal:          { n: 'Otra señal (escriba cuál)', capa: 'senal', g: 'Otra', e: 'advertencia', i: 'M12 6v8M12 17.5v.5' },
  otro:                { n: 'Otro elemento', capa: 'senal', g: 'Otra', e: 'neutro', i: ICONOS.otro }
};
/* «Otra señal»: el grupo elegido define su forma y color. */
const GRUPOS_OTRA = { 'Advertencia': 'advertencia', 'Prohibición': 'prohibicion', 'Obligación': 'obligacion',
  'Contra incendios': 'rojo', 'Evacuación y salvamento': 'verde' };
const ESTADOS_SENAL = ['Buena', 'Deteriorada', 'Faltante'];
const CAMPOS_SEG = {
  extintor:       { control: 'Última recarga', vence: 'Próxima recarga', estados: ['Operativo', 'Descargado', 'Faltante'],
                    extra: [['agente', 'Agente', ['PQS', 'CO₂', 'Agua', 'Espuma', 'Clase K']], ['capacidad', 'Capacidad (ej. 10 lb)', null]] },
  botiquin:       { control: 'Última revisión', vence: 'Caducidad más próxima de sus insumos', estados: ['Completo', 'Incompleto'] },
  detector_humo:  { control: 'Última prueba', vence: 'Próxima prueba', estados: ['Batería OK', 'Batería baja', 'Sin batería', 'Dañado'] },
  alarma:         { control: 'Última prueba', vence: 'Próxima prueba', estados: ['Funciona', 'Dañada'] },
  luz_emergencia: { control: 'Última prueba', vence: 'Próxima prueba', estados: ['Funciona', 'Dañada'] },
  foco:           { control: 'Fecha del último reporte', estados: ['Funciona', 'Dañado'] },
  ruta_evacuacion:{ estados: ESTADOS_SENAL, extra: [['direccion', 'Dirección de la flecha', ['→', '←', '↑', '↓']]] },
  otra_senal:     { estados: ESTADOS_SENAL, extra: [['categoria', 'Grupo de la señal', Object.keys(GRUPOS_OTRA)], ['texto', 'Qué dice la señal', null]] }
};
const ESTADOS_MALOS = ['Descargado', 'Faltante', 'Incompleto', 'Batería baja', 'Sin batería', 'Dañado', 'Dañada', 'Deteriorada'];
const GIRO = { '→': 0, '↓': 90, '←': 180, '↑': 270 };
const DIAS_AVISO = 30;

function camposSeg(tipo) { return CAMPOS_SEG[tipo] || { estados: ESTADOS_SENAL }; }

function alertaSeg(el) {
  if (el.estado && ESTADOS_MALOS.includes(el.estado)) return { nivel: 'mal', texto: el.estado };
  if (el.fecha_vence) {
    const dias = Math.floor((new Date(el.fecha_vence + 'T00:00:00') - new Date(hoy() + 'T00:00:00')) / 86400000);
    if (dias < 0) return { nivel: 'mal', texto: `Vencido el ${fecha(el.fecha_vence)}` };
    if (dias <= DIAS_AVISO) return { nivel: 'pronto', texto: `Vence el ${fecha(el.fecha_vence)} (en ${dias} ${dias === 1 ? 'día' : 'días'})` };
  }
  return null;
}

/* Colores de señalética normalizada (ISO 7010 / INEN):
   contra incendios = fondo rojo y símbolo blanco;
   evacuación = fondo verde y símbolo blanco;
   prohibición = círculo rojo con franja, dibujo negro;
   advertencia = triángulo amarillo con borde negro;
   botiquín = blanco con cruz roja. */
const SEN_ROJO = '#c62828', SEN_VERDE = '#1b873f', SEN_AMARILLO = '#ffcc00', SEN_AZUL = '#1565c0';

function svgSeg(el) {
  const t = TIPOS_SEG[el.tipo] || TIPOS_SEG.otro;
  const giro = el.tipo === 'ruta_evacuacion' ? GIRO[el.datos?.direccion] || 0 : 0;
  const trazo = (color, ancho = 2) =>
    `fill="none" stroke="${color}" stroke-width="${ancho}" stroke-linecap="round" stroke-linejoin="round"`;
  const icono = (color) => `<g transform="translate(4 4) scale(0.667)${giro ? ` rotate(${giro} 12 12)` : ''}"><path d="${t.i}" ${trazo(color, 2.6)}/></g>`;
  const glifo = (color, escala, dx, dy) => `<g transform="translate(${dx} ${dy}) scale(${escala})"><path d="${t.i}" ${trazo(color, 2.4 / escala * 0.6)}/></g>`;
  const estilo = el.tipo === 'otra_senal' ? (GRUPOS_OTRA[el.datos?.categoria] || 'advertencia') : t.e;
  let dentro;
  switch (estilo) {
    case 'rojo':
      dentro = `<rect x="1" y="1" width="22" height="22" rx="3" fill="${SEN_ROJO}"/>${icono('#fff')}`; break;
    case 'verde':
      dentro = `<rect x="1" y="1" width="22" height="22" rx="3" fill="${SEN_VERDE}"/>${icono('#fff')}`; break;
    case 'botiquin':
      dentro = `<rect x="1" y="1" width="22" height="22" rx="3" fill="#fff" stroke="#6b6b6b" stroke-width="1.2"/>
        <rect x="9.5" y="4.5" width="5" height="15" fill="${SEN_ROJO}"/><rect x="4.5" y="9.5" width="15" height="5" fill="${SEN_ROJO}"/>`; break;
    case 'prohibicion':
      dentro = `<circle cx="12" cy="12" r="10.5" fill="#fff"/>${glifo('#111', 0.55, 5.4, 5.4)}
        <circle cx="12" cy="12" r="10.5" ${trazo(SEN_ROJO, 2.6)}/><line x1="4.6" y1="4.6" x2="19.4" y2="19.4" ${trazo(SEN_ROJO, 2.6)}/>`; break;
    case 'advertencia':
      dentro = `<path d="M12 2 L23 21.5 H1 Z" fill="${SEN_AMARILLO}" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/>${glifo('#111', 0.54, 5.5, 8)}`; break;
    case 'obligacion':
      dentro = `<circle cx="12" cy="12" r="11" fill="${SEN_AZUL}"/>${glifo('#fff', 0.6, 4.8, 4.8)}`; break;
    case 'luz':
      dentro = `<rect x="1" y="1" width="22" height="22" rx="3" fill="#fff6dc" stroke="#b07a00" stroke-width="1.2"/>${icono('#8a5300')}`; break;
    default:
      dentro = `<rect x="1" y="1" width="22" height="22" rx="3" fill="#eef0ed" stroke="#5d6b62" stroke-width="1.2"/>${icono('#3f4a43')}`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${dentro}</svg>`;
}

function descripcionSeg(el) {
  const t = TIPOS_SEG[el.tipo] || TIPOS_SEG.otro;
  const nombre = el.tipo === 'otra_senal' && el.datos?.texto ? el.datos.texto : t.n;
  const partes = [el.codigo, nombre, el.datos?.agente, el.datos?.capacidad, el.estado].filter(Boolean);
  const a = alertaSeg(el);
  if (a) partes.push(a.texto);
  else if (el.fecha_vence) partes.push(`vence ${fecha(el.fecha_vence)}`);
  return partes.join(' · ');
}

async function cargarSeguridad() {
  try {
    S.seguridad = await traerTodo(() => S.sb.from('viv_seguridad').select('*')
      .eq('empresa_id', S.empresaId).eq('activo', true).order('id'));
    S.seguridadFalta = false;
  } catch (error) {
    S.seguridad = [];
    S.seguridadFalta = faltaSql(error);
    if (!S.seguridadFalta) console.warn('NEXUS · seguridad:', error.message);
  }
}

const seguridadDe = (edifId) => S.seguridad.filter((x) => x.edificio_id === edifId);

/* ---------- Encabezado de la capa (va en la vista del edificio) ---------- */

function barraSeguridadHtml(edif) {
  if (S.seguridadFalta) {
    return S.estructura ? `<p class="ayuda">Para ubicar extintores y señalética, el administrador debe ejecutar <code>sql/habitaciones_etapa3.sql</code> en Supabase.</p>` : '';
  }
  const lista = seguridadDe(edif.id);
  const alertas = lista.map(alertaSeg).filter(Boolean);
  const mal = alertas.filter((a) => a.nivel === 'mal').length;
  const pronto = alertas.length - mal;
  return `<div class="hab-seg-barra">
    <button class="hab-chip" id="seg-ver" type="button" aria-pressed="${S.segVisible}">Mostrar seguridad${lista.length ? ` (${lista.length})` : ''}</button>
    ${S.segVisible ? Object.entries(CAPAS_SEG).map(([k, v]) =>
      `<button class="hab-chip hab-chip--capa" type="button" data-capa="${k}" aria-pressed="${!S.segOcultas.has(k)}">${v}</button>`).join('') : ''}
    ${alertas.length ? `<button class="hab-seg-aviso ${mal ? 'hab-seg-aviso--mal' : ''}" id="seg-avisos" type="button">
      ${mal ? `${mal} vencido${mal > 1 ? 's' : ''} o con problema` : ''}${mal && pronto ? ' · ' : ''}${pronto ? `${pronto} por vencer` : ''}</button>` : ''}
    ${S.estructura && !S.editando ? `<button class="${S.segEdit ? 'boton-primario' : 'boton-secundario'} boton-compacto" id="seg-editar" type="button" aria-pressed="${S.segEdit}">
      ${S.segEdit ? 'Terminar seguridad' : 'Editar seguridad'}</button>` : ''}
  </div>
  ${S.segEdit ? `<div class="hab-herramientas" role="toolbar" aria-label="Colocar elementos de seguridad">
    <label class="etiqueta" for="seg-tipo" style="margin:0">Elemento</label>
    <select class="entrada" id="seg-tipo" style="width:auto">
      ${[...new Set(Object.values(TIPOS_SEG).map((t) => t.g))].map((g) => `<optgroup label="${g}">${Object.entries(TIPOS_SEG)
        .filter(([, t]) => t.g === g).map(([k, t]) => `<option value="${k}" ${S.segColocar === k ? 'selected' : ''}>${t.n}</option>`).join('')}</optgroup>`).join('')}
    </select>
    <button class="${S.segColocar ? 'boton-primario' : 'boton-secundario'} boton-compacto" id="seg-colocar" type="button">
      ${S.segColocar ? 'Toque el plano… (cancelar)' : 'Colocar en el plano'}</button>
    <span class="hab-herramientas-nombre" style="font-weight:400">${S.segColocar
      ? `Toque el cuarto o pasillo donde está el ${esc(TIPOS_SEG[S.segColocar].n.toLowerCase())}.`
      : 'Arrastre un símbolo para reubicarlo · tóquelo para ver o editar sus datos.'}</span>
  </div>` : ''}`;
}

function conectarBarraSeguridad(edif) {
  document.getElementById('seg-ver')?.addEventListener('click', () => { S.segVisible = !S.segVisible; if (!S.segVisible) { S.segEdit = false; S.segColocar = null; } pintar(); });
  document.querySelectorAll('[data-capa]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.capa;
    if (S.segOcultas.has(k)) S.segOcultas.delete(k); else S.segOcultas.add(k);
    pintar();
  }));
  document.getElementById('seg-avisos')?.addEventListener('click', () => modalAvisosSeg(edif));
  document.getElementById('seg-editar')?.addEventListener('click', () => {
    S.segEdit = !S.segEdit; S.segColocar = null;
    if (S.segEdit) { S.segVisible = true; S.segOcultas.clear(); }
    pintar();
  });
  document.getElementById('seg-colocar')?.addEventListener('click', () => {
    S.segColocar = S.segColocar ? null : document.getElementById('seg-tipo').value;
    pintar();
  });
  document.getElementById('seg-tipo')?.addEventListener('change', (e) => { if (S.segColocar) { S.segColocar = e.target.value; pintar(); } });
}

/* ---------- Dibujar los símbolos sobre el plano ---------- */

function anclaDe($f, el) {
  const planta = $f.querySelector(`.hab-planta[data-planta="${el.planta}"]`);
  if (!planta) return { nodo: null, suelto: true };
  if (el.ancla_tipo === 'espacio' && el.ancla_espacio) {
    const n = planta.querySelector(`.hab-esp[data-esp="${el.ancla_espacio}"]`);
    if (n) return { nodo: n, suelto: false };
  }
  if (el.ancla_tipo === 'pasillo' && el.ancla_pasillo) {
    const n = planta.querySelector(`.hab-pasillo[data-pasillo="${el.ancla_pasillo}"]`);
    if (n) return { nodo: n, suelto: false };
  }
  return { nodo: planta, suelto: el.ancla_tipo !== 'planta' };
}

function pintarSeguridad($f, edif) {
  if (S.seguridadFalta || !S.segVisible) return;
  if (S.segEdit) $f.classList.add('hab-seg-editando');
  if (S.segColocar) $f.classList.add('hab-seg-colocando');
  seguridadDe(edif.id).forEach((el) => {
    const t = TIPOS_SEG[el.tipo] || TIPOS_SEG.otro;
    if (S.segOcultas.has(t.capa)) return;
    const { nodo, suelto } = anclaDe($f, el);
    if (!nodo) return;
    const a = alertaSeg(el);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hab-seg' + (a ? ` hab-seg--${a.nivel}` : '') + (suelto ? ' hab-seg--suelto' : '');
    b.dataset.seg = el.id;
    b.style.left = `${el.x}%`;
    b.style.top = `${el.y}%`;
    const texto = descripcionSeg(el) + (suelto ? ' · su cuarto ya no existe: reubíquelo' : '');
    b.title = texto;
    b.setAttribute('aria-label', texto);
    b.innerHTML = svgSeg(el) + (a ? '<span class="hab-seg-punto" aria-hidden="true"></span>' : '');
    conectarSimbolo(b, el);
    nodo.appendChild(b);
  });
}

/** Qué cuarto, pasillo o planta hay bajo un punto de la pantalla. */
function anclaEnPunto(x, y) {
  const pila = document.elementsFromPoint(x, y);
  let nodo = null;
  for (const n of pila) {
    if (n.classList?.contains('hab-seg')) continue;
    nodo = n.closest?.('.hab-esp[data-esp], .hab-pasillo, .hab-planta');
    if (nodo) break;
  }
  if (!nodo) return null;
  const planta = nodo.closest('.hab-planta') || nodo;
  const r = nodo.getBoundingClientRect();
  const px = Math.max(3, Math.min(97, ((x - r.left) / r.width) * 100));
  const py = Math.max(5, Math.min(95, ((y - r.top) / r.height) * 100));
  const base = { planta: parseInt(planta.dataset.planta, 10), x: +px.toFixed(2), y: +py.toFixed(2) };
  if (nodo.matches('.hab-esp')) return { ...base, ancla_tipo: 'espacio', ancla_espacio: nodo.dataset.esp, ancla_pasillo: null };
  if (nodo.matches('.hab-pasillo')) return { ...base, ancla_tipo: 'pasillo', ancla_espacio: null, ancla_pasillo: nodo.dataset.pasillo };
  return { ...base, ancla_tipo: 'planta', ancla_espacio: null, ancla_pasillo: null };
}

function conectarSimbolo(b, el) {
  if (!S.segEdit) {
    b.addEventListener('click', (e) => { e.stopPropagation(); modalSeguridad(el); });
    return;
  }
  let inicio = null, movido = false;
  b.addEventListener('pointerdown', (e) => {
    if (S.segColocar) return;
    e.preventDefault(); e.stopPropagation();
    inicio = { x: e.clientX, y: e.clientY };
    movido = false;
    b.setPointerCapture(e.pointerId);
  });
  b.addEventListener('pointermove', (e) => {
    if (!inicio) return;
    if (!movido && Math.hypot(e.clientX - inicio.x, e.clientY - inicio.y) < 5) return;
    if (!movido) {
      movido = true;
      // Se queda en su lugar del documento (si se moviera, el
      // navegador soltaría el puntero); solo pasa a posición fija.
      b.classList.add('hab-seg--arrastrando');
    }
    b.style.left = `${e.clientX}px`;
    b.style.top = `${e.clientY}px`;
  });
  b.addEventListener('pointerup', async (e) => {
    if (!inicio) return;
    inicio = null;
    if (!movido) { modalSeguridad(el); return; }
    b.style.visibility = 'hidden';
    const destino = anclaEnPunto(e.clientX, e.clientY);
    if (!destino || !Number.isInteger(destino.planta)) { pintar(); return; }
    const { error } = await S.sb.from('viv_seguridad').update(alEditar(destino)).eq('id', el.id);
    if (error) toast(mensajeError(error));
    else Object.assign(el, destino);
    pintar();
  });
  b.addEventListener('pointercancel', () => { if (inicio) { inicio = null; pintar(); } });
  b.addEventListener('click', (e) => e.stopPropagation());
}

/** Modo «colocar»: el siguiente toque en el plano crea el elemento. */
function conectarColocar($f, edif) {
  if (!S.segColocar) return;
  $f.addEventListener('click', async (e) => {
    if (!S.segColocar) return;
    if (e.target.closest('.hab-seg')) return;
    e.preventDefault(); e.stopPropagation();
    const destino = anclaEnPunto(e.clientX, e.clientY);
    if (!destino) return;
    const tipo = S.segColocar;
    const iguales = seguridadDe(edif.id).filter((x) => x.tipo === tipo).length;
    const prefijo = { extintor: 'EXT', botiquin: 'BOT', detector_humo: 'DET', alarma: 'ALM', luz_emergencia: 'LE', foco: 'FOC' }[tipo];
    const fila = alCrear({
      empresa_id: S.empresaId, edificio_id: edif.id, tipo, ...destino,
      codigo: prefijo ? `${prefijo}-${String(iguales + 1).padStart(2, '0')}` : null,
      datos: tipo === 'ruta_evacuacion' ? { direccion: '→' } : tipo === 'otra_senal' ? { categoria: 'Advertencia' } : {}
    });
    const { data, error } = await S.sb.from('viv_seguridad').insert(fila).select().single();
    if (error) { toast(mensajeError(error)); return; }
    S.seguridad.push(data);
    S.segColocar = null;
    pintar();
    modalSeguridad(data, true);
  }, true);
}

/* ---------- Ficha de un elemento ---------- */

function modalSeguridad(el, recienCreado = false) {
  const t = TIPOS_SEG[el.tipo] || TIPOS_SEG.otro;
  const c = camposSeg(el.tipo);
  const m = modal(`${el.tipo === 'otra_senal' && el.datos?.texto ? el.datos.texto : t.n}${el.codigo ? ' · ' + el.codigo : ''}`);
  const esp = el.ancla_espacio && porId(S.espacios, el.ancla_espacio);
  const edif = porId(S.edificios, el.edificio_id);
  const lugar = [nombrePlanta(el.planta, edif?.num_plantas || 1),
    esp ? (esp.tipo === 'habitacion' ? `Habitación ${esp.nombre}` : esp.nombre)
      : el.ancla_tipo === 'pasillo' ? (el.ancla_pasillo === 'central' || el.ancla_pasillo === 'lado' ? 'Pasillo' : `Pasillo frente ${el.ancla_pasillo}`) : null
  ].filter(Boolean).join(' · ');
  const a = alertaSeg(el);

  if (!S.estructura) {
    m.cuerpo.innerHTML = `<p class="ayuda">${esc(lugar)}</p>
      ${a ? `<div class="hab-nota ${a.nivel === 'mal' ? 'hab-nota--error' : ''}">${esc(a.texto)}</div>` : ''}
      <table class="hab-datos">
        ${c.estados ? `<tr><td>Estado</td><td>${esc(el.estado || '—')}</td></tr>` : ''}
        ${(c.extra || []).map(([k, n]) => `<tr><td>${esc(n)}</td><td>${esc(el.datos?.[k] || '—')}</td></tr>`).join('')}
        ${c.control ? `<tr><td>${esc(c.control)}</td><td>${fecha(el.fecha_control)}</td></tr>` : ''}
        ${c.vence ? `<tr><td>${esc(c.vence)}</td><td>${fecha(el.fecha_vence)}</td></tr>` : ''}
        ${el.nota ? `<tr><td>Nota</td><td>${esc(el.nota)}</td></tr>` : ''}
      </table>`;
    m.botones([['Cerrar', 'boton-primario', () => m.cerrar()]]);
    return;
  }

  const opciones = (lista, actual) => `<option value="">—</option>` + lista.map((x) => `<option ${x === actual ? 'selected' : ''}>${esc(x)}</option>`).join('');
  m.cuerpo.innerHTML = `<p class="ayuda">${esc(lugar)}${recienCreado ? ' · complete sus datos (puede hacerlo después)' : ''}</p>
    ${a ? `<div class="hab-nota ${a.nivel === 'mal' ? 'hab-nota--error' : ''}">${esc(a.texto)}</div>` : ''}
    <div class="hab-form">
      <div class="hab-form-fila">
        <div class="campo"><label class="etiqueta" for="sg-codigo">Código</label>
          <input class="entrada" id="sg-codigo" maxlength="20" value="${esc(el.codigo || '')}" placeholder="Ej. EXT-01"></div>
        ${c.estados ? `<div class="campo"><label class="etiqueta" for="sg-estado">Estado</label>
          <select class="entrada" id="sg-estado">${opciones(c.estados, el.estado)}</select></div>` : ''}
      </div>
      ${(c.extra || []).length ? `<div class="hab-form-fila">${c.extra.map(([k, n, lista]) => `<div class="campo">
        <label class="etiqueta" for="sg-x-${k}">${esc(n)}</label>
        ${lista ? `<select class="entrada" id="sg-x-${k}">${opciones(lista, el.datos?.[k])}</select>`
                : `<input class="entrada" id="sg-x-${k}" maxlength="${k === 'texto' ? 80 : 30}" value="${esc(el.datos?.[k] || '')}">`}</div>`).join('')}</div>` : ''}
      ${c.control || c.vence ? `<div class="hab-form-fila">
        ${c.control ? `<div class="campo"><label class="etiqueta" for="sg-control">${esc(c.control)}</label>
          <input class="entrada" id="sg-control" type="date" value="${el.fecha_control || ''}"></div>` : ''}
        ${c.vence ? `<div class="campo"><label class="etiqueta" for="sg-vence">${esc(c.vence)}</label>
          <input class="entrada" id="sg-vence" type="date" value="${el.fecha_vence || ''}"></div>` : ''}
      </div>${c.vence ? `<span class="ayuda">El sistema avisará ${DIAS_AVISO} días antes de esta fecha.</span>` : ''}` : ''}
      <div class="campo"><label class="etiqueta" for="sg-nota">Nota</label>
        <input class="entrada" id="sg-nota" maxlength="200" value="${esc(el.nota || '')}"></div>
    </div>`;

  m.botones([
    ['Eliminar', 'boton-secundario boton-critico', (b) => {
      if (b.dataset.confirmar !== '1') { b.dataset.confirmar = '1'; b.textContent = 'Confirmar eliminación'; return; }
      conBoton(b, async () => {
        const { error } = await S.sb.from('viv_seguridad').update(alEditar({ activo: false })).eq('id', el.id);
        if (error) return m.error(mensajeError(error));
        S.seguridad = S.seguridad.filter((x) => x.id !== el.id);
        m.cerrar(); toast(`${t.n} eliminado`); pintar();
      });
    }],
    ['Cancelar', 'boton-secundario', () => m.cerrar()],
    ['Guardar', 'boton-primario', (b) => conBoton(b, async () => {
      const control = valor(m, 'sg-control') || null;
      const vence = valor(m, 'sg-vence') || null;
      if (control && vence && vence < control) return m.error('La fecha de vencimiento no puede ser anterior a la del último control.');
      const datos = { ...(el.datos || {}) };
      (c.extra || []).forEach(([k]) => { datos[k] = valor(m, `sg-x-${k}`) || null; });
      if (el.tipo === 'otra_senal' && !datos.texto) return m.error('Escriba qué dice la señal (por ejemplo, «Riesgo de explosión»).');
      const cambios = {
        codigo: valor(m, 'sg-codigo') || null,
        estado: c.estados ? (valor(m, 'sg-estado') || null) : null,
        fecha_control: c.control ? control : null,
        fecha_vence: c.vence ? vence : null,
        datos, nota: valor(m, 'sg-nota') || null
      };
      const { error } = await S.sb.from('viv_seguridad').update(alEditar(cambios)).eq('id', el.id);
      if (error) return m.error(mensajeError(error));
      Object.assign(el, cambios);
      m.cerrar(); toast('Datos guardados'); pintar();
    })]
  ]);
  m.enfocar();
}

function modalAvisosSeg(edif) {
  const m = modal(`Controles de seguridad · ${edif.nombre}`);
  const filas = seguridadDe(edif.id).map((el) => ({ el, a: alertaSeg(el) })).filter((x) => x.a)
    .sort((x, y) => (x.a.nivel === 'mal' ? 0 : 1) - (y.a.nivel === 'mal' ? 0 : 1));
  m.cuerpo.innerHTML = `<p class="ayuda">Vencidos o con problema primero; luego lo que vence en los próximos ${DIAS_AVISO} días.</p>
    <div class="hab-filas-lista" id="sa-lista"></div>`;
  const $l = m.cuerpo.querySelector('#sa-lista');
  filas.forEach(({ el, a }) => {
    const t = TIPOS_SEG[el.tipo] || TIPOS_SEG.otro;
    const d = document.createElement('div');
    d.innerHTML = `<span><b>${esc(el.codigo || t.n)}</b> · ${esc(t.n)} · ${esc(nombrePlanta(el.planta, edif.num_plantas))}<br>
      <span class="ayuda" style="color:${a.nivel === 'mal' ? 'var(--hab-salio)' : 'var(--hab-cambio)'}">${esc(a.texto)}</span></span>
      <button class="boton-secundario boton-compacto" type="button">Ver</button>`;
    d.querySelector('button').addEventListener('click', () => modalSeguridad(el));
    $l.appendChild(d);
  });
  m.botones([['Cerrar', 'boton-primario', () => m.cerrar()]]);
}


/* ============================================
   IMPRIMIR PLANOS DEL EDIFICIO
   Portada + una hoja horizontal por planta (con su leyenda)
   + el croquis de la base, opcional. Se arma aparte, en
   #hab-impresion, y solo eso sale en la hoja. Desde la ventana
   de impresión se puede guardar como PDF.
   ============================================ */

function modalImprimir(edif) {
  const m = modal(`Imprimir planos · ${edif.nombre}`);
  const plantas = Array.from({ length: edif.num_plantas }, (_, k) => k + 1);
  const hayCroquis = !S.croquisFalta;
  const haySeg = !S.seguridadFalta && seguridadDe(edif.id).length > 0;
  m.cuerpo.innerHTML = `<div class="hab-form">
    <div><p class="etiqueta">Plantas</p><div class="hab-opciones">
      ${plantas.map((p) => `<label><input type="checkbox" name="imp-planta" value="${p}" checked> ${nombrePlanta(p, edif.num_plantas)}</label>`).join('')}
    </div></div>
    <div><p class="etiqueta">Camas</p><div class="hab-opciones">
      <label><input type="radio" name="imp-camas" value="codigo" checked> Solo código y estado (libre u ocupada)</label>
      <label><input type="radio" name="imp-camas" value="nombres"> Con nombre, cargo y edad de quien duerme ahí</label>
      <span class="ayuda">Los nombres son datos personales: inclúyalos solo si el plano es para uso interno.</span>
    </div></div>
    ${haySeg ? `<div><p class="etiqueta">Seguridad</p><div class="hab-opciones">
      ${Object.entries(CAPAS_SEG).map(([k, v]) => `<label><input type="checkbox" name="imp-capa" value="${k}" checked> ${v}</label>`).join('')}
    </div></div>` : ''}
    ${hayCroquis ? `<div class="hab-opciones"><label><input type="checkbox" id="imp-croquis" checked> Incluir el croquis de la base</label></div>` : ''}
    <div><p class="etiqueta">Orientación de la hoja</p><div class="hab-opciones">
      <label><input type="radio" name="imp-orientacion" value="h" checked> Horizontal (recomendada para edificios anchos)</label>
      <label><input type="radio" name="imp-orientacion" value="v"> Vertical</label>
    </div></div>
    <span class="ayuda">En la ventana de impresión puede elegir «Guardar como PDF». Se imprime en hoja A4; cada plano se amplía para ocupar toda la hoja.</span>
  </div>`;
  m.botones([
    ['Cancelar', 'boton-secundario', () => m.cerrar()],
    ['Imprimir', 'boton-primario', (b) => conBoton(b, async () => {
      const elegidas = [...m.cuerpo.querySelectorAll('input[name="imp-planta"]:checked')].map((x) => parseInt(x.value, 10));
      if (elegidas.length === 0) return m.error('Elija al menos una planta.');
      const opciones = {
        plantas: elegidas.sort((a, b) => b - a),
        nombres: m.cuerpo.querySelector('input[name="imp-camas"]:checked').value === 'nombres',
        capas: new Set([...m.cuerpo.querySelectorAll('input[name="imp-capa"]:checked')].map((x) => x.value)),
        croquis: !!m.cuerpo.querySelector('#imp-croquis')?.checked,
        vertical: m.cuerpo.querySelector('input[name="imp-orientacion"]:checked')?.value === 'v',
        seguridad: haySeg
      };
      m.cerrar();
      await imprimirPlanos(edif, opciones);
    })]
  ]);
}

async function datosEmpresa() {
  try {
    const { data } = await S.sb.from('empresas').select('razon_social, logo_url').eq('id', S.empresaId).maybeSingle();
    return { nombre: data?.razon_social || '', logo: data?.logo_url || 'logo.png' };
  } catch {
    return { nombre: '', logo: 'logo.png' };
  }
}

function leyendaHtml(planta, conSeguridad) {
  const estados = `<span class="hab-imp-ley-cama" style="--c:var(--hab-libre);--f:var(--hab-libre-f)">Cama libre</span>
    <span class="hab-imp-ley-cama" style="--c:var(--hab-ocupada);--f:var(--hab-ocupada-f)">Cama ocupada</span>
    <span class="hab-imp-ley-cama" style="--c:var(--hab-cambio);--f:var(--hab-cambio-f)">Colchón por cambiar</span>
    <span class="hab-imp-ley-cama" style="--c:var(--hab-salio);--f:var(--hab-salio-f)">Ocupante ya no labora</span>`;
  let simbolos = '';
  if (conSeguridad) {
    const vistos = new Map();
    planta.querySelectorAll('.hab-seg').forEach((b) => {
      const el = porId(S.seguridad, b.dataset.seg);
      if (!el) return;
      const clave = el.tipo === 'otra_senal' ? `otra:${el.datos?.texto}` : el.tipo;
      if (!vistos.has(clave)) vistos.set(clave, el);
    });
    simbolos = [...vistos.values()].map((el) => {
      const t = TIPOS_SEG[el.tipo] || TIPOS_SEG.otro;
      const nombre = el.tipo === 'otra_senal' && el.datos?.texto ? el.datos.texto : t.n;
      return `<span class="hab-imp-ley-seg">${svgSeg(el)}${esc(nombre)}</span>`;
    }).join('');
  }
  return `<div class="hab-imp-leyenda">${estados}${simbolos}</div>`;
}

async function imprimirPlanos(edif, op) {
  const base = porId(S.bases, edif.base_id);
  const suc = base && porId(S.sucursales, base.sucursal_id);
  const empresa = await datosEmpresa();
  const quien = [S.perfil?.nombres, S.perfil?.apellidos].filter(Boolean).join(' ');
  const fechaHoy = new Date().toLocaleDateString('es-EC', { day: '2-digit', month: 'long', year: 'numeric' });

  /* Se dibuja con los mismos componentes de la pantalla, en modo
     consulta; al terminar se devuelve todo como estaba. */
  const antes = { detalle: S.detalle, editando: S.editando, segEdit: S.segEdit, segColocar: S.segColocar,
    segVisible: S.segVisible, segOcultas: S.segOcultas, soloLibres: S.soloLibres, resaltar: S.resaltar };
  Object.assign(S, { detalle: op.nombres, editando: false, segEdit: false, segColocar: null, soloLibres: false, resaltar: null,
    segVisible: op.seguridad && op.capas.size > 0,
    segOcultas: new Set(Object.keys(CAPAS_SEG).filter((k) => !op.capas.has(k))) });

  document.getElementById('hab-impresion')?.remove();
  const $imp = document.createElement('div');
  $imp.id = 'hab-impresion';
  $imp.className = 'hab hab-imp' + (op.vertical ? ' hab-imp--vertical' : '');

  const encabezado = (titulo) => `<header class="hab-imp-cab">
      <img src="${esc(empresa.logo)}" alt="" class="hab-imp-logo">
      <div><strong>${esc(empresa.nombre)}</strong><span>${esc([suc?.nombre, base?.nombre, edif.nombre].filter(Boolean).join(' · '))}</span></div>
      <div class="hab-imp-cab-der"><strong>${esc(titulo)}</strong><span>${esc(fechaHoy)}</span></div>
    </header>`;

  try {
    // Portada
    const c = conteo(camasDeEdificio(edif.id));
    const segs = op.seguridad ? seguridadDe(edif.id) : [];
    const avisos = segs.map(alertaSeg).filter(Boolean).length;
    $imp.insertAdjacentHTML('beforeend', `<section class="hab-imp-hoja hab-imp-portada">
      <img src="${esc(empresa.logo)}" alt="" class="hab-imp-logo-grande">
      <h1>${esc(edif.nombre)}</h1>
      <p class="hab-imp-sub">${esc([suc?.nombre, base?.nombre].filter(Boolean).join(' · '))}</p>
      <div class="hab-imp-fachada">${svgFachada(edif)}</div>
      <table class="hab-datos hab-imp-resumen">
        <tr><td>Plantas incluidas</td><td>${op.plantas.slice().reverse().map((p) => esc(nombrePlanta(p, edif.num_plantas))).join(', ')}</td></tr>
        <tr><td>Camas</td><td>${c.total} en total · ${c.ocupadas} ocupadas · ${c.libres} libres</td></tr>
        ${op.seguridad ? `<tr><td>Elementos de seguridad</td><td>${segs.length}${avisos ? ` · ${avisos} vencidos, por vencer o con problema` : ''}</td></tr>` : ''}
        <tr><td>Camas</td><td>${op.nombres ? 'Con nombre de los ocupantes (uso interno)' : 'Solo código y estado'}</td></tr>
        <tr><td>Impreso por</td><td>${esc(quien || '—')} · ${esc(fechaHoy)}</td></tr>
      </table>
      <p class="hab-imp-nota">Esquema proporcional elaborado en NEXUS, no es un plano a escala.</p>
    </section>`);

    // Una hoja por planta (de la baja a la más alta)
    op.plantas.slice().reverse().forEach((p) => {
      const hoja = document.createElement('section');
      hoja.className = 'hab-imp-hoja';
      hoja.innerHTML = encabezado(nombrePlanta(p, edif.num_plantas));
      const $f = document.createElement('div');
      $f.className = `hab-fachada hab-imp-plano ${S.detalle ? '' : 'hab-compacta'}`;
      const planta = document.createElement('section');
      planta.className = 'hab-planta';
      planta.dataset.planta = p;
      planta.appendChild(edif.tiene_frentes ? plantaConFrentes(edif, p) : filaHtml(edif, p, null));
      if (!edif.tiene_frentes && pasilloDe(edif) === 'lado') planta.appendChild(pasilloHtml('lado'));
      $f.appendChild(planta);
      pintarSeguridad($f, edif);
      hoja.appendChild($f);
      hoja.insertAdjacentHTML('beforeend', leyendaHtml(planta, S.segVisible));
      $imp.appendChild(hoja);
    });

    // Croquis de la base
    if (op.croquis && base) {
      const hoja = document.createElement('section');
      hoja.className = 'hab-imp-hoja';
      hoja.innerHTML = encabezado(`Croquis de ${base.nombre}`);
      const $cq = document.createElement('div');
      $cq.className = 'hab-cq hab-imp-cq';
      elementosCroquis(base).forEach((el) => $cq.appendChild(elementoCq(el, false, $cq)));
      hoja.appendChild($cq);
      $imp.appendChild(hoja);
    }
  } finally {
    Object.assign(S, antes);
  }

  // Los botones del plano no hacen nada en papel
  $imp.querySelectorAll('button').forEach((b) => { b.tabIndex = -1; b.disabled = true; });
  document.body.appendChild($imp);

  /* Cada plano se AMPLÍA (o reduce, si no cabe) hasta ocupar
     todo el espacio libre de la hoja: su alto menos el
     encabezado y la leyenda. Se mide con la hoja ya armada. */
  $imp.classList.add('hab-imp-midiendo');
  const MM = 96 / 25.4;
  const anchoUtil = (op.vertical ? 190 : 277) * MM;
  const altoHoja = (op.vertical ? 272 : 186) * MM;
  $imp.querySelectorAll('.hab-imp-hoja').forEach(($h) => {
    const $p = $h.querySelector('.hab-imp-plano');
    if (!$p) return;
    const cab = $h.querySelector('.hab-imp-cab')?.offsetHeight || 0;
    const ley = $h.querySelector('.hab-imp-leyenda')?.offsetHeight || 0;
    const altoUtil = altoHoja - cab - ley - 36;   // 36 px de separaciones
    const escala = Math.min(anchoUtil / $p.scrollWidth, altoUtil / $p.scrollHeight, 2.5);
    $p.style.zoom = escala.toFixed(3);
  });
  $imp.classList.remove('hab-imp-midiendo');

  await esperarImagenes($imp);
  const titulo = document.title;
  document.title = `Planos · ${base?.nombre || ''} · ${edif.nombre}`;
  document.body.classList.add('hab-imprimiendo');
  if (op.vertical) document.body.classList.add('hab-imprimiendo-v');
  const limpiar = () => {
    document.body.classList.remove('hab-imprimiendo', 'hab-imprimiendo-v');
    document.title = titulo;
    $imp.remove();
    window.removeEventListener('afterprint', limpiar);
  };
  window.addEventListener('afterprint', limpiar);
  window.print();
  setTimeout(() => { if ($imp.isConnected && !matchMedia('print').matches) limpiar(); }, 1500);
}

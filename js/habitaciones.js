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

   Tablas: sql/habitaciones.sql (viv_*). Plano interior a ojo:
   sql/habitaciones_etapa4_plano.sql (viv_espacios.plano_*).

   Este archivo se carga solo cuando alguien abre la pestaña,
   así un error aquí nunca afecta a Ficha, Registros ni
   Atenciones.
   ============================================ */

import { alCrear, alEditar } from './autoria.js?v=1';
import { esperarImagenes } from './impresion.js?v=11';

const VERSION = 'v32';
console.info('NEXUS · habitaciones', VERSION);

/* Dos permisos distintos:
   - ESTRUCTURA: bases, edificios, plantas, espacios, camas y
     literas (agregar o quitar), el croquis y el plano → admin,
     técnico de seguridad y trabajo social.
   - ASIGNACIÓN: asignar, trasladar y liberar camas, y los
     colchones → admin y trabajo social.
   Los demás roles que abren la pestaña solo consultan. */
const ROLES_ESTRUCTURA = ['admin', 'supervisor', 'tecnico_sst', 'trabajo_social'];
const ROLES_ASIGNACION = ['admin', 'supervisor', 'trabajo_social'];
const EDITORES_SEG = ['admin', 'supervisor', 'tecnico_sst'];
const QUIEN_ESTRUCTURA = 'Las registra trabajo social, el técnico de seguridad o el administrador.';

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
    vistaEdif: 'frentes',  // 'frentes' | 'plano' (plano interior a ojo)
    planoPlanta: 1,        // planta que se ve en el plano
    pl: null,              // edición del plano en curso
    plVer: null,           // plano: mostrar cuadrícula, camas, seguridad
    plCinta: null,         // plano: pestaña de la cinta
    selEspacio: null,
    areas: [],             // viv_areas: Mecánicos, Cocina… (dibujo y color)
    areasFalta: false,     // true si aún no se ejecutó habitaciones_etapa5_areas.sql
    piezas: [],            // viv_piezas: inodoros, duchas, lavamanos… de los baños
    piezasFalta: false,    // true si aún no se ejecutó habitaciones_etapa7_piezas_banos.sql
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
/* planta (opcional): una planta puede tener su propio pasillo (etapa 6) */
function pasilloDe(edif, planta) {
  const propio = planta && edif.pasillos_planta ? edif.pasillos_planta[String(planta)] : null;
  const p = (propio && PASILLOS[propio] ? propio : null) || edif.pasillo || (edif.tiene_frentes ? 'central' : 'lado');
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
  muro: '#3f5170', estructura: '#8a97ab', claro: '#f3f6fb', blanco: '#ffffff',
  techo: '#123A7A', ventana: '#f3c14b', ventanaBorde: '#b98a14', apagada: '#e6ebf3'
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

/* ============================================
   PIEZAS DE LOS BAÑOS (etapa 7)
   Inodoros, duchas, lavamanos… cada uno con nombre y estado.
   ============================================ */
const TIPOS_PIEZA = {
  inodoro:   { n: 'Inodoro',   f: '#E8F1FF', c: '#1F5FA8', i: 'M7 3h10v4.5H7zM5.5 7.5h13c0 4.2-2.6 7.2-6.5 7.2S5.5 11.7 5.5 7.5zM9 14.5 8 21h8l-1-6.5' },
  ducha:     { n: 'Ducha',     f: '#E3F8FB', c: '#00838F', i: 'M5 21V7a4 4 0 0 1 4-4h1a4 4 0 0 1 4 4M10.5 9.5h7l-3.5-3zM11.5 13v1.2M14 12.5v1.2M16.5 13v1.2M12.5 16v1.2M15.5 16v1.2M14 19v1.2' },
  lavamanos: { n: 'Lavamanos', f: '#EEF3FB', c: '#37474F', i: 'M2.5 10h19c0 4.2-3.6 6.6-9.5 6.6S2.5 14.2 2.5 10zM12 10V5.5h4.5M16.5 5.5v1.8M10 16.6V21h4v-4.4' },
  urinario:  { n: 'Urinario',  f: '#FFF7E0', c: '#B07F14', i: 'M8 3.5h8v9.5c0 3-1.8 5.2-4 5.2s-4-2.2-4-5.2zM12 18.2V21M10 8h4' },
  lavadero:  { n: 'Lavadero',  f: '#F1ECFB', c: '#6D3FA0', i: 'M2.5 9h19v4.5a3 3 0 0 1-3 3h-13a3 3 0 0 1-3-3zM6 16.5V21M18 16.5V21M10 9V5.5h4V9M7 12.5h10' },
  espejo:    { n: 'Espejo',    f: '#F4F6F8', c: '#607D8B', i: 'M12 2.8c3 0 5.2 3.2 5.2 7.4S15 17.6 12 17.6 6.8 14.4 6.8 10.2 9 2.8 12 2.8zM9 21h6M12 17.6V21M10 7.5l2.5-2' }
};
const ESTADOS_PIEZA = { ok: 'Funciona', reparacion: 'En reparación', danada: 'Dañada' };
const CON_PIEZAS = ['banos', 'lavanderia', 'otro'];

function svgPieza(tipo) {
  const t = TIPOS_PIEZA[tipo] || TIPOS_PIEZA.inodoro;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${t.i}" fill="${t.f}" stroke="${t.c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
const piezasBano = (espId) => S.piezas.filter((p) => p.espacio_id === espId)
  .sort((a, b) => Object.keys(TIPOS_PIEZA).indexOf(a.tipo) - Object.keys(TIPOS_PIEZA).indexOf(b.tipo) || a.orden - b.orden || String(a.nombre).localeCompare(String(b.nombre), 'es', { numeric: true }));

async function cargarPiezas() {
  try {
    S.piezas = await traerTodo(() => S.sb.from('viv_piezas').select('*').eq('empresa_id', S.empresaId).eq('activo', true).order('id'));
    S.piezasFalta = false;
  } catch (err) {
    S.piezas = [];
    S.piezasFalta = true;
  }
}

function piezaHtml(p) {
  if (!p.estado) p.estado = 'ok';
  return `<button type="button" class="hab-pieza hab-pieza--${esc(p.estado)}" data-pieza="${esc(p.id)}" title="${esc(p.nombre)} · ${esc(ESTADOS_PIEZA[p.estado] || '')}${p.nota ? ' · ' + esc(p.nota) : ''}">
    ${svgPieza(p.tipo)}<span>${esc(p.nombre)}</span>${p.estado !== 'ok' ? `<i class="hab-pieza-marca" aria-hidden="true">${p.estado === 'danada' ? '✕' : '🔧'}</i>` : ''}</button>`;
}

/* Resumen corto: 🚽 4 · 🚿 3 (con cuántas están dañadas) */
function resumenPiezas(espId) {
  const lista = piezasBano(espId);
  const mal = lista.filter((p) => p.estado !== 'ok').length;
  return { total: lista.length, mal };
}

/* Cuántas piezas de cada tipo tiene el espacio (con − / +) */
function modalPiezasConteo(esp) {
  if (S.piezasFalta) {
    const m0 = modal('Piezas del baño');
    m0.cuerpo.innerHTML = '<div class="hab-nota">Para registrar inodoros, duchas y lavamanos, el administrador debe ejecutar una vez <code>sql/habitaciones_etapa7_piezas_banos.sql</code> en Supabase.</div>';
    m0.botones([['Cerrar', 'boton-primario', () => m0.cerrar()]]);
    return;
  }
  const m = modal(`Piezas · ${esp.nombre}`);
  const actual = {};
  Object.keys(TIPOS_PIEZA).forEach((t) => { actual[t] = piezasBano(esp.id).filter((p) => p.tipo === t).length; });
  const quiere = { ...actual };
  const pintarC = () => {
    m.cuerpo.innerHTML = `<p class="ayuda">Indique cuántas hay de cada una. Cada pieza queda con su nombre (Ducha 1, Ducha 2…) y luego puede marcar si funciona, está en reparación o dañada tocándola.</p>
      <div class="hab-piezas-conteo">${Object.entries(TIPOS_PIEZA).map(([t, d]) => `
        <div class="hab-pc-fila">
          <span class="hab-pc-ico">${svgPieza(t)}</span>
          <b>${d.n}</b>
          <span class="hab-pc-ctrl">
            <button type="button" class="boton-secundario" data-menos="${t}" ${quiere[t] <= 0 ? 'disabled' : ''} aria-label="Una ${d.n.toLowerCase()} menos">−</button>
            <output>${quiere[t]}</output>
            <button type="button" class="boton-secundario" data-mas="${t}" ${quiere[t] >= 30 ? 'disabled' : ''} aria-label="Una ${d.n.toLowerCase()} más">+</button>
          </span>
        </div>`).join('')}</div>`;
    m.cuerpo.querySelectorAll('[data-menos]').forEach((b) => b.addEventListener('click', () => { quiere[b.dataset.menos]--; pintarC(); }));
    m.cuerpo.querySelectorAll('[data-mas]').forEach((b) => b.addEventListener('click', () => { quiere[b.dataset.mas]++; pintarC(); }));
  };
  pintarC();
  const guardar = (b) => conBoton(b, async () => {
    const altas = [], bajas = [];
    Object.keys(TIPOS_PIEZA).forEach((t) => {
      const tiene = piezasBano(esp.id).filter((p) => p.tipo === t);
      if (quiere[t] > tiene.length) {
        const nums = tiene.map((p) => parseInt(String(p.nombre).replace(/\D/g, ''), 10)).filter((x) => !isNaN(x));
        let k = nums.length ? Math.max(...nums) : 0;
        for (let i = tiene.length; i < quiere[t]; i++) {
          k++;
          altas.push(alCrear({ empresa_id: S.empresaId, espacio_id: esp.id, tipo: t, nombre: `${TIPOS_PIEZA[t].n} ${k}`, orden: k }));
        }
      } else if (quiere[t] < tiene.length) {
        // Se quitan primero las de número más alto
        tiene.slice().sort((a, b) => b.orden - a.orden).slice(0, tiene.length - quiere[t]).forEach((p) => bajas.push(p));
      }
    });
    if (!altas.length && !bajas.length) { m.cerrar(); return; }
    if (bajas.length && !confirm(`Se quitarán ${bajas.length} pieza(s): ${bajas.map((p) => p.nombre).join(', ')}. ¿Continuar?`)) return;
    if (altas.length) {
      const r = await S.sb.from('viv_piezas').insert(altas).select();
      if (r.error) return m.error(mensajeError(r.error));
      S.piezas.push(...(r.data || []));
    }
    if (bajas.length) {
      const r = await S.sb.from('viv_piezas').update(alEditar({ activo: false })).in('id', bajas.map((p) => p.id));
      if (r.error) return m.error(mensajeError(r.error));
      const fuera = new Set(bajas.map((p) => p.id));
      S.piezas = S.piezas.filter((p) => !fuera.has(p.id));
    }
    m.cerrar();
    toast(`${esp.nombre}: ${piezasBano(esp.id).length} pieza(s)`);
    pintar();
  });
  m.botones([['Cancelar', 'boton-secundario', () => m.cerrar()], ['Guardar', 'boton-primario', guardar]]);
}

/* Una pieza: nombre, estado y nota */
function modalPieza(p) {
  const m = modal(p.nombre);
  let estado = p.estado;
  m.cuerpo.innerHTML = `<div class="hab-form">
    <div class="hab-pieza-grande">${svgPieza(p.tipo)}</div>
    <div class="campo"><label class="etiqueta" for="hp-nombre">Nombre</label>
      <input class="entrada" id="hp-nombre" maxlength="40" value="${esc(p.nombre)}" ${S.estructura ? '' : 'disabled'}></div>
    <div class="campo"><span class="etiqueta">Estado</span>
      <div class="hab-pieza-estados">${Object.entries(ESTADOS_PIEZA).map(([k, v]) =>
        `<button type="button" class="hab-pe hab-pe--${k}" data-estado="${k}" aria-pressed="${k === estado}" ${S.estructura || S.asigna ? '' : 'disabled'}>${k === 'ok' ? '✅' : k === 'reparacion' ? '🔧' : '❌'} ${v}</button>`).join('')}</div></div>
    <div class="campo"><label class="etiqueta" for="hp-nota">Observación (opcional)</label>
      <input class="entrada" id="hp-nota" maxlength="200" value="${esc(p.nota || '')}" placeholder="Ej.: fuga en la llave, reportado el lunes" ${S.estructura || S.asigna ? '' : 'disabled'}></div>
  </div>`;
  m.cuerpo.querySelectorAll('[data-estado]').forEach((b) => b.addEventListener('click', () => {
    estado = b.dataset.estado;
    m.cuerpo.querySelectorAll('[data-estado]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.estado === estado)));
  }));
  const guardar = (b) => conBoton(b, async () => {
    const nombre = valor(m, 'hp-nombre');
    if (!nombre) return m.error('Escriba un nombre para la pieza.');
    const cambios = { nombre, estado, nota: valor(m, 'hp-nota') || null };
    const r = await S.sb.from('viv_piezas').update(alEditar(cambios)).eq('id', p.id);
    if (r.error) return m.error(mensajeError(r.error));
    Object.assign(p, cambios);
    m.cerrar();
    toast(`${p.nombre}: ${ESTADOS_PIEZA[estado]}`);
    pintar();
  });
  const quitar = (b) => conBoton(b, async () => {
    if (!confirm(`¿Quitar ${p.nombre}?`)) return;
    const r = await S.sb.from('viv_piezas').update(alEditar({ activo: false })).eq('id', p.id);
    if (r.error) return m.error(mensajeError(r.error));
    S.piezas = S.piezas.filter((x) => x.id !== p.id);
    m.cerrar();
    pintar();
  });
  const lista = [['Cerrar', 'boton-secundario', () => m.cerrar()]];
  if (S.estructura) lista.push(['Quitar pieza', 'boton-secundario boton-critico', quitar]);
  if (S.estructura || S.asigna) lista.push(['Guardar', 'boton-primario', guardar]);
  m.botones(lista);
}

/* Agrega una sola pieza (clic derecho en el plano) */
async function agregarPieza(esp, tipo, px = null, py = null) {
  if (S.piezasFalta) { modalPiezasConteo(esp); return; }
  const tiene = piezasBano(esp.id).filter((p) => p.tipo === tipo);
  const nums = tiene.map((p) => parseInt(String(p.nombre).replace(/\D/g, ''), 10)).filter((x) => !isNaN(x));
  const k = (nums.length ? Math.max(...nums) : 0) + 1;
  const fila = alCrear({ empresa_id: S.empresaId, espacio_id: esp.id, tipo, nombre: `${TIPOS_PIEZA[tipo].n} ${k}`, orden: k,
    ...(px != null ? { plano_px: Math.round(px * 100) / 100, plano_py: Math.round(py * 100) / 100 } : {}) });
  const r = await S.sb.from('viv_piezas').insert(fila).select().single();
  if (r.error) { toast(mensajeError(r.error)); return; }
  S.piezas.push(r.data);
  toast(`${r.data.nombre} agregado`);
  pintar();
}

/* Piezas dentro del cuarto en el plano: en su lugar guardado o, si no
   tiene, acomodadas en filas. Quien edita las arrastra a su sitio. */
function piezasPl(d, esp, editando, el) {
  const lista = piezasBano(esp.id);
  if (!lista.length) return;
  const cont = document.createElement('div');
  cont.className = 'hab-pl-piezas';
  // Cuadrícula según el tamaño del cuarto (cada pieza ocupa unas 3 × 3 celdas)
  const W = el ? el.w : 10, H = el ? el.h : 8;
  const porFila = Math.max(1, Math.min(lista.length, Math.floor(W / 2.8)));
  const filas = Math.ceil(lista.length / porFila);
  if (filas * 2.8 > H - 1 || porFila * 2.8 > W + 0.5) cont.classList.add('hab-pl-piezas--apretado');
  lista.forEach((p, i) => {
    const b = document.createElement('div');
    b.innerHTML = piezaHtml(p);
    const $p = b.firstElementChild;
    $p.classList.add('hab-pl-pieza');
    const fx = p.plano_px != null ? Number(p.plano_px) : ((i % porFila) + 0.5) / porFila * 100;
    const fy = p.plano_py != null ? Number(p.plano_py) : 14 + (Math.floor(i / porFila) + 0.5) / filas * 84;
    $p.style.left = Math.min(92, Math.max(8, fx)) + '%';
    $p.style.top = Math.min(90, Math.max(10, fy)) + '%';
    let arr = null;
    $p.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!editando || e.button !== 0) return;
      e.preventDefault();
      arr = { x: e.clientX, y: e.clientY, movio: false };
      $p.setPointerCapture(e.pointerId);
    });
    $p.addEventListener('pointermove', (e) => {
      if (!arr) return;
      if (Math.abs(e.clientX - arr.x) + Math.abs(e.clientY - arr.y) > 4) arr.movio = true;
      if (!arr.movio) return;
      const r = d.getBoundingClientRect();
      $p.style.left = Math.min(95, Math.max(5, (e.clientX - r.left) / r.width * 100)) + '%';
      $p.style.top = Math.min(95, Math.max(5, (e.clientY - r.top) / r.height * 100)) + '%';
    });
    $p.addEventListener('pointerup', async () => {
      if (!arr) return;
      const movio = arr.movio; arr = null;
      if (!movio) { modalPieza(p); return; }
      const px = Math.round(parseFloat($p.style.left) * 100) / 100, py = Math.round(parseFloat($p.style.top) * 100) / 100;
      const r = await S.sb.from('viv_piezas').update(alEditar({ plano_px: px, plano_py: py })).eq('id', p.id);
      if (r.error) { toast(mensajeError(r.error)); return; }
      p.plano_px = px; p.plano_py = py;
    });
    if (!editando) $p.addEventListener('click', (e) => { e.stopPropagation(); modalPieza(p); });
    cont.appendChild($p);
  });
  d.appendChild(cont);
  d.classList.add('hab-pl-el--con-piezas');
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
  await cargarAreas();
  await cargarPiezas();
  await cargarCroquis();
  await cargarSeguridad();
}

/* Áreas de trabajo (etapa 5). Si falta el SQL, todo lo demás sigue igual. */
async function cargarAreas() {
  try {
    S.areas = await traerTodo(() => S.sb.from('viv_areas').select('*').eq('empresa_id', S.empresaId).eq('activo', true).order('orden').order('nombre'));
    S.areasFalta = false;
  } catch (err) {
    S.areas = [];
    S.areasFalta = true;
  }
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
  if (!salirDelPlanoOk()) return;
  S.nav = { sucursalId: null, baseId: null, edificioId: null, ...nav };
  S.editando = false;
  S.selEspacio = null;
  S.resaltar = null;
  S.cq = null;
  S.pl = null;
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
  if (S.vistaEdif === 'plano') { vistaPlano($v, edif); return; }
  const c = conteo(camasDeEdificio(edif.id));
  const sel = S.editando && S.selEspacio ? porId(S.espacios, S.selEspacio) : null;

  $v.innerHTML = `
    <div class="hab-cabeza">
      <h2 class="hab-titulo">${esc(edif.nombre)} <small>código ${esc(edif.codigo)}</small></h2>
      <div class="hab-cabeza-acciones">
        ${!S.editando && !S.segEdit ? '<button class="boton-secundario" id="hab-imprimir" type="button">Imprimir planos</button>' : ''}
        ${S.estructura || S.areas.length ? '<button class="boton-secundario" id="hab-areas" type="button">🏷️ Áreas</button>' : ''}
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
      ${chipsVistaEdif(S.editando || S.segEdit)}
      <div class="hab-filtros">
        <button class="hab-chip" id="hab-detalle" type="button" aria-pressed="${S.detalle}">Ver camas en detalle</button>
        <button class="hab-chip" id="hab-libres" type="button" aria-pressed="${S.soloLibres}">Solo habitaciones con camas libres</button>
      </div>
    </div>
    ${leyendaAreasHtml(edif)}
    ${barraSeguridadHtml(edif)}
    ${S.editando ? herramientasHtml(sel) : ''}
    <div class="hab-fachada ${S.editando ? 'hab-editando' : ''} ${S.detalle ? '' : 'hab-compacta'}" id="hab-fachada"></div>`;

  document.getElementById('hab-config-edif')?.addEventListener('click', () => modalEdificio(edif));
  document.getElementById('hab-areas')?.addEventListener('click', () => modalAreas());
  document.getElementById('hab-imprimir')?.addEventListener('click', () => modalImprimir(edif));
  document.getElementById('hab-modo')?.addEventListener('click', () => {
    S.editando = !S.editando; S.selEspacio = null;
    if (S.editando) { S.segEdit = false; S.segColocar = null; }
    pintar();
  });
  document.getElementById('hab-libres').addEventListener('click', () => { S.soloLibres = !S.soloLibres; pintar(); });
  document.getElementById('hab-detalle').addEventListener('click', () => { S.detalle = !S.detalle; pintar(); });
  if (S.editando) conectarHerramientas(sel);
  conectarChipsVistaEdif();
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
    if (!edif.tiene_frentes && pasilloDe(edif, p) === 'lado') planta.appendChild(pasilloHtml('lado'));
    $f.appendChild(planta);
  }
  $f.insertAdjacentHTML('beforeend', '<div class="hab-suelo" aria-hidden="true"></div>');
  marcarGruposArea($f);
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
  const tipoPasillo = pasilloDe(edif, planta);
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
    const piezas = piezasBano(esp.id);
    d.className = 'hab-esp hab-esp--otro' + (seleccionado ? ' hab-esp--sel' : '') + (piezas.length ? ' hab-esp--con-piezas' : '');
    d.innerHTML = `${svgIcono(esp.tipo)}<span>${esc(esp.nombre)}</span>${esp.frente === 'AB' ? '<span class="hab-ab">Frentes A y B</span>' : ''}
      ${piezas.length ? `<div class="hab-piezas">${piezas.map(piezaHtml).join('')}</div>` : ''}`;
    d.querySelectorAll('[data-pieza]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = S.piezas.find((x) => String(x.id) === b.dataset.pieza);
      if (p) modalPieza(p);
    }));
  } else {
    const camas = camasDe(esp.id);
    const ocup = camas.filter((c) => asigDeCama(c.id)).length;
    const tenue = S.soloLibres && !S.editando && (camas.length === 0 || ocup === camas.length);
    const area = areaDe(esp);
    d.className = 'hab-esp' + (tenue ? ' hab-esp--tenue' : '') + (seleccionado ? ' hab-esp--sel' : '') + (area ? ' hab-esp--area' : '');
    if (area) { d.style.setProperty('--area', area.color); d.dataset.area = area.id; }
    d.innerHTML = `${area ? etiquetaArea(area) : ''}<div class="hab-esp-cabeza"><b>Hab. ${esc(esp.nombre)}</b>
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

  if (!S.editando && esp.tipo !== 'sin_construir' && planoDisponible()) {
    // Flujo guiado: tocar la habitación (no una cama) abre su plano para el detalle interior
    d.classList.add('hab-esp--entrable');
    d.title = 'Toque para ver y editar por dentro (plano)';
    d.addEventListener('click', (e) => {
      if (e.target.closest('.hab-cama, button, a, .hab-litera-nombre')) return;
      abrirPlanoEn(esp);
    });
  }
  if (S.editando) {
    d.addEventListener('dblclick', (e) => { e.preventDefault(); abrirPlanoEn(esp); });
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

/* ============================================
   ÁREAS DE TRABAJO (etapa 5)
   Cada habitación puede llevar un área (Mecánicos, Cocina…)
   con su dibujo y su color; se ve encima de la habitación.
   ============================================ */
const AREAS_SUGERIDAS = [
  ['Mecánicos', '🔧', '#607D8B'], ['Choferes', '🚚', '#00B4FF'], ['Supervisores', '🦺', '#FFD400'],
  ['Operadores de maquinaria', '🚜', '#FF9F1C'], ['Guardias ADAE', '🛡️', '#2D5BFF'], ['Guardias AGRIMROC', '👮', '#22E06B'],
  ['Cocina', '🍳', '#FF2D55'], ['Geología', '⛏️', '#B5651D'], ['Eléctricos', '⚡', '#B026FF'],
  ['Personal de salud', '🩺', '#00E5D4']
];
const ICONOS_AREA = ['🔧', '🛠️', '⚙️', '🚚', '🚗', '🚌', '🚜', '🏗️', '🦺', '👷', '👮', '🛡️', '💂', '🍳', '👨‍🍳', '🍽️',
  '⛏️', '🪨', '💎', '⚡', '🔌', '💡', '🧪', '🩺', '💊', '🧹', '🧺', '📋', '💻', '📦', '🔥', '💧', '🌱', '📡', '🔩', '🧰'];
/* Colores vivos (tono neón) */
const COLORES_AREA = ['#FF6A00', '#00B4FF', '#FFD400', '#FF9F1C', '#2D5BFF', '#22E06B', '#FF2D55', '#B5651D',
  '#B026FF', '#00E5D4', '#FF4FD8', '#A3FF12', '#FF3B30', '#7C4DFF', '#00C853', '#607D8B'];

/* Letra oscura sobre colores claros (amarillo, lima…), blanca sobre los demás */
function textoSobre(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#1b1f24' : '#fff';
}

function areaDe(esp) {
  return esp && esp.area_id ? S.areas.find((a) => a.id === esp.area_id) || null : null;
}
function etiquetaArea(area, clase = 'hab-area') {
  return `<div class="${clase}" style="--area:${esc(area.color)};--area-t:${textoSobre(area.color)}" title="Área: ${esc(area.nombre)}"><span class="hab-area-ico" aria-hidden="true">${esc(area.icono)}</span><span>${esc(area.nombre)}</span></div>`;
}

/* Asigna (o quita) el área de un espacio sin recargar toda la pestaña */
async function asignarArea(esp, areaId) {
  const { error } = await S.sb.from('viv_espacios').update(alEditar({ area_id: areaId })).eq('id', esp.id);
  if (error) { toast(mensajeError(error)); return; }
  esp.area_id = areaId;
  const a = areaDe(esp);
  toast(a ? `${nombreEspCorto(esp)}: ${a.nombre}` : `${nombreEspCorto(esp)}: sin área`);
  pintar();
}
function nombreEspCorto(esp) { return esp.tipo === 'habitacion' ? `Hab. ${esp.nombre}` : esp.nombre; }

/* Leyenda con las áreas que hay en el edificio */
function leyendaAreasHtml(edif) {
  if (!S.areas.length) return '';
  const usadas = new Map();
  espaciosDe(edif.id).forEach((x) => { const a = areaDe(x); if (a) usadas.set(a.id, (usadas.get(a.id) || 0) + 1); });
  if (!usadas.size) return '';
  return `<div class="hab-areas-leyenda" aria-label="Áreas de este edificio">${S.areas.filter((a) => usadas.has(a.id)).map((a) =>
    `<span class="hab-area-chip" style="--area:${esc(a.color)};--area-t:${textoSobre(a.color)}">${esc(a.icono)} ${esc(a.nombre)} <b>${usadas.get(a.id)}</b></span>`).join('')}</div>`;
}

/* Habitaciones PEGADAS de la misma área (2 o más): un solo contorno neón
   alrededor del grupo. Cada habitación dibuja solo los lados exteriores
   del grupo; los lados que comparte con su vecina quedan sin línea. */
function marcarGruposArea($f) {
  $f.querySelectorAll('.hab-esp[data-area]').forEach((d) => {
    const mismo = (x) => x && x.classList && x.classList.contains('hab-esp') && x.dataset.area === d.dataset.area;
    const ant = mismo(d.previousElementSibling), sig = mismo(d.nextElementSibling);
    if (!ant && !sig) return;
    d.classList.add('hab-grupo');
    if (ant) d.classList.add('hab-grupo-sin-o');
    if (sig) d.classList.add('hab-grupo-sin-e');
  });
}

/* En el plano: se tocan (o hay 1 cuadrito entre ellas) y comparten al menos la mitad de una pared */
function marcarGruposPl($pl, elems) {
  const conArea = elems.map((el) => ({ el, esp: porId(S.espacios, el.id) }))
    .filter((x) => x.esp && x.esp.tipo === 'habitacion' && areaDe(x.esp));
  // Comparten pared: al menos la mitad del lado más corto
  const cruza = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1) >= Math.min(a2 - a1, b2 - b1) / 2;
  conArea.forEach(({ el, esp }) => {
    const lados = { n: false, s: false, e: false, o: false };
    conArea.forEach((o) => {
      if (o.el === el || o.esp.area_id !== esp.area_id) return;
      const b = o.el;
      if (cruza(el.y, el.y + el.h, b.y, b.y + b.h)) {
        const dE = b.x - (el.x + el.w), dO = el.x - (b.x + b.w);
        if (dE >= 0 && dE <= 1) lados.e = true;
        if (dO >= 0 && dO <= 1) lados.o = true;
      }
      if (cruza(el.x, el.x + el.w, b.x, b.x + b.w)) {
        const dS = b.y - (el.y + el.h), dN = el.y - (b.y + b.h);
        if (dS >= 0 && dS <= 1) lados.s = true;
        if (dN >= 0 && dN <= 1) lados.n = true;
      }
    });
    if (!lados.n && !lados.s && !lados.e && !lados.o) return;
    const d = $pl.querySelector(`[data-clave="${CSS.escape(String(el.id))}"]`);
    if (!d) return;
    d.classList.add('hab-grupo');
    Object.keys(lados).forEach((k) => { if (lados[k]) d.classList.add('hab-grupo-sin-' + k); });
  });
}

/* alVolver(areaId): si se abrió desde una habitación, al crear un área
   se vuelve a la habitación con esa área ya elegida */
function modalAreas(alVolver = null, abrirNueva = false) {
  const m = modal('Áreas de trabajo');
  if (S.areasFalta) {
    m.cuerpo.innerHTML = '<div class="hab-nota">Para usar las áreas, el administrador debe ejecutar una vez <code>sql/habitaciones_etapa5_areas.sql</code> en Supabase.</div>';
    m.botones([['Cerrar', 'boton-primario', () => m.cerrar()]]);
    return;
  }
  const pintarLista = () => {
    m.cuerpo.innerHTML = `<p class="ayuda">Cada habitación puede llevar un área. Se ve encima de la habitación con su dibujo y su color. Se asigna en «Editar» de la habitación o con clic derecho en el plano.</p>
      <div class="hab-areas-lista">${S.areas.length ? S.areas.map((a) => `
        <div class="hab-area-fila">${etiquetaArea(a)}
          <span class="hab-area-uso">${S.espacios.filter((x) => x.area_id === a.id).length} habitación(es)</span>
          ${S.estructura ? `<button class="boton-secundario boton-compacto" type="button" data-editar="${a.id}">Editar</button>` : ''}
        </div>`).join('') : '<div class="hab-vacio">Aún no hay áreas.</div>'}</div>`;
    m.cuerpo.querySelectorAll('[data-editar]').forEach((b) => b.addEventListener('click', () => formArea(porId(S.areas, Number(b.dataset.editar)) || S.areas.find((x) => String(x.id) === b.dataset.editar))));
    const botones = [[alVolver ? 'Volver' : 'Cerrar', 'boton-secundario', () => { m.cerrar(); if (alVolver) alVolver(null); }]];
    if (S.estructura && !S.areas.length) botones.push(['Cargar áreas sugeridas', 'boton-secundario', cargarSugeridas]);
    if (S.estructura && S.areas.length) botones.push(['Aplicar colores nuevos', 'boton-secundario', actualizarPaleta]);
    if (S.estructura) botones.push(['+ Nueva área', 'boton-primario', () => formArea(null)]);
    m.botones(botones);
  };
  /* Pone a las áreas sugeridas los colores vivos actuales (por nombre) y
     agrega las sugeridas que falten (por ejemplo, Personal de salud).
     Las áreas creadas a mano no se tocan. */
  const actualizarPaleta = (b) => conBoton(b, async () => {
    const norm = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    let cambiadas = 0;
    const nuevas = [];
    for (let i = 0; i < AREAS_SUGERIDAS.length; i++) {
      const [nombre, icono, color] = AREAS_SUGERIDAS[i];
      const a = S.areas.find((x) => norm(x.nombre) === norm(nombre));
      if (a) {
        if (a.color.toLowerCase() !== color.toLowerCase()) {
          const r = await S.sb.from('viv_areas').update(alEditar({ color })).eq('id', a.id);
          if (r.error) return m.error(mensajeError(r.error));
          cambiadas++;
        }
      } else {
        nuevas.push(alCrear({ empresa_id: S.empresaId, nombre, icono, color, orden: (i + 1) * 10 }));
      }
    }
    if (nuevas.length) {
      const r = await S.sb.from('viv_areas').insert(nuevas);
      if (r.error) return m.error(mensajeError(r.error));
    }
    await cargarAreas();
    pintarLista();
    pintar();
    toast(`Colores actualizados: ${cambiadas}${nuevas.length ? ` · áreas agregadas: ${nuevas.map((x) => x.nombre).join(', ')}` : ''}`);
  });
  const cargarSugeridas = (b) => conBoton(b, async () => {
    const filas = AREAS_SUGERIDAS.map(([nombre, icono, color], i) => alCrear({ empresa_id: S.empresaId, nombre, icono, color, orden: (i + 1) * 10 }));
    const { error } = await S.sb.from('viv_areas').insert(filas);
    if (error) return m.error(mensajeError(error));
    await cargarAreas();
    pintarLista();
    pintar();
  });

  const formArea = (area) => {
    m.titulo(area ? `Editar área · ${area.nombre}` : 'Nueva área');
    let icono = area?.icono || ICONOS_AREA[0];
    let color = area?.color || COLORES_AREA[0];
    m.cuerpo.innerHTML = `<div class="hab-form">
      <div class="hab-area-muestra" id="ha-muestra"></div>
      <div class="campo"><label class="etiqueta" for="ha-nombre">Nombre del área o cargo</label>
        <input class="entrada" id="ha-nombre" maxlength="40" value="${esc(area?.nombre || '')}" placeholder="Ej.: Mecánicos, Cocina, Guardias ADAE"></div>
      <div class="campo"><span class="etiqueta">Dibujo</span>
        <div class="hab-area-iconos" role="radiogroup" aria-label="Dibujo">${ICONOS_AREA.map((ic) =>
          `<button type="button" class="hab-area-ico-op" data-ico="${ic}" role="radio" aria-checked="false" aria-label="${ic}">${ic}</button>`).join('')}</div>
        <label class="ayuda" for="ha-ico-libre">¿No está el dibujo? Escriba o pegue cualquier emoji:
          <input class="entrada hab-area-ico-libre" id="ha-ico-libre" maxlength="8" value=""></label></div>
      <div class="campo"><span class="etiqueta">Color</span>
        <div class="hab-area-colores">${COLORES_AREA.map((c) =>
          `<button type="button" class="hab-area-color-op" data-color="${c}" style="--c:${c}" aria-label="Color ${c}"></button>`).join('')}
          <label class="hab-area-color-libre" title="Otro color"><input type="color" id="ha-color" value="${esc(color)}"> Otro</label></div></div>
    </div>`;
    const $n = m.cuerpo.querySelector('#ha-nombre');
    const muestra = () => {
      m.cuerpo.querySelector('#ha-muestra').innerHTML = etiquetaArea({ nombre: $n.value.trim() || 'Nombre del área', icono, color });
      m.cuerpo.querySelectorAll('.hab-area-ico-op').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.ico === icono)));
      m.cuerpo.querySelectorAll('.hab-area-color-op').forEach((b) => b.classList.toggle('activo', b.dataset.color.toLowerCase() === color.toLowerCase()));
    };
    $n.addEventListener('input', muestra);
    m.cuerpo.querySelectorAll('.hab-area-ico-op').forEach((b) => b.addEventListener('click', () => { icono = b.dataset.ico; m.cuerpo.querySelector('#ha-ico-libre').value = ''; muestra(); }));
    m.cuerpo.querySelector('#ha-ico-libre').addEventListener('input', (e) => { const v = e.target.value.trim(); if (v) { icono = v; muestra(); } });
    m.cuerpo.querySelectorAll('.hab-area-color-op').forEach((b) => b.addEventListener('click', () => { color = b.dataset.color; m.cuerpo.querySelector('#ha-color').value = color; muestra(); }));
    m.cuerpo.querySelector('#ha-color').addEventListener('input', (e) => { color = e.target.value; muestra(); });
    muestra();

    const guardar = (b) => conBoton(b, async () => {
      const nombre = $n.value.trim();
      if (nombre.length < 2) return m.error('Escriba el nombre del área (al menos 2 letras).');
      if (S.areas.some((x) => x.id !== area?.id && x.nombre.toLowerCase() === nombre.toLowerCase())) return m.error('Ya existe un área con ese nombre.');
      const datos = { nombre, icono, color };
      const r = area
        ? await S.sb.from('viv_areas').update(alEditar(datos)).eq('id', area.id)
        : await S.sb.from('viv_areas').insert(alCrear({ ...datos, empresa_id: S.empresaId, orden: (S.areas.length + 1) * 10 }));
      if (r.error) return m.error(mensajeError(r.error));
      await cargarAreas();
      toast(area ? 'Área actualizada' : `Área «${nombre}» creada`);
      if (alVolver) {
        const nueva = area || S.areas.find((x) => x.nombre.toLowerCase() === nombre.toLowerCase());
        m.cerrar();
        pintar();
        alVolver(nueva ? nueva.id : null);
        return;
      }
      m.titulo('Áreas de trabajo');
      pintarLista();
      pintar();
    });
    const quitar = (b) => conBoton(b, async () => {
      const uso = S.espacios.filter((x) => x.area_id === area.id).length;
      if (!confirm(`¿Quitar el área «${area.nombre}»?${uso ? ` ${uso} habitación(es) quedarán sin área.` : ''}`)) return;
      if (uso) {
        const r1 = await S.sb.from('viv_espacios').update(alEditar({ area_id: null })).eq('area_id', area.id);
        if (r1.error) return m.error(mensajeError(r1.error));
        S.espacios.forEach((x) => { if (x.area_id === area.id) x.area_id = null; });
      }
      const r = await S.sb.from('viv_areas').update(alEditar({ activo: false })).eq('id', area.id);
      if (r.error) return m.error(mensajeError(r.error));
      await cargarAreas();
      m.titulo('Áreas de trabajo');
      pintarLista();
      pintar();
    });
    const lista = [['Volver', 'boton-secundario', () => { m.titulo('Áreas de trabajo'); pintarLista(); }]];
    if (area) lista.push(['Quitar área', 'boton-secundario boton-critico', quitar]);
    lista.push([area ? 'Guardar' : 'Crear área', 'boton-primario', guardar]);
    m.botones(lista);
    $n.focus();
  };
  if (abrirNueva && S.estructura) formArea(null); else pintarLista();
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
    const { data: creada, error } = nueva
      ? await S.sb.from('viv_bases').insert(alCrear({ ...fila, empresa_id: S.empresaId, sucursal_id: S.nav.sucursalId })).select().single()
      : await S.sb.from('viv_bases').update(alEditar(fila)).eq('id', base.id);
    if (error) return m.error(mensajeError(error));
    m.cerrar();
    toast(nueva ? `Base «${nombre}» creada. Ubique sus edificios y demás elementos en el croquis.` : 'Base actualizada');
    await recargar();
    // Flujo guiado: la base nueva se abre en su croquis, listo para dibujar
    if (nueva && creada && !S.croquisFalta) {
      const b2 = porId(S.bases, creada.id);
      if (b2) {
        S.nav = { sucursalId: b2.sucursal_id, baseId: b2.id, edificioId: null };
        S.vistaBase = 'croquis';
        S.cq = { baseId: b2.id, elems: elementosCroquis(b2), sel: null, quitados: [] };
        pintar();
      }
    }
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
    <div class="campo" id="he-pp-campo"><span class="etiqueta">Pasillo por planta</span>
      <div class="hab-pp" id="he-pp"></div>
      <span class="ayuda">Si una planta es distinta (por ejemplo, planta baja con cuartos espalda con espalda que salen directo afuera, y plantas de arriba con pasillo en medio), elíjalo aquí.</span></div>
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

  /* Pasillo por planta (etapa 6): la columna existe si algún edificio la trae */
  const hayPP = S.edificios.some((x) => 'pasillos_planta' in x);
  const ppActual = { ...(edif?.pasillos_planta || {}) };
  const $pp = m.cuerpo.querySelector('#he-pp');
  const $plantas = m.cuerpo.querySelector('#he-plantas');
  const pintarPP = () => {
    $pp.querySelectorAll('select').forEach((x) => { ppActual[x.dataset.planta] = x.value; });
    const total = parseInt($plantas.value, 10) || 1;
    const claves = $fr.checked ? ['central', 'frente', 'ninguno'] : ['lado', 'ninguno'];
    const nombreGeneral = PASILLOS[$pa.value] || '';
    $pp.innerHTML = Array.from({ length: total }, (_, i) => i + 1).map((k) => `<label class="hab-pp-fila">
      <span>${nombrePlanta(k, total)}</span>
      <select class="entrada" data-planta="${k}">
        <option value="">Igual que el edificio (${esc(nombreGeneral.toLowerCase())})</option>
        ${claves.map((c) => `<option value="${c}" ${ppActual[k] === c ? 'selected' : ''}>${c === 'ninguno' && $fr.checked ? 'Espalda con espalda, salen directo afuera (sin pasillo)' : PASILLOS[c]}</option>`).join('')}
      </select></label>`).join('');
  };
  if (!hayPP && S.edificios.length) {
    m.cuerpo.querySelector('#he-pp-campo').innerHTML = '<span class="etiqueta">Pasillo por planta</span><span class="ayuda">Para elegir un pasillo distinto en cada planta, el administrador debe ejecutar una vez <code>sql/habitaciones_etapa6_pasillo_por_planta.sql</code> en Supabase.</span>';
  }
  const conPP = () => !!m.cuerpo.querySelector('#he-pp');
  const extraPP = () => {
    if (!conPP()) return {};
    const out = {};
    $pp.querySelectorAll('select').forEach((x) => { if (x.value) out[x.dataset.planta] = x.value; });
    return hayPP || Object.keys(out).length ? { pasillos_planta: out } : {};
  };

  $fr.addEventListener('change', () => { opcionesPasillo(); ordenCampo(); if (conPP()) pintarPP(); });
  $pa.addEventListener('change', () => { if (conPP()) pintarPP(); });
  $plantas.addEventListener('change', () => { if (conPP()) pintarPP(); });
  opcionesPasillo();
  ordenCampo();
  if (conPP()) pintarPP();
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
        ...(S.seguridadFalta ? {} : { pasillo: valor(m, 'he-pasillo') }), ...extraOrden(), ...extraPP()
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
        ...(S.seguridadFalta ? {} : { pasillo: valor(m, 'he-pasillo') }), ...extraOrden(), ...extraPP() })).eq('id', edif.id);
    if (error) return m.error(/pasillos_planta/.test(error.message || '') ? 'Para elegir el pasillo de cada planta, el administrador debe ejecutar sql/habitaciones_etapa6_pasillo_por_planta.sql en Supabase.' : mensajeError(error));
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
  const puedeArriba = !!destinoVertical(sel, -1), puedeAbajo = !!destinoVertical(sel, 1);
  const btn = (h, texto, extra = '', des = false) =>
    `<button class="boton-secundario boton-compacto ${extra}" type="button" data-h="${h}" ${des ? 'disabled' : ''}>${texto}</button>`;
  return `<div class="hab-herramientas" role="toolbar" aria-label="Editar ${esc(sel.nombre)}">
    <span class="hab-herramientas-nombre">${hab ? 'Habitación ' : ''}${esc(sel.nombre)} · ${TAMANOS[sel.ancho]}</span>
    ${btn('izq', '← Mover', '', !puedeIzq)}
    ${btn('der', 'Mover →', '', !puedeDer)}
    ${btn('arriba', '↑ Subir', '', !puedeArriba)}
    ${btn('abajo', '↓ Bajar', '', !puedeAbajo)}
    ${btn('menos', '− Angosto', '', sel.ancho <= 1)}
    ${btn('mas', '+ Ancho', '', sel.ancho >= ANCHO_MAX)}
    ${hab ? btn('cama', '+ Cama o litera') : ''}
    ${hab ? btn('quitar-cama', '− Cama o litera', '', camasDe(sel.id).length === 0) : ''}
    ${CON_PIEZAS.includes(sel.tipo) ? btn('piezas', `🚽 Piezas${piezasBano(sel.id).length ? ` (${piezasBano(sel.id).length})` : ''}`) : ''}
    ${btn('editar', 'Nombre o tipo')}
    ${planoDisponible() ? btn('plano', 'Por dentro (plano) ▸') : ''}
    ${btn('quitar', 'Quitar', 'boton-critico')}
  </div>`;
}

function conectarHerramientas(sel) {
  if (!sel) return;
  const h = (k) => document.querySelector(`.hab-herramientas [data-h="${k}"]`);
  h('izq')?.addEventListener('click', () => moverEspacio(sel, -1));
  h('der')?.addEventListener('click', () => moverEspacio(sel, 1));
  h('arriba')?.addEventListener('click', () => moverVertical(sel, -1));
  h('abajo')?.addEventListener('click', () => moverVertical(sel, 1));
  conectarTeclasEdicion();
  h('menos')?.addEventListener('click', () => cambiarAncho(sel, -1));
  h('mas')?.addEventListener('click', () => cambiarAncho(sel, 1));
  h('cama')?.addEventListener('click', () => modalAgregarCama(sel));
  h('quitar-cama')?.addEventListener('click', () => modalQuitarCamas(sel));
  h('piezas')?.addEventListener('click', () => modalPiezasConteo(sel));
  h('editar')?.addEventListener('click', () => {
    const edif = porId(S.edificios, sel.edificio_id);
    modalEspacio(sel, { edif, planta: sel.planta, frente: sel.frente });
  });
  h('quitar')?.addEventListener('click', () => modalQuitarEspacio(sel));
  h('plano')?.addEventListener('click', () => abrirPlanoEn(sel));
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

/* ---------- Subir o bajar un espacio (↑ ↓) ----------
   Filas de arriba hacia abajo: planta más alta primero y, en
   cada planta, el frente de arriba y luego el de abajo. Subir
   lleva el espacio a la fila de arriba (otro frente u otra
   planta) en la misma posición horizontal. */
function filasVisuales(edif) {
  const filas = [];
  const [arriba, abajo] = edif.frentes_invertidos ? ['B', 'A'] : ['A', 'B'];
  for (let p = edif.num_plantas; p >= 1; p--) {
    if (edif.tiene_frentes) filas.push({ planta: p, frente: arriba }, { planta: p, frente: abajo });
    else filas.push({ planta: p, frente: null });
  }
  return filas;
}
function destinoVertical(esp, dir) {
  const edif = porId(S.edificios, esp.edificio_id);
  if (!edif) return null;
  if (esp.frente === 'AB') {                        // ocupa ambos frentes: solo cambia de planta
    const p = esp.planta - dir;
    return p >= 1 && p <= edif.num_plantas ? { planta: p, frente: 'AB' } : null;
  }
  const filas = filasVisuales(edif);
  const i = filas.findIndex((f) => f.planta === esp.planta && (f.frente || null) === (esp.frente || null));
  return i < 0 ? null : filas[i + dir] || null;
}
async function moverVertical(esp, dir) {
  const edif = porId(S.edificios, esp.edificio_id);
  const dest = destinoVertical(esp, dir);
  if (!edif || !dest) return;
  // Posición horizontal actual dentro de su fila
  const filaAct = filaDe(edif.id, esp.planta, esp.frente === 'AB' ? 'A' : esp.frente);
  const pos = Math.max(0, filaAct.findIndex((x) => x.id === esp.id));
  // Fila destino (sin el propio espacio) y vecino que quedará a su derecha
  const filaDest = filaDe(edif.id, dest.planta, dest.frente === 'AB' ? 'A' : dest.frente).filter((x) => x.id !== esp.id);
  const siguiente = filaDest[pos] || null;
  const anterior = pos > 0 ? filaDest[Math.min(pos, filaDest.length) - 1] : null;
  // Orden de toda la planta destino con el espacio insertado
  const todos = espaciosDe(edif.id).filter((x) => x.planta === dest.planta && x.id !== esp.id).sort(porOrden);
  let k = siguiente ? todos.indexOf(siguiente) : (anterior ? todos.indexOf(anterior) + 1 : todos.length);
  if (k < 0) k = todos.length;
  todos.splice(k, 0, esp);
  const cambiaPlanta = dest.planta !== esp.planta;
  const cambios = [];
  todos.forEach((x, n) => {
    const orden = (n + 1) * 10;
    if (x === esp) {
      const c = { orden, planta: dest.planta, frente: dest.frente };
      // En otra planta, su lugar en el plano se vuelve a ubicar allá
      if (cambiaPlanta && 'plano_x' in esp) Object.assign(c, { plano_x: null, plano_y: null, plano_w: null, plano_h: null });
      cambios.push([x, c]);
    } else if (x.orden !== orden) cambios.push([x, { orden }]);
  });
  const res = await Promise.all(cambios.map(([x, c]) => S.sb.from('viv_espacios').update(alEditar(c)).eq('id', x.id)));
  const fallo = res.find((r) => r.error);
  if (fallo) { toast(mensajeError(fallo.error)); await recargar(); return; }
  cambios.forEach(([x, c]) => Object.assign(x, c));
  // Equipos de seguridad pegados a ese espacio viajan con él
  if (cambiaPlanta && !S.seguridadFalta) {
    const suyos = (S.seguridad || []).filter((q) => q.ancla_espacio === esp.id);
    if (suyos.length) {
      await S.sb.from('viv_seguridad').update(alEditar({ planta: dest.planta })).eq('ancla_espacio', esp.id);
      suyos.forEach((q) => { q.planta = dest.planta; });
    }
  }
  toast(`${nombreEspCorto(esp)} → ${nombrePlanta(dest.planta, edif.num_plantas)}${dest.frente && dest.frente !== 'AB' ? ` · frente ${dest.frente}` : ''}`);
  pintar();
}

/* Abre el plano del piso de ese espacio con el espacio elegido (para cuartos o baños internos) */
function abrirPlanoEn(esp) {
  S.editando = false; S.selEspacio = null;
  S.vistaEdif = 'plano';
  S.planoPlanta = esp.planta;
  S.pl = null;
  pintar();
  if (!S.pl) return;
  if (!S.pl.elems.some((x) => x.id === esp.id)) {
    const el = ubicarEnPlano(esp);
    S.pl.cambios = true;
    S.pl.conocidos.add(esp.id);
    if (el) S.pl.sel = el.id;
  }
  S.pl.sel = esp.id;
  pintar();
  document.querySelector(`.hab-pl-el[data-clave="${CSS.escape(String(esp.id))}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast(`${nombreEspCorto(esp)}: clic derecho sobre ella → «Agregar cuarto interno» para baños o cuartos dentro`);
}

/* Ctrl+C / Ctrl+V en la vista por frentes: la copia (sin camas) queda a la derecha del elegido */
let portapapelesFr = null;
async function pegarEnFrentes(junto) {
  if (!portapapelesFr) { toast('Elija un espacio y pulse Ctrl + C para copiarlo.'); return; }
  const edif = porId(S.edificios, junto.edificio_id);
  const usados = new Set(espaciosDe(edif.id).map((x) => String(x.nombre).toLowerCase()));
  const nombre = nombreCopia(portapapelesFr, edif, junto.planta, portapapelesFr.planta, usados);
  const fila = {
    empresa_id: S.empresaId, edificio_id: edif.id, planta: junto.planta, frente: junto.frente || null,
    orden: junto.orden + 1, ancho: portapapelesFr.ancho || 1, tipo: portapapelesFr.tipo, nombre
  };
  if (!S.areasFalta && portapapelesFr.area_id && S.areas.some((a) => a.id === portapapelesFr.area_id)) fila.area_id = portapapelesFr.area_id;
  const { data, error } = await S.sb.from('viv_espacios').insert(alCrear(fila)).select().single();
  if (error) { toast(mensajeError(error)); return; }
  S.espacios.push(data);
  S.selEspacio = data.id;
  toast(`${nombreEspCorto(data)} pegado (sin camas)`);
  pintar();
}

/* Flechas del teclado mientras se editan plantas y espacios */
let teclasEdicion = false;
function conectarTeclasEdicion() {
  if (teclasEdicion) return;
  teclasEdicion = true;
  document.addEventListener('keydown', (e) => {
    if (!S || !S.editando || !S.selEspacio || S.vistaEdif === 'plano' || modalActual) return;
    if (e.target.closest && e.target.closest('input, select, textarea, [contenteditable]')) return;
    const esp = porId(S.espacios, S.selEspacio);
    if (!esp) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      portapapelesFr = { tipo: esp.tipo, nombre: esp.nombre, ancho: esp.ancho, area_id: esp.area_id ?? null, planta: esp.planta };
      toast(`${nombreEspCorto(esp)} copiado · Ctrl + V lo pega a su derecha (sin camas)`);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pegarEnFrentes(esp); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const acciones = { ArrowLeft: () => moverEspacio(esp, -1), ArrowRight: () => moverEspacio(esp, 1),
      ArrowUp: () => moverVertical(esp, -1), ArrowDown: () => moverVertical(esp, 1) };
    if (acciones[e.key]) { e.preventDefault(); acciones[e.key](); }
  });
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

function modalEspacio(esp, { edif, planta, frente, tipo: tipoPedido }) {
  const nuevo = !esp;
  const lugar = `${nombrePlanta(planta, edif.num_plantas)}${frente ? ` · frente ${frente}` : ''}`;
  const m = modal(nuevo ? `Agregar espacio · ${lugar}` : `Editar ${esp.nombre}`);
  const tipoIni = esp?.tipo || tipoPedido || 'habitacion';

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
    ${!S.areasFalta ? `<div class="campo" id="hs-area-bloque"><label class="etiqueta" for="hs-area">Área de trabajo</label>
      <div class="hab-form-fila hab-area-elegir"><select class="entrada" id="hs-area">
        <option value="">Sin área</option>
        ${S.areas.map((a) => `<option value="${a.id}" ${esp?.area_id === a.id ? 'selected' : ''}>${esc(a.icono)} ${esc(a.nombre)}</option>`).join('')}
      </select><button class="boton-secundario boton-compacto" type="button" id="hs-areas-admin">+ Nueva área</button></div>
      <span class="ayuda">Se muestra encima de la habitación con su dibujo y su color.</span></div>` : ''}
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
    const $area = m.cuerpo.querySelector('#hs-area-bloque');
    if ($area) $area.hidden = !hab;
  };
  m.cuerpo.querySelector('#hs-areas-admin')?.addEventListener('click', () => {
    // Recuerda lo escrito y vuelve aquí con el área nueva ya elegida
    const borrador = { tipo: $tipo.value, nombre: $nombre.value };
    modalAreas((areaId) => {
      if (areaId == null && !borrador) return;
      modalEspacio(esp, { edif, planta, frente, tipo: borrador.tipo });
      const m2 = modalActual;
      if (!m2) return;
      const $n2 = m2.cuerpo.querySelector('#hs-nombre');
      if ($n2 && borrador.nombre) { $n2.value = borrador.nombre; $n2.dispatchEvent(new Event('input')); }
      const $a2 = m2.cuerpo.querySelector('#hs-area');
      if ($a2 && areaId != null) $a2.value = String(areaId);
    }, true);
  });
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
    const $selArea = m.cuerpo.querySelector('#hs-area');
    const areaElegida = $selArea && tipo === 'habitacion' ? (S.areas.find((a) => String(a.id) === $selArea.value)?.id ?? null) : null;
    const conArea = (fila) => ($selArea ? { ...fila, area_id: areaElegida } : fila);
    if (nuevo) {
      const fila = ambos
        ? espaciosDe(edif.id).filter((x) => x.planta === planta)
        : filaDe(edif.id, planta, frente);
      const orden = (fila.length ? Math.max(...fila.map((x) => x.orden)) : 0) + 10;
      const { data, error } = await S.sb.from('viv_espacios').insert(alCrear(conArea({
        empresa_id: S.empresaId, edificio_id: edif.id, planta, frente: ambos ? 'AB' : (frente || null),
        orden, ancho: ANCHO_INICIAL[tipo], tipo, nombre
      }))).select().single();
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
    const cambios = conArea({ tipo, nombre });
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
  conectarMenuCroquis($cq, base, editando);
}

/* Clic derecho en el croquis: las mismas dinámicas que el plano */
function conectarMenuCroquis($cq, base, editando) {
  $cq.addEventListener('contextmenu', (e) => {
    const nodo = e.target.closest('.hab-cq-el');
    const lista = editando ? S.cq.elems : elementosCroquis(base);
    const el = nodo && (lista.find((x) => claveCq(x) === nodo.dataset.clave)
      || (nodo.dataset.edif ? lista.find((x) => x.edificio_id === nodo.dataset.edif) : null));
    const items = [];
    const entrar = (edifId, plano) => () => {
      if (plano) S.vistaEdif = 'plano';
      ir({ sucursalId: base.sucursal_id, baseId: base.id, edificioId: edifId });
    };
    if (!editando) {
      if (el && el.tipo === 'edificio') {
        items.push({ label: 'Entrar al edificio', accion: entrar(el.edificio_id, false) });
        items.push({ label: 'Ver plano interior', accion: entrar(el.edificio_id, true) });
      }
      if (S.estructura) {
        if (items.length) items.push({ sep: true });
        items.push({ label: 'Editar croquis', accion: () => { S.cq = { baseId: base.id, elems: elementosCroquis(base), sel: null, quitados: [] }; pintar(); } });
      }
    } else if (el) {
      seleccionarCq(claveCq(el));
      const pulsar = (id) => () => document.getElementById(id)?.click();
      if (el.tipo !== 'edificio') items.push({ label: 'Renombrar…', k: 'F2', accion: pulsar('cq-renombrar') });
      items.push({ label: 'Girar', accion: pulsar('cq-girar') });
      if (el.tipo !== 'edificio') items.push({ sep: true }, { label: 'Quitar del croquis', peligro: true, accion: pulsar('cq-quitar') });
    } else {
      const r = $cq.getBoundingClientRect();
      const gx = Math.floor((e.clientX - r.left) / r.width * CQ_COLS);
      const gy = Math.floor((e.clientY - r.top) / r.height * CQ_FILAS);
      items.push({ label: 'Agregar', sub: Object.entries(TIPOS_CROQUIS).map(([tipo, n]) => ({ label: n, accion: () => {
        const [w, h] = TAM_CROQUIS[tipo];
        const iguales = S.cq.elems.filter((c) => c.tipo === tipo).length;
        const nuevo = { tmp: `t${++tmpSeq}`, tipo, nombre: iguales ? `${n} ${iguales + 1}` : n,
          x: Math.max(0, Math.min(CQ_COLS - w, gx)), y: Math.max(0, Math.min(CQ_FILAS - h, gy)), w, h, nuevo: true };
        S.cq.elems.push(nuevo); S.cq.sel = claveCq(nuevo); S.cq.cambios = true;
        pintar();
      } })) });
      items.push({ sep: true });
      items.push({ label: 'Guardar croquis', accion: () => document.getElementById('cq-guardar')?.click() });
      items.push({ label: 'Cancelar', accion: () => document.getElementById('cq-cancelar')?.click() });
    }
    if (!items.length) return;
    e.preventDefault();
    abrirMenuPl(items, e.clientX, e.clientY, el ? (el.tipo === 'edificio' ? porId(S.edificios, el.edificio_id)?.nombre || '' : el.nombre) : '');
  });
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
  if (el.edificio_id) d.dataset.edif = el.edificio_id;
  d.title = el.tipo === 'edificio' ? (porId(S.edificios, el.edificio_id)?.nombre || el.nombre) : el.nombre;
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
        S.vistaEdif = 'frentes';      // del croquis se entra a la vista por frentes
        ir({ sucursalId: base.sucursal_id, baseId: base.id, edificioId: el.edificio_id });
      };
      d.addEventListener('click', entrar);
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); entrar(); } });
    }
    return d;
  }

  /* ----- Edición: seleccionar, arrastrar, cambiar tamaño ----- */
  // Doble clic sobre un edificio: su configuración (plantas, frentes, pasillos)
  if (el.tipo === 'edificio') {
    d.title += ' · doble clic para configurar el edificio';
    d.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      const edif = porId(S.edificios, el.edificio_id);
      if (edif) modalEdificio(edif);
    });
  }
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
   PLANO INTERIOR DE CADA PLANTA (etapa 4 · editor tipo Word)
   Vista desde arriba, a ojo (sin medidas), en una cuadrícula de
   40 × 25. Para admin y técnico de seguridad es un editor:
   - Cinta de opciones (Inicio · Insertar · Seguridad · Vista).
   - Clic derecho sobre el plano o sobre un espacio: menú con
     submenús (agregar espacios, cuartos internos, puertas,
     camas, equipos de emergencia y señalética).
   - Arrastrar para mover, esquina para estirar, puertas por
     las paredes; Deshacer y un solo «Guardar plano».
   - Panel de propiedades del espacio elegido.
   Los demás roles lo ven y tocan las camas (asignación).
   Columnas viv_espacios.plano_* (habitaciones_etapa4_plano.sql).
   No cambia la vista por frentes ni las camas.
   ============================================ */

const PL_COLS = 40;
const PL_FILAS = 25;
const PL_TAM = { habitacion: [7, 6], banos: [4, 4], escaleras: [4, 5], comedor: [9, 6], sin_construir: [8, 6], garita: [3, 3] };
const PL_MAX_PUERTAS = 3;
const LADOS_PUERTA = ['n', 'e', 's', 'o'];
/* Color de fondo y de borde de cada tipo de espacio en el plano */
const COLOR_TIPO = {
  habitacion: ['#FBF3E4', '#B98B46'], oficina: ['#ECEEFB', '#7480C4'], banos: ['#E2F0FA', '#5C9BC6'],
  comedor: ['#FCE8D8', '#D9844A'], bodega: ['#EFEBE4', '#978A74'], garita: ['#F1EEF6', '#8E7CB0'],
  lavanderia: ['#E7F3E7', '#6BA66B'], escaleras: ['#ECEEF1', '#7E8794'], sin_construir: ['#E8F2E1', '#7FB069'],
  otro: ['#FBFAF6', '#A9A08F']
};
const CORTO_PL = { habitacion: 'Habitación', sin_construir: 'Terreno abierto', lavanderia: 'Lavandería', escaleras: 'Escaleras' };
const EQUIPOS_PL = ['extintor', 'botiquin', 'detector_humo', 'luz_emergencia', 'alarma', 'gabinete_incendio', 'telefono_emergencia'];
/* Íconos de la cinta (trazo 24 × 24) */
const ICO_PL = {
  guardar: 'M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7', armar: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h16v7H4z', deshacer: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  duplicar: 'M4 4h10v10H4zM10 10h10v10H10z', girar: 'M20 12a8 8 0 1 1-3-6.2M20 4v5h-5', puerta: 'M6 21V4h9v17M3 21h18M12 12h1',
  quitar: 'M4 12h16', borrar: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14', editar: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  cama: 'M3 18v-8M3 14h18v4M7 11h4v3M21 14v-2a2 2 0 0 0-2-2h-6', grid: 'M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16',
  pantalla: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5', ojo: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  habitacion: 'M3 20V9l9-5 9 5v11M3 20h18M9 20v-6h6v6', oficina: 'M4 7h16v12H4zM9 7V4h6v3M4 12h16',
  banos: 'M4 12h16v3a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM6 12V5a2 2 0 0 1 4 0', comedor: 'M7 3v8M5 3v4a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 1-3 4-3 7h3v11',
  bodega: 'M3 8l9-5 9 5v13H3zM3 8h18M9 21v-7h6v7', garita: 'M5 21V9h14v12M3 9l9-6 9 6M10 13h4', lavanderia: 'M5 3h14v18H5zM12 14m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M8 6h1',
  escaleras: 'M4 20h4v-4h4v-4h4V8h4', sin_construir: 'M3 20h18M6 20c0-5 3-9 6-9s6 4 6 9M12 11V5', otro: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M12 8v4M12 16h.01'
};

const tienePlano = (x) => x.plano_x != null && x.plano_y != null && x.plano_w != null && x.plano_h != null;
const editaPlano = () => S.estructura && planoDisponible();
const editaSeg = () => EDITORES_SEG.includes(S.perfil?.rol) && !S.seguridadFalta;

function planoDisponible() {
  return S.espacios.length === 0 || Object.prototype.hasOwnProperty.call(S.espacios[0], 'plano_x');
}

/** Elementos del plano de una planta: copia editable de cada espacio ubicado. */
function elementosPlano(edif, planta) {
  return espaciosDe(edif.id)
    .filter((x) => x.planta === planta && tienePlano(x))
    .map((x) => ({
      id: x.id, x: x.plano_x, y: x.plano_y, w: x.plano_w, h: x.plano_h,
      puertas: (Array.isArray(x.plano_puertas) ? x.plano_puertas : [])
        .filter((p) => p && LADOS_PUERTA.includes(p.l))
        .map((p) => ({ l: p.l, p: Math.min(0.92, Math.max(0.08, Number(p.p) || 0.5)) }))
    }));
}

/* Arma un plano a partir de la estructura por frentes que ya existe:
   frente de arriba, pasillo al medio y frente de abajo, cada espacio
   con un ancho proporcional a su tamaño. Sin frentes: una sola fila.
   Es un punto de partida: luego se ajusta a ojo y se guarda. */
function armarDesdeFrentes(edif, planta, soloIds = null) {
  const usar = (x) => !soloIds || soloIds.has(x.id);
  const elems = [];
  const poner = (esp, x, y, w, h, lado) => {
    if (!usar(esp)) return;
    w = Math.max(2, Math.min(PL_COLS, w)); h = Math.max(2, Math.min(PL_FILAS, h));
    x = Math.max(0, Math.min(PL_COLS - w, x)); y = Math.max(0, Math.min(PL_FILAS - h, y));
    elems.push({ id: esp.id, x, y, w, h, puertas: lado ? [{ l: lado, p: 0.5 }] : [] });
  };
  if (!edif.tiene_frentes) {
    const fila = filaDe(edif.id, planta, null);
    const total = fila.reduce((a, x) => a + (x.ancho || 1), 0) || 1;
    let acum = 0;
    fila.forEach((x) => {
      const x0 = Math.round(acum * PL_COLS / total);
      acum += x.ancho || 1;
      poner(x, x0, 2, Math.round(acum * PL_COLS / total) - x0, 12, 's');
    });
    return elems;
  }
  const tramos = tramosDe(edif.id, planta);
  const suma = (l) => l.reduce((a, x) => a + (x.ancho || 1), 0);
  const total = tramos.reduce((a, t) => a + (t.tipo === 'ab' ? (t.esp.ancho || 1) : Math.max(suma(t.A), suma(t.B), 1)), 0) || 1;
  const [arriba, abajo] = edif.frentes_invertidos ? ['B', 'A'] : ['A', 'B'];
  const Y = { [arriba]: 1, [abajo]: 15 }, ALTO = 9;
  const puerta = { [arriba]: 's', [abajo]: 'n' };
  const col = (u) => Math.round(u * PL_COLS / total);
  let u = 0;
  tramos.forEach((t) => {
    if (t.tipo === 'ab') {
      const x0 = col(u); u += t.esp.ancho || 1;
      poner(t.esp, x0, 1, col(u) - x0, 23, null);
      return;
    }
    const ancho = Math.max(suma(t.A), suma(t.B), 1);
    [arriba, abajo].forEach((f) => {
      let v = u;
      t[f].forEach((x) => {
        const x0 = col(v); v += x.ancho || 1;
        poner(x, x0, Y[f], col(v) - x0, ALTO, puerta[f]);
      });
    });
    u += ancho;
  });
  return elems;
}

/* Plano → vista por frentes (al guardar el plano):
   - Frente: lo de la mitad de arriba del plano va al frente de arriba
     y lo de abajo al de abajo; lo que atraviesa casi todo el alto
     (un baño central, escaleras) queda en «Frentes A y B».
   - Orden: de izquierda a derecha, como en el plano.
   - Tamaño: proporcional al ancho dibujado (1 a 6).
   Los espacios que no están en el plano quedan al final, en su orden. */
async function acomodarFrentesDesdePlano(edif, planta, elems) {
  const lista = (elems || []).map((el) => ({ el, esp: porId(S.espacios, el.id) })).filter((x) => x.esp);
  if (!lista.length) return null;
  const top = Math.min(...lista.map((x) => x.el.y));
  const bot = Math.max(...lista.map((x) => x.el.y + x.el.h));
  const mid = (top + bot) / 2;
  const [arriba, abajo] = edif.frentes_invertidos ? ['B', 'A'] : ['A', 'B'];

  // Unidad de ancho: la habitación típica del plano
  const anchosHab = lista.filter((x) => x.esp.tipo === 'habitacion').map((x) => x.el.w).sort((a, b) => a - b);
  const unidad = Math.max(3, anchosHab.length ? anchosHab[Math.floor(anchosHab.length / 2)] : PL_TAM.habitacion[0]);

  // Una sola hilera dibujada (todo a la misma altura): va entera al frente de arriba
  const centros = lista.map((x) => x.el.y + x.el.h / 2);
  const unaHilera = Math.max(...centros) - Math.min(...centros) < 4;
  const nuevos = new Map();
  lista.forEach(({ el, esp }) => {
    let frente = null;
    if (edif.tiene_frentes && unaHilera) frente = esp.frente === 'AB' ? 'AB' : arriba;
    else if (edif.tiene_frentes) {
      const atraviesa = el.y <= mid - 1 && el.y + el.h >= mid + 1 && el.h >= (bot - top) * 0.6;
      frente = atraviesa ? 'AB' : (el.y + el.h / 2 < mid ? arriba : abajo);
    }
    const ancho = Math.max(1, Math.min(ANCHO_MAX, Math.round(el.w / unidad) || 1));
    nuevos.set(esp.id, { frente, ancho, cx: el.x + el.w / 2, cy: el.y + el.h / 2 });
  });
  const enPlano = lista.map((x) => x.esp)
    .sort((a, b) => nuevos.get(a.id).cx - nuevos.get(b.id).cx || nuevos.get(a.id).cy - nuevos.get(b.id).cy);
  const fuera = espaciosDe(edif.id).filter((x) => x.planta === planta && !nuevos.has(x.id)).sort(porOrden);

  const cambios = [];
  enPlano.concat(fuera).forEach((esp, k) => {
    const n = nuevos.get(esp.id);
    const c = {};
    const orden = (k + 1) * 10;
    if (esp.orden !== orden) c.orden = orden;
    if (n) {
      if ((esp.frente || null) !== n.frente) c.frente = n.frente;
      if (esp.ancho !== n.ancho) c.ancho = n.ancho;
    }
    if (Object.keys(c).length) cambios.push([esp, c]);
  });
  if (!cambios.length) return null;
  const res = await Promise.all(cambios.map(([esp, c]) => S.sb.from('viv_espacios').update(alEditar(c)).eq('id', esp.id)));
  const fallo = res.find((r) => r.error);
  if (fallo) return mensajeError(fallo.error);
  cambios.forEach(([esp, c]) => Object.assign(esp, c));
  return null;
}

function sinUbicar(edif, planta, elems) {
  const puestos = new Set(elems.map((e) => e.id));
  return espaciosDe(edif.id).filter((x) => x.planta === planta && !puestos.has(x.id)).sort(porOrden);
}

const nombreEsp = (x) => (x.tipo === 'habitacion' ? `Hab. ${x.nombre}` : x.nombre);
const svgIco = (d, color = 'currentColor') =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

/* ¿Hay cambios del plano sin guardar? Pregunta antes de perderlos. */
function salirDelPlanoOk() {
  if (!S.pl?.cambios) return true;
  return confirm('Hay cambios del plano sin guardar. ¿Salir sin guardarlos?');
}

function chipsVistaEdif(bloqueada) {
  const plano = S.vistaEdif === 'plano';
  return `<div class="hab-filtros" role="group" aria-label="Vista del edificio">
    <button class="hab-chip" type="button" data-ve="frentes" aria-pressed="${!plano}" ${bloqueada ? 'disabled' : ''}>Por frentes</button>
    <button class="hab-chip" type="button" data-ve="plano" aria-pressed="${plano}" ${bloqueada ? 'disabled' : ''}>Plano</button>
  </div>`;
}

function conectarChipsVistaEdif() {
  document.querySelectorAll('[data-ve]').forEach((b) => b.addEventListener('click', () => {
    if (S.vistaEdif === b.dataset.ve) return;
    if (!salirDelPlanoOk()) return;
    S.vistaEdif = b.dataset.ve;
    S.editando = false; S.selEspacio = null; S.segEdit = false; S.segColocar = null; S.pl = null;
    pintar();
  }));
}

/* ---------- Vista ---------- */

function vistaPlano($v, edif) {
  cerrarMenuPl();
  const c = conteo(camasDeEdificio(edif.id));
  if (!S.planoPlanta || S.planoPlanta > edif.num_plantas) S.planoPlanta = 1;
  const planta = S.planoPlanta;
  if (S.pl && (S.pl.edifId !== edif.id || S.pl.planta !== planta)) S.pl = null;
  if (!S.plVer) S.plVer = { grid: true, camas: true, seg: true };
  if (!S.plCinta) S.plCinta = 'insertar';

  // El editor está siempre activo para quien puede editar (un solo «Guardar plano»)
  if (!S.pl && editaPlano()) {
    S.pl = { edifId: edif.id, planta, elems: elementosPlano(edif, planta), sel: null, puerta: null, cambios: false,
      conocidos: new Set(espaciosDe(edif.id).map((x) => x.id)), hist: [], pendiente: null, colocar: null, armado: false, multi: new Set() };
    if (!S.pl.elems.length && espaciosDe(edif.id).some((x) => x.planta === planta)) {
      S.pl.elems = armarDesdeFrentes(edif, planta);
      S.pl.cambios = true;
      S.pl.armado = true;
    }
  }
  const editando = !!S.pl;
  if (editando) {
    S.pl.elems = S.pl.elems.filter((e) => porId(S.espacios, e.id));   // espacios eliminados
    if (S.pl.sel && !porId(S.espacios, S.pl.sel)) S.pl.sel = null;
    // Espacios recién creados: se ubican donde se pidió y quedan elegidos
    espaciosDe(edif.id).filter((x) => x.planta === planta && !S.pl.conocidos.has(x.id)).forEach((x) => {
      S.pl.conocidos.add(x.id);
      if (S.pl.elems.some((e) => e.id === x.id)) return;
      const el = ubicarEnPlano(x, S.pl.pendiente);
      S.pl.sel = el.id; S.pl.puerta = null; S.pl.cambios = true;
    });
    S.pl.pendiente = null;
  }
  let elems = editando ? S.pl.elems : elementosPlano(edif, planta);
  const provisional = !editando && !elems.length && planoDisponible();
  if (provisional) elems = armarDesdeFrentes(edif, planta);
  const faltan = sinUbicar(edif, planta, elems);

  $v.innerHTML = `
    <div class="hab-cabeza">
      <h2 class="hab-titulo">${esc(edif.nombre)} <small>código ${esc(edif.codigo)}</small></h2>
      ${chipsVistaEdif(false)}
    </div>
    ${cifras(c, true)}
    ${editando ? cintaHtml() : ''}
    <div class="pl-cuerpo">
      <div class="pl-zona" id="pl-zona"></div>
      <aside class="pl-panel" id="pl-panel" aria-label="Propiedades"></aside>
    </div>
    <div class="pl-pisos" role="tablist" aria-label="Plantas">
      ${Array.from({ length: edif.num_plantas }, (_, i) => i + 1).map((p) =>
        `<button type="button" role="tab" class="pl-piso" data-pp="${p}" aria-selected="${p === planta}">${nombrePlanta(p, edif.num_plantas)}</button>`).join('')}
      <span class="pl-estado">${c.total} camas · ${c.ocupadas} ocupadas · ${c.libres} libres</span>
    </div>`;

  conectarChipsVistaEdif();
  document.querySelectorAll('[data-pp]').forEach((b) => b.addEventListener('click', () => {
    if (Number(b.dataset.pp) === S.planoPlanta || !salirDelPlanoOk()) return;
    S.planoPlanta = Number(b.dataset.pp); S.pl = null; pintar();
  }));
  if (editando) conectarCinta(edif, planta);

  const $z = document.getElementById('pl-zona');
  if (!planoDisponible()) {
    $z.innerHTML = `<div class="hab-vacio"><strong>El plano necesita preparar la base de datos.</strong><br>
      El administrador debe ejecutar una vez <code>sql/habitaciones_etapa4_plano.sql</code> en Supabase.
      Mientras tanto puede usar la vista «Por frentes».</div>`;
    pintarPanelPl(edif, planta, faltan);
    return;
  }

  $z.innerHTML = `${editando && S.pl.armado ? `<div class="pl-aviso-armado"><b>Armamos este plano a partir de su estructura por frentes.</b>
      Ajústelo a ojo (mueva, estire, agregue puertas) y pulse <b>Guardar plano</b>.</div>` : ''}
    ${provisional ? '<div class="pl-aviso-armado">Plano provisional, armado desde la vista por frentes (aún no fue dibujado).</div>' : ''}
    <div class="hab-cq-marco">
      <div class="hab-cq hab-pl ${editando ? 'hab-cq--editando' : ''} ${S.plVer.grid ? '' : 'pl-sin-grid'} ${S.pl?.colocar ? 'pl-colocando' : ''}" id="hab-pl"
        role="${editando ? 'application' : 'group'}" aria-label="Plano de ${esc(nombrePlanta(planta, edif.num_plantas))}"></div>
    </div>
    <p class="ayuda pl-ayuda">${editando
      ? (S.pl.colocar ? `<b>Toque en el plano dónde va: ${esc((TIPOS_SEG[S.pl.colocar] || {}).n || '')}.</b> <button type="button" class="enlace-boton" id="pl-cancelar-colocar">Cancelar</button>`
        : 'Clic derecho sobre el plano o sobre un espacio para ver las opciones · arrastre para mover · esquina inferior derecha para estirar · las puertas se arrastran por las paredes · <b>Ctrl + clic</b> o un recuadro para elegir varios · <b>Ctrl + C</b> / <b>Ctrl + V</b> copiar y pegar.')
      : (elems.length ? 'Plano a ojo, visto desde arriba. Toque una cama para ver quién la ocupa.' : 'Esta planta aún no tiene plano dibujado.')}</p>`;
  document.getElementById('pl-cancelar-colocar')?.addEventListener('click', () => { S.pl.colocar = null; pintar(); });

  const $pl = document.getElementById('hab-pl');
  /* Los más grandes se dibujan debajo: un cuarto grande puede
     contener cuartos internos dibujados encima */
  elems.slice().sort((a, b) => b.w * b.h - a.w * a.h)
    .forEach((el) => $pl.appendChild(elementoPl(el, editando, $pl, edif)));
  marcarGruposPl($pl, elems);
  if (S.plVer.seg) pintarSegPl($pl, edif, planta);
  if (editando) conectarLienzoPl($pl, edif, planta, faltan);
  pintarPanelPl(edif, planta, faltan);
  if (editando && seleccionPl().length > 1) pintarSeleccionPl();
}

function elementoPl(el, editando, $pl, edif) {
  const esp = porId(S.espacios, el.id);
  const [fondo, borde] = COLOR_TIPO[esp?.tipo] || COLOR_TIPO.otro;
  const d = document.createElement('div');
  d.className = `hab-cq-el hab-pl-el hab-pl-el--${esp?.tipo || 'otro'}`;
  d.style.setProperty('--pl-f', fondo);
  d.style.setProperty('--pl-b', borde);
  d.dataset.clave = el.id;
  posicionar(d, el);

  if (esp?.tipo === 'habitacion') {
    const camas = camasDe(esp.id);
    const ocup = camas.filter((x) => asigDeCama(x.id)).length;
    const area = areaDe(esp);
    if (area) { d.classList.add('hab-pl-el--area'); d.style.setProperty('--area', area.color); d.dataset.area = area.id; }
    d.innerHTML = `${area ? etiquetaArea(area, 'hab-area hab-area--pl') : ''}<span class="hab-pl-nombre"><b>${esc(nombreEsp(esp))}</b>${camas.length ? ` <small>${ocup}/${camas.length}</small>` : ''}</span>`;
    if (S.plVer.camas && camas.length) {
      const $c = document.createElement('span');
      $c.className = 'hab-pl-camas';
      camas.forEach((cama) => $c.appendChild(camaMini(cama)));
      d.appendChild($c);
    }
  } else {
    d.innerHTML = `${svgIcono(esp?.tipo)}<span class="hab-pl-nombre"><b>${esc(esp ? nombreEsp(esp) : '—')}</b></span>`;
    if (esp) piezasPl(d, esp, editando, el);
  }
  d.setAttribute('aria-label', esp ? `${TIPOS_ESPACIO[esp.tipo]} ${esp.nombre}` : 'Espacio');
  el.puertas.forEach((pu, i) => d.appendChild(puertaPl(el, pu, i, editando, d)));
  d.classList.toggle('pl-puerta-arriba', el.puertas.some((p) => p.l === 'n'));

  if (!editando) return d;

  /* ----- Edición: seleccionar, arrastrar, estirar, menú ----- */
  d.tabIndex = 0;
  d.setAttribute('role', 'button');
  const sel = S.pl.sel === el.id || (S.pl.multi && S.pl.multi.has(el.id));
  d.setAttribute('aria-pressed', String(sel));
  if (sel) d.classList.add('hab-cq-el--sel');
  d.insertAdjacentHTML('beforeend', '<span class="hab-cq-asa" aria-hidden="true"></span>');

  let modo = null, ix, iy, ox, oy, ow, oh, guardado = false, grupoMov = null;
  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (S.pl.colocar) return;                                      // lo maneja el lienzo
    if (e.target.closest('.hab-pl-puerta, .hab-cama, .hab-pl-seg, .hab-pl-pieza')) return;
    e.preventDefault(); e.stopPropagation();
    cerrarMenuPl();
    // Ctrl o Mayús + clic: suma o quita de la selección (varios a la vez)
    if (e.ctrlKey || e.metaKey || e.shiftKey) { alternarSeleccionPl(el.id); return; }
    modo = e.target.classList.contains('hab-cq-asa') ? 'tam' : 'mover';
    ix = e.clientX; iy = e.clientY; ox = el.x; oy = el.y; ow = el.w; oh = el.h; guardado = false;
    d.setPointerCapture(e.pointerId);
    const enGrupo = seleccionPl().length > 1 && seleccionPl().includes(el.id);
    grupoMov = enGrupo && modo === 'mover'
      ? S.pl.elems.filter((x) => seleccionPl().includes(x.id) && x !== el).map((x) => ({ x, ox: x.x, oy: x.y })) : null;
    if (!enGrupo && S.pl.sel !== el.id) seleccionarPl(el.id, null);
  });
  d.addEventListener('pointermove', (e) => {
    if (!modo) return;
    const r = $pl.getBoundingClientRect();
    const dx = Math.round((e.clientX - ix) / r.width * PL_COLS);
    const dy = Math.round((e.clientY - iy) / r.height * PL_FILAS);
    if (!dx && !dy) return;
    if (!guardado) { recordarPl(); guardado = true; }
    if (modo === 'mover' && grupoMov) {
      // Todo el grupo se mueve junto (sin salirse del plano)
      const todos = [{ x: el, ox, oy }].concat(grupoMov);
      const mdx = Math.max(-Math.min(...todos.map((g) => g.ox)), Math.min(dx, Math.min(...todos.map((g) => PL_COLS - g.x.w - g.ox))));
      const mdy = Math.max(-Math.min(...todos.map((g) => g.oy)), Math.min(dy, Math.min(...todos.map((g) => PL_FILAS - g.x.h - g.oy))));
      todos.forEach((g) => {
        g.x.x = g.ox + mdx; g.x.y = g.oy + mdy;
        const dd = $pl.querySelector(`[data-clave="${CSS.escape(String(g.x.id))}"]`);
        if (dd) posicionar(dd, g.x);
      });
      return;
    }
    if (modo === 'mover') {
      el.x = Math.max(0, Math.min(PL_COLS - el.w, ox + dx));
      el.y = Math.max(0, Math.min(PL_FILAS - el.h, oy + dy));
    } else {
      el.w = Math.max(2, Math.min(PL_COLS - el.x, ow + dx));
      el.h = Math.max(2, Math.min(PL_FILAS - el.y, oh + dy));
    }
    posicionar(d, el);
  });
  const soltar = () => {
    if (!modo) return;
    const eraGrupo = !!grupoMov;
    modo = null; grupoMov = null;
    if (guardado) { marcarCambioPl(); if (S.areas.length || eraGrupo) pintar(); }
    else if (eraGrupo) { S.pl.multi = new Set(); seleccionarPl(el.id, null); }   // clic sin mover: solo este
  };
  d.addEventListener('pointerup', soltar);
  d.addEventListener('pointercancel', soltar);
  d.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (S.pl.sel !== el.id) seleccionarPl(el.id, null);
    const r = d.getBoundingClientRect();
    const px = Math.max(3, Math.min(97, (e.clientX - r.left) / r.width * 100));
    const py = Math.max(5, Math.min(95, (e.clientY - r.top) / r.height * 100));
    abrirMenuPl(menuEspacioPl(esp, el, edif, { px, py }), e.clientX, e.clientY, esp ? nombreEsp(esp) : '');
  });
  d.addEventListener('keydown', (e) => {
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (seleccionPl().length > 1 && (k || e.key === 'Delete') && !e.shiftKey) return;   // lo maneja el teclado del plano
    if (e.key === 'Delete') { e.preventDefault(); quitarDelPlano(el); return; }
    if (!k) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); seleccionarPl(el.id, null); } return; }
    e.preventDefault();
    recordarPl();
    if (e.shiftKey) {
      el.w = Math.max(2, Math.min(PL_COLS - el.x, el.w + k[0]));
      el.h = Math.max(2, Math.min(PL_FILAS - el.y, el.h + k[1]));
    } else {
      el.x = Math.max(0, Math.min(PL_COLS - el.w, el.x + k[0]));
      el.y = Math.max(0, Math.min(PL_FILAS - el.h, el.y + k[1]));
    }
    marcarCambioPl();
    posicionar(d, el);
  });
  return d;
}

/** Puerta: símbolo de plano (hoja + arco) sobre una pared del espacio. */
function ubicarPuerta(s, pu) {
  s.className = `hab-pl-puerta hab-pl-puerta--${pu.l}`;
  const pos = `${(pu.p * 100).toFixed(1)}%`;
  s.style.left = s.style.top = '';
  if (pu.l === 'n' || pu.l === 's') s.style.left = pos; else s.style.top = pos;
}

function puertaPl(el, pu, i, editando, d) {
  const s = document.createElement('span');
  ubicarPuerta(s, pu);
  s.setAttribute('aria-hidden', 'true');
  if (!editando) return s;
  if (S.pl.sel === el.id && S.pl.puerta === i) s.classList.add('hab-pl-puerta--sel');
  s.title = 'Arrastre la puerta por las paredes';
  let arrastrando = false;
  s.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    recordarPl();
    arrastrando = true;
    s.setPointerCapture(e.pointerId);
    seleccionarPl(el.id, i);
  });
  s.addEventListener('pointermove', (e) => {
    if (!arrastrando) return;
    const r = d.getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const dist = { n: fy * r.height, s: (1 - fy) * r.height, o: fx * r.width, e: (1 - fx) * r.width };
    const lado = Object.keys(dist).reduce((a, b) => (dist[a] <= dist[b] ? a : b));
    pu.l = lado;
    pu.p = Math.min(0.92, Math.max(0.08, lado === 'n' || lado === 's' ? fx : fy));
    ubicarPuerta(s, pu);
    s.classList.add('hab-pl-puerta--sel');
  });
  const soltar = () => {
    if (!arrastrando) return;
    arrastrando = false;
    d.classList.toggle('pl-puerta-arriba', el.puertas.some((p) => p.l === 'n'));
    marcarCambioPl();
  };
  s.addEventListener('pointerup', soltar);
  s.addEventListener('pointercancel', soltar);
  return s;
}

/* Equipos y señalética de esta planta: los anclados a un espacio
   van dentro de él; los anclados a la planta, sobre el plano. */
function pintarSegPl($pl, edif, planta) {
  if (S.seguridadFalta) return;
  seguridadDe(edif.id).filter((x) => x.planta === planta).forEach((el) => {
    let cont = null;
    if (el.ancla_tipo === 'espacio' && el.ancla_espacio) cont = $pl.querySelector(`.hab-pl-el[data-clave="${el.ancla_espacio}"]`);
    else if (el.ancla_tipo === 'planta') cont = $pl;
    if (!cont) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hab-pl-seg';
    b.style.left = `${el.x}%`;
    b.style.top = `${el.y}%`;
    b.innerHTML = svgSeg(el);
    const texto = descripcionSeg(el);
    b.title = texto;
    b.setAttribute('aria-label', texto);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (EDITORES_SEG.includes(S.perfil?.rol)) modalSeguridad(el); else toast(texto);
    });
    cont.appendChild(b);
  });
}

/* Clic derecho y «colocar» sobre el lienzo vacío */
function conectarLienzoPl($pl, edif, planta, faltan) {
  $pl.addEventListener('contextmenu', (e) => {
    if (e.target !== $pl) return;
    e.preventDefault();
    const r = $pl.getBoundingClientRect();
    const gx = Math.floor((e.clientX - r.left) / r.width * PL_COLS);
    const gy = Math.floor((e.clientY - r.top) / r.height * PL_FILAS);
    const px = Math.max(2, Math.min(98, (e.clientX - r.left) / r.width * 100));
    const py = Math.max(2, Math.min(98, (e.clientY - r.top) / r.height * 100));
    seleccionarPl(null, null);
    abrirMenuPl(menuLienzoPl(edif, planta, faltan, { gx, gy, px, py }), e.clientX, e.clientY, '');
  });
  $pl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (S.pl.colocar) {
      e.preventDefault(); e.stopPropagation();
      const cuarto = e.target.closest('.hab-pl-el');
      const caja = (cuarto || $pl).getBoundingClientRect();
      const px = Math.max(3, Math.min(97, (e.clientX - caja.left) / caja.width * 100));
      const py = Math.max(4, Math.min(96, (e.clientY - caja.top) / caja.height * 100));
      const tipo = S.pl.colocar;
      S.pl.colocar = null;
      crearSegPl(edif, planta, tipo, cuarto ? { ancla_tipo: 'espacio', ancla_espacio: cuarto.dataset.clave } : { ancla_tipo: 'planta', ancla_espacio: null }, px, py);
      return;
    }
    if (e.target === $pl) { cerrarMenuPl(); iniciarRecuadroPl(e, $pl); }
  }, true);
  conectarTeclasPlano();
}

/* ---------- Varios a la vez: selección, recuadro, copiar y pegar ---------- */
function seleccionPl() {
  if (!S.pl) return [];
  const ids = new Set(S.pl.multi || []);
  if (S.pl.sel) ids.add(S.pl.sel);
  return Array.from(ids);
}
function pintarSeleccionPl() {
  const ids = new Set(seleccionPl());
  document.querySelectorAll('.hab-pl-el').forEach((x) => {
    const si = ids.has(x.dataset.clave) || ids.has(Number(x.dataset.clave));
    x.classList.toggle('hab-cq-el--sel', si);
    x.setAttribute('aria-pressed', String(si));
  });
  const n = ids.size;
  const $a = document.querySelector('.pl-ayuda');
  if ($a && n > 1) $a.innerHTML = `<b>${n} elegidos.</b> Arrastre uno para mover todos · flechas para moverlos · <b>Ctrl + C</b> copiar · <b>Ctrl + V</b> pegar · <b>Supr</b> quitar del plano · <b>Esc</b> soltar la selección.`;
}
function alternarSeleccionPl(id) {
  const ids = new Set(seleccionPl());
  if (ids.has(id)) ids.delete(id); else ids.add(id);
  const lista = Array.from(ids);
  S.pl.sel = lista.length === 1 ? lista[0] : (lista.includes(S.pl.sel) ? S.pl.sel : lista[0] || null);
  S.pl.multi = new Set(lista.filter((x) => x !== S.pl.sel));
  S.pl.puerta = null;
  if (lista.length <= 1) { S.pl.multi = new Set(); seleccionarPl(S.pl.sel, null); }
  pintarSeleccionPl();
}
function elegirVariosPl(ids) {
  S.pl.sel = ids[0] || null;
  S.pl.multi = new Set(ids.slice(1));
  S.pl.puerta = null;
  seleccionarPl(S.pl.sel, null);
  pintarSeleccionPl();
}

// Arrastrar sobre una zona vacía dibuja un recuadro: elige lo que queda dentro
function iniciarRecuadroPl(e, $pl) {
  const r = $pl.getBoundingClientRect();
  const x0 = e.clientX, y0 = e.clientY;
  const banda = document.createElement('div');
  banda.className = 'pl-banda';
  let activa = false;
  const mover = (ev) => {
    const w = Math.abs(ev.clientX - x0), h = Math.abs(ev.clientY - y0);
    if (!activa && w < 5 && h < 5) return;
    if (!activa) { activa = true; $pl.appendChild(banda); }
    Object.assign(banda.style, { left: (Math.min(x0, ev.clientX) - r.left) + 'px', top: (Math.min(y0, ev.clientY) - r.top) + 'px', width: w + 'px', height: h + 'px' });
  };
  const soltar = (ev) => {
    document.removeEventListener('pointermove', mover);
    document.removeEventListener('pointerup', soltar);
    banda.remove();
    if (!activa) { S.pl.multi = new Set(); seleccionarPl(null, null); return; }
    const gx1 = (Math.min(x0, ev.clientX) - r.left) / r.width * PL_COLS, gx2 = (Math.max(x0, ev.clientX) - r.left) / r.width * PL_COLS;
    const gy1 = (Math.min(y0, ev.clientY) - r.top) / r.height * PL_FILAS, gy2 = (Math.max(y0, ev.clientY) - r.top) / r.height * PL_FILAS;
    // Basta con que el espacio quede dentro en su mayor parte
    const dentro = S.pl.elems.filter((el) => {
      const ix = Math.max(0, Math.min(gx2, el.x + el.w) - Math.max(gx1, el.x));
      const iy = Math.max(0, Math.min(gy2, el.y + el.h) - Math.max(gy1, el.y));
      return ix * iy >= el.w * el.h * 0.5;
    }).map((el) => el.id);
    elegirVariosPl(dentro);
  };
  document.addEventListener('pointermove', mover);
  document.addEventListener('pointerup', soltar);
}

// Portapapeles de espacios (se conserva al cambiar de planta)
let portapapelesPl = null;

function copiarPl() {
  const ids = seleccionPl();
  if (!ids.length) { toast('Elija primero uno o varios espacios'); return; }
  const elems = S.pl.elems.filter((x) => ids.includes(x.id));
  const mx = Math.min(...elems.map((x) => x.x)), my = Math.min(...elems.map((x) => x.y));
  portapapelesPl = {
    edifId: S.pl.edifId, planta: S.pl.planta,
    items: elems.map((el) => {
      const esp = porId(S.espacios, el.id);
      return { tipo: esp.tipo, nombre: esp.nombre, ancho: esp.ancho, area_id: esp.area_id ?? null,
        dx: el.x - mx, dy: el.y - my, w: el.w, h: el.h, puertas: el.puertas.map((p) => ({ ...p })) };
    })
  };
  toast(`${elems.length} ${elems.length === 1 ? 'espacio copiado' : 'espacios copiados'} · Ctrl + V para pegar (sin camas)`);
}

/* Nombre de la copia: habitaciones con el siguiente número libre
   (en otra planta respeta la centena: 201 → 301); los demás, como al crearlos. */
function nombreCopia(item, edif, planta, origen, usados) {
  if (item.tipo !== 'habitacion') {
    const n = nombrePorDefecto(item.tipo, edif.id);
    let nombre = n || item.nombre, k = 2;
    while (usados.has(nombre.toLowerCase())) nombre = `${n || item.nombre} ${k++}`;
    usados.add(nombre.toLowerCase());
    return nombre;
  }
  const num = parseInt(String(item.nombre).replace(/\D/g, ''), 10);
  let cand;
  if (!isNaN(num) && planta !== origen && num >= 100) cand = planta * 100 + (num % 100);
  else {
    const nums = Array.from(usados).map((x) => parseInt(x, 10)).filter((x) => !isNaN(x) && (planta < 2 || Math.floor(x / 100) === planta || x < 100));
    cand = nums.length ? Math.max(...nums) + 1 : (planta > 1 ? planta * 100 + 1 : 1);
  }
  while (usados.has(String(cand).toLowerCase())) cand++;
  usados.add(String(cand).toLowerCase());
  return String(cand);
}

async function pegarPl() {
  if (!S.pl || !portapapelesPl || !portapapelesPl.items.length) { toast('No hay nada copiado. Elija espacios y pulse Ctrl + C.'); return; }
  const edif = porId(S.edificios, S.pl.edifId);
  const planta = S.pl.planta;
  const items = portapapelesPl.items;
  const W = Math.max(...items.map((i) => i.dx + i.w)), H = Math.max(...items.map((i) => i.dy + i.h));
  // Donde quepa todo el grupo junto
  const hueco = huecoPlano(S.pl.elems, Math.min(W, PL_COLS), Math.min(H, PL_FILAS));
  const usados = new Set(espaciosDe(edif.id).map((x) => String(x.nombre).toLowerCase()));
  const filaOrden = espaciosDe(edif.id).filter((x) => x.planta === planta);
  let orden = (filaOrden.length ? Math.max(...filaOrden.map((x) => x.orden)) : 0) + 10;
  const filas = items.map((it) => {
    const fila = {
      empresa_id: S.empresaId, edificio_id: edif.id, planta, frente: edif.tiene_frentes ? 'A' : null,
      orden, ancho: it.ancho || ANCHO_INICIAL[it.tipo] || 1, tipo: it.tipo,
      nombre: nombreCopia(it, edif, planta, portapapelesPl.planta, usados)
    };
    orden += 10;
    if (!S.areasFalta && it.area_id && S.areas.some((a) => a.id === it.area_id)) fila.area_id = it.area_id;
    return alCrear(fila);
  });
  const { data, error } = await S.sb.from('viv_espacios').insert(filas).select();
  if (error) { toast(mensajeError(error)); return; }
  recordarPl();
  const nuevos = [];
  (data || []).forEach((esp, k) => {
    const it = items[k];
    S.espacios.push(esp);
    S.pl.conocidos.add(esp.id);
    const el = {
      id: esp.id,
      x: Math.max(0, Math.min(PL_COLS - it.w, hueco.x + it.dx)),
      y: Math.max(0, Math.min(PL_FILAS - it.h, hueco.y + it.dy)),
      w: it.w, h: it.h, puertas: it.puertas.map((p) => ({ ...p }))
    };
    S.pl.elems.push(el);
    nuevos.push(esp.id);
  });
  S.pl.sel = nuevos[0] || null;
  S.pl.multi = new Set(nuevos.slice(1));
  marcarCambioPl();
  pintar();
  toast(`${nuevos.length} ${nuevos.length === 1 ? 'espacio pegado' : 'espacios pegados'} (sin camas) · pulse «Guardar plano»`);
}

function quitarVariosDelPlano() {
  const ids = seleccionPl();
  if (!ids.length) return;
  recordarPl();
  S.pl.elems = S.pl.elems.filter((x) => !ids.includes(x.id));
  S.pl.sel = null; S.pl.puerta = null; S.pl.multi = new Set();
  marcarCambioPl();
  pintar();
}

function moverVariosPl(dx, dy) {
  const elems = S.pl.elems.filter((x) => seleccionPl().includes(x.id));
  if (!elems.length) return;
  const mdx = Math.max(-Math.min(...elems.map((x) => x.x)), Math.min(dx, Math.min(...elems.map((x) => PL_COLS - x.w - x.x))));
  const mdy = Math.max(-Math.min(...elems.map((x) => x.y)), Math.min(dy, Math.min(...elems.map((x) => PL_FILAS - x.h - x.y))));
  if (!mdx && !mdy) return;
  recordarPl();
  elems.forEach((x) => { x.x += mdx; x.y += mdy; });
  marcarCambioPl();
  pintar();
}

// Atajos del plano: Ctrl+C, Ctrl+V, Ctrl+E (todo), flechas y Supr con varios, Esc
let teclasPlano = false;
function conectarTeclasPlano() {
  if (teclasPlano) return;
  teclasPlano = true;
  document.addEventListener('keydown', (e) => {
    if (!S || !S.pl || S.vistaEdif !== 'plano' || modalActual) return;
    if (e.target.closest && e.target.closest('input, select, textarea, [contenteditable]')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 'c') { e.preventDefault(); copiarPl(); return; }
    if (ctrl && k === 'v') { e.preventDefault(); pegarPl(); return; }
    if (ctrl && (k === 'e' || k === 'a')) { e.preventDefault(); elegirVariosPl(S.pl.elems.map((x) => x.id)); return; }
    if (seleccionPl().length > 1) {
      const fl = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (fl && !e.shiftKey) { e.preventDefault(); moverVariosPl(fl[0], fl[1]); return; }
      if (e.key === 'Delete') { e.preventDefault(); quitarVariosDelPlano(); return; }
      if (e.key === 'Escape') { S.pl.multi = new Set(); seleccionarPl(S.pl.sel, null); pintarSeleccionPl(); }
    }
  });
}

/* ---------- Selección, historial y cambios ---------- */

function seleccionarPl(id, puerta) {
  if (!S.pl) return;
  if (S.pl.multi && S.pl.multi.size && !(S.pl.multi.has(id) || S.pl.sel === id)) S.pl.multi = new Set();
  S.pl.sel = id;
  S.pl.puerta = puerta;
  const multi = S.pl.multi || new Set();
  document.querySelectorAll('.hab-pl-el').forEach((x) => {
    const si = x.dataset.clave === id || multi.has(x.dataset.clave) || multi.has(Number(x.dataset.clave));
    x.classList.toggle('hab-cq-el--sel', si);
    x.setAttribute('aria-pressed', String(si));
    x.querySelectorAll('.hab-pl-puerta').forEach((p, i) => p.classList.toggle('hab-pl-puerta--sel', si && i === puerta));
  });
  const edif = porId(S.edificios, S.pl.edifId);
  if (edif) pintarPanelPl(edif, S.pl.planta, sinUbicar(edif, S.pl.planta, S.pl.elems));
  actualizarCinta();
}

function recordarPl() {
  S.pl.hist.push(JSON.stringify(S.pl.elems));
  if (S.pl.hist.length > 40) S.pl.hist.shift();
}
function marcarCambioPl() {
  S.pl.cambios = true;
  actualizarCinta();
}
function deshacerPl() {
  const ult = S.pl?.hist.pop();
  if (!ult) { toast('No hay nada que deshacer'); return; }
  S.pl.elems = JSON.parse(ult);
  S.pl.cambios = true;
  pintar();
}

/** Primer hueco libre del tamaño pedido (si no hay, arriba a la izquierda). */
function huecoPlano(elems, w, h, desdeX = 0, desdeY = 0) {
  for (let y = desdeY; y + h <= PL_FILAS; y++) {
    for (let x = (y === desdeY ? desdeX : 0); x + w <= PL_COLS; x++) {
      if (!elems.some((c) => choca({ x, y, w, h }, c))) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/** Pone un espacio en el plano: en un punto, dentro de otro, junto a una copia o en el primer hueco. */
function ubicarEnPlano(esp, donde = null) {
  let [w, h] = PL_TAM[esp.tipo] || [5, 5];
  let x, y;
  if (donde?.dentro) {
    const p = donde.dentro;
    w = Math.max(2, Math.min(w, p.w - 2)); h = Math.max(2, Math.min(h, p.h - 2));
    x = p.x + 1; y = p.y + 1;
  } else if (donde?.copiaDe) {
    const p = donde.copiaDe;
    w = p.w; h = p.h;
    ({ x, y } = huecoPlano(S.pl.elems, w, h, Math.min(PL_COLS - w, p.x + p.w), p.y));
  } else if (donde && donde.gx != null) {
    x = Math.max(0, Math.min(PL_COLS - w, donde.gx)); y = Math.max(0, Math.min(PL_FILAS - h, donde.gy));
  } else {
    ({ x, y } = huecoPlano(S.pl.elems, w, h));
  }
  recordarPl();
  const el = { id: esp.id, x, y, w, h, puertas: [{ l: 's', p: 0.5 }] };
  S.pl.elems.push(el);
  return el;
}

function quitarDelPlano(el) {
  recordarPl();
  S.pl.elems = S.pl.elems.filter((x) => x !== el);
  S.pl.sel = null; S.pl.puerta = null;
  marcarCambioPl();
  pintar();
}
function girarPl(el) {
  recordarPl();
  const w = Math.min(el.h, PL_COLS), h = Math.min(el.w, PL_FILAS);
  el.w = w; el.h = h;
  el.x = Math.min(el.x, PL_COLS - w); el.y = Math.min(el.y, PL_FILAS - h);
  const giro = { n: 'e', e: 's', s: 'o', o: 'n' };
  el.puertas.forEach((p) => { p.l = giro[p.l]; });
  marcarCambioPl();
  pintar();
}
function agregarPuertaPl(el) {
  if (el.puertas.length >= PL_MAX_PUERTAS) { toast(`Máximo ${PL_MAX_PUERTAS} puertas por espacio`); return; }
  recordarPl();
  const lado = ['s', 'n', 'e', 'o'].find((l) => !el.puertas.some((p) => p.l === l)) || 's';
  el.puertas.push({ l: lado, p: 0.5 });
  S.pl.sel = el.id; S.pl.puerta = el.puertas.length - 1;
  marcarCambioPl();
  pintar();
  toast('Puerta agregada. Arrástrela por la pared hasta su lugar.');
}
function quitarPuertaPl(el) {
  if (!el.puertas.length) return;
  recordarPl();
  const i = S.pl.puerta != null && el.puertas[S.pl.puerta] ? S.pl.puerta : el.puertas.length - 1;
  el.puertas.splice(i, 1);
  S.pl.puerta = null;
  marcarCambioPl();
  pintar();
}

/* Crea el espacio con la ventana de siempre (nombre, camas…) y,
   al volver, lo deja ubicado donde se pidió. */
function nuevoEspacioPl(edif, planta, tipo, donde) {
  S.pl.pendiente = donde || null;
  modalEspacio(null, { edif, planta, frente: edif.tiene_frentes ? 'A' : null, tipo });
}

async function crearSegPl(edif, planta, tipo, ancla, px, py) {
  if (!editaSeg()) { toast(S.seguridadFalta ? 'Falta preparar la base de datos de seguridad (habitaciones_etapa3.sql).' : 'Solo el técnico de seguridad o el administrador colocan equipos.'); return; }
  const iguales = seguridadDe(edif.id).filter((x) => x.tipo === tipo).length;
  const prefijo = { extintor: 'EXT', botiquin: 'BOT', detector_humo: 'DET', alarma: 'ALM', luz_emergencia: 'LE', foco: 'FOC' }[tipo];
  const fila = alCrear({
    empresa_id: S.empresaId, edificio_id: edif.id, tipo, planta,
    x: +px.toFixed(2), y: +py.toFixed(2),
    ancla_tipo: ancla.ancla_tipo, ancla_espacio: ancla.ancla_espacio || null, ancla_pasillo: null,
    codigo: prefijo ? `${prefijo}-${String(iguales + 1).padStart(2, '0')}` : null,
    datos: tipo === 'ruta_evacuacion' ? { direccion: '→' } : tipo === 'otra_senal' ? { categoria: 'Advertencia' } : {}
  });
  const { data, error } = await S.sb.from('viv_seguridad').insert(fila).select().single();
  if (error) { toast(mensajeError(error)); return; }
  S.seguridad.push(data);
  pintar();
  modalSeguridad(data, true);
}

/* ---------- Menús del clic derecho ---------- */

function menuTiposPl(accion) {
  return Object.keys(TIPOS_ESPACIO).map((k) => ({ label: TIPOS_ESPACIO[k], color: (COLOR_TIPO[k] || COLOR_TIPO.otro)[1], accion: () => accion(k) }));
}
function menuSeguridadPl(colocar) {
  const equipos = EQUIPOS_PL.filter((k) => TIPOS_SEG[k]).map((k) => ({ label: TIPOS_SEG[k].n, seg: k, accion: () => colocar(k) }));
  const grupos = {};
  Object.entries(TIPOS_SEG).forEach(([k, t]) => {
    if (!t.g || EQUIPOS_PL.includes(k)) return;
    (grupos[t.g] = grupos[t.g] || []).push({ label: t.n, seg: k, accion: () => colocar(k) });
  });
  const senal = Object.entries(grupos).map(([g, l]) => ({ label: g, seg: l[0].seg, sub: l }));
  return [
    { label: 'Equipos de emergencia', sub: equipos },
    { label: 'Señalética', sub: senal }
  ];
}

function menuEspacioPl(esp, el, edif, punto) {
  const planta = S.pl.planta;
  const hab = esp?.tipo === 'habitacion';
  const l = [];
  if (hab) {
    const camas = camasDe(esp.id);
    l.push({ label: 'Camas', sub: [
      { label: '+ Cama o litera…', accion: () => modalAgregarCama(esp) },
      { label: '− Quitar camas…', accion: () => modalQuitarCamas(esp), deshabilitado: !camas.length }
    ] });
    const libre = camas.find((x) => !asigDeCama(x.id));
    l.push({ label: 'Asignar cama a un trabajador…', deshabilitado: !libre || !S.asigna, accion: () => abrirCama(libre, 'asignar') });
    if (!S.areasFalta) {
      l.push({ label: 'Área de trabajo', sub: [
        ...S.areas.map((a) => ({ label: `${a.icono} ${a.nombre}${esp.area_id === a.id ? '  ✓' : ''}`, accion: () => asignarArea(esp, a.id) })),
        { label: 'Sin área', accion: () => asignarArea(esp, null), deshabilitado: !esp.area_id },
        { label: '+ Nueva área para esta habitación…', accion: () => modalAreas((areaId) => { if (areaId != null) asignarArea(esp, areaId); }, true) },
        { label: 'Administrar áreas…', accion: () => modalAreas() }
      ] });
    }
  }
  if (esp && CON_PIEZAS.includes(esp.tipo)) {
    l.push({ label: 'Piezas del baño', sub: [
      ...Object.entries(TIPOS_PIEZA).map(([t, dd]) => ({ label: `Agregar ${dd.n.toLowerCase()}`, accion: () => agregarPieza(esp, t, punto.px, punto.py) })),
      { label: 'Cantidades…', accion: () => modalPiezasConteo(esp) }
    ] });
  }
  l.push({ label: 'Agregar cuarto interno', sub: menuTiposPl((t) => nuevoEspacioPl(edif, planta, t, { dentro: el })) });
  l.push({ label: 'Agregar puerta', accion: () => agregarPuertaPl(el), deshabilitado: el.puertas.length >= PL_MAX_PUERTAS });
  if (el.puertas.length) l.push({ label: 'Quitar puerta', accion: () => quitarPuertaPl(el) });
  if (editaSeg()) {
    l.push({ sep: true });
    menuSeguridadPl((tipo) => crearSegPl(edif, planta, tipo, { ancla_tipo: 'espacio', ancla_espacio: esp.id }, punto.px, punto.py)).forEach((x) => l.push(x));
  }
  l.push({ sep: true });
  l.push({ label: 'Nombre o tipo…', k: 'F2', accion: () => modalEspacio(esp, { edif, planta: esp.planta, frente: esp.frente }) });
  l.push({ label: 'Duplicar', accion: () => nuevoEspacioPl(edif, planta, esp.tipo, { copiaDe: el }) });
  l.push({ label: 'Girar', accion: () => girarPl(el) });
  l.push({ label: 'Quitar del plano', k: 'Supr', accion: () => quitarDelPlano(el) });
  l.push({ sep: true });
  l.push({ label: 'Eliminar espacio…', peligro: true, accion: () => modalQuitarEspacio(esp) });
  return l;
}

function menuLienzoPl(edif, planta, faltan, punto) {
  const l = [{ label: 'Agregar espacio', sub: menuTiposPl((t) => nuevoEspacioPl(edif, planta, t, { gx: punto.gx, gy: punto.gy })) }];
  if (faltan.length) {
    l.push({ label: 'Ubicar espacio ya creado', sub: faltan.map((x) => ({ label: nombreEsp(x), accion: () => {
      const el = ubicarEnPlano(x, { gx: punto.gx, gy: punto.gy });
      S.pl.sel = el.id; marcarCambioPl(); pintar();
    } })) });
  }
  if (editaSeg()) {
    l.push({ sep: true });
    menuSeguridadPl((tipo) => crearSegPl(edif, planta, tipo, { ancla_tipo: 'planta', ancla_espacio: null }, punto.px, punto.py)).forEach((x) => l.push(x));
  }
  l.push({ sep: true });
  l.push({ label: 'Deshacer', k: 'Ctrl+Z', accion: deshacerPl, deshabilitado: !S.pl.hist.length });
  l.push({ label: 'Guardar plano', accion: () => guardarPlano(edif, planta), deshabilitado: !S.pl.cambios });
  return l;
}

/* Menú flotante con submenús (se abren al pasar el mouse) */
function cerrarMenuPl() {
  document.querySelectorAll('.pl-menu').forEach((n) => n.remove());
}
let menuPlConectado = false;
function abrirMenuPl(items, x, y, titulo) {
  cerrarMenuPl();
  if (!menuPlConectado) {
    menuPlConectado = true;
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.pl-menu')) cerrarMenuPl(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarMenuPl(); });
    window.addEventListener('resize', cerrarMenuPl);
    document.addEventListener('wheel', (e) => { if (!e.target.closest?.('.pl-menu')) cerrarMenuPl(); }, { passive: true });
  }
  panelMenuPl(items, x, y, 0, titulo);
}
function panelMenuPl(items, x, y, nivel, titulo, junto = null) {
  document.querySelectorAll('.pl-menu').forEach((n) => { if (Number(n.dataset.nivel) >= nivel) n.remove(); });
  const m = document.createElement('div');
  m.className = 'pl-menu';
  m.dataset.nivel = nivel;
  m.setAttribute('role', 'menu');
  if (titulo) m.insertAdjacentHTML('beforeend', `<div class="pl-menu-titulo">${esc(titulo)}</div>`);
  items.forEach((it) => {
    if (it.sep) { m.insertAdjacentHTML('beforeend', '<div class="pl-menu-sep" role="separator"></div>'); return; }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.className = 'pl-menu-item' + (it.peligro ? ' pl-menu-peligro' : '');
    b.disabled = !!it.deshabilitado;
    const marca = it.seg ? `<span class="pl-menu-seg">${svgSeg({ tipo: it.seg, datos: {} })}</span>`
      : it.color ? `<span class="pl-menu-punto" style="background:${it.color}"></span>` : '';
    b.innerHTML = `<span class="pl-menu-texto">${marca}${esc(it.label)}</span><span class="pl-menu-k">${it.sub ? '▸' : esc(it.k || '')}</span>`;
    b.addEventListener('mouseenter', () => {
      m.querySelectorAll('.pl-menu-item').forEach((o) => o.classList.toggle('pl-menu-abierto', o === b && !!it.sub));
      if (it.sub) { const r = b.getBoundingClientRect(); panelMenuPl(it.sub, r.right - 4, r.top - 6, nivel + 1, '', r); }
      else document.querySelectorAll('.pl-menu').forEach((n) => { if (Number(n.dataset.nivel) > nivel) n.remove(); });
    });
    b.addEventListener('click', () => {
      if (it.sub) { const r = b.getBoundingClientRect(); panelMenuPl(it.sub, r.right - 4, r.top - 6, nivel + 1, '', r); return; }
      cerrarMenuPl();
      it.accion?.();
    });
    m.appendChild(b);
  });
  document.body.appendChild(m);
  // Que quepa en la pantalla (los submenús se abren a la izquierda si no hay lugar)
  const r = m.getBoundingClientRect();
  let left = x, top = y;
  if (left + r.width > innerWidth - 8) left = junto ? junto.left - r.width + 4 : innerWidth - r.width - 8;
  if (top + r.height > innerHeight - 8) top = Math.max(8, innerHeight - r.height - 8);
  m.style.left = `${Math.max(8, left)}px`;
  m.style.top = `${top}px`;
}

/* ---------- Cinta de opciones (como Word / PowerPoint) ---------- */

function cintaHtml() {
  const tabs = { inicio: 'Inicio', insertar: 'Insertar', seguridad: 'Seguridad', vista: 'Vista' };
  return `<div class="pl-cinta" role="toolbar" aria-label="Herramientas del plano">
    <div class="pl-cinta-tabs" role="tablist">
      ${Object.entries(tabs).map(([k, v]) => `<button type="button" role="tab" class="pl-cinta-tab" data-cinta="${k}" aria-selected="${S.plCinta === k}">${v}</button>`).join('')}
      <span style="flex:1 1 auto"></span>
      <button type="button" class="pl-cinta-top" data-pla="deshacer">${svgIco(ICO_PL.deshacer)} Deshacer</button>
      <button type="button" class="pl-cinta-top pl-cinta-guardar" data-pla="guardar">${svgIco(ICO_PL.guardar)} Guardar plano</button>
    </div>
    <div class="pl-cinta-cuerpo" id="pl-cinta-cuerpo"></div>
  </div>`;
}

function botonCinta(label, d, accion, extra = {}) {
  return { label, d, accion, ...extra };
}

function gruposCinta(edif, planta) {
  const el = S.pl.elems.find((x) => x.id === S.pl.sel);
  const esp = el && porId(S.espacios, el.id);
  const conSel = (f) => () => (el ? f() : toast('Primero toque un espacio del plano'));
  const colocar = (tipo) => () => {
    if (!editaSeg()) { toast('Solo el técnico de seguridad o el administrador colocan equipos.'); return; }
    S.pl.colocar = tipo; pintar();
  };
  switch (S.plCinta) {
    case 'inicio': return [
      { nombre: 'Plano', botones: [
        botonCinta('Guardar', ICO_PL.guardar, () => guardarPlano(edif, planta), { off: !S.pl.cambios }),
        botonCinta('Deshacer', ICO_PL.deshacer, deshacerPl, { off: !S.pl.hist.length }),
        botonCinta('Armar desde frentes', ICO_PL.armar, () => {
          if (S.pl.elems.length && !confirm('¿Rehacer el plano de esta planta a partir de la vista por frentes? Lo que movió a ojo se reemplaza (puede usar Deshacer).')) return;
          recordarPl();
          S.pl.elems = armarDesdeFrentes(edif, planta);
          S.pl.armado = true; S.pl.sel = null;
          marcarCambioPl(); pintar();
        })] },
      { nombre: 'Espacio elegido', botones: [
        botonCinta('Nombre o tipo', ICO_PL.editar, conSel(() => modalEspacio(esp, { edif, planta: esp.planta, frente: esp.frente })), { off: !el }),
        botonCinta('Duplicar', ICO_PL.duplicar, conSel(() => nuevoEspacioPl(edif, planta, esp.tipo, { copiaDe: el })), { off: !el }),
        botonCinta('Girar', ICO_PL.girar, conSel(() => girarPl(el)), { off: !el }),
        botonCinta('+ Puerta', ICO_PL.puerta, conSel(() => agregarPuertaPl(el)), { off: !el }),
        botonCinta('Quitar del plano', ICO_PL.quitar, conSel(() => quitarDelPlano(el)), { off: !el }),
        botonCinta('Eliminar', ICO_PL.borrar, conSel(() => modalQuitarEspacio(esp)), { off: !el, color: '#C62828' })] }
    ];
    case 'seguridad': {
      const grupos = menuSeguridadPl((t) => colocar(t)())[1].sub;
      return [
        { nombre: 'Equipos de emergencia (toque luego en el plano)', botones: EQUIPOS_PL.filter((k) => TIPOS_SEG[k]).map((k) =>
          botonCinta(TIPOS_SEG[k].n.split(' ')[0], null, colocar(k), { seg: k })) },
        { nombre: 'Señalética', botones: grupos.map((g) => botonCinta(g.label.split(' ')[0], null, (ev) => {
          const r = ev.currentTarget.getBoundingClientRect();
          abrirMenuPl(g.sub, r.left, r.bottom + 4, g.label);
        }, { seg: g.seg })) }
      ];
    }
    case 'vista': return [
      { nombre: 'Mostrar', botones: [
        botonCinta('Cuadrícula', ICO_PL.grid, () => { S.plVer.grid = !S.plVer.grid; pintar(); }, { on: S.plVer.grid }),
        botonCinta('Camas', ICO_PL.cama, () => { S.plVer.camas = !S.plVer.camas; pintar(); }, { on: S.plVer.camas }),
        botonCinta('Seguridad', ICO_PL.ojo, () => { S.plVer.seg = !S.plVer.seg; pintar(); }, { on: S.plVer.seg })] },
      { nombre: 'Pantalla', botones: [
        botonCinta('Pantalla completa', ICO_PL.pantalla, () => {
          const z = document.querySelector('.hab');
          if (document.fullscreenElement) document.exitFullscreen(); else z?.requestFullscreen?.();
        })] }
    ];
    default: return [
      { nombre: 'Espacios (o clic derecho en el plano)', botones: Object.keys(TIPOS_ESPACIO).map((k) =>
        botonCinta(CORTO_PL[k] || TIPOS_ESPACIO[k], ICO_PL[k] || ICO_PL.otro, () => nuevoEspacioPl(edif, planta, k, null), { color: (COLOR_TIPO[k] || COLOR_TIPO.otro)[1] })) },
      { nombre: 'Espacio elegido', botones: [
        botonCinta('Puerta', ICO_PL.puerta, conSel(() => agregarPuertaPl(el)), { off: !el }),
        botonCinta('Cama o litera', ICO_PL.cama, conSel(() => (esp.tipo === 'habitacion' ? modalAgregarCama(esp) : toast('Las camas van en habitaciones'))), { off: !el || esp?.tipo !== 'habitacion' })] }
    ];
  }
}

function conectarCinta(edif, planta) {
  document.querySelectorAll('[data-cinta]').forEach((b) => b.addEventListener('click', () => { S.plCinta = b.dataset.cinta; actualizarCinta(); }));
  document.querySelector('[data-pla="deshacer"]')?.addEventListener('click', deshacerPl);
  document.querySelector('[data-pla="guardar"]')?.addEventListener('click', (e) => conBoton(e.currentTarget, () => guardarPlano(edif, planta)));
  actualizarCinta();
}

function actualizarCinta() {
  const $c = document.getElementById('pl-cinta-cuerpo');
  if (!$c || !S.pl) return;
  const edif = porId(S.edificios, S.pl.edifId);
  document.querySelectorAll('[data-cinta]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.cinta === S.plCinta)));
  const g = document.querySelector('[data-pla="guardar"]');
  if (g) g.classList.toggle('pl-pendiente', !!S.pl.cambios);
  $c.innerHTML = '';
  gruposCinta(edif, S.pl.planta).forEach((grupo) => {
    const $g = document.createElement('div');
    $g.className = 'pl-cinta-grupo';
    const $b = document.createElement('div');
    $b.className = 'pl-cinta-botones';
    grupo.botones.forEach((bt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pl-cinta-btn' + (bt.on ? ' pl-on' : '');
      b.disabled = !!bt.off;
      b.innerHTML = `${bt.seg ? `<span class="pl-cinta-seg">${svgSeg({ tipo: bt.seg, datos: {} })}</span>` : svgIco(bt.d, bt.color || '#123A7A')}<span>${esc(bt.label)}</span>`;
      b.title = bt.seg ? (TIPOS_SEG[bt.seg]?.n || bt.label) : bt.label;
      b.addEventListener('click', (ev) => bt.accion(ev));
      $b.appendChild(b);
    });
    $g.appendChild($b);
    $g.insertAdjacentHTML('beforeend', `<div class="pl-cinta-nombre">${esc(grupo.nombre)}</div>`);
    $c.appendChild($g);
  });
}

/* ---------- Panel de propiedades ---------- */

function pintarPanelPl(edif, planta, faltan) {
  const $p = document.getElementById('pl-panel');
  if (!$p) return;
  const editando = !!S.pl;
  const id = editando ? S.pl.sel : null;
  const esp = id && porId(S.espacios, id);
  const leyenda = `<div class="pl-leyenda">
      <div class="pl-panel-etq">Leyenda</div>
      <span><i style="background:var(--hab-libre)"></i>Cama libre</span>
      <span><i style="background:#D9534F"></i>Cama ocupada</span>
      ${['habitacion', 'banos', 'comedor', 'oficina', 'escaleras'].map((k) => `<span><i class="pl-cuadro" style="background:${COLOR_TIPO[k][0]};border-color:${COLOR_TIPO[k][1]}"></i>${TIPOS_ESPACIO[k]}</span>`).join('')}
    </div>`;
  if (!esp) {
    $p.innerHTML = `<div class="pl-panel-etq">Propiedades</div>
      <p class="ayuda">${editando ? 'Toque un espacio para ver sus datos y camas. Use la cinta o el <b>clic derecho</b> para agregar espacios, puertas, equipos y señalética.' : 'Toque una cama para ver quién la ocupa.'}</p>
      ${editando && faltan.length ? `<div class="pl-panel-etq">Sin ubicar en el plano</div>
        <div class="pl-faltan">${faltan.map((x) => `<button type="button" class="hab-chip" data-ubicar="${x.id}">${esc(nombreEsp(x))}</button>`).join('')}</div>
        ${faltan.length > 1 ? '<button type="button" class="boton-secundario boton-compacto" id="pl-ubicar-todos">Ubicar todos</button>' : ''}` : ''}
      ${!editando && faltan.length ? `<p class="ayuda">Sin ubicar: ${faltan.map((x) => esc(nombreEsp(x))).join(', ')}.</p>` : ''}
      ${leyenda}`;
    $p.querySelectorAll('[data-ubicar]').forEach((b) => b.addEventListener('click', () => {
      const x = porId(S.espacios, b.dataset.ubicar);
      const el = ubicarEnPlano(x);
      S.pl.sel = el.id; marcarCambioPl(); pintar();
    }));
    document.getElementById('pl-ubicar-todos')?.addEventListener('click', () => {
      // Se acomodan como están en la vista por frentes; si chocan con lo ya dibujado, en el primer hueco
      recordarPl();
      const sugeridos = armarDesdeFrentes(edif, planta, new Set(faltan.map((x) => x.id)));
      sugeridos.forEach((el) => {
        if (S.pl.elems.some((c) => choca(el, c))) { const h = huecoPlano(S.pl.elems, el.w, el.h); el.x = h.x; el.y = h.y; }
        S.pl.elems.push(el);
      });
      marcarCambioPl(); pintar();
      toast('Espacios ubicados. Arrastre cada uno a su lugar.');
    });
    return;
  }
  const [fondo, borde] = COLOR_TIPO[esp.tipo] || COLOR_TIPO.otro;
  const camas = esp.tipo === 'habitacion' ? camasDe(esp.id) : [];
  const ocup = camas.filter((c) => asigDeCama(c.id)).length;
  $p.innerHTML = `<div class="pl-panel-etq">Propiedades</div>
    <div class="pl-panel-nombre">${esc(nombreEsp(esp))}</div>
    <span class="pl-panel-tipo" style="background:${fondo};border-color:${borde}">${esc(TIPOS_ESPACIO[esp.tipo])}</span>
    ${esp.tipo === 'habitacion' ? `<p class="pl-panel-dato">${camas.length} camas · ${ocup} ocupadas · ${camas.length - ocup} libres</p>
      <div class="pl-panel-camas" id="pl-panel-camas"></div>` : ''}
    ${editando ? `<div class="pl-panel-acciones">
      <button type="button" class="boton-secundario boton-compacto" data-pa="editar">Nombre o tipo</button>
      ${esp.tipo === 'habitacion' ? '<button type="button" class="boton-secundario boton-compacto" data-pa="cama">+ Cama o litera</button>' : ''}
      <button type="button" class="boton-secundario boton-compacto" data-pa="puerta">+ Puerta</button>
      <button type="button" class="boton-secundario boton-compacto" data-pa="quitar">Quitar del plano</button>
    </div>
    <p class="ayuda">Clic derecho sobre el espacio para más opciones.</p>` : ''}
    ${leyenda}`;
  const $c = document.getElementById('pl-panel-camas');
  camas.forEach((cama) => {
    const a = asigDeCama(cama.id);
    const t = a && S.trab.get(a.trabajador_id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pl-panel-cama' + (a ? ' pl-ocupada' : '');
    const nombre = cama.tipo === 'litera' ? `Litera ${cama.numero} · ${cama.nivel === 'superior' ? 'arriba' : 'abajo'}` : `Cama ${cama.numero}`;
    b.innerHTML = `<i></i><span><b>${esc(nombre)}</b><small>${a ? esc(t?.nombre_completo || 'Ocupada') : 'Libre'}</small></span>`;
    b.addEventListener('click', () => abrirCama(cama));
    $c?.appendChild(b);
  });
  const el = editando && S.pl.elems.find((x) => x.id === esp.id);
  $p.querySelector('[data-pa="editar"]')?.addEventListener('click', () => modalEspacio(esp, { edif, planta: esp.planta, frente: esp.frente }));
  $p.querySelector('[data-pa="cama"]')?.addEventListener('click', () => modalAgregarCama(esp));
  $p.querySelector('[data-pa="puerta"]')?.addEventListener('click', () => el && agregarPuertaPl(el));
  $p.querySelector('[data-pa="quitar"]')?.addEventListener('click', () => el && quitarDelPlano(el));
}

async function guardarPlano(edif, planta) {
  const actuales = new Map(S.pl.elems.map((x) => [x.id, x]));
  const ops = [];
  espaciosDe(edif.id).filter((x) => x.planta === planta).forEach((esp) => {
    const el = actuales.get(esp.id);
    const nuevo = el
      ? { plano_x: el.x, plano_y: el.y, plano_w: el.w, plano_h: el.h, plano_puertas: el.puertas.map((p) => ({ l: p.l, p: Math.round(p.p * 1000) / 1000 })) }
      : { plano_x: null, plano_y: null, plano_w: null, plano_h: null, plano_puertas: [] };
    const igual = esp.plano_x === nuevo.plano_x && esp.plano_y === nuevo.plano_y && esp.plano_w === nuevo.plano_w
      && esp.plano_h === nuevo.plano_h && JSON.stringify(esp.plano_puertas || []) === JSON.stringify(nuevo.plano_puertas);
    if (!igual) ops.push(S.sb.from('viv_espacios').update(alEditar(nuevo)).eq('id', esp.id));
  });
  if (ops.length === 0) { S.pl.cambios = false; actualizarCinta(); toast('No hay cambios por guardar'); return; }
  const res = await Promise.all(ops);
  const fallo = res.find((r) => r.error);
  if (fallo) { toast(mensajeError(fallo.error)); return; }
  // La vista por frentes se acomoda según lo dibujado
  const errFrentes = await acomodarFrentesDesdePlano(edif, planta, S.pl.elems);
  if (errFrentes) toast('Plano guardado, pero no se pudo acomodar la vista por frentes: ' + errFrentes);
  const sel = S.pl.sel;
  S.pl = null;
  await recargar();
  if (S.pl) { S.pl.sel = sel && porId(S.espacios, sel) ? sel : null; pintar(); }
  toast('Plano guardado');
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
    <p class="ayuda">Las camas se dibujan pequeñas, con su número y su color de estado (libre u ocupada); los planos no muestran datos de las personas.</p>
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
        nombres: false,
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
      if (!edif.tiene_frentes && pasilloDe(edif, p) === 'lado') planta.appendChild(pasilloHtml('lado'));
      $f.appendChild(planta);
      pintarSeguridad($f, edif);
      const area = document.createElement('div');
      area.className = 'hab-imp-area';
      area.appendChild($f);
      hoja.appendChild(area);
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

  /* Cada plano se ajusta al área libre de su hoja (lo que queda
     entre el encabezado y la leyenda, que nunca se recortan):
     se amplía o reduce sin deformarse y, si lo limita el alto,
     se ensancha hasta ocupar todo el ancho de la hoja. Se mide
     con las hojas ya armadas y con su alto real. */
  $imp.classList.add('hab-imp-midiendo');
  $imp.querySelectorAll('.hab-imp-area').forEach((area) => {
    const $p = area.querySelector('.hab-imp-plano');
    const anchoUtil = area.clientWidth - 4;
    const altoUtil = area.clientHeight - 4;
    // Máximo 1,35: más allá, los títulos de cuartos y pasillos
    // quedan desproporcionados frente a las camas pequeñas.
    const escala = Math.min(anchoUtil / $p.scrollWidth, altoUtil / $p.scrollHeight, 1.35);
    $p.style.zoom = escala.toFixed(3);
    /* Las señales miden ~5 mm en el papel (19 px a 96 ppp),
       sin importar cuánto se amplió o redujo el plano. */
    $p.style.setProperty('--hab-seg-imp', `${(19 / escala).toFixed(1)}px`);
    // Camas: ~7 × 4 mm en el papel
    $p.style.setProperty('--hab-cama-imp', `${(26 / escala).toFixed(1)}px`);
    if (anchoUtil / $p.scrollWidth > escala + 0.01) {
      // Limitado por el alto: el plano se estira a lo ancho
      $p.style.width = `${Math.floor(anchoUtil / escala)}px`;
    }
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

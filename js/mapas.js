/* ============================================
   NEXUS · mapas.js
   Pestaña «Mapas de evacuación y riesgos» de cada base
   (al lado de «Croquis» en Habitaciones).

   Una hoja como los planos del Anexo 16:
   - El campamento entero: terreno, accesos, edificios con sus
     cuartos por dentro (del plano de cada piso), cancha, etc.
   - Las plantas altas dibujadas aparte, abajo.
   - Evacuación: rutas con flechas verdes, salidas, punto de
     encuentro, «usted se encuentra aquí», extintores, botiquines…
   - Riesgos: señales de advertencia, prohibición y obligación,
     también «en todas las habitaciones» de una vez.
   - Leyenda automática (con «Control del riesgo»), rosa de los
     vientos, fecha y «Elaborado por».
   - Impresión en A3 o A1 horizontal (vectorial, nítida).

   Módulo aparte: se carga solo al abrir la pestaña. Solo LEE el
   croquis, los planos y la señalética; lo suyo va en viv_mapas
   (sql/habitaciones_etapa8_mapas.sql).
   ============================================ */

const VERSION = 'v4';
console.info('NEXUS · mapas', VERSION);

/* ---------- Hoja (unidades del dibujo) ---------- */
const W = 1600, H = 1130;
// Zona del dibujo y columna derecha (rosa, leyenda, cajetín). El de riesgos
// lleva la columna «Control del riesgo», así que su leyenda es más ancha.
let AREA = { x: 24, y: 112, w: 1160, h: 996 };
let COL = { x: 1206, w: 372 };
function geometria() {
  if (M && M.tipo === 'riesgos') { AREA = { x: 24, y: 112, w: 1000, h: 996 }; COL = { x: 1046, w: 532 }; }
  else { AREA = { x: 24, y: 112, w: 1160, h: 996 }; COL = { x: 1206, w: 372 }; }
}
const CQ_COLS = 40, CQ_FILAS = 25;                       // cuadrícula del croquis
const VERDE = '#16c60c';
const TAM_SENAL = 30;

const TIPOS_MAPA = { evacuacion: 'Mapa de evacuación y recursos', riesgos: 'Mapa de riesgos' };
const ESTILOS_CAPA = {
  evacuacion: ['rojo', 'verde', 'botiquin', 'luz'],
  riesgos: ['advertencia', 'prohibicion', 'obligacion', 'info']
};
const GRUPOS_CAPA = {
  evacuacion: ['Contra incendios', 'Evacuación y salvamento', 'Primeros auxilios', 'Iluminación'],
  riesgos: ['Advertencia (peligro)', 'Prohibición', 'Obligación', 'Información', 'Otra']
};

/* «Control del riesgo» sugerido (se puede cambiar en cada mapa) */
const CONTROL_DEFECTO = {
  riesgo_electrico: 'No manipular cajas de breakers ni sistemas eléctricos sin estar capacitado. Ante un desperfecto, notificar al personal técnico. No sobrecargar tomacorrientes ni extensiones.',
  riesgo_incendio: 'Los brigadistas deben estar capacitados en el uso de extintores y actuar según el plan de emergencia. No encender llamas abiertas; prohibido fumar en las habitaciones.',
  inflamable: 'Mantener alejado de fuentes de calor y llamas. Almacenar en lugar ventilado y señalizado.',
  caida_desnivel: 'Prestar atención al subir o bajar las gradas; usar el pasamanos y no correr.',
  piso_resbaladizo: 'No correr cuando el piso esté mojado. Mantener el piso seco en cocina y baños.',
  riesgo_tropezar: 'Caminar atento a los obstáculos. Mantener el orden y la limpieza de las instalaciones.',
  superficie_caliente: 'Usar guantes para manipular objetos calientes. No realizar las actividades de cocina con prisa.',
  explosion: 'Revisar válvulas y mangueras de gas. Mantener los cilindros en lugares ventilados, sin golpes. Dar mantenimiento a las cocinas industriales.',
  gas_presion: 'Revisar periódicamente válvulas, mangueras y ductos de gas. Cilindros asegurados y ventilados.',
  riesgo_corte: 'Usar cuchillos y objetos cortopunzantes con atención; mantenerlos en buen estado y bien guardados.',
  sierra_electrica: 'Mantener las manos en un sitio seguro y evitar distracciones. Si la máquina falla, comunicar de inmediato al responsable.',
  riesgo_ergonomico: 'Realizar pausas activas cada hora (al menos 3 minutos). Usar coches de ruedas para trasladar cargas.',
  no_fumar: 'Prohibido fumar en las habitaciones e instalaciones, salvo en el punto permitido y señalado en el mapa.',
  no_fuego: 'Prohibido encender fuego en este sitio por riesgo de explosión o incendio.',
  no_apagar_agua: 'No apagar con agua el fuego de aceite caliente ni el de cortocircuitos: usar el extintor adecuado (PQS o CO₂).',
  no_joyas: 'En cocina no usar relojes, cadenas, pulseras, aretes ni anillos: pueden atascarse y causar accidentes.',
  prohibido_paso: 'Solo personal autorizado. No pueden ingresar personas ajenas a la empresa o sin autorización.',
  no_mascotas: 'Prohibido ingresar con mascotas a las instalaciones del campamento.',
  permitido_fumar: 'Se puede fumar solo en este punto. No dejar colillas en el piso.',
  usar_red_cabello: 'Uso obligatorio de red para el cabello en la cocina.',
  usar_mascarilla: 'Uso obligatorio de mascarilla en las áreas señaladas.',
  usar_botas_caucho: 'Uso obligatorio de botas de caucho con puntera de seguridad.',
  usar_guantes: 'Uso obligatorio de guantes de manejo.',
  agua_potable: 'Beber solo agua potable purificada del filtro.',
  riesgo_biologico: 'Usar el equipo de protección indicado y lavarse las manos. Desechar los residuos en el lugar asignado.',
  ruido: 'Usar protección auditiva en las áreas señaladas.'
};

let C = null;   // contexto que entrega habitaciones.js
let M = null;   // estado del mapa

/* ============================================
   Montaje
   ============================================ */
export async function montarMapas(ctx) {
  C = ctx;
  M = {
    tipo: 'evacuacion', herr: 'sel', sel: null, temp: null, cambios: false, hist: [],
    filas: { evacuacion: null, riesgos: null },     // filas de viv_mapas
    comun: { terreno: [], items: [] },               // terreno, vías y textos (sirven a los dos mapas)
    propios: { evacuacion: [], riesgos: [] },
    datos: { fecha: hoyIso(), elaborado_nombre: '', elaborado_cargo: '', elaborado_entidad: '' },
    controles: {},
    empresa: '', falta: false, rects: {}
  };
  C.contenedor.innerHTML = '<p class="ayuda">Cargando mapas…</p>';
  await cargar();
  pintar();
}

async function cargar() {
  const { data, error } = await C.sb.from('viv_mapas').select('*').eq('base_id', C.base.id).eq('activo', true);
  if (error) { M.falta = /viv_mapas|relation|does not exist|schema cache/i.test(error.message || ''); if (!M.falta) C.toast(error.message); }
  (data || []).forEach((f) => { if (f.tipo in M.filas) M.filas[f.tipo] = f; });
  const ev = M.filas.evacuacion, ri = M.filas.riesgos;
  const esComun = (it) => it && (it.k === 'via' || it.k === 'texto');
  M.comun.terreno = (ev && Array.isArray(ev.terreno) ? ev.terreno : (ri && Array.isArray(ri.terreno) ? ri.terreno : [])) || [];
  M.comun.items = (ev ? (ev.elementos || []).filter(esComun) : (ri ? (ri.elementos || []).filter(esComun) : []));
  M.propios.evacuacion = ev ? (ev.elementos || []).filter((x) => !esComun(x)) : [];
  M.propios.riesgos = ri ? (ri.elementos || []).filter((x) => !esComun(x)) : [];
  M.controles = { ...(ri?.controles || {}) };
  M.titulos = { evacuacion: ev?.titulo || '', riesgos: ri?.titulo || '' };
  const ref = ev || ri;
  if (ref) {
    M.datos = { fecha: ref.fecha || hoyIso(), elaborado_nombre: ref.elaborado_nombre || '',
      elaborado_cargo: ref.elaborado_cargo || '', elaborado_entidad: ref.elaborado_entidad || '' };
  } else if (!M.falta) {
    // «Elaborado por» del último mapa de la empresa
    const u = await C.sb.from('viv_mapas').select('elaborado_nombre, elaborado_cargo, elaborado_entidad')
      .eq('empresa_id', C.empresaId).order('actualizado_en', { ascending: false }).limit(1);
    const x = (u.data || [])[0];
    if (x) Object.assign(M.datos, { elaborado_nombre: x.elaborado_nombre || '', elaborado_cargo: x.elaborado_cargo || '', elaborado_entidad: x.elaborado_entidad || '' });
  }
  try {
    const e = await C.sb.from('empresas').select('razon_social').eq('id', C.empresaId).maybeSingle();
    M.empresa = e.data?.razon_social || '';
  } catch { M.empresa = ''; }
  if (!M.datos.elaborado_entidad) M.datos.elaborado_entidad = M.empresa;
}

/* ============================================
   Utilidades
   ============================================ */
const esc = (t) => C.esc(t);
function hoyIso() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function fechaTxt(iso) { if (!iso) return ''; const [a, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${a}`; }
const r1 = (n) => Math.round(n * 10) / 10;
const items = () => M.comun.items.concat(M.propios[M.tipo]);
const tituloDe = (tipo) => (M.titulos && M.titulos[tipo]) || `${TIPOS_MAPA[tipo]} (${C.base.nombre})`;
function estiloDe(tipo, datos) {
  const t = C.TIPOS_SEG[tipo];
  if (!t) return 'neutro';
  if (tipo === 'otra_senal') {
    const g = { 'Advertencia': 'advertencia', 'Prohibición': 'prohibicion', 'Obligación': 'obligacion', 'Contra incendios': 'rojo', 'Evacuación y salvamento': 'verde' };
    return g[datos?.categoria] || 'advertencia';
  }
  return t.e;
}
const enCapa = (tipo, datos) => ESTILOS_CAPA[M.tipo].includes(estiloDe(tipo, datos));
function nombreSenal(tipo, datos) {
  if (tipo === 'otra_senal' && datos?.texto) return datos.texto;
  return C.TIPOS_SEG[tipo]?.n || tipo;
}
function svgSenal(tipo, x, y, tam, extra = '', datos = null) {
  const s = C.svgSeg({ tipo, datos: datos || {} }).replace('<svg ', `<svg x="${r1(x - tam / 2)}" y="${r1(y - tam / 2)}" width="${tam}" height="${tam}" ${extra} `);
  return s;
}
function guardarHist() { M.hist.push(JSON.stringify({ c: M.comun, p: M.propios })); if (M.hist.length > 60) M.hist.shift(); }
function deshacer() {
  const u = M.hist.pop();
  if (!u) { C.toast('No hay nada que deshacer'); return; }
  const o = JSON.parse(u); M.comun = o.c; M.propios = o.p; M.sel = null; M.cambios = true; pintar();
}
function marcar() { M.cambios = true; const b = document.getElementById('mp-guardar'); if (b) b.classList.add('mp-pendiente'); }

/* ============================================
   Dibujo de la hoja (SVG)
   ============================================ */
function hojaSvg(editando) {
  geometria();
  M.rects = {};
  const eds = C.edificios;
  const conAltas = eds.filter((e) => e.num_plantas > 1);
  // Plantas altas a la MISMA escala que su planta baja: se mide todo en celdas del croquis
  const bbox = (els) => {
    const minx = Math.min(...els.map((e) => e.x)), miny = Math.min(...els.map((e) => e.y));
    return { bw: Math.max(1, Math.max(...els.map((e) => e.x + e.w)) - minx), bh: Math.max(1, Math.max(...els.map((e) => e.y + e.h)) - miny) };
  };
  const piezas = [];
  conAltas.forEach((e) => {
    const c = C.croquis.find((x) => x.edificio_id === e.id);
    const cw = c ? c.w : 8, ch = c ? c.h : 4;
    const p1 = C.planoDe(e, 1) || [];
    const b1 = p1.length ? bbox(p1) : null;
    const k = b1 ? Math.min(cw / b1.bw, ch / b1.bh) : null;      // celdas por unidad del plano
    for (let p = 2; p <= e.num_plantas; p++) {
      const pl = C.planoDe(e, p) || [];
      if (pl.length && k) { const b = bbox(pl); piezas.push({ e, p, w: b.bw * k, h: b.bh * k }); }
      else piezas.push({ e, p, w: cw, h: ch });
    }
  });
  const usadas = C.croquis.length ? Math.min(CQ_FILAS, Math.max(...C.croquis.map((c) => c.y + c.h)) + 0.5) : CQ_FILAS;
  const HUECO = 1.2, TIT = 34, SEP = 22;                         // celdas entre piezas · px título · px separación
  const altoAltas = piezas.length ? Math.max(...piezas.map((x) => x.h)) : 0;
  const anchoAltas = piezas.reduce((a, x) => a + x.w, 0) + Math.max(0, piezas.length - 1) * HUECO;
  const cel = piezas.length
    ? Math.min(AREA.w / CQ_COLS, AREA.w / anchoAltas, (AREA.h - TIT - SEP) / (usadas + altoAltas))
    : Math.min(AREA.w / CQ_COLS, AREA.h / CQ_FILAS);
  const ox = AREA.x + (AREA.w - CQ_COLS * cel) / 2, oy = AREA.y;
  const cq = (c) => ({ x: ox + c.x * cel, y: oy + c.y * cel, w: c.w * cel, h: c.h * cel });

  let s = '';
  // Terreno
  if (M.comun.terreno.length >= 3) {
    s += `<polygon class="mp-terreno" points="${M.comun.terreno.map((p) => p.join(',')).join(' ')}" fill="#fbfbf8" stroke="#2b2b2b" stroke-width="2.4" stroke-linejoin="round"/>`;
  }
  // Vías y accesos (debajo de todo)
  M.comun.items.forEach((it, i) => { if (it.k === 'via') s += dibujarVia(it, i, editando, true); });

  // Elementos del croquis
  const titulo = (txt, r) => `<text x="${r1(r.x + r.w / 2)}" y="${r1(r.y + r.h / 2)}" text-anchor="middle" dominant-baseline="middle" font-size="${Math.max(10, Math.min(20, r.w / 9))}" fill="#222" font-family="Arial, Helvetica, sans-serif">${esc(String(txt).toUpperCase())}</text>`;
  C.croquis.forEach((c) => {
    const r = cq(c);
    if (c.tipo === 'edificio') {
      const edif = eds.find((e) => e.id === c.edificio_id);
      if (edif) s += dibujarEdificio(edif, 1, r, true);
      return;
    }
    if (c.tipo === 'punto_encuentro') {
      s += svgSenal('punto_encuentro', r.x + r.w / 2, r.y + r.h / 2, Math.min(56, r.w * 0.8, r.h * 0.8));
      return;
    }
    const fondo = c.tipo === 'area_verde' ? '#e6f4e1' : 'none';
    s += `<rect x="${r1(r.x)}" y="${r1(r.y)}" width="${r1(r.w)}" height="${r1(r.h)}" fill="${fondo}" stroke="#2b2b2b" stroke-width="1.8"/>${titulo(c.nombre || '', r)}`;
  });

  // Plantas altas, aparte y abajo, a la misma escala que la planta baja
  if (piezas.length) {
    const y0 = oy + usadas * cel + SEP;
    let x = AREA.x + Math.max(0, (AREA.w - anchoAltas * cel) / 2);
    piezas.forEach(({ e, p, w, h }) => {
      const r = { x, y: y0 + TIT, w: w * cel, h: h * cel };
      s += `<text x="${r1(r.x + r.w / 2)}" y="${r1(y0 + 18)}" text-anchor="middle" font-size="15" font-family="Arial, Helvetica, sans-serif" fill="#222">${esc(`${e.nombre} · ${C.nombrePlanta(p, e.num_plantas)}`.toUpperCase())}</text>`;
      s += dibujarEdificio(e, p, r, false);
      x += (w + HUECO) * cel;
    });
  }

  // Señalética de los planos (solo la de esta capa)
  s += senaleticaPlanos();

  // Lo propio del mapa: flechas, rutas, señales, textos, «usted está aquí»
  items().forEach((it, i) => { if (it.k !== 'via') s += dibujarItem(it, i, editando); });

  // Trazo en curso (ruta, vía o terreno)
  if (editando && M.temp && M.temp.pts.length) {
    const pts = M.temp.pts.map((p) => p.join(',')).join(' ');
    s += `<polyline points="${pts}" fill="none" stroke="${M.temp.k === 'ruta' ? VERDE : '#123A7A'}" stroke-width="3" stroke-dasharray="8 6"/>`;
    M.temp.pts.forEach((p) => { s += `<circle cx="${p[0]}" cy="${p[1]}" r="5" fill="#123A7A"/>`; });
  }

  return `<svg class="mp-hoja" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="Arial, Helvetica, sans-serif">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>
    <rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="none" stroke="#222" stroke-width="1.5"/>
    ${encabezado()}
    <g class="mp-dibujo">${s}</g>
    ${rosa(COL.x + COL.w / 2, 82)}
    ${leyenda()}
    ${cajetin()}
  </svg>`;
}

/* Un edificio: su contorno del croquis y, dentro, los cuartos del plano de ese piso */
function dibujarEdificio(edif, planta, R, conContorno) {
  const elems = C.planoDe(edif, planta) || [];
  let s = '';
  if (!elems.length) {
    s += `<rect x="${r1(R.x)}" y="${r1(R.y)}" width="${r1(R.w)}" height="${r1(R.h)}" fill="#fff" stroke="#111" stroke-width="2.4"/>
      <text x="${r1(R.x + R.w / 2)}" y="${r1(R.y + R.h / 2)}" text-anchor="middle" dominant-baseline="middle" font-size="14" fill="#222">${esc(edif.nombre.toUpperCase())}</text>`;
    return s;
  }
  const minx = Math.min(...elems.map((e) => e.x)), miny = Math.min(...elems.map((e) => e.y));
  const maxx = Math.max(...elems.map((e) => e.x + e.w)), maxy = Math.max(...elems.map((e) => e.y + e.h));
  const bw = Math.max(1, maxx - minx), bh = Math.max(1, maxy - miny);
  // Igual que en el croquis: el plano se ajusta al contorno sin deformarse (centrado)
  const k = Math.min(R.w / bw, R.h / bh);
  const dx = R.x + (R.w - bw * k) / 2, dy = R.y + (R.h - bh * k) / 2;
  const T = { x: (c) => dx + (c - minx) * k, y: (c) => dy + (c - miny) * k, sx: k, sy: k };
  if (conContorno) s += `<rect x="${r1(R.x)}" y="${r1(R.y)}" width="${r1(R.w)}" height="${r1(R.h)}" fill="#fff" stroke="none"/>`;
  // Los grandes primero (cuartos internos encima)
  elems.slice().sort((a, b) => b.w * b.h - a.w * a.h).forEach((el) => {
    const esp = C.espacios.find((x) => x.id === el.id);
    const r = { x: T.x(el.x), y: T.y(el.y), w: el.w * T.sx, h: el.h * T.sy };
    M.rects[el.id] = { ...r, planta, edif: edif.id, tipo: esp?.tipo };
    s += `<rect x="${r1(r.x)}" y="${r1(r.y)}" width="${r1(r.w)}" height="${r1(r.h)}" fill="#fff" stroke="#111" stroke-width="2.2"/>`;
    if (esp?.tipo === 'escaleras') {
      const n = Math.max(3, Math.floor(r.w / 7));
      for (let i = 1; i < n; i++) s += `<line x1="${r1(r.x + i * r.w / n)}" y1="${r1(r.y)}" x2="${r1(r.x + i * r.w / n)}" y2="${r1(r.y + r.h)}" stroke="#111" stroke-width="1"/>`;
    }
    (el.puertas || []).forEach((pu) => { s += puertaSvg(r, pu); });
    const nombre = esp ? (esp.tipo === 'habitacion' ? `Hab. ${esp.nombre}` : esp.nombre) : '';
    if (nombre && esp?.tipo !== 'escaleras') s += textoCuarto(nombre, r, el.puertas || []);
  });
  M.rects[`plano-${edif.id}-${planta}`] = { T, edif: edif.id, planta };
  return s;
}

/* Nombre del cuarto: dentro de sus paredes, lejos de las puertas y partido en líneas si no cabe */
function textoCuarto(nombre, r, puertas) {
  const hueco = (l) => { const lado = (l === 'n' || l === 's') ? r.w : r.h; return Math.min(16, lado * 0.32) + 2; };
  const tiene = (l) => puertas.some((p) => p.l === l);
  let x0 = r.x + 3, x1 = r.x + r.w - 3, y0 = r.y + 3, y1 = r.y + r.h - 3;
  if (tiene('n')) y0 = r.y + hueco('n');
  if (tiene('s')) y1 = r.y + r.h - hueco('s');
  if (r.w > 70) {
    if (tiene('o')) x0 = r.x + hueco('o');
    if (tiene('e')) x1 = r.x + r.w - hueco('e');
  } else {
    // Cuarto angosto con puertas a los lados: el texto va en el tramo libre más alto
    const tapas = puertas.filter((p) => p.l === 'o' || p.l === 'e').map((p) => {
      const a = Math.min(16, r.h * 0.32), yy = r.y + Math.min(0.92, Math.max(0.08, Number(p.p) || 0.5)) * r.h - a / 2;
      return [yy - 1, yy + a + 1];
    }).sort((a, b) => a[0] - b[0]);
    if (tapas.length) {
      const libres = [];
      let ini = y0;
      tapas.forEach(([a, b]) => { if (a > ini) libres.push([ini, Math.min(a, y1)]); ini = Math.max(ini, b); });
      if (ini < y1) libres.push([ini, y1]);
      const mejor = libres.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
      if (mejor && mejor[1] - mejor[0] >= 7) { y0 = mejor[0]; y1 = mejor[1]; }
    }
  }
  if (y1 - y0 < 8) { y0 = r.y + 2; y1 = r.y + r.h - 2; }
  const W = Math.max(8, x1 - x0), H = Math.max(6, y1 - y0);
  const partir = (fs) => {
    const max = Math.max(1, Math.floor(W / (fs * 0.64)));
    const lineas = [];
    let act = '';
    String(nombre).split(/\s+/).forEach((pal) => {
      while (pal.length > max) { if (act) { lineas.push(act); act = ''; } lineas.push(pal.slice(0, max)); pal = pal.slice(max); }
      if (!pal) return;
      if (!act) act = pal;
      else if ((act + ' ' + pal).length <= max) act += ' ' + pal;
      else { lineas.push(act); act = pal; }
    });
    if (act) lineas.push(act);
    return lineas;
  };
  let fs = 13, lineas = partir(fs);
  while (fs > 5 && lineas.length * fs * 1.15 > H) { fs -= 0.5; lineas = partir(fs); }
  const caben = Math.max(1, Math.floor(H / (fs * 1.15)));
  if (lineas.length > caben) { lineas = lineas.slice(0, caben); lineas[caben - 1] = lineas[caben - 1].replace(/.$/, '…'); }
  const cx = (x0 + x1) / 2;
  return `<text x="${r1(cx)}" y="${r1(y0 + fs * 0.95)}" text-anchor="middle" font-size="${r1(fs)}" fill="#222">${lineas.map((l, i) => `<tspan x="${r1(cx)}" dy="${i ? r1(fs * 1.15) : 0}">${esc(l)}</tspan>`).join('')}</text>`;
}

function puertaSvg(r, pu) {
  const p = Math.min(0.92, Math.max(0.08, Number(pu.p) || 0.5));
  const lado = (pu.l === 'n' || pu.l === 's') ? r.w : r.h;
  const a = Math.min(16, lado * 0.32);
  let x, y, gap, arco;
  if (pu.l === 'n' || pu.l === 's') {
    x = r.x + p * r.w - a / 2; y = pu.l === 'n' ? r.y : r.y + r.h;
    gap = `<line x1="${r1(x)}" y1="${r1(y)}" x2="${r1(x + a)}" y2="${r1(y)}" stroke="#fff" stroke-width="3.4"/>`;
    const dy = pu.l === 'n' ? a : -a;
    arco = `<path d="M${r1(x)} ${r1(y)} L${r1(x)} ${r1(y + dy)} A${r1(a)} ${r1(a)} 0 0 ${pu.l === 'n' ? 0 : 1} ${r1(x + a)} ${r1(y)}" fill="none" stroke="#111" stroke-width="0.9"/>`;
  } else {
    x = pu.l === 'o' ? r.x : r.x + r.w; y = r.y + p * r.h - a / 2;
    gap = `<line x1="${r1(x)}" y1="${r1(y)}" x2="${r1(x)}" y2="${r1(y + a)}" stroke="#fff" stroke-width="3.4"/>`;
    const dx = pu.l === 'o' ? a : -a;
    arco = `<path d="M${r1(x)} ${r1(y)} L${r1(x + dx)} ${r1(y)} A${r1(a)} ${r1(a)} 0 0 ${pu.l === 'o' ? 1 : 0} ${r1(x)} ${r1(y + a)}" fill="none" stroke="#111" stroke-width="0.9"/>`;
  }
  return gap + arco;
}

/* Extintores, botiquines, señales… ya ubicados en los planos (solo los de esta capa) */
function senaleticaPlanos() {
  let s = '';
  C.seguridad.forEach((q) => {
    if (!enCapa(q.tipo, q.datos)) return;
    let x, y;
    if (q.ancla_tipo === 'espacio' && M.rects[q.ancla_espacio]) {
      const r = M.rects[q.ancla_espacio];
      if (r.planta !== q.planta) return;
      x = r.x + (Number(q.x) || 50) / 100 * r.w; y = r.y + (Number(q.y) || 50) / 100 * r.h;
    } else if (q.ancla_tipo === 'planta' && M.rects[`plano-${q.edificio_id}-${q.planta}`]) {
      const { T } = M.rects[`plano-${q.edificio_id}-${q.planta}`];
      x = T.x((Number(q.x) || 50) / 100 * 40); y = T.y((Number(q.y) || 50) / 100 * 25);
    } else return;
    s += svgSenal(q.tipo, x, y, 22, '', q.datos);
  });
  return s;
}

function flechaPath() { return 'M-15 -5 H3 V-11 L16 0 L3 11 V5 H-15 Z'; }

function dibujarItem(it, i, editando) {
  const sel = editando && M.sel === i;
  const marco = (x, y, w, h) => sel ? `<rect x="${r1(x - w / 2 - 5)}" y="${r1(y - h / 2 - 5)}" width="${r1(w + 10)}" height="${r1(h + 10)}" fill="none" stroke="#123A7A" stroke-width="2" stroke-dasharray="5 4"/>` : '';
  const g = (contenido) => `<g data-i="${i}" class="mp-item${sel ? ' mp-sel' : ''}">${contenido}</g>`;
  if (it.k === 'flecha') {
    const t = (it.tam || 1);
    return g(`<g transform="translate(${it.x} ${it.y}) rotate(${it.ang || 0}) scale(${t})"><path d="${flechaPath()}" fill="${VERDE}" stroke="#0b7a06" stroke-width="0.8"/></g>${marco(it.x, it.y, 34 * t, 26 * t)}`);
  }
  if (it.k === 'ruta') {
    let s = '';
    const paso = 46;
    for (let k = 0; k < it.pts.length - 1; k++) {
      const [x1, y1] = it.pts[k], [x2, y2] = it.pts[k + 1];
      const L = Math.hypot(x2 - x1, y2 - y1); if (L < 1) continue;
      const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      for (let d = 18; d < L - 8; d += paso) {
        const x = x1 + (x2 - x1) * d / L, y = y1 + (y2 - y1) * d / L;
        s += `<g transform="translate(${r1(x)} ${r1(y)}) rotate(${r1(ang)}) scale(0.85)"><path d="${flechaPath()}" fill="${VERDE}" stroke="#0b7a06" stroke-width="0.8"/></g>`;
      }
    }
    const pista = `<polyline points="${it.pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="transparent" stroke-width="22"/>`;
    const linea = sel ? `<polyline points="${it.pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#123A7A" stroke-width="1.5" stroke-dasharray="5 4"/>` : '';
    return g(pista + s + linea);
  }
  if (it.k === 'senal') {
    const p = posSenal(it); if (!p) return '';
    const tam = TAM_SENAL * (it.tam || 1);
    return g(svgSenal(it.tipo, p.x, p.y, tam, '', it.datos) + marco(p.x, p.y, tam, tam));
  }
  if (it.k === 'aqui') {
    return g(`<circle cx="${it.x}" cy="${it.y}" r="${11 * (it.tam || 1)}" fill="#ff3b1f" stroke="#fff" stroke-width="2"/>${marco(it.x, it.y, 22, 22)}`);
  }
  if (it.k === 'texto') {
    const fs = it.tam || 18;
    const ancho = Math.max(30, String(it.t).length * fs * 0.55);
    return g(`<text x="${it.x}" y="${it.y}" text-anchor="middle" dominant-baseline="middle" font-size="${fs}" fill="#111" ${it.ang ? `transform="rotate(${it.ang} ${it.x} ${it.y})"` : ''}>${esc(it.t)}</text>${marco(it.x, it.y, ancho, fs * 1.3)}`);
  }
  return '';
}

/* Señal anclada a un cuarto (se mueve con él) o libre en la hoja */
function posSenal(it) {
  if (it.esp != null) {
    const r = M.rects[it.esp];
    if (!r) return null;
    return { x: r.x + (it.fx ?? 0.5) * r.w, y: r.y + (it.fy ?? 0.6) * r.h };
  }
  return { x: it.x, y: it.y };
}

function dibujarVia(it, i, editando) {
  const pts = it.pts.map((p) => p.join(',')).join(' ');
  const anc = it.ancho || 40;
  let s = `<polyline points="${pts}" fill="none" stroke="#222" stroke-width="${anc}" stroke-linejoin="round" stroke-linecap="butt"/>
    <polyline points="${pts}" fill="none" stroke="#fff" stroke-width="${anc - 3.4}" stroke-linejoin="round" stroke-linecap="butt"/>`;
  if (it.t) {
    // Rótulo sobre el tramo más largo, girado con él
    let mejor = 0, k0 = 0;
    for (let k = 0; k < it.pts.length - 1; k++) {
      const L = Math.hypot(it.pts[k + 1][0] - it.pts[k][0], it.pts[k + 1][1] - it.pts[k][1]);
      if (L > mejor) { mejor = L; k0 = k; }
    }
    const [x1, y1] = it.pts[k0], [x2, y2] = it.pts[k0 + 1];
    let ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    s += `<text x="${r1(cx)}" y="${r1(cy)}" text-anchor="middle" dominant-baseline="middle" font-size="${Math.min(18, anc * 0.45)}" font-family="Times New Roman, serif" fill="#111" transform="rotate(${r1(ang)} ${r1(cx)} ${r1(cy)})">${esc(it.t.toUpperCase())}</text>`;
  }
  const sel = editando && M.sel === i;
  if (sel) s += `<polyline points="${pts}" fill="none" stroke="#123A7A" stroke-width="2" stroke-dasharray="6 5"/>`;
  return `<g data-i="${i}" class="mp-item${sel ? ' mp-sel' : ''}">${s}</g>`;
}

function encabezado() {
  const t1 = tituloDe(M.tipo).toUpperCase();
  const cx = AREA.x + AREA.w / 2;
  return `<text x="${cx}" y="52" text-anchor="middle" font-size="30" font-weight="700" font-family="Times New Roman, serif" fill="#111">${esc(t1)}</text>
    ${M.empresa ? `<text x="${cx}" y="88" text-anchor="middle" font-size="24" font-weight="700" font-family="Times New Roman, serif" fill="#111">${esc(M.empresa.toUpperCase())}</text>` : ''}`;
}

function rosa(cx, cy) {
  const r = 46;
  return `<g aria-label="Rosa de los vientos">
    <path d="M${cx} ${cy - r} L${cx + 8} ${cy - 8} L${cx} ${cy} Z" fill="#111"/><path d="M${cx} ${cy - r} L${cx - 8} ${cy - 8} L${cx} ${cy} Z" fill="#777"/>
    <path d="M${cx} ${cy + r} L${cx - 8} ${cy + 8} L${cx} ${cy} Z" fill="#111"/><path d="M${cx} ${cy + r} L${cx + 8} ${cy + 8} L${cx} ${cy} Z" fill="#777"/>
    <path d="M${cx + r} ${cy} L${cx + 8} ${cy + 8} L${cx} ${cy} Z" fill="#111"/><path d="M${cx + r} ${cy} L${cx + 8} ${cy - 8} L${cx} ${cy} Z" fill="#777"/>
    <path d="M${cx - r} ${cy} L${cx - 8} ${cy - 8} L${cx} ${cy} Z" fill="#111"/><path d="M${cx - r} ${cy} L${cx - 8} ${cy + 8} L${cx} ${cy} Z" fill="#777"/>
    <text x="${cx}" y="${cy - r - 8}" text-anchor="middle" font-size="20" font-weight="700">N</text>
    <text x="${cx}" y="${cy + r + 22}" text-anchor="middle" font-size="20" font-weight="700">S</text>
    <text x="${cx + r + 16}" y="${cy + 7}" text-anchor="middle" font-size="20" font-weight="700">E</text>
    <text x="${cx - r - 16}" y="${cy + 7}" text-anchor="middle" font-size="20" font-weight="700">O</text></g>`;
}

/* Leyenda automática: solo lo que aparece en este mapa */
function entradasLeyenda() {
  const tipos = new Map();
  const sumar = (tipo, datos) => { const k = tipo === 'otra_senal' ? `otra:${datos?.texto || ''}` : tipo; if (!tipos.has(k)) tipos.set(k, { tipo, datos }); };
  C.seguridad.forEach((q) => { if (enCapa(q.tipo, q.datos) && (M.rects[q.ancla_espacio] || M.rects[`plano-${q.edificio_id}-${q.planta}`])) sumar(q.tipo, q.datos); });
  C.croquis.forEach((c) => { if (c.tipo === 'punto_encuentro' && M.tipo === 'evacuacion') sumar('punto_encuentro'); });
  items().forEach((it) => { if (it.k === 'senal') sumar(it.tipo, it.datos); });
  const lista = Array.from(tipos.values()).map(({ tipo, datos }) => ({ tipo, datos, n: nombreSenal(tipo, datos) }));
  if (items().some((it) => it.k === 'flecha' || it.k === 'ruta')) lista.push({ especial: 'ruta', n: 'Ruta de evacuación' });
  if (items().some((it) => it.k === 'aqui')) lista.push({ especial: 'aqui', n: 'Usted se encuentra aquí' });
  // Orden: evacuación primero, luego incendio, auxilios, advertencias…
  const ORDEN = ['verde', 'rojo', 'botiquin', 'luz', 'advertencia', 'prohibicion', 'obligacion', 'info', 'neutro'];
  return lista.sort((a, b) => (a.especial ? 1 : 0) - (b.especial ? 1 : 0)
    || ORDEN.indexOf(estiloDe(a.tipo, a.datos)) - ORDEN.indexOf(estiloDe(b.tipo, b.datos)));
}

function leyenda() {
  const lista = entradasLeyenda();
  const riesgos = M.tipo === 'riesgos';
  const icono = (e) => {
    if (e.especial === 'ruta') return `<svg viewBox="-18 -13 36 26" width="30" height="22"><path d="${flechaPath()}" fill="${VERDE}" stroke="#0b7a06" stroke-width="0.8"/></svg>`;
    if (e.especial === 'aqui') return '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#ff3b1f"/></svg>';
    return C.svgSeg({ tipo: e.tipo, datos: e.datos || {} }).replace('<svg ', '<svg width="30" height="30" ');
  };
  const filas = lista.map((e) => `<tr><td class="s">${icono(e)}</td><td class="d">${esc(e.n)}</td>${riesgos ? `<td class="c">${esc(e.especial ? '' : (M.controles[e.tipo] ?? CONTROL_DEFECTO[e.tipo] ?? ''))}</td>` : ''}</tr>`).join('');
  const alto = 760;
  return `<foreignObject x="${COL.x}" y="160" width="${COL.w}" height="${alto}">
    <div xmlns="http://www.w3.org/1999/xhtml" class="mp-ley">
      ${lista.length ? `<table><thead><tr><th>SÍMBOLO</th><th>DESCRIPCIÓN</th>${riesgos ? '<th>CONTROL DEL RIESGO</th>' : ''}</tr></thead><tbody>${filas}</tbody></table>`
        : '<p class="vacia">La leyenda se arma sola con lo que coloque en el mapa.</p>'}
    </div></foreignObject>`;
}

function cajetin() {
  const d = M.datos;
  return `<foreignObject x="${COL.x}" y="${H - 190}" width="${COL.w}" height="170">
    <div xmlns="http://www.w3.org/1999/xhtml" class="mp-caj">
      <div class="f">Fecha de elaboración: <b>${esc(fechaTxt(d.fecha))}</b></div>
      <div class="e"><span>Elaborado por:</span>
        <b>${esc(d.elaborado_nombre || '—')}</b><span>${esc(d.elaborado_cargo || '')}</span><span>${esc(d.elaborado_entidad || '')}</span></div>
    </div></foreignObject>`;
}

/* Estilos de la leyenda y el cajetín (van dentro del SVG para imprimir igual) */
const ESTILO_HOJA = `
  .mp-ley{font:12px Arial,Helvetica,sans-serif;color:#111}
  .mp-ley table{width:100%;border-collapse:collapse;background:#fff}
  .mp-ley th{border:1.2px solid #111;padding:4px 6px;font-size:12px;font-weight:700;text-align:center}
  .mp-ley td{border:1.2px solid #111;padding:3px 6px;vertical-align:middle}
  .mp-ley td.s{width:40px;text-align:center}.mp-ley td.s svg{display:block;margin:auto}
  .mp-ley td.d{font-size:12.5px}.mp-ley td.c{font-size:10px;line-height:1.25;color:#222}
  .mp-ley .vacia{font-size:13px;color:#666;border:1px dashed #aaa;padding:10px;margin:0}
  .mp-caj{font:13px Arial,Helvetica,sans-serif;color:#111;border:1.4px solid #111;background:#fff;height:100%;box-sizing:border-box;display:flex;flex-direction:column}
  .mp-caj .f{padding:8px 10px;border-bottom:1.4px solid #111}
  .mp-caj .e{padding:10px;display:flex;flex-direction:column;gap:3px}
`;

/* ============================================
   Pantalla: pestañas, herramientas y la hoja
   ============================================ */
const HERRAMIENTAS = [
  ['sel', '↖ Seleccionar', 'Toque un elemento para elegirlo y arrastrarlo'],
  ['ruta', '➜ Ruta de evacuación', 'Toque punto por punto el recorrido; doble clic (o Enter) para terminar. Las flechas salen solas'],
  ['flecha', '➡ Flecha suelta', 'Toque donde va la flecha; con la flecha elegida use ⟲ ⟳ o la tecla R para girarla'],
  ['senal', '⚠ Señal…', 'Elija la señal y toque dónde va'],
  ['aqui', '● Usted está aquí', 'Toque dónde se colgará este mapa'],
  ['texto', 'T Texto', 'Toque dónde va el texto'],
  ['via', '═ Vía o acceso', 'Toque punto por punto la vía; doble clic para terminar y escribir su nombre'],
  ['terreno', '⬠ Terreno', 'Toque las esquinas del terreno; doble clic para cerrar']
];

function pintar() {
  const editar = C.puedeEditar && !M.falta;
  const $c = C.contenedor;
  $c.className = 'hab-mapas-raiz mp';
  if (M.falta) {
    $c.innerHTML = `<div class="hab-vacio"><strong>Los mapas necesitan preparar la base de datos.</strong><br>
      El administrador debe ejecutar una vez <code>sql/habitaciones_etapa8_mapas.sql</code> en Supabase.</div>`;
    return;
  }
  const h = HERRAMIENTAS.find((x) => x[0] === M.herr) || HERRAMIENTAS[0];
  $c.innerHTML = `
    <div class="mp-barra">
      <div class="mp-tabs" role="tablist">
        ${Object.entries(TIPOS_MAPA).map(([k, v]) => `<button type="button" role="tab" class="mp-tab" data-tipo="${k}" aria-selected="${M.tipo === k}">${k === 'evacuacion' ? '🟩' : '⚠️'} ${v}</button>`).join('')}
      </div>
      <div class="mp-acciones">
        ${editar ? '<button type="button" class="boton-secundario boton-compacto" id="mp-datos">Título y elaborado por</button>' : ''}
        ${editar && M.tipo === 'riesgos' ? '<button type="button" class="boton-secundario boton-compacto" id="mp-controles">Textos de «Control del riesgo»</button>' : ''}
        <button type="button" class="boton-secundario boton-compacto" data-imprimir="A3">🖨 Imprimir A3</button>
        <button type="button" class="boton-secundario boton-compacto" data-imprimir="A1">🖨 Imprimir A1</button>
        ${editar ? `<button type="button" class="boton-primario boton-compacto ${M.cambios ? 'mp-pendiente' : ''}" id="mp-guardar">💾 Guardar mapa</button>` : ''}
      </div>
    </div>
    ${editar ? `<div class="mp-herr" role="toolbar" aria-label="Herramientas del mapa">
      ${HERRAMIENTAS.map(([k, t]) => `<button type="button" class="mp-h" data-h="${k}" aria-pressed="${M.herr === k}">${t}</button>`).join('')}
      <span class="mp-sep"></span>
      <button type="button" class="mp-h" id="mp-todas">🏠 Señal en todas las habitaciones…</button>
      <button type="button" class="mp-h" id="mp-deshacer" title="Ctrl + Z">↶ Deshacer</button>
    </div>
    <div class="mp-ayuda"><b>${esc(h[1].replace(/^[^ ]+ /, ''))}:</b> ${esc(h[2])}${M.herr === 'senal' && M.senalTipo ? ` · <span class="mp-senal-elegida">${C.svgSeg({ tipo: M.senalTipo, datos: {} }).replace('<svg ', '<svg width="20" height="20" ')} ${esc(nombreSenal(M.senalTipo))}</span>` : ''}</div>
    <div class="mp-selbar" id="mp-selbar"></div>` : `<p class="ayuda">Vista de consulta. Lo dibuja el técnico de seguridad o el administrador.</p>`}
    <div class="mp-lienzo" id="mp-lienzo"><style>${ESTILO_HOJA}</style>${hojaSvg(editar)}</div>
    <p class="ayuda mp-pie">Los edificios y sus cuartos salen del croquis y del plano de cada piso: si los cambia allá, el mapa se actualiza solo. Las plantas altas se dibujan aparte, abajo, a la misma escala que la planta baja.</p>`;

  $c.querySelectorAll('[data-tipo]').forEach((b) => b.addEventListener('click', () => { M.tipo = b.dataset.tipo; M.sel = null; M.temp = null; pintar(); }));
  $c.querySelectorAll('[data-imprimir]').forEach((b) => b.addEventListener('click', () => imprimir(b.dataset.imprimir)));
  if (!editar) return;
  document.getElementById('mp-guardar').addEventListener('click', guardar);
  document.getElementById('mp-datos').addEventListener('click', modalDatos);
  document.getElementById('mp-controles')?.addEventListener('click', modalControles);
  document.getElementById('mp-deshacer').addEventListener('click', deshacer);
  document.getElementById('mp-todas').addEventListener('click', () => elegirSenal((tipo) => enTodasHabitaciones(tipo)));
  $c.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => {
    M.herr = b.dataset.h; M.temp = null; M.sel = null;
    if (M.herr === 'senal') { elegirSenal((tipo) => { M.senalTipo = tipo; pintar(); }); return; }
    pintar();
  }));
  conectarLienzo();
  pintarSelBar();
}

/* Repinta solo la hoja (rápido, al arrastrar) */
function repintarHoja() {
  const $l = document.getElementById('mp-lienzo');
  if (!$l) return;
  $l.innerHTML = `<style>${ESTILO_HOJA}</style>${hojaSvg(true)}`;
  conectarLienzo();
  pintarSelBar();
}

function puntoSvg(svg, e) {
  const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
  const q = p.matrixTransform(svg.getScreenCTM().inverse());
  return [r1(Math.max(0, Math.min(W, q.x))), r1(Math.max(0, Math.min(H, q.y)))];
}

let teclasListas = false;
let arrastre = null;
const svgActual = () => document.querySelector('#mp-lienzo svg');
function conectarLienzo() {
  const svg = svgActual();
  if (!svg) return;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const pt = puntoSvg(svg, e);
    const g = e.target.closest('[data-i]');
    if (M.herr === 'sel') {
      if (!g) { M.sel = null; repintarHoja(); return; }
      const i = Number(g.dataset.i);
      const it = items()[i];
      arrastre = { i, desde: pt, orig: JSON.parse(JSON.stringify(it)), movio: false };
      e.preventDefault();
      if (M.sel !== i) { M.sel = i; repintarHoja(); }
      return;
    }
    if (['ruta', 'via', 'terreno'].includes(M.herr)) {
      // Doble toque en el mismo lugar = terminar (la hoja se redibuja en cada toque)
      const ahora = Date.now();
      if (M.ultToque && ahora - M.ultToque.t < 450 && Math.hypot(M.ultToque.pt[0] - pt[0], M.ultToque.pt[1] - pt[1]) < 8 && M.temp) {
        M.ultToque = null; terminarTrazo(); return;
      }
      M.ultToque = { t: ahora, pt };
      if (!M.temp) M.temp = { k: M.herr, pts: [] };
      const ult = M.temp.pts[M.temp.pts.length - 1];
      if (!ult || Math.hypot(ult[0] - pt[0], ult[1] - pt[1]) > 4) M.temp.pts.push(pt);
      repintarHoja();
      return;
    }
    colocar(pt);
  });
  svg.addEventListener('dblclick', (e) => { e.preventDefault(); terminarTrazo(); });

  if (!teclasListas) {
    teclasListas = true;
    document.addEventListener('pointermove', (e) => {
      if (!arrastre) return;
      const sv = svgActual(); if (!sv) return;
      const pt = puntoSvg(sv, e);
      const dx = pt[0] - arrastre.desde[0], dy = pt[1] - arrastre.desde[1];
      if (!arrastre.movio && Math.hypot(dx, dy) < 3) return;
      if (!arrastre.movio) { guardarHist(); arrastre.movio = true; }
      moverItem(arrastre.i, arrastre.orig, dx, dy);
      repintarHoja();
    });
    const soltar = () => { if (arrastre) { if (arrastre.movio) marcar(); arrastre = null; } };
    document.addEventListener('pointerup', soltar);
    document.addEventListener('pointercancel', soltar);
    document.addEventListener('keydown', (e) => {
      if (!M || !document.getElementById('mp-lienzo')) return;
      if (e.target.closest && e.target.closest('input, textarea, select, .modal')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); deshacer(); return; }
      if (e.key === 'Enter' && M.temp) { e.preventDefault(); terminarTrazo(); return; }
      if (e.key === 'Escape') { M.temp = null; M.sel = null; repintarHoja(); return; }
      if (M.sel == null) return;
      const it = items()[M.sel];
      if (!it) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); quitarSel(); return; }
      if (e.key.toLowerCase() === 'r' && (it.k === 'flecha' || it.k === 'texto')) { e.preventDefault(); girar(e.shiftKey ? -45 : 45); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); tamano(1); return; }
      if (e.key === '-') { e.preventDefault(); tamano(-1); return; }
      const fl = { ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, -4], ArrowDown: [0, 4] }[e.key];
      if (fl) { e.preventDefault(); guardarHist(); moverItem(M.sel, JSON.parse(JSON.stringify(it)), fl[0], fl[1]); marcar(); repintarHoja(); }
    });
  }
}

function lista(i) {
  // Devuelve [arreglo, posición] del elemento i de items()
  const nc = M.comun.items.length;
  return i < nc ? [M.comun.items, i] : [M.propios[M.tipo], i - nc];
}

function moverItem(i, orig, dx, dy) {
  const [arr, k] = lista(i);
  const it = arr[k];
  if (it.pts) it.pts = orig.pts.map((p) => [r1(p[0] + dx), r1(p[1] + dy)]);
  else if (it.esp != null) {
    const r = M.rects[it.esp];
    const p0 = { x: r.x + (orig.fx ?? 0.5) * r.w, y: r.y + (orig.fy ?? 0.6) * r.h };
    // Si sale de su cuarto, queda suelta en la hoja
    const nx = p0.x + dx, ny = p0.y + dy;
    if (nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h) { it.fx = (nx - r.x) / r.w; it.fy = (ny - r.y) / r.h; }
    else { delete it.esp; delete it.fx; delete it.fy; it.x = r1(nx); it.y = r1(ny); }
  } else { it.x = r1(orig.x + dx); it.y = r1(orig.y + dy); }
}

function colocar(pt) {
  const nuevo = { flecha: { k: 'flecha', ang: 0 }, aqui: { k: 'aqui' } }[M.herr];
  if (M.herr === 'senal') {
    if (!M.senalTipo) { elegirSenal((t) => { M.senalTipo = t; pintar(); }); return; }
    agregar({ k: 'senal', tipo: M.senalTipo, ...anclar(pt) });
    return;
  }
  if (M.herr === 'texto') {
    pedirTexto('Texto', '', (t) => { if (t) agregar({ k: 'texto', t, x: pt[0], y: pt[1], tam: 18 }, true); });
    return;
  }
  if (nuevo) agregar({ ...nuevo, x: pt[0], y: pt[1] });
}

/* Si la señal cae dentro de un cuarto, queda anclada a él */
function anclar(pt) {
  const dentro = Object.entries(M.rects).filter(([k, r]) => !String(k).startsWith('plano-')
    && pt[0] >= r.x && pt[0] <= r.x + r.w && pt[1] >= r.y && pt[1] <= r.y + r.h)
    .sort((a, b) => a[1].w * a[1].h - b[1].w * b[1].h)[0];
  if (!dentro) return { x: pt[0], y: pt[1] };
  const [id, r] = dentro;
  const esp = C.espacios.find((x) => String(x.id) === String(id));
  return { esp: esp ? esp.id : id, fx: r1((pt[0] - r.x) / r.w * 1000) / 1000, fy: r1((pt[1] - r.y) / r.h * 1000) / 1000 };
}

function agregar(it, comun = false) {
  guardarHist();
  const arr = comun ? M.comun.items : M.propios[M.tipo];
  arr.push(it);
  M.sel = comun ? M.comun.items.length - 1 : M.comun.items.length + arr.length - 1;
  marcar();
  repintarHoja();
}

function terminarTrazo() {
  const t = M.temp;
  if (!t) return;
  M.temp = null;
  if (t.k === 'terreno') {
    if (t.pts.length < 3) { C.toast('El terreno necesita al menos 3 esquinas'); repintarHoja(); return; }
    guardarHist(); M.comun.terreno = t.pts; marcar(); repintarHoja(); return;
  }
  if (t.pts.length < 2) { C.toast('Toque al menos 2 puntos'); repintarHoja(); return; }
  if (t.k === 'ruta') { agregar({ k: 'ruta', pts: t.pts }); return; }
  if (t.k === 'via') pedirTexto('Nombre de la vía (opcional)', 'ACCESO', (nombre) => agregar({ k: 'via', pts: t.pts, t: nombre || '', ancho: 40 }, true));
}

function quitarSel() {
  if (M.sel == null) return;
  guardarHist();
  const [arr, k] = lista(M.sel);
  arr.splice(k, 1);
  M.sel = null; marcar(); repintarHoja();
}
function girar(g) {
  const [arr, k] = lista(M.sel); const it = arr[k];
  guardarHist(); it.ang = ((it.ang || 0) + g + 360) % 360; marcar(); repintarHoja();
}
function tamano(d) {
  const [arr, k] = lista(M.sel); const it = arr[k];
  guardarHist();
  if (it.k === 'texto') it.tam = Math.max(8, Math.min(60, (it.tam || 18) + d * 2));
  else if (it.k === 'via') it.ancho = Math.max(14, Math.min(90, (it.ancho || 40) + d * 4));
  else it.tam = Math.max(0.5, Math.min(3, r1((it.tam || 1) + d * 0.15)));
  marcar(); repintarHoja();
}

/* Barra del elemento elegido */
function pintarSelBar() {
  const $b = document.getElementById('mp-selbar');
  if (!$b) return;
  const it = M.sel != null ? items()[M.sel] : null;
  if (!it) { $b.innerHTML = ''; $b.hidden = true; return; }
  $b.hidden = false;
  const nombre = { flecha: 'Flecha', ruta: 'Ruta de evacuación', senal: nombreSenal(it.tipo, it.datos), aqui: 'Usted está aquí', texto: `Texto «${it.t}»`, via: `Vía ${it.t ? '«' + it.t + '»' : ''}` }[it.k] || '';
  $b.innerHTML = `<b>${esc(nombre)}</b>
    ${it.k === 'flecha' || it.k === 'texto' ? '<button type="button" data-a="izq" title="Girar (Mayús + R)">⟲</button><button type="button" data-a="der" title="Girar (R)">⟳</button>' : ''}
    ${['flecha', 'senal', 'texto', 'aqui', 'via'].includes(it.k) ? '<button type="button" data-a="menos" title="Más pequeño (−)">−</button><button type="button" data-a="mas" title="Más grande (+)">+</button>' : ''}
    ${it.k === 'texto' || it.k === 'via' ? '<button type="button" data-a="editar">Cambiar texto</button>' : ''}
    <button type="button" data-a="quitar" class="mp-quitar">Quitar (Supr)</button>`;
  const acc = { izq: () => girar(-45), der: () => girar(45), menos: () => tamano(-1), mas: () => tamano(1), quitar: quitarSel,
    editar: () => pedirTexto('Texto', it.t || '', (t) => { if (t != null) { guardarHist(); it.t = t; marcar(); repintarHoja(); } }) };
  $b.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => acc[b.dataset.a]()));
}

/* ============================================
   Señal en todas las habitaciones de una vez
   ============================================ */
function enTodasHabitaciones(tipo) {
  const habs = Object.entries(M.rects).filter(([k, r]) => !String(k).startsWith('plano-') && r.tipo === 'habitacion');
  if (!habs.length) { C.toast('No hay habitaciones dibujadas en los planos de esta base'); return; }
  guardarHist();
  let n = 0;
  habs.forEach(([id]) => {
    const esp = C.espacios.find((x) => String(x.id) === String(id));
    const espId = esp ? esp.id : id;
    if (M.propios[M.tipo].some((it) => it.k === 'senal' && it.tipo === tipo && String(it.esp) === String(espId))) return;
    // Varias señales en un cuarto: se acomodan una al lado de la otra
    const ya = M.propios[M.tipo].filter((it) => it.k === 'senal' && String(it.esp) === String(espId)).length;
    const LUGAR = [[0.5, 0.62], [0.24, 0.62], [0.76, 0.62], [0.5, 0.86], [0.24, 0.86], [0.76, 0.86]];
    const [fx, fy] = LUGAR[ya % LUGAR.length];
    M.propios[M.tipo].push({ k: 'senal', tipo, esp: espId, fx, fy });
    n++;
  });
  marcar();
  C.toast(n ? `«${nombreSenal(tipo)}» en ${n} habitación(es)` : 'Todas las habitaciones ya tenían esa señal');
  repintarHoja();
}

/* ============================================
   Ventanas
   ============================================ */
function ventana(titulo) {
  document.querySelector('.mp-modal')?.remove();
  const m = document.createElement('div');
  m.className = 'modal hab-modal mp-modal';
  m.innerHTML = `<div class="modal-caja" role="dialog" aria-modal="true"><header class="modal-cabecera"><h2 class="modal-titulo"></h2>
    <button class="modal-cerrar" type="button" aria-label="Cerrar">×</button></header><div class="modal-cuerpo"></div><footer class="modal-pie"></footer></div>`;
  m.querySelector('.modal-titulo').textContent = titulo;
  (document.querySelector('.hab') || document.body).appendChild(m);
  const cerrar = () => { m.remove(); document.removeEventListener('keydown', tecla); };
  const tecla = (e) => { if (e.key === 'Escape') cerrar(); };
  document.addEventListener('keydown', tecla);
  m.querySelector('.modal-cerrar').addEventListener('click', cerrar);
  m.addEventListener('mousedown', (e) => { if (e.target === m) cerrar(); });
  return {
    cuerpo: m.querySelector('.modal-cuerpo'), cerrar,
    botones(l) {
      const pie = m.querySelector('.modal-pie'); pie.innerHTML = '';
      l.forEach(([t, c, f]) => { const b = document.createElement('button'); b.type = 'button'; b.className = c; b.textContent = t; b.addEventListener('click', () => f(b)); pie.appendChild(b); });
    }
  };
}

function pedirTexto(titulo, valor, listo) {
  const v = ventana(titulo);
  v.cuerpo.innerHTML = `<div class="hab-form"><input class="entrada" id="mp-txt" maxlength="80" value="${esc(valor)}"></div>`;
  const $i = v.cuerpo.querySelector('#mp-txt');
  const ok = () => { const t = $i.value.trim(); v.cerrar(); listo(t); };
  $i.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  v.botones([['Cancelar', 'boton-secundario', () => { v.cerrar(); listo(null); }], ['Aceptar', 'boton-primario', ok]]);
  setTimeout(() => { $i.focus(); $i.select(); }, 30);
}

/* Catálogo de señales por grupo (primero las de este mapa) */
function elegirSenal(listo) {
  const v = ventana('Elija la señal');
  const grupos = {};
  Object.entries(C.TIPOS_SEG).forEach(([k, t]) => {
    if (k === 'otro' || k === 'otra_senal' || k === 'foco') return;
    (grupos[t.g] = grupos[t.g] || []).push([k, t]);
  });
  const orden = Object.keys(grupos).sort((a, b) => (GRUPOS_CAPA[M.tipo].includes(a) ? 0 : 1) - (GRUPOS_CAPA[M.tipo].includes(b) ? 0 : 1));
  v.cuerpo.innerHTML = `<input class="entrada mp-buscar" placeholder="Buscar señal…" id="mp-buscar">
    ${orden.map((g) => `<div class="mp-grupo"><h4>${esc(g)}</h4><div class="mp-senales">${grupos[g].map(([k, t]) =>
      `<button type="button" class="mp-senal-op" data-tipo="${k}" title="${esc(t.n)}">${C.svgSeg({ tipo: k, datos: {} })}<span>${esc(t.n)}</span></button>`).join('')}</div></div>`).join('')}`;
  v.cuerpo.querySelector('#mp-buscar').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    v.cuerpo.querySelectorAll('.mp-senal-op').forEach((b) => { b.hidden = q && !b.textContent.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q); });
  });
  v.cuerpo.querySelectorAll('[data-tipo]').forEach((b) => b.addEventListener('click', () => { v.cerrar(); M.herr = M.herr === 'senal' ? 'senal' : M.herr; listo(b.dataset.tipo); }));
  v.botones([['Cancelar', 'boton-secundario', () => v.cerrar()]]);
}

function modalDatos() {
  const v = ventana('Título y elaborado por');
  const d = M.datos;
  v.cuerpo.innerHTML = `<div class="hab-form">
    <div class="campo"><label class="etiqueta" for="md-t">Título (vacío = automático)</label>
      <input class="entrada" id="md-t" maxlength="120" value="${esc((M.titulos || {})[M.tipo] || '')}" placeholder="${esc(`${TIPOS_MAPA[M.tipo]} (${C.base.nombre})`)}"></div>
    <div class="campo"><label class="etiqueta" for="md-f">Fecha de elaboración o actualización</label>
      <input class="entrada" id="md-f" type="date" value="${esc(d.fecha)}"></div>
    <div class="campo"><label class="etiqueta" for="md-n">Elaborado por</label>
      <input class="entrada" id="md-n" maxlength="80" value="${esc(d.elaborado_nombre)}" placeholder="Ej.: Ing. Iván Larreátegui M."></div>
    <div class="campo"><label class="etiqueta" for="md-c">Cargo</label>
      <input class="entrada" id="md-c" maxlength="80" value="${esc(d.elaborado_cargo)}" placeholder="Ej.: Jefe de Seguridad y Salud Ocupacional"></div>
    <div class="campo"><label class="etiqueta" for="md-e">Empresa</label>
      <input class="entrada" id="md-e" maxlength="80" value="${esc(d.elaborado_entidad)}"></div>
    <span class="ayuda">El título vale para el mapa que está viendo; la fecha y «Elaborado por» para los dos mapas de esta base.</span>
  </div>`;
  v.botones([['Cancelar', 'boton-secundario', () => v.cerrar()], ['Aplicar', 'boton-primario', () => {
    const val = (id) => v.cuerpo.querySelector('#' + id).value.trim();
    M.datos = { fecha: val('md-f') || hoyIso(), elaborado_nombre: val('md-n'), elaborado_cargo: val('md-c'), elaborado_entidad: val('md-e') };
    M.titulos = M.titulos || {}; M.titulos[M.tipo] = val('md-t');
    v.cerrar(); marcar(); pintar();
  }]]);
}

function modalControles() {
  const v = ventana('Textos de «Control del riesgo»');
  const lista = entradasLeyenda().filter((e) => !e.especial);
  if (!lista.length) { v.cuerpo.innerHTML = '<p class="ayuda">Primero coloque señales en el mapa de riesgos.</p>'; v.botones([['Cerrar', 'boton-primario', () => v.cerrar()]]); return; }
  v.cuerpo.innerHTML = `<p class="ayuda">Salen en la leyenda del mapa de riesgos. Vienen con un texto sugerido; cámbielo si hace falta.</p>
    ${lista.map((e) => `<div class="campo mp-ctl"><label class="etiqueta">${C.svgSeg({ tipo: e.tipo, datos: e.datos || {} }).replace('<svg ', '<svg width="22" height="22" ')} ${esc(e.n)}</label>
      <textarea class="entrada" rows="2" data-tipo="${e.tipo}" maxlength="400">${esc(M.controles[e.tipo] ?? CONTROL_DEFECTO[e.tipo] ?? '')}</textarea></div>`).join('')}`;
  v.botones([['Cancelar', 'boton-secundario', () => v.cerrar()], ['Aplicar', 'boton-primario', () => {
    v.cuerpo.querySelectorAll('textarea[data-tipo]').forEach((t) => { M.controles[t.dataset.tipo] = t.value.trim(); });
    v.cerrar(); marcar(); pintar();
  }]]);
}

/* ============================================
   Guardar (los dos mapas de la base)
   ============================================ */
async function guardar(ev) {
  const b = ev?.currentTarget || document.getElementById('mp-guardar');
  if (b) { b.disabled = true; b.textContent = 'Guardando…'; }
  try {
    const comunes = M.comun.items;
    const titulos = M.titulos || {};
    for (const tipo of ['evacuacion', 'riesgos']) {
      const fila = M.filas[tipo];
      const datos = {
        titulo: titulos[tipo] || null,
        fecha: M.datos.fecha || hoyIso(),
        elaborado_nombre: M.datos.elaborado_nombre || null,
        elaborado_cargo: M.datos.elaborado_cargo || null,
        elaborado_entidad: M.datos.elaborado_entidad || null,
        terreno: M.comun.terreno,
        elementos: comunes.concat(M.propios[tipo]),
        controles: tipo === 'riesgos' ? M.controles : {},
        actualizado_en: new Date().toISOString()
      };
      // No crea un mapa vacío que nunca se usó
      if (!fila && !datos.elementos.length && !datos.terreno.length && tipo !== M.tipo) continue;
      const r = fila
        ? await C.sb.from('viv_mapas').update(C.alEditar(datos)).eq('id', fila.id).select().single()
        : await C.sb.from('viv_mapas').insert(C.alCrear({ ...datos, empresa_id: C.empresaId, base_id: C.base.id, tipo })).select().single();
      if (r.error) throw r.error;
      M.filas[tipo] = r.data || { ...(fila || {}), ...datos };
    }
    M.cambios = false;
    C.toast('Mapa guardado');
  } catch (e) {
    C.toast('No se pudo guardar el mapa: ' + (e.message || e));
  }
  pintar();
}

/* ============================================
   Imprimir (A3 o A1 horizontal; «Guardar como PDF»)
   ============================================ */
function imprimir(papel) {
  const sel = M.sel, temp = M.temp;
  M.sel = null; M.temp = null;
  const svg = hojaSvg(false);
  M.sel = sel; M.temp = temp;
  const tam = papel === 'A1' ? '841mm 594mm' : 'A3 landscape';
  const w = window.open('', '_blank');
  if (!w) { C.toast('El navegador bloqueó la ventana. Permita ventanas emergentes.'); return; }
  w.document.open();
  w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>${esc(tituloDe(M.tipo))}</title>
    <style>@page{size:${tam};margin:6mm}html,body{margin:0;background:#fff}svg{width:100%;height:auto;display:block}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}${ESTILO_HOJA}</style></head>
    <body>${svg}<script>setTimeout(function(){window.print()},400)<\/script></body></html>`);
  w.document.close();
}

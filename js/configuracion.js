/* ============================================
   NEXUS · configuracion.js
   Ajustes visuales del sistema (solo admin).
   Tamaño del logo, tamaño y posición del nombre.
   Se guarda en config_sistema (para todos).
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina } from './auth.js';
import { montarNavegacion, MODULOS } from './nav.js';
import { empresasPermitidas, sesionActual, MODULOS_OPCIONALES, modulosActivosEmpresa, fijarModuloEmpresa } from './auth.js';
import { escapar } from './utils.js';

const estado = {
  logo_tam: 200,
  nombre_tam: 26,
  nombre_pos: 'centro'
};

iniciar();

async function iniciar() {
  const perfil = await protegerPagina(['admin']);
  if (!perfil) return;
  montarNavegacion(perfil, 'configuracion');

  await cargar();
  conectar();
  aplicarPrevia();
}

async function cargar() {
  const { data } = await supabase
    .from('config_sistema').select('*').eq('id', 1).maybeSingle();
  if (data) {
    estado.logo_tam = data.logo_tam ?? 200;
    estado.nombre_tam = data.nombre_tam ?? 26;
    estado.nombre_pos = data.nombre_pos ?? 'centro';
  }
  // Reflejar en los controles
  document.getElementById('cfg-logo-tam').value = estado.logo_tam;
  document.getElementById('cfg-nombre-tam').value = estado.nombre_tam;
  document.getElementById('val-logo-tam').textContent = estado.logo_tam;
  document.getElementById('val-nombre-tam').textContent = estado.nombre_tam;
  marcarPos(estado.nombre_pos);
}

function marcarPos(pos) {
  document.querySelectorAll('.pos-btn').forEach((b) =>
    b.classList.toggle('activa', b.dataset.pos === pos));
}

function aplicarPrevia() {
  document.getElementById('previa-logo').style.width = estado.logo_tam + 'px';
  const $nombre = document.getElementById('previa-nombre');
  $nombre.style.fontSize = estado.nombre_tam + 'px';

  const $tit = document.getElementById('previa-titulo');
  const map = { izquierda: 'flex-start', centro: 'center', derecha: 'flex-end' };
  $tit.style.alignItems = map[estado.nombre_pos] || 'center';
  $tit.style.textAlign = estado.nombre_pos === 'izquierda' ? 'left'
    : estado.nombre_pos === 'derecha' ? 'right' : 'center';
}

async function guardar() {
  const $g = document.getElementById('config-guardado');
  const { error } = await supabase.from('config_sistema').update({
    logo_tam: estado.logo_tam,
    nombre_tam: estado.nombre_tam,
    nombre_pos: estado.nombre_pos,
    modificado_en: new Date().toISOString()
  }).eq('id', 1);

  if (error) {
    const $a = document.getElementById('alerta-config');
    $a.textContent = 'No fue posible guardar: ' + error.message;
    $a.hidden = false;
    return;
  }
  document.getElementById('alerta-config').hidden = true;
  $g.textContent = 'Guardado. Recargue las páginas para ver el cambio.';
  setTimeout(() => { $g.textContent = ''; }, 4000);
}

function restaurar() {
  estado.logo_tam = 200;
  estado.nombre_tam = 26;
  estado.nombre_pos = 'centro';
  document.getElementById('cfg-logo-tam').value = 200;
  document.getElementById('cfg-nombre-tam').value = 26;
  document.getElementById('val-logo-tam').textContent = 200;
  document.getElementById('val-nombre-tam').textContent = 26;
  marcarPos('centro');
  aplicarPrevia();
}

function conectar() {
  document.getElementById('cfg-logo-tam').addEventListener('input', (e) => {
    estado.logo_tam = parseInt(e.target.value, 10);
    document.getElementById('val-logo-tam').textContent = estado.logo_tam;
    aplicarPrevia();
  });
  document.getElementById('cfg-nombre-tam').addEventListener('input', (e) => {
    estado.nombre_tam = parseInt(e.target.value, 10);
    document.getElementById('val-nombre-tam').textContent = estado.nombre_tam;
    aplicarPrevia();
  });
  document.querySelectorAll('.pos-btn').forEach((b) =>
    b.addEventListener('click', () => {
      estado.nombre_pos = b.dataset.pos;
      marcarPos(estado.nombre_pos);
      aplicarPrevia();
    }));
  document.getElementById('btn-guardar-config').addEventListener('click', guardar);
  document.getElementById('btn-restaurar').addEventListener('click', restaurar);

  conectarTirador();
}

/* Arrastrar la esquina del logo para redimensionarlo,
   como en Word o PowerPoint. */
function conectarTirador() {
  const $tirador = document.getElementById('tirador');
  const $caja = document.getElementById('logo-caja');
  if (!$tirador || !$caja) return;

  let arrastrando = false;
  let inicioX = 0;
  let anchoInicial = 0;

  const MIN = 60, MAX = 600;

  function empezar(e) {
    arrastrando = true;
    inicioX = (e.touches ? e.touches[0].clientX : e.clientX);
    anchoInicial = estado.logo_tam;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  function mover(e) {
    if (!arrastrando) return;
    const x = (e.touches ? e.touches[0].clientX : e.clientX);
    let nuevo = anchoInicial + (x - inicioX);
    nuevo = Math.max(MIN, Math.min(MAX, Math.round(nuevo)));
    estado.logo_tam = nuevo;
    document.getElementById('val-logo-tam').textContent = nuevo;
    document.getElementById('cfg-logo-tam').value = nuevo;
    aplicarPrevia();
  }

  function terminar() {
    arrastrando = false;
    document.body.style.userSelect = '';
  }

  $tirador.addEventListener('mousedown', empezar);
  document.addEventListener('mousemove', mover);
  document.addEventListener('mouseup', terminar);

  $tirador.addEventListener('touchstart', empezar, { passive: false });
  document.addEventListener('touchmove', mover, { passive: false });
  document.addEventListener('touchend', terminar);
}

/* ============================================
   Pestaña: Sucursales y cargos
   ============================================ */


const cargosEstado = { empresaId: null };

async function initCargos() {
  // Pestañas
  document.querySelectorAll('.pestana').forEach((p) =>
    p.addEventListener('click', () => {
      const v = p.dataset.vista;
      document.querySelectorAll('.pestana').forEach((x) => x.classList.toggle('activa', x === p));
      document.getElementById('vista-apariencia').hidden = v !== 'apariencia';
      document.getElementById('vista-cargos').hidden = v !== 'cargos';
      document.getElementById('vista-modulos').hidden = v !== 'modulos';
      document.getElementById('vista-logo').hidden = v !== 'logo';
      document.getElementById('vista-bitacora').hidden = v !== 'bitacora';
      if (v === 'cargos') cargarEmpresasCargos();
      if (v === 'modulos') cargarEmpresasModulos();
      if (v === 'logo') cargarEmpresasLogo();
      if (v === 'bitacora') iniciarBitacora();
    }));

  document.getElementById('cfg-empresa').addEventListener('change', (e) => {
    cargosEstado.empresaId = e.target.value || null;
    document.getElementById('cargos-area').hidden = !cargosEstado.empresaId;
    if (cargosEstado.empresaId) { cargarSuc(); cargarCargos(); }
  });

  document.getElementById('mod-empresa').addEventListener('change', (e) => {
    const id = e.target.value || null;
    document.getElementById('mod-lista').hidden = !id;
    if (id) pintarModulos(id);
  });

  document.getElementById('logo-empresa').addEventListener('change', (e) => {
    logoEstado.empresaId = e.target.value || null;
    document.getElementById('logo-area').hidden = !logoEstado.empresaId;
    if (logoEstado.empresaId) cargarLogoActual();
  });
  document.getElementById('logo-archivo').addEventListener('change', alElegirLogo);
  document.getElementById('btn-guardar-logo').addEventListener('click', guardarLogo);
  document.getElementById('btn-guardar-color').addEventListener('click', guardarColor);

  document.getElementById('btn-add-suc').addEventListener('click', addSucursal);
  document.getElementById('btn-add-cargo').addEventListener('click', addCargo);
}

let empresasCargadasCargos = false;
async function cargarEmpresasCargos() {
  if (empresasCargadasCargos) return;
  const perfil = sesionActual() || { rol: 'admin' };
  const data = await empresasPermitidas(perfil);
  const $s = document.getElementById('cfg-empresa');
  (data || []).forEach((e) => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.razon_social;
    $s.appendChild(o);
  });
  empresasCargadasCargos = true;
}

/* ============================================
   Pestaña: Módulos por empresa
   ============================================ */

let empresasCargadasModulos = false;
async function cargarEmpresasModulos() {
  if (empresasCargadasModulos) return;
  const perfil = sesionActual() || { rol: 'admin' };
  const data = await empresasPermitidas(perfil);
  const $s = document.getElementById('mod-empresa');
  (data || []).forEach((e) => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.razon_social;
    $s.appendChild(o);
  });
  empresasCargadasModulos = true;
}

async function pintarModulos(empresaId) {
  const $lista = document.getElementById('mod-lista');
  $lista.innerHTML = '<p class="ayuda">Cargando…</p>';

  const opcionales = MODULOS.filter((m) => MODULOS_OPCIONALES.includes(m.id));
  const activos = await modulosActivosEmpresa(empresaId);

  $lista.innerHTML = '';
  opcionales.forEach((modulo) => {
    const fila = document.createElement('div');
    fila.className = 'item mod-item';

    const nombre = document.createElement('span');
    nombre.className = 'item-nombre';
    nombre.textContent = modulo.texto;
    fila.appendChild(nombre);

    const label = document.createElement('label');
    label.className = 'mod-switch';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = activos.has(modulo.id);
    const cursor = document.createElement('span');
    cursor.className = 'mod-switch-cursor';
    label.appendChild(chk);
    label.appendChild(cursor);
    fila.appendChild(label);

    chk.addEventListener('change', async () => {
      chk.disabled = true;
      const r = await fijarModuloEmpresa(empresaId, modulo.id, chk.checked);
      chk.disabled = false;
      if (!r.ok) {
        alert('No se pudo guardar el cambio: ' + r.mensaje);
        chk.checked = !chk.checked; // revertir el switch visualmente
      }
    });

    $lista.appendChild(fila);
  });
}

/* ============================================
   Pestaña: Logo y color por empresa
   ============================================ */

const logoEstado = { empresaId: null, logoRecortadoDataUrl: null };

let empresasCargadasLogo = false;
async function cargarEmpresasLogo() {
  if (empresasCargadasLogo) return;
  const perfil = sesionActual() || { rol: 'admin' };
  const data = await empresasPermitidas(perfil);
  const $s = document.getElementById('logo-empresa');
  (data || []).forEach((e) => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.razon_social;
    $s.appendChild(o);
  });
  empresasCargadasLogo = true;
}

/* Trae el logo y color ya guardados de la empresa elegida, para
   que la vista previa arranque mostrando lo que ya existe, no
   un cuadro en blanco. */
async function cargarLogoActual() {
  const $btn = document.getElementById('btn-guardar-logo');
  const $previaCaja = document.getElementById('logo-previa-caja');
  const $previa = document.getElementById('logo-previa');
  const $archivo = document.getElementById('logo-archivo');
  const $color = document.getElementById('logo-color');
  const $alerta = document.getElementById('alerta-logo');

  $archivo.value = '';
  logoEstado.logoRecortadoDataUrl = null;
  $btn.disabled = true;
  $alerta.hidden = true;
  document.getElementById('logo-guardado').textContent = '';
  document.getElementById('color-guardado').textContent = '';

  const { data } = await supabase
    .from('empresas')
    .select('logo_url, color_marca')
    .eq('id', logoEstado.empresaId)
    .maybeSingle();

  if (data?.logo_url) {
    $previa.src = data.logo_url;
    $previaCaja.hidden = false;
  } else {
    $previaCaja.hidden = true;
  }

  $color.value = data?.color_marca || '#1b5e20';
}

/* Al elegir un archivo, se recorta el espacio vacío o
   transparente alrededor de la marca ANTES de mostrar la vista
   previa — así, sin importar cómo venga el archivo original,
   el logo siempre llena el espacio disponible al máximo. Esto
   es lo que garantiza que cualquier empresa nueva se vea igual
   de grande que Agrimroc en cada documento. */
async function alElegirLogo(e) {
  const archivo = e.target.files?.[0];
  const $alerta = document.getElementById('alerta-logo');
  $alerta.hidden = true;

  if (!archivo) return;

  try {
    const dataUrl = await recortarImagen(archivo);
    logoEstado.logoRecortadoDataUrl = dataUrl;

    document.getElementById('logo-previa').src = dataUrl;
    document.getElementById('logo-previa-caja').hidden = false;
    document.getElementById('btn-guardar-logo').disabled = false;
  } catch (err) {
    console.error('NEXUS · configuracion: no se pudo recortar el logo', err);
    $alerta.textContent = 'No se pudo procesar esa imagen. Intente con otro archivo.';
    $alerta.hidden = false;
  }
}

/**
 * Recorta el espacio transparente o casi blanco alrededor de la
 * marca, usando un lienzo (canvas) en el navegador. Devuelve un
 * PNG en formato data URL, listo para subir.
 */
function recortarImagen(archivo) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onerror = () => reject(new Error('No se pudo leer el archivo'));
    lector.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
      img.onload = () => {
        try {
          resolve(recortarEnLienzo(img));
        } catch (err) {
          reject(err);
        }
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(archivo);
  });
}

function recortarEnLienzo(img) {
  const ancho = img.naturalWidth;
  const alto = img.naturalHeight;

  const lienzo = document.createElement('canvas');
  lienzo.width = ancho;
  lienzo.height = alto;
  const ctx = lienzo.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const { data } = ctx.getImageData(0, 0, ancho, alto);

  /* Un píxel cuenta como "vacío" si es transparente o casi
     blanco puro — el margen que sobra alrededor del logotipo
     en la mayoría de archivos exportados desde Canva, Figma o
     Word. */
  const esVacio = (i) => {
    const a = data[i + 3];
    if (a < 10) return true;
    return data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250;
  };

  let top = 0, bottom = alto - 1, left = 0, right = ancho - 1;

  busquedaTop:
  for (; top < alto; top++) {
    for (let x = 0; x < ancho; x++) {
      if (!esVacio((top * ancho + x) * 4)) break busquedaTop;
    }
  }

  busquedaBottom:
  for (; bottom > top; bottom--) {
    for (let x = 0; x < ancho; x++) {
      if (!esVacio((bottom * ancho + x) * 4)) break busquedaBottom;
    }
  }

  busquedaLeft:
  for (; left < ancho; left++) {
    for (let y = top; y <= bottom; y++) {
      if (!esVacio((y * ancho + left) * 4)) break busquedaLeft;
    }
  }

  busquedaRight:
  for (; right > left; right--) {
    for (let y = top; y <= bottom; y++) {
      if (!esVacio((y * ancho + right) * 4)) break busquedaRight;
    }
  }

  /* Si la imagen resultara vacía por completo (un archivo en
     blanco, por ejemplo), se usa la original tal cual en vez de
     producir un recorte de tamaño cero. */
  const anchoRecorte = right - left + 1;
  const altoRecorte = bottom - top + 1;
  if (anchoRecorte <= 0 || altoRecorte <= 0) {
    return lienzo.toDataURL('image/png');
  }

  /* Un margen pequeño y parejo se ve más ordenado que el logo
     pegado justo al borde de su propia caja. */
  const margen = Math.round(Math.max(anchoRecorte, altoRecorte) * 0.04);

  const final = document.createElement('canvas');
  final.width = anchoRecorte + margen * 2;
  final.height = altoRecorte + margen * 2;
  const ctxFinal = final.getContext('2d');
  ctxFinal.drawImage(
    lienzo,
    left, top, anchoRecorte, altoRecorte,
    margen, margen, anchoRecorte, altoRecorte
  );

  return final.toDataURL('image/png');
}

function dataUrlABlob(dataUrl) {
  const [cabecera, base64] = dataUrl.split(',');
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

async function guardarLogo() {
  if (!logoEstado.empresaId || !logoEstado.logoRecortadoDataUrl) return;

  const $btn = document.getElementById('btn-guardar-logo');
  const $guardado = document.getElementById('logo-guardado');
  const $alerta = document.getElementById('alerta-logo');
  $alerta.hidden = true;
  $btn.disabled = true;
  $btn.textContent = 'Guardando…';

  const blob = dataUrlABlob(logoEstado.logoRecortadoDataUrl);
  const ruta = `${logoEstado.empresaId}/logo.png`;

  const { error: errSubida } = await supabase.storage
    .from('logos-empresas')
    .upload(ruta, blob, { upsert: true, contentType: 'image/png' });

  if (errSubida) {
    $btn.disabled = false;
    $btn.textContent = 'Guardar logo';
    $alerta.textContent = 'No se pudo subir el logo: ' + errSubida.message;
    $alerta.hidden = false;
    return;
  }

  const { data: publica } = supabase.storage.from('logos-empresas').getPublicUrl(ruta);
  // Se agrega la hora como parámetro para que el navegador no
  // siga mostrando el logo viejo desde su caché al reemplazarlo.
  const url = `${publica.publicUrl}?t=${Date.now()}`;

  const { error: errGuardar } = await supabase
    .from('empresas')
    .update({ logo_url: url })
    .eq('id', logoEstado.empresaId);

  $btn.disabled = false;
  $btn.textContent = 'Guardar logo';

  if (errGuardar) {
    $alerta.textContent = 'El archivo se subió, pero no se pudo guardar en la empresa: ' + errGuardar.message;
    $alerta.hidden = false;
    return;
  }

  $guardado.textContent = 'Logo guardado ✓';
  setTimeout(() => { $guardado.textContent = ''; }, 3000);
}

async function guardarColor() {
  if (!logoEstado.empresaId) return;

  const color = document.getElementById('logo-color').value;
  const $guardado = document.getElementById('color-guardado');

  const { error } = await supabase
    .from('empresas')
    .update({ color_marca: color })
    .eq('id', logoEstado.empresaId);

  if (error) {
    alert('No se pudo guardar el color: ' + error.message);
    return;
  }

  $guardado.textContent = 'Color guardado ✓';
  setTimeout(() => { $guardado.textContent = ''; }, 3000);
}

async function cargarSuc() {
  const { data } = await supabase.from('v_sucursales_reales')
    .select('id, nombre').eq('empresa_id', cargosEstado.empresaId).order('nombre');
  const $l = document.getElementById('lista-suc');
  $l.innerHTML = '';
  if (!data || data.length === 0) { $l.innerHTML = '<p class="lista-vacia">Sin sucursales aún.</p>'; return; }
  data.forEach((s) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span class="item-nombre">${escapar(s.nombre)}</span>`;
    const b = document.createElement('button');
    b.className = 'boton-icono'; b.textContent = 'Eliminar';
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar la sucursal ' + s.nombre + '?')) return;
      await supabase.from('sucursales').delete().eq('id', s.id);
      cargarSuc();
    });
    d.appendChild(b);
    $l.appendChild(d);
  });
}

async function addSucursal() {
  const nombre = document.getElementById('suc-nombre').value.trim();
  if (!nombre) return;
  const { error } = await supabase.from('sucursales')
    .insert({ empresa_id: cargosEstado.empresaId, nombre });
  if (error) { alert('No se pudo agregar: ' + error.message); return; }
  document.getElementById('suc-nombre').value = '';
  cargarSuc();
}

async function cargarCargos() {
  const { data } = await supabase.from('cargos_catalogo')
    .select('id, nombre').eq('empresa_id', cargosEstado.empresaId)
    .eq('activo', true).order('nombre');
  const $l = document.getElementById('lista-cargos');
  $l.innerHTML = '';
  if (!data || data.length === 0) { $l.innerHTML = '<p class="lista-vacia">Sin cargos aún.</p>'; return; }
  data.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span class="item-nombre">${escapar(c.nombre)}</span>`;
    const b = document.createElement('button');
    b.className = 'boton-icono'; b.textContent = 'Eliminar';
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar el cargo ' + c.nombre + '?')) return;
      await supabase.from('cargos_catalogo').delete().eq('id', c.id);
      cargarCargos();
    });
    d.appendChild(b);
    $l.appendChild(d);
  });
}

async function addCargo() {
  const nombre = document.getElementById('cargo-nombre').value.trim();
  if (!nombre) return;
  const { error } = await supabase.from('cargos_catalogo')
    .insert({ empresa_id: cargosEstado.empresaId, nombre: nombre.toUpperCase() });
  if (error) {
    if (error.message.includes('duplicate')) alert('Ese cargo ya existe.');
    else alert('No se pudo agregar: ' + error.message);
    return;
  }
  document.getElementById('cargo-nombre').value = '';
  cargarCargos();
}

initCargos();


/* ============================================
   Bitácora · quién hizo qué

   Lo escribe un disparador de la base cada vez que alguien
   crea, cambia o da de baja un registro de las tablas
   vigiladas. Aquí solo se lee.

   ADVERTENCIA: el autor lo declara el navegador. Mientras el
   login no emita una sesión de verdad, alguien con
   conocimientos puede escribir el identificador de otra
   persona. Sirve para saber quién hizo qué entre el equipo;
   no es prueba ante una discrepancia laboral.
   ============================================ */

const POR_PAGINA = 100;

const bit = { pagina: 0, filas: [], hayMas: false, listo: false };

/* Nombres de columna que nadie fuera de programación
   reconocería. Lo que no esté aquí se muestra tal cual, con
   los guiones bajos cambiados por espacios: es preferible un
   nombre imperfecto a esconder que algo cambió. */
const CAMPOS_LEGIBLES = {
  stock_disponible: 'stock disponible',
  stock_minimo: 'stock mínimo',
  stock_optimo: 'stock óptimo',
  fecha_caducidad: 'fecha de caducidad',
  numero_lote: 'número de lote',
  nombre_generico: 'nombre genérico',
  fecha_ingreso: 'fecha de ingreso',
  fecha_salida: 'fecha de salida',
  motivo_salida: 'motivo de salida',
  ubicacion_texto: 'ubicación en el acta',
  responsable_cargo: 'cargo del responsable',
  destinatario_cargo: 'cargo del destinatario',
  fecha_inspeccion: 'fecha de inspección',
  fecha_revision: 'fecha de revisión',
  sin_destinatario: 'sin destinatario',
  exige_codigo: 'exige código',
  activo: 'estado'
};

const ACCIONES = {
  alta:   ['insignia-activa', 'Alta'],
  cambio: ['insignia-aviso',  'Cambio'],
  baja:   ['insignia-critica','Baja']
};

async function iniciarBitacora() {
  if (bit.listo) return;
  bit.listo = true;

  ['bit-modulo', 'bit-usuario', 'bit-accion', 'bit-desde'].forEach((id) =>
    document.getElementById(id).addEventListener('change', () => {
      bit.pagina = 0;
      bit.filas = [];
      cargarBitacora();
    }));

  document.getElementById('bit-btn-mas').addEventListener('click', () => {
    bit.pagina += 1;
    cargarBitacora();
  });

  await llenarFiltrosBitacora();
  await cargarBitacora();
}

/* Los desplegables se arman con lo que REALMENTE hay en la
   bitácora, no con una lista fija de módulos y usuarios.
   Ofrecer un filtro que siempre devuelve vacío es peor que no
   ofrecerlo. */
async function llenarFiltrosBitacora() {
  const { data } = await supabase
    .from('v_bitacora')
    .select('modulo, usuario, usuario_id')
    .order('creado_en', { ascending: false })
    .limit(1000);

  const modulos = [...new Set((data || []).map((r) => r.modulo))].sort();
  const $m = document.getElementById('bit-modulo');
  modulos.forEach((m) => {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    $m.appendChild(o);
  });

  const vistos = new Map();
  (data || []).forEach((r) => {
    if (r.usuario_id && !vistos.has(r.usuario_id)) vistos.set(r.usuario_id, r.usuario);
  });
  const $u = document.getElementById('bit-usuario');
  [...vistos.entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .forEach(([id, nombre]) => {
      const o = document.createElement('option');
      o.value = id; o.textContent = nombre;
      $u.appendChild(o);
    });
}

async function cargarBitacora() {
  const modulo  = document.getElementById('bit-modulo').value;
  const usuario = document.getElementById('bit-usuario').value;
  const accion  = document.getElementById('bit-accion').value;
  const desde   = document.getElementById('bit-desde').value;

  const inicio = bit.pagina * POR_PAGINA;

  let q = supabase.from('v_bitacora').select('*')
    .order('creado_en', { ascending: false })
    .range(inicio, inicio + POR_PAGINA - 1);

  if (modulo)  q = q.eq('modulo', modulo);
  if (usuario) q = q.eq('usuario_id', usuario);
  if (accion)  q = q.eq('accion', accion);
  if (desde)   q = q.gte('creado_en', desde);

  const { data, error } = await q;

  if (error) {
    document.getElementById('bit-vacio').hidden = false;
    document.getElementById('bit-vacio').textContent =
      'No se pudo leer la bitácora. ¿Ejecutó el SQL 038?';
    return;
  }

  bit.filas = bit.pagina === 0 ? (data || []) : bit.filas.concat(data || []);
  bit.hayMas = (data || []).length === POR_PAGINA;
  pintarBitacora();
}

function pintarBitacora() {
  const $c = document.getElementById('bit-cuerpo');
  const $vacio = document.getElementById('bit-vacio');
  $c.innerHTML = '';

  $vacio.hidden = bit.filas.length > 0;
  document.getElementById('bit-btn-mas').hidden = !bit.hayMas;
  document.getElementById('bit-cuenta').textContent = bit.filas.length === 0
    ? '—'
    : `${bit.filas.length} movimiento${bit.filas.length === 1 ? '' : 's'}`;

  bit.filas.forEach((r) => {
    const [clase, texto] = ACCIONES[r.accion] || ['insignia-inactiva', r.accion];

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="bit-fecha">${escapar(momento(r.creado_en))}</td>
      <td>${escapar(r.usuario || 'No identificado')}</td>
      <td class="celda-centro">
        <span class="insignia ${clase}">${texto}</span>
      </td>
      <td class="celda-tenue">${escapar(r.modulo)}</td>
      <td class="bit-cambios">${describir(r)}</td>
    `;
    $c.appendChild(tr);
  });
}

/* Fecha y hora juntas: en una bitácora, saber que dos cambios
   ocurrieron el mismo día no sirve de nada si no se sabe
   cuál fue primero. */
function momento(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('es-EC') + ' · '
       + d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' });
}

function describir(r) {
  if (r.accion === 'alta') return '<span class="celda-tenue">Registro creado</span>';
  if (r.accion === 'baja') return '<span class="celda-tenue">Registro eliminado</span>';

  const campos = r.campos || [];
  if (campos.length === 0) return '<span class="celda-tenue">—</span>';

  /* Se muestra el valor anterior y el nuevo, no solo el nombre
     del campo: «cambió el stock» no responde la pregunta que
     lleva a alguien a abrir la bitácora. */
  return campos.slice(0, 4).map((c) => {
    const antes = valorLegible(r.antes?.[c]);
    const ahora = valorLegible(r.despues?.[c]);
    return `<span class="bit-campo">${escapar(CAMPOS_LEGIBLES[c] || c.replace(/_/g, ' '))}</span>
            <span class="bit-antes">${escapar(antes)}</span>
            <span class="bit-flecha">→</span>
            <span class="bit-ahora">${escapar(ahora)}</span>`;
  }).join('<br>')
    + (campos.length > 4
        ? `<br><span class="celda-tenue">y ${campos.length - 4} campo${
            campos.length - 4 === 1 ? '' : 's'} más</span>` : '');
}

function valorLegible(v) {
  if (v === null || v === undefined) return 'vacío';
  if (v === true) return 'sí';
  if (v === false) return 'no';
  const t = String(v);
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

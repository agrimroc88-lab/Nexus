/* ============================================
   NEXUS · nav.js
   Barra lateral compartida por todos los módulos.
   ARCHIVO COMPARTIDO — un solo punto de verdad
   para el catálogo de módulos del sistema.
   ============================================ */

import { cerrarSesion, puedeVerModulo, empresasPermitidas, salirDeEmpresa, empresaActivaId, modulosActivosEmpresa } from './auth.js?v=11';
import { supabase } from './supabase.js?v=11';

/* --- Catálogo de módulos ---
   Orden de aparición en el sidebar = orden de este arreglo.

   listo : habilita el enlace. Cambiar a true al construir el módulo.
           Mientras sea false, el enlace se muestra en gris (inactivo).
   roles : lista de roles que VEN el módulo. Si se omite, lo ven todos.
           La ESCRITURA real la impone siempre la RLS de PostgreSQL;
           esta lista solo controla la visibilidad del enlace.          */

export const MODULOS = [
  { id: 'dashboard',     texto: 'Panel general',        archivo: 'dashboard.html',            listo: true  },
  { id: 'empresas',      texto: 'Empresas',             archivo: 'empresas.html',             listo: true,
    roles: ['admin'] },
  { id: 'trabajadores',  texto: 'Trabajadores',         archivo: 'trabajadores.html',         listo: true  },
  { id: 'salud_ocup',    texto: 'Salud ocupacional',    archivo: 'salud-ocupacional.html',    listo: true,
    roles: ['admin', 'medico_ocupacional', 'enfermeria', 'psicologo'], opcional: true },
  { id: 'psicologia',    texto: 'Psicología',           archivo: 'psicologia.html',           listo: true,
    roles: ['admin', 'psicologo', 'psico_social'], opcional: true },
  { id: 'seguridad_ind', texto: 'Seguridad industrial', archivo: 'seguridad-industrial.html', listo: true,
    roles: ['admin', 'tecnico_sst', 'medico_ocupacional', 'enfermeria'], opcional: true },
  { id: 'trabajo_social',texto: 'Trabajo Social',       archivo: 'trabajo-social.html',       listo: true,
    roles: ['admin', 'trabajo_social', 'psico_social', 'medico_ocupacional'], opcional: true },
  { id: 'atenciones',    texto: 'Atenciones médicas',   archivo: 'atenciones.html',           listo: true,
    roles: ['admin', 'medico_ocupacional', 'enfermeria'], opcional: true },
  { id: 'farmacia',      texto: 'Farmacia',             archivo: 'farmacia.html',             listo: true,
    roles: ['admin', 'enfermeria'], opcional: true },
  { id: 'certificados',  texto: 'Certificados médicos', archivo: 'certificados.html',         listo: true,
    opcional: true },
  { id: 'usuarios',      texto: 'Usuarios',             archivo: 'usuarios.html',             listo: true,
    roles: ['admin'] },
  { id: 'configuracion', texto: 'Configuración',        archivo: 'configuracion.html',        listo: true,
    roles: ['admin'], abajo: true }
];

/**
 * Construye la barra lateral y la cabecera de usuario.
 * @param {object} perfil - perfil devuelto por protegerPagina()
 * @param {string} moduloActivo - id del módulo actual
 */
export async function montarNavegacion(perfil, moduloActivo) {
  const empresa = await datosEmpresaActiva();
  pintarMarca(empresa);
  pintarTituloEmpresa(empresa);
  aplicarColorSidebar(empresa?.color_marca);
  pintarUsuario(perfil);
  pintarEnlaces(perfil, moduloActivo);
  conectarEventos();
  aplicarConfigVisual();  // lee config_sistema y ajusta tamaños (asíncrono)
  suscribirModulosEnVivo(perfil, moduloActivo);
}

/* Un solo canal por pestaña abierta. Si Configuración enciende o
   apaga un módulo para la empresa activa mientras esta pestaña
   está abierta, el menú se redibuja solo — sin F5. */
let canalModulos = null;

function suscribirModulosEnVivo(perfil, moduloActivo) {
  const empresaId = empresaActivaId();
  if (!empresaId || canalModulos) return;

  canalModulos = supabase
    .channel('nexus-empresa-modulos-' + empresaId)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'empresa_modulos',
      filter: 'empresa_id=eq.' + empresaId
    }, () => {
      pintarEnlaces(perfil, moduloActivo);
    })
    .subscribe();
}

/* Lee la configuración visual guardada y la aplica al logo
   y al nombre en TODAS las páginas. Si falla, deja los valores
   por defecto del CSS. */
async function aplicarConfigVisual() {
  try {
    const { data } = await supabase
      .from('config_sistema').select('*').eq('id', 1).maybeSingle();
    if (!data) return;

    const $logo = document.querySelector('.lateral-logo');
    if ($logo && data.logo_tam) $logo.style.maxWidth = data.logo_tam + 'px';

    const $nombre = document.querySelector('.empresa-nombre');
    if ($nombre && data.nombre_tam) $nombre.style.fontSize = data.nombre_tam + 'px';

    const $tit = document.querySelector('.empresa-titulo');
    if ($tit && data.nombre_pos) {
      // Reposicionar el título en la cabecera
      if (data.nombre_pos === 'izquierda') {
        $tit.style.left = '4.5rem';
        $tit.style.transform = 'none';
        $tit.style.textAlign = 'left';
        $tit.style.alignItems = 'flex-start';
      } else if (data.nombre_pos === 'derecha') {
        $tit.style.left = 'auto';
        $tit.style.right = '14rem';
        $tit.style.transform = 'none';
        $tit.style.textAlign = 'right';
        $tit.style.alignItems = 'flex-end';
      } else {
        $tit.style.left = '50%';
        $tit.style.transform = 'translateX(-50%)';
        $tit.style.textAlign = 'center';
        $tit.style.alignItems = 'center';
      }
    }
  } catch (_) { /* silencioso: usa defaults */ }
}

/* Datos de marca de la empresa activa: logo, nombre y color.
   Si la empresa no tiene logo o color configurado todavía (caso
   de Agrimroc, que nunca pasó por la pestaña nueva), se usa el
   logo fijo de siempre — así ninguna empresa existente cambia
   de aspecto sin que un admin lo configure a propósito. */
async function datosEmpresaActiva() {
  const id = empresaActivaId();
  if (!id) return null;

  const { data, error } = await supabase
    .from('empresas')
    .select('razon_social, logo_url, color_marca')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.warn('NEXUS · nav: no se pudo leer la empresa activa:', error.message);
    return null;
  }
  return data;
}

function escaparTexto(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

/* --- Color del menú lateral, derivado del color de marca ---
   Solo afecta el resaltado al pasar el cursor y la opción
   activa del sidebar — nada más de la interfaz cambia. Si la
   empresa no tiene color propio, se quita la variable y todo
   vuelve al verde de siempre (ver layout.css, que ya trae ese
   verde como respaldo). */

function hexARgb(hex) {
  const limpio = (hex || '').replace('#', '');
  const completo = limpio.length === 3
    ? limpio.split('').map((c) => c + c).join('')
    : limpio;
  const num = parseInt(completo, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function mezclarColor(hex, hacia, cantidad) {
  const { r, g, b } = hexARgb(hex);
  const mr = Math.round(r + (hacia[0] - r) * cantidad);
  const mg = Math.round(g + (hacia[1] - g) * cantidad);
  const mb = Math.round(b + (hacia[2] - b) * cantidad);
  return `rgb(${mr}, ${mg}, ${mb})`;
}

function aplicarColorSidebar(color) {
  const raiz = document.documentElement.style;
  if (!color) {
    raiz.removeProperty('--color-marca-suave');
    raiz.removeProperty('--color-marca-oscuro');
    return;
  }
  try {
    raiz.setProperty('--color-marca-suave', mezclarColor(color, [255, 255, 255], 0.85));
    raiz.setProperty('--color-marca-oscuro', mezclarColor(color, [0, 0, 0], 0.35));
  } catch (_) { /* color mal formado: se ignora, queda el verde de siempre */ }
}

async function pintarMarca(empresa) {
  const $marca = document.querySelector('.lateral-marca');
  if (!$marca) return;

  const logo = empresa?.logo_url || 'logo.png';
  const alt = empresa?.razon_social || 'Nexus';

  $marca.innerHTML =
    `<img src="${escaparTexto(logo)}" alt="${escaparTexto(alt)}" class="lateral-logo">`;
}

/* Título centrado en la cabecera: nombre de la empresa activa. */
async function pintarTituloEmpresa(empresa) {
  const $cab = document.querySelector('.cabecera');
  if (!$cab || document.querySelector('.empresa-titulo')) return;

  const nombre = empresa?.razon_social || 'AGRIMROC S.A.';
  const color = empresa?.color_marca;

  const div = document.createElement('div');
  div.className = 'empresa-titulo';
  div.innerHTML =
    `<span class="empresa-nombre"${color ? ` style="color:${escaparTexto(color)}"` : ''}>`
    + `${escaparTexto(nombre)}</span>`
    + '<span class="empresa-sub">USSO · Unidad de Seguridad y Salud Ocupacional</span>';

  // Insertar centrado: después del título del módulo
  const $titulo = $cab.querySelector('.cabecera-titulo');
  if ($titulo) $titulo.after(div);
  else $cab.appendChild(div);
}

function pintarUsuario(perfil) {
  const $nombre = document.getElementById('usuario-nombre');
  const $rol = document.getElementById('usuario-rol');
  if ($nombre) $nombre.textContent = `${perfil.nombres} ${perfil.apellidos}`;
  if ($rol) $rol.textContent = perfil.rol.replace(/_/g, ' ');

  // Botón de cerrar sesión en la cabecera, debajo del nombre
  const $usuario = document.querySelector('.cabecera-usuario');
  if ($usuario && !document.getElementById('btn-salir-cabecera')) {
    const btn = document.createElement('button');
    btn.id = 'btn-salir-cabecera';
    btn.className = 'btn-salir-cabecera';
    btn.type = 'button';
    btn.textContent = 'Cerrar sesión';
    btn.addEventListener('click', cerrarSesion);
    $usuario.appendChild(btn);
  }

  // Botón de salir de empresa: solo si tiene más de una asignada.
  // No cierra sesión, solo regresa a elegir con cuál trabajar.
  if ($usuario && !document.getElementById('btn-salir-empresa')) {
    empresasPermitidas(perfil).then((permitidas) => {
      if (permitidas.length <= 1) return;
      const btn = document.createElement('button');
      btn.id = 'btn-salir-empresa';
      btn.className = 'btn-salir-cabecera btn-salir-empresa';
      btn.type = 'button';
      btn.textContent = 'Salir de empresa';
      btn.addEventListener('click', salirDeEmpresa);
      $usuario.appendChild(btn);
    });
  }
}

async function pintarEnlaces(perfil, moduloActivo) {
  const $nav = document.getElementById('lateral-nav');
  if (!$nav) return;

  // Módulos opcionales apagados para la empresa activa (Fase 3).
  // Si algo falla o no hay empresa aún, se asume todo activo —
  // nunca se oculta un módulo por error de red, solo por decisión
  // explícita del admin en Configuración.
  const activos = await modulosActivosEmpresa(empresaActivaId());

  // Se limpia antes de redibujar: además del arranque normal, esta
  // función se vuelve a llamar en vivo cuando cambia empresa_modulos
  // (ver suscribirModulosEnVivo), y sin este paso los enlaces se
  // duplicarían en cada actualización.
  $nav.innerHTML = '';

  const fragmento = document.createDocumentFragment();

  MODULOS.forEach((modulo) => {
    // Filtro de visibilidad por rol. Si el módulo no declara `roles`,
    // puedeVerModulo() devuelve true y lo ven todos.
    if (!puedeVerModulo(perfil.rol, modulo)) return;

    // Filtro por empresa: los módulos núcleo (sin `opcional`) no
    // se evalúan aquí y siempre se muestran si el rol lo permite.
    if (modulo.opcional && !activos.has(modulo.id)) return;

    const enlace = document.createElement('a');
    enlace.className = 'nav-enlace';
    // Los que llevan `abajo: true` se empujan al fondo del sidebar
    if (modulo.abajo) enlace.classList.add('nav-abajo');
    enlace.textContent = modulo.texto;

    if (modulo.listo) {
      enlace.href = modulo.archivo;
      if (modulo.id === moduloActivo) enlace.classList.add('activo');
    } else {
      enlace.classList.add('inactivo');
      enlace.title = 'Módulo en construcción';
    }

    fragmento.appendChild(enlace);
  });

  $nav.appendChild(fragmento);
}

function conectarEventos() {
  const $salir = document.getElementById('btn-salir');
  const $menu = document.getElementById('btn-menu');
  const $lateral = document.getElementById('barra-lateral');

  if ($salir) $salir.addEventListener('click', cerrarSesion);
  if ($menu && $lateral) {
    $menu.addEventListener('click', () => $lateral.classList.toggle('abierta'));
  }
}

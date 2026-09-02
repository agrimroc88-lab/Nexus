/* ============================================
   NEXUS · logo-empresa.js
   Logo de una empresa para membretes de documentos impresos.
   ARCHIVO COMPARTIDO — lo usa cualquier módulo que imprima
   un documento con membrete.

   Un solo punto de verdad: si el día de mañana cambia cómo o
   dónde se guarda el logo, se corrige aquí una sola vez en vez
   de en cada uno de los módulos que lo usan.
   ============================================ */

import { supabase } from './supabase.js';

/**
 * @param {string|null} empresaId
 * @returns {Promise<string>} URL del logo propio de la empresa,
 *   o 'logo.png' (el logo fijo de siempre) si la empresa no
 *   tiene uno configurado, si no se pudo consultar, o si no se
 *   recibió ningún id.
 *
 * De paso, aplica el color de marca de la empresa a los
 * documentos impresos (ver aplicarColorDocumento) — así con una
 * sola consulta quedan resueltos el logo y el color juntos, sin
 * duplicar la llamada en cada módulo que imprime algo.
 */
export async function logoEmpresa(empresaId) {
  if (!empresaId) { aplicarColorDocumento(null); return 'logo.png'; }

  try {
    const { data, error } = await supabase
      .from('empresas')
      .select('logo_url, color_marca')
      .eq('id', empresaId)
      .maybeSingle();

    if (error) {
      console.warn('NEXUS · logo-empresa: no se pudo consultar, se usa el logo fijo:', error.message);
      aplicarColorDocumento(null);
      return 'logo.png';
    }
    aplicarColorDocumento(data?.color_marca || null);
    return data?.logo_url || 'logo.png';
  } catch (err) {
    console.warn('NEXUS · logo-empresa: error inesperado, se usa el logo fijo:', err);
    aplicarColorDocumento(null);
    return 'logo.png';
  }
}

/* ============================================
   Color de marca en documentos impresos

   Todos los documentos (certificados, oficios, informes) leen
   su color institucional de tres variables compartidas
   definidas en documentos.css (--doc-verde y sus dos tonos
   claros). En vez de tocar cada plantilla de cada documento,
   basta con sobrescribir esas tres variables antes de imprimir
   — como el color es al fin y al cabo el mismo dato para toda
   la empresa, un solo punto de aplicación alcanza para los 18
   documentos del sistema.
   ============================================ */

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

/**
 * @param {string|null} color - color_marca de la empresa (hex),
 *   o null para volver al verde institucional de siempre.
 */
export function aplicarColorDocumento(color) {
  const raiz = document.documentElement.style;

  if (!color) {
    raiz.removeProperty('--doc-verde');
    raiz.removeProperty('--doc-verde-claro');
    raiz.removeProperty('--doc-verde-tenue');
    return;
  }

  try {
    raiz.setProperty('--doc-verde', color);
    raiz.setProperty('--doc-verde-claro', mezclarColor(color, [255, 255, 255], 0.85));
    raiz.setProperty('--doc-verde-tenue', mezclarColor(color, [255, 255, 255], 0.94));
  } catch (_) { /* color mal formado: se ignora, queda el verde de siempre */ }
}

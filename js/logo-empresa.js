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
 */
export async function logoEmpresa(empresaId) {
  if (!empresaId) return 'logo.png';

  try {
    const { data, error } = await supabase
      .from('empresas')
      .select('logo_url')
      .eq('id', empresaId)
      .maybeSingle();

    if (error) {
      console.warn('NEXUS · logo-empresa: no se pudo consultar, se usa el logo fijo:', error.message);
      return 'logo.png';
    }
    return data?.logo_url || 'logo.png';
  } catch (err) {
    console.warn('NEXUS · logo-empresa: error inesperado, se usa el logo fijo:', err);
    return 'logo.png';
  }
}

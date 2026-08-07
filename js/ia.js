/* ============================================
   NEXUS · ia.js

   Único punto de contacto del sistema con la IA.

   Tres decisiones que conviene no revertir:

   1 · La clave no está aquí.
       La llamada va a una Edge Function de Supabase que
       guarda la clave y el prompt. Una clave de API en el
       navegador la lee cualquiera que abra la consola, y a
       diferencia de la `anon` de Supabase no tiene RLS
       debajo: quien la copie factura contra esta cuenta.

   2 · Nunca sale un dato personal.
       Cada módulo arma un resumen de cifras agregadas y ese
       resumen es todo lo que se envía. La historia clínica es
       dato sensible según la LOPDP; mandarla a un tercero
       exige base legal y consentimiento que aquí no hay. Si
       algún día un módulo necesitara enviarlos, es una
       decisión aparte con su propio consentimiento, no una
       ampliación de este archivo.

   3 · Si esto falla, el informe sale igual.
       El sistema está hecho para durar sin depender de nadie,
       y un proveedor externo es lo contrario. Por eso el
       asistente rellena un campo que se puede dejar vacío: si
       el servicio no responde, el informe se genera sin
       análisis y nadie se queda sin informe.
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { sesionActual } from './auth.js?v=11';

const VERSION = 'v1';
console.info('NEXUS · ia', VERSION);

/**
 * Pide un borrador a la Edge Function.
 *
 * @param {string} funcion  nombre de la función desplegada
 * @param {object} datos    resumen agregado, sin datos personales
 * @returns {Promise<{ok: boolean, texto?: string, mensaje?: string}>}
 */
export async function redactar(funcion, datos) {
  const perfil = sesionActual();
  if (!perfil?.id) return { ok: false, mensaje: 'No hay sesión activa.' };

  const generico = 'No se pudo contactar el servicio de redacción. '
                 + 'Puede escribir el análisis a mano o dejarlo vacío.';

  try {
    const { data, error } = await supabase.functions.invoke(funcion, {
      body: { usuario_id: perfil.id, datos }
    });

    /* El cuerpo de error de la función trae el motivo, y es
       más útil que el genérico del cliente: sin esto, un tope
       diario alcanzado y una función sin desplegar se leen
       igual. */
    if (error) {
      let motivo = '';
      try {
        motivo = (await error.context?.json())?.error || '';
      } catch { /* la respuesta no era JSON */ }
      return { ok: false, mensaje: motivo || generico };
    }

    if (!data?.texto) {
      return { ok: false, mensaje: 'El servicio devolvió una respuesta vacía.' };
    }

    return { ok: true, texto: data.texto };

  } catch (e) {
    console.error('NEXUS · ia:', e);
    return { ok: false, mensaje: generico };
  }
}

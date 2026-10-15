/* ============================================
   NEXUS · puente-learning.js
   Conexión compartida con Nexus Learning (otra plataforma,
   otro proyecto de Supabase). La usan:
    · seleccionar-empresa.js → muestra el cuadro de Nexus Learning
    · learning.js            → módulo de avance por empresa

   Envía el pase de sesión de NEXUS al "puente" (Edge Function
   puente-nexus de Nexus Learning). El puente pregunta a NEXUS
   quién es la persona y responde su papel o un pase de entrada.
   Nunca viaja la contraseña.
   ============================================ */

export const LEARNING = {
  url: 'https://yfmefiytswvxsqmnmrvg.supabase.co',
  clave: 'sb_publishable_F3cIyhfFGoPurU4D0sNVWQ_jLugMPCO',   // pública por diseño
  sitio: 'https://agrimroc88-lab.github.io/nexus-learning/'
};

const PUENTE = LEARNING.url + '/functions/v1/puente-nexus';

async function llamarPuente(accion, msEspera, extra) {
  const pase = sessionStorage.getItem('nexus_token');
  if (!pase) return { error: 'No hay una sesión de NEXUS activa.' };

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), msEspera);
  try {
    const r = await fetch(PUENTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': LEARNING.clave, 'x-sesion-nexus': pase },
      body: JSON.stringify(Object.assign({ accion }, extra || {})),
      signal: control.signal
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { error: datos.error || 'No fue posible conectar con Nexus Learning.', sin_acceso: Boolean(datos.sin_acceso) };
    }
    return datos;
  } catch (e) {
    return { error: 'No fue posible conectar con Nexus Learning. Revise su conexión a internet.' };
  } finally {
    clearTimeout(reloj);
  }
}

/* "admin", "docente" o null. Ante cualquier falla devuelve null:
   así NEXUS sigue funcionando aunque Nexus Learning no responda. */
export async function papelEnLearning() {
  const r = await llamarPuente('consultar', 5000);
  return r.error ? null : (r.rol || null);
}

/* { token_hash, rol } o { error } */
export function paseDeEntrada() {
  return llamarPuente('entrar', 12000);
}

/* Módulo Usuarios (admin): registra o desactiva a la persona como
   docente en Nexus Learning. { ok } o { error } */
export function sincronizarDocente(cedula, nombres, docente) {
  return llamarPuente('docente_nexus', 12000, { cedula, nombres, docente: Boolean(docente) });
}

/* Lleva a la persona a Nexus Learning con su pase de un solo uso */
export function irALearning(tokenHash, rol) {
  window.location.href = LEARNING.sitio + 'entrar.html#th=' +
    encodeURIComponent(tokenHash) + '&rol=' + encodeURIComponent(rol);
}

/* ============================================
   NEXUS · autoria.js

   Marca quién hace cada cambio.

   ARCHIVO COMPARTIDO — lo usan todos los módulos que
   escriben en la base.

   Cómo encaja con la bitácora:
     Las tablas ya tenían creado_por y modificado_por. Se
     diseñaron para Supabase Auth, donde se rellenaban solos
     con auth.uid(); al pasar al login simple dejó de haber
     sesión de base de datos y esas columnas quedaron vacías.
     Estas funciones las rellenan desde el navegador, y el
     disparador de la base copia el autor a la bitácora.

   Por qué helpers y no una llamada distinta en cada módulo:
     Porque el olvido es silencioso. Una escritura sin autor
     no falla ni avisa: simplemente aparece en la bitácora
     como «No identificado», y eso se descubre meses después,
     cuando alguien pregunta quién hizo algo y la respuesta
     no está.

   ADVERTENCIA:
     El autor lo pone el navegador. Mientras el login no emita
     una sesión de verdad, alguien con conocimientos puede
     escribir el identificador de otra persona. Sirve para
     saber quién hizo qué entre gente de confianza; no es
     prueba ante una discrepancia laboral.
   ============================================ */

import { sesionActual } from './auth.js?v=11';

const VERSION = 'v1';
console.info('NEXUS · autoria', VERSION);

/** Identificador del usuario con la sesión abierta, o null. */
export function autorId() {
  return sesionActual()?.id ?? null;
}

/**
 * Añade la autoría a una fila que se va a INSERTAR.
 *
 *   await supabase.from('kardex').insert(alCrear({ ... }))
 *
 * Se ponen las dos columnas: creado_por para saber quién lo
 * dio de alta, modificado_por para que el disparador tenga de
 * dónde leer el autor también en el alta.
 */
export function alCrear(fila) {
  const id = autorId();
  return { ...fila, creado_por: id, modificado_por: id };
}

/**
 * Añade la autoría a una fila que se va a ACTUALIZAR.
 *
 *   await supabase.from('insumos').update(alEditar({ ... })).eq('id', x)
 *
 * No toca creado_por: quien creó el registro lo creó, y
 * sobrescribirlo borraría el único dato que no se puede
 * reconstruir después.
 */
export function alEditar(fila) {
  return { ...fila, modificado_por: autorId(), modificado_en: new Date().toISOString() };
}

/**
 * Marca el autor ANTES de borrar.
 *
 * En un DELETE no hay fila nueva de donde sacar quién lo
 * hizo, así que el disparador lee modificado_por de la fila
 * que se va. Hay que dejarlo escrito antes de borrarla.
 *
 *   await marcarAntesDeBorrar(supabase, 'lotes', id);
 *   await supabase.from('lotes').delete().eq('id', id);
 */
export async function marcarAntesDeBorrar(supabase, tabla, id) {
  const autor = autorId();
  if (!autor) return;

  /* Si falla, se sigue adelante: perder el autor de una baja
     es malo, pero impedir la baja por eso sería peor. Queda
     en la consola para que no pase inadvertido. */
  const { error } = await supabase.from(tabla)
    .update({ modificado_por: autor }).eq('id', id);

  if (error) {
    console.warn(`NEXUS · autoria: no se pudo marcar la baja en ${tabla}:`,
                 error.message);
  }
}

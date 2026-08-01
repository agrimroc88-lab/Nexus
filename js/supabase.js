/* ============================================
   NEXUS · supabase.js
   Cliente único de conexión.
   ARCHIVO COMPARTIDO — punto único de conexión.
   Ningún módulo debe crear su propio cliente.
   ============================================ */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://ydqwkxpkjwydxownwapv.supabase.co';

/* Clave anónima: pública por diseño.
   La seguridad real la impone Row Level Security en PostgreSQL. */
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlkcXdreHBrand5ZHhvd253YXB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzY4ODQsImV4cCI6MjA5OTgxMjg4NH0.QWuQaipGukrMipJ1Z3TmP3t66ggsHzb1Fe-QROJiXrw';

/* El cliente se guarda fuera del módulo.

   Un módulo cargado con dos rutas distintas —por ejemplo
   './supabase.js?v=8' y './supabase.js?v=9' mientras se
   actualizan los archivos— es, para el navegador, dos módulos
   separados: se ejecuta dos veces y nacen dos clientes de
   autenticación sobre la misma clave de almacenamiento.
   Supabase avisa de ello y el comportamiento pasa a ser
   impredecible al refrescar el token.

   Anclarlo al ámbito global lo vuelve único de verdad, sin
   depender de que todos los archivos estén sincronizados. */
const CLAVE = '__nexus_supabase__';

export const supabase = globalThis[CLAVE] ??= createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
      /* No se toca storageKey: cambiarlo cerraría la sesión de
         todo el mundo, porque las que hay guardadas viven bajo
         la clave que Supabase asigna por defecto. */
    }
  }
);

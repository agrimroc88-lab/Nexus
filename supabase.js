/* ============================================
   NEXUS · supabase.js
   Cliente único de conexión.
   ARCHIVO COMPARTIDO — punto único de conexión.
   Ningún módulo debe crear su propio cliente.
   ============================================ */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ydqwkxpkjwydxownwapv.supabase.co';

/* Clave anónima: pública por diseño.
   La seguridad real la impone Row Level Security en PostgreSQL. */
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlkcXdreHBrand5ZHhvd253YXB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMzY4ODQsImV4cCI6MjA5OTgxMjg4NH0.QWuQaipGukrMipJ1Z3TmP3t66ggsHzb1Fe-QROJiXrw';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

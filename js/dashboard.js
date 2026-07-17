/* ============================================
   NEXUS · dashboard.js
   Lógica exclusiva de dashboard.html
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina } from './auth.js';
import { montarNavegacion } from './nav.js';

iniciar();

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  montarNavegacion(perfil, 'dashboard');
  cargarIndicadores();
}

/* --- Datos --- */

async function cargarIndicadores() {
  const tablas = [
    { tabla: 'empresas',   destino: 'kpi-empresas' },
    { tabla: 'sucursales', destino: 'kpi-sucursales' },
    { tabla: 'areas',      destino: 'kpi-areas' },
    { tabla: 'cargos',     destino: 'kpi-cargos' }
  ];

  for (const item of tablas) {
    const { count, error } = await supabase
      .from(item.tabla)
      .select('*', { count: 'exact', head: true })
      .eq('activo', true);

    const $destino = document.getElementById(item.destino);
    if ($destino) $destino.textContent = error ? '—' : (count ?? 0);
  }
}

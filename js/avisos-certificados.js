/* ============================================
   NEXUS · avisos-certificados.js
   Notificación a pantalla completa en el inicio.

   Muestra un overlay grande cuando hay trabajadores
   cuyo fin de reposo o fin de rotación cae dentro de
   la ventana de aviso configurada. Se cierra manual y
   se recuerda por sesión para no repetir en cada carga.

   Se llama desde dashboard.js con una sola línea:
     import { mostrarAvisosCertificados } from './avisos-certificados.js';
     await mostrarAvisosCertificados();
   ============================================ */

import { supabase } from './supabase.js';
import { escapar } from './utils.js';

const MESES = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
               'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function fmt(fecha) {
  if (!fecha) return '—';
  const d = new Date(fecha + 'T00:00');
  return `${d.getDate()} ${MESES[d.getMonth() + 1]} ${d.getFullYear()}`;
}

export async function mostrarAvisosCertificados() {
  // No repetir dentro de la misma sesión del navegador
  if (sessionStorage.getItem('nexus_avisos_cert_vistos') === '1') return;

  const { data, error } = await supabase
    .from('v_avisos_certificados')
    .select('*')
    .order('dias_restantes', { ascending: true });

  if (error || !data || data.length === 0) return;

  // Solo los que están dentro del primer o segundo umbral configurado.
  // La vista ya filtró por el aviso mayor (d1); aquí destacamos urgencia.
  const avisos = data;
  if (avisos.length === 0) return;

  inyectar(avisos);
}

function inyectar(avisos) {
  // Evitar duplicado si ya existe
  if (document.getElementById('overlay-avisos-cert')) return;

  const overlay = document.createElement('div');
  overlay.id = 'overlay-avisos-cert';
  overlay.className = 'avisos-overlay';

  const filas = avisos.map((a) => {
    const urgente = a.dias_restantes <= (a.d2 ?? 3);
    const tipo = a.tipo_aviso === 'reposo' ? 'Fin de reposo' : 'Fin de rotación';
    const accion = a.tipo_aviso === 'reposo'
      ? 'Gestionar nueva consulta médica'
      : 'Gestionar reintegro al puesto';
    const cuando = a.dias_restantes === 0
      ? 'hoy'
      : a.dias_restantes === 1 ? 'mañana' : `en ${a.dias_restantes} días`;

    return `
      <div class="aviso-fila ${urgente ? 'aviso-urgente' : ''}">
        <div class="aviso-dias">
          <span class="aviso-numero">${a.dias_restantes}</span>
          <span class="aviso-dias-txt">día${a.dias_restantes === 1 ? '' : 's'}</span>
        </div>
        <div class="aviso-info">
          <span class="aviso-nombre">${escapar(a.nombre_completo)}</span>
          <span class="aviso-meta">Cód. ${a.codigo_trabajador}${a.cargo ? ' · ' + escapar(a.cargo) : ''}${a.area ? ' · ' + escapar(a.area) : ''}</span>
          <span class="aviso-tipo">${tipo}: ${fmt(a.fecha_fin)} (${cuando})</span>
          <span class="aviso-accion">${accion}</span>
        </div>
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="avisos-caja" role="dialog" aria-modal="true" aria-labelledby="avisos-titulo">
      <div class="avisos-cabecera">
        <span class="avisos-icono">🔔</span>
        <h2 class="avisos-titulo" id="avisos-titulo">Gestión de reposos y reubicaciones</h2>
      </div>
      <p class="avisos-sub">${avisos.length} trabajador${avisos.length === 1 ? '' : 'es'} requiere${avisos.length === 1 ? '' : 'n'} gestión próxima. Revise y agende lo que corresponda.</p>
      <div class="avisos-lista">${filas}</div>
      <div class="avisos-pie">
        <a class="boton-primario" href="certificados.html">Ir a Certificados</a>
        <button class="boton-secundario" id="btn-cerrar-avisos" type="button">Entendido</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  inyectarEstilos();

  document.getElementById('btn-cerrar-avisos').addEventListener('click', () => {
    sessionStorage.setItem('nexus_avisos_cert_vistos', '1');
    overlay.remove();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      sessionStorage.setItem('nexus_avisos_cert_vistos', '1');
      overlay.remove();
    }
  });
}

/* Estilos inyectados una vez (módulo autónomo, sin depender de CSS externo) */
function inyectarEstilos() {
  if (document.getElementById('avisos-cert-estilos')) return;
  const s = document.createElement('style');
  s.id = 'avisos-cert-estilos';
  s.textContent = `
    .avisos-overlay {
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(15, 23, 42, 0.75);
      display: flex; align-items: center; justify-content: center;
      padding: 1.5rem; backdrop-filter: blur(3px);
      animation: avisos-aparece 0.2s ease;
    }
    @keyframes avisos-aparece { from { opacity: 0; } to { opacity: 1; } }
    .avisos-caja {
      background: #fff; border-radius: 16px;
      max-width: 640px; width: 100%; max-height: 88vh; overflow-y: auto;
      box-shadow: 0 24px 60px rgba(0,0,0,0.4);
      padding: 1.75rem;
      border-top: 6px solid #e0a020;
    }
    .avisos-cabecera { display: flex; align-items: center; gap: 0.75rem; }
    .avisos-icono { font-size: 2rem; }
    .avisos-titulo { margin: 0; font-size: 1.5rem; color: #1e293b; }
    .avisos-sub { color: #64748b; margin: 0.5rem 0 1.25rem; font-size: 1rem; }
    .avisos-lista { display: flex; flex-direction: column; gap: 0.75rem; }
    .aviso-fila {
      display: flex; align-items: center; gap: 1rem;
      border: 1px solid #e2e8f0; border-radius: 12px; padding: 0.9rem 1rem;
      border-left: 5px solid #94a3b8;
    }
    .aviso-fila.aviso-urgente { border-left-color: #dc2626; background: #fef5f5; }
    .aviso-dias {
      display: flex; flex-direction: column; align-items: center;
      min-width: 60px; padding: 0.4rem; border-radius: 10px;
      background: #f1f5f9;
    }
    .aviso-urgente .aviso-dias { background: #fee2e2; }
    .aviso-numero { font-size: 1.7rem; font-weight: 700; line-height: 1; color: #1e293b; }
    .aviso-urgente .aviso-numero { color: #dc2626; }
    .aviso-dias-txt { font-size: 0.7rem; color: #64748b; text-transform: uppercase; }
    .aviso-info { display: flex; flex-direction: column; gap: 0.15rem; }
    .aviso-nombre { font-weight: 700; font-size: 1.05rem; color: #1e293b; }
    .aviso-meta { font-size: 0.8rem; color: #64748b; }
    .aviso-tipo { font-size: 0.9rem; color: #334155; margin-top: 0.2rem; }
    .aviso-accion { font-size: 0.85rem; font-weight: 600; color: #b45309; }
    .aviso-urgente .aviso-accion { color: #dc2626; }
    .avisos-pie {
      display: flex; justify-content: flex-end; gap: 0.75rem;
      margin-top: 1.5rem; flex-wrap: wrap;
    }
    .avisos-pie .boton-primario, .avisos-pie .boton-secundario {
      padding: 0.6rem 1.25rem; border-radius: 8px; font-size: 0.95rem;
      cursor: pointer; text-decoration: none; border: none; font-weight: 600;
    }
    .avisos-pie .boton-primario { background: #1f4e79; color: #fff; }
    .avisos-pie .boton-secundario { background: #e2e8f0; color: #334155; }
    @media (max-width: 520px) {
      .avisos-caja { padding: 1.25rem; }
      .avisos-titulo { font-size: 1.25rem; }
    }`;
  document.head.appendChild(s);
}

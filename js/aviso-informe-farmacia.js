/* ============================================
   NEXUS · aviso-informe-farmacia.js

   Recuerda hacer el informe mensual de farmacia.

   Por qué es un aviso dentro del sistema y no un correo:
     NEXUS es HTML estático en GitHub Pages. No hay servidor
     que despierte el día 1 y mande un mensaje; para eso harían
     falta una tarea programada y un proveedor de correo, que
     cuestan. Pero el equipo abre el sistema todos los días,
     así que un aviso en el inicio se ve igual de bien y no
     depende de nadie.

   Por qué no avisa ANTES de que el mes cierre:
     Porque el informe no se puede hacer antes. El 28 todavía
     faltan movimientos por registrar. Un aviso que nadie puede
     atender enseña a ignorar los avisos, y entonces tampoco se
     atienden los que sí importan.

   Tres momentos, tres mensajes:

     Tres días antes del cierre · «prepárese»
       No sirve para hacer el informe —el mes no ha cerrado—
       sino para poner el kardex al día. Si las salidas de los
       últimos días están registradas, el día 1 el informe sale
       de un clic y cuadrado; si no, aparece el descuadre y hay
       que ir a buscar papeles.

     El último día del mes · «cierra mañana»

     Del día 1 en adelante · «falta el informe»
       Sube de tono conforme pasan los días. No hay día
       obligatorio, de modo que el 1 de enero —feriado— se
       resuelve solo: quien vuelva el 2 se encuentra el aviso.

   A quién:
     Solo a quien puede hacer el informe. Al de trabajo social
     no le sirve de nada, y avisar a quien no puede actuar
     enseña a cerrar avisos sin leerlos —y entonces tampoco se
     leen los que sí importan.

   Se llama desde dashboard.js con una línea:
     import { avisarInformeFarmacia } from './aviso-informe-farmacia.js';
     avisarInformeFarmacia(perfil);
   ============================================ */

import { supabase } from './supabase.js?v=11';
import { empresasPermitidas, puedeGestionarFarmacia } from './auth.js?v=11';
import { escapar } from './utils.js?v=11';

const VERSION = 'v2';
console.info('NEXUS · aviso-informe-farmacia', VERSION);

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/* Cuántos días de gracia antes de subir el tono. Los primeros
   días del mes suelen ser de cierre y hay otras cosas que
   entregar; a partir de ahí, el retraso empieza a notarse. */
const DIAS_ADVERTENCIA = 8;

/**
 * Muestra el aviso si falta el informe del mes cerrado.
 * @param {object} perfil  sesión activa
 */
export async function avisarInformeFarmacia(perfil) {
  if (!perfil) return;
  if (!puedeGestionarFarmacia(perfil.rol)) return;

  /* Una vez por sesión del navegador. Repetirlo en cada carga
     convierte el aviso en un estorbo que se cierra sin leer. */
  if (sessionStorage.getItem('nexus_aviso_informe') === '1') return;

  const hoy = new Date();
  const dia = hoy.getDate();

  /* Día 0 del mes siguiente = último del actual. Así funciona
     con meses de 28, 30 y 31 sin listas de excepciones. */
  const ultimoDia = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  const faltanParaCierre = ultimoDia - dia;

  /* --- Antes del cierre: preparar, no informar --- */
  if (faltanParaCierre >= 0 && faltanParaCierre <= 3) {
    const mesActual = `${MESES[hoy.getMonth()]} de ${hoy.getFullYear()}`;
    pintarPrevio(faltanParaCierre, mesActual);
    return;
  }

  /* --- Después del cierre: el informe del mes anterior --- */
  const cierre = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const periodo = `${cierre.getFullYear()}-`
                + `${String(cierre.getMonth() + 1).padStart(2, '0')}-01`;
  const nombreMes = `${MESES[cierre.getMonth()]} de ${cierre.getFullYear()}`;

  let empresas;
  try {
    empresas = await empresasPermitidas(perfil);
  } catch {
    return;
  }
  if (!empresas || empresas.length === 0) return;

  const { data, error } = await supabase
    .from('v_informes_farmacia')
    .select('empresa_id')
    .eq('periodo', periodo)
    .in('empresa_id', empresas.map((e) => e.id));

  /* Sin la tabla —el SQL 040 sin ejecutar— no se avisa de
     nada. Un aviso que sale por un error de instalación es
     ruido, no información. */
  if (error) return;

  const hechos = new Set((data || []).map((r) => r.empresa_id));
  const faltan = empresas.filter((e) => !hechos.has(e.id));

  if (faltan.length === 0) return;

  pintar(faltan, nombreMes, dia);
}

/* ============================================
   Aviso previo al cierre

   No lleva a farmacia a hacer el informe —todavía no se
   puede— sino al kardex, que es lo único accionable en estos
   días. Un aviso cuyo botón no hace nada útil es un aviso que
   se cierra sin leer.
   ============================================ */

function pintarPrevio(faltanDias, mesActual) {
  const cuando = faltanDias === 0 ? 'hoy'
    : faltanDias === 1 ? 'mañana'
    : `en ${faltanDias} días`;

  const caja = document.createElement('div');
  caja.className = 'aif-fondo';
  caja.innerHTML = `
    <div class="aif-caja aif-previo" role="dialog" aria-modal="true">
      <p class="aif-etiqueta">Aviso</p>

      <h2 class="aif-titulo">
        ${escapar(mesActual.charAt(0).toUpperCase() + mesActual.slice(1))}
        cierra ${cuando}
      </h2>

      <p class="aif-texto">
        Revise que el kardex esté al día: ingresos anotados y salidas
        registradas. Con eso, el informe del mes sale de un clic y cuadrado.
        Si quedan movimientos sin registrar, el día 1 aparece el descuadre y
        hay que ir a buscar papeles.
      </p>

      <p class="aif-texto aif-tenue">
        El informe se genera desde el día 1, cuando el mes ya cerró.
      </p>

      <div class="aif-pie">
        <button class="aif-boton-secundario" type="button" data-cerrar>Entendido</button>
        <a class="aif-boton" href="farmacia.html">Revisar kardex</a>
      </div>
    </div>`;

  const cerrar = () => {
    sessionStorage.setItem('nexus_aviso_informe', '1');
    caja.remove();
  };

  caja.querySelector('[data-cerrar]').addEventListener('click', cerrar);
  caja.addEventListener('click', (e) => { if (e.target === caja) cerrar(); });
  caja.querySelector('.aif-boton').addEventListener('click', () => {
    sessionStorage.setItem('nexus_aviso_informe', '1');
  });

  document.body.appendChild(caja);
  estilos();
}

function pintar(faltan, nombreMes, diaDelMes) {
  const urgente = diaDelMes >= DIAS_ADVERTENCIA;

  const overlay = document.createElement('div');
  overlay.className = 'aif-fondo';

  const lista = faltan.map((e) =>
    `<li>${escapar(e.nombre || 'Empresa sin nombre')}</li>`).join('');

  overlay.innerHTML = `
    <div class="aif-caja ${urgente ? 'aif-urgente' : ''}" role="dialog" aria-modal="true">
      <p class="aif-etiqueta">${urgente ? 'Pendiente' : 'Recordatorio'}</p>

      <h2 class="aif-titulo">
        Falta el informe de farmacia de ${escapar(nombreMes)}
      </h2>

      <p class="aif-texto">
        ${urgente
          ? `Van ${diaDelMes} días del mes y todavía no se ha guardado.`
          : 'El mes ya cerró, así que las cifras están completas y el informe '
            + 'se puede generar.'}
      </p>

      <p class="aif-sub">
        ${faltan.length === 1 ? 'Empresa pendiente:' : 'Empresas pendientes:'}
      </p>
      <ul class="aif-lista">${lista}</ul>

      <div class="aif-pie">
        <button class="aif-boton-secundario" type="button" data-cerrar>
          Ahora no
        </button>
        <a class="aif-boton" href="farmacia.html">Ir a farmacia</a>
      </div>
    </div>`;

  const cerrar = () => {
    sessionStorage.setItem('nexus_aviso_informe', '1');
    overlay.remove();
  };

  overlay.querySelector('[data-cerrar]').addEventListener('click', cerrar);

  /* Al pulsar fuera también se cierra, pero solo fuera de la
     caja: si no, un clic dentro del texto lo haría desaparecer
     a media lectura. */
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrar(); });

  /* «Ir a farmacia» también marca el aviso como visto: si no,
     al volver al inicio reaparecería aunque ya haya ido. */
  overlay.querySelector('.aif-boton').addEventListener('click', () => {
    sessionStorage.setItem('nexus_aviso_informe', '1');
  });

  document.body.appendChild(overlay);
  estilos();
}

/* Los estilos van aquí y no en un .css para que el aviso sea
   un solo archivo: se puede añadir o quitar de una página sin
   tocar nada más. Es el mismo criterio de avisos-certificados. */
function estilos() {
  if (document.getElementById('aif-estilos')) return;

  const s = document.createElement('style');
  s.id = 'aif-estilos';
  s.textContent = `
    .aif-fondo {
      position: fixed;
      inset: 0;
      z-index: 900;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      background: rgba(0, 0, 0, 0.55);
    }
    .aif-caja {
      width: 100%;
      max-width: 30rem;
      padding: 1.6rem;
      background: var(--color-superficie, #161b22);
      border: 1px solid var(--color-borde, #30363d);
      border-top: 3px solid #2f81f7;
      border-radius: var(--radio, 10px);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
    }
    .aif-caja.aif-urgente { border-top-color: #f5d76e; }

    /* El previo es gris: no hay nada que corregir todavia,
       solo algo que conviene tener listo. Reservar el color
       para lo que sí exige accion mantiene su significado. */
    .aif-caja.aif-previo { border-top-color: #8b949e; }
    .aif-previo .aif-etiqueta { color: #8b949e; }
    .aif-tenue { font-size: 0.84rem !important; opacity: 0.8; }

    .aif-etiqueta {
      margin: 0 0 0.35rem;
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 1px;
      color: #2f81f7;
      text-transform: uppercase;
    }
    .aif-urgente .aif-etiqueta { color: #f5d76e; }

    .aif-titulo {
      margin: 0 0 0.6rem;
      font-size: 1.15rem;
      line-height: 1.35;
      color: var(--color-texto, #e6edf3);
    }
    .aif-texto, .aif-sub {
      margin: 0 0 0.5rem;
      font-size: 0.9rem;
      line-height: 1.55;
      color: var(--color-texto-tenue, #8b949e);
    }
    .aif-sub { margin-top: 0.9rem; }

    .aif-lista {
      margin: 0;
      padding-left: 1.1rem;
      font-size: 0.9rem;
      color: var(--color-texto, #e6edf3);
    }
    .aif-lista li { margin-bottom: 0.2rem; }

    .aif-pie {
      display: flex;
      gap: 0.6rem;
      justify-content: flex-end;
      margin-top: 1.4rem;
    }
    .aif-boton, .aif-boton-secundario {
      padding: 0.55rem 1.1rem;
      font-size: 0.88rem;
      font-weight: 500;
      cursor: pointer;
      border-radius: var(--radio, 8px);
    }
    .aif-boton {
      color: #fff;
      text-decoration: none;
      background: #2f81f7;
      border: 1px solid #2f81f7;
    }
    .aif-boton-secundario {
      color: var(--color-texto-tenue, #8b949e);
      background: transparent;
      border: 1px solid var(--color-borde, #30363d);
    }
    .aif-boton-secundario:hover { color: var(--color-texto, #e6edf3); }
  `;
  document.head.appendChild(s);
}

/* ============================================
   NEXUS · membrete.js
   Encabezado estándar para documentos impresos.
   ARCHIVO COMPARTIDO — todos los módulos lo usan.
   ============================================ */

import { escapar } from './utils.js';

/* Devuelve el HTML del membrete (logo + empresa + unidad) con un título.
   - empresaNombre: nombre de la empresa (ej. "AGRIMROC S.A.")
   - titulo: título del documento (ej. "CERTIFICADO MÉDICO")
*/
export function membreteHTML(empresaNombre, titulo) {
  return `
    <div class="membrete">
      <img src="logo.png" class="membrete-logo" alt="">
      <div class="membrete-datos">
        <strong>${escapar(empresaNombre || 'AGRIMROC S.A.')}</strong>
        <span>Unidad de Seguridad y Salud Ocupacional</span>
      </div>
    </div>
    ${titulo ? `<h1 class="membrete-titulo">${escapar(titulo)}</h1>` : ''}`;
}

/* CSS del membrete, para inyectar donde se necesite (o usar el de cada CSS). */
export const MEMBRETE_CSS = `
  .membrete { display: flex; align-items: center; gap: 1rem;
    border-bottom: 2px solid #1b5e20; padding-bottom: 0.7rem; margin-bottom: 1rem; }
  .membrete-logo { height: 65px; width: auto; }
  .membrete-datos { display: flex; flex-direction: column; }
  .membrete-datos strong { font-size: 13pt; color: #1b5e20; }
  .membrete-datos span { font-size: 10pt; color: #333; }
  .membrete-titulo { text-align: center; font-size: 14pt; text-transform: uppercase;
    margin: 0.5rem 0 1.2rem; color: #000; }
`;

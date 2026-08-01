/* ============================================
   NEXUS · documento.js

   Genera documentos que Word abre y respeta.

   Por qué no se imprime directo:
     Los informes llevan evidencia fotográfica y las fotos
     salen del celular de quien inspecciona. Subirlas al
     sistema exigiría almacenamiento, permisos y control de
     tamaño; descargar el documento con el recuadro ya
     maquetado resuelve lo mismo sin nada de eso: se abre en
     Word, se pega la foto en su sitio y se imprime.

   Cómo funciona:
     Word abre HTML si viene con las cabeceras de Office y se
     entrega como .doc. No es OOXML, pero conserva tablas,
     márgenes, tipografías y saltos de página, que es lo que
     hace falta. Y a diferencia de un .docx armado a mano, no
     necesita ninguna librería externa.
   ============================================ */

/* Milímetros a puntos, que es la unidad que entiende Word */
const MM = 2.83465;

/**
 * Envuelve el cuerpo en un documento que Word reconoce.
 *
 * @param {string} cuerpo   HTML del documento
 * @param {string} titulo   título interno del archivo
 * @param {object} opciones margenes en mm
 */
export function envolverWord(cuerpo, titulo, opciones = {}) {
  const m = Object.assign(
    { superior: 20, inferior: 20, izquierdo: 25, derecho: 20 },
    opciones
  );

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="utf-8">
  <title>${escaparTexto(titulo)}</title>
  <!--[if gte mso 9]><xml>
    <w:WordDocument>
      <w:View>Print</w:View>
      <w:Zoom>100</w:Zoom>
      <w:DoNotOptimizeForBrowser/>
    </w:WordDocument>
  </xml><![endif]-->
  <style>
    @page {
      size: 21cm 29.7cm;
      margin: ${m.superior}mm ${m.derecho}mm ${m.inferior}mm ${m.izquierdo}mm;
      mso-page-orientation: portrait;
    }
    body {
      font-family: 'Times New Roman', serif;
      font-size: 11pt;
      color: #000;
      line-height: 1.35;
    }
    table { border-collapse: collapse; }
    .salto { page-break-before: always; }
    .no-partir { page-break-inside: avoid; }
  </style>
</head>
<body>
${cuerpo}
</body>
</html>`;
}

/**
 * Descarga el documento. El nombre lleva el periodo para que
 * la carpeta se ordene sola por mes.
 */
export function descargarWord(html, nombreArchivo) {
  const blob = new Blob(['\ufeff', html], {
    type: 'application/msword;charset=utf-8'
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo.replace(/[\\/:*?"<>|]/g, '-') + '.doc';
  document.body.appendChild(a);
  a.click();
  a.remove();

  /* Liberar tarde: en Safari revocar de inmediato cancela la
     descarga antes de que empiece. */
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Recuadro donde se pega una fotografía.
 * Va como tabla de una celda porque Word la trata como un
 * contenedor de tamaño fijo: la imagen pegada dentro se
 * ajusta sola y no desplaza el resto del documento.
 *
 * @param {string} pie    rótulo bajo el recuadro
 * @param {number} altoMm alto del hueco
 */
export function recuadroFoto(pie, altoMm = 75) {
  return `
    <table style="width:100%;margin:6pt 0 4pt;" class="no-partir">
      <tr>
        <td style="height:${Math.round(altoMm * MM)}pt;
                   border:1pt dashed #999;
                   text-align:center;
                   vertical-align:middle;
                   color:#999;
                   font-size:9pt;">
          Pegue aquí la fotografía
        </td>
      </tr>
      <tr>
        <td style="text-align:center;font-size:9pt;font-weight:bold;
                   padding-top:3pt;">
          ${escaparTexto(pie)}
        </td>
      </tr>
    </table>`;
}

/**
 * Bloque de firma con espacio real para trazarla.
 *
 * En Word no se puede medir la página antes de imprimir, así
 * que el espacio va fijo. Cinco centímetros es lo acordado
 * para que la rúbrica quepa sin apretarse.
 *
 * @param {Array} columnas [{ rotulo, nombre, detalle }]
 */
export function bloqueFirmas(columnas, espacioMm = 50) {
  const ancho = Math.floor(100 / columnas.length);

  return `
    <div style="height:${Math.round(espacioMm * MM)}pt;">&nbsp;</div>
    <table style="width:100%;" class="no-partir">
      <tr>
        ${columnas.map((c) => `
          <td style="width:${ancho}%;text-align:center;vertical-align:top;
                     padding:0 8pt;">
            <div style="border-top:1pt solid #000;padding-top:4pt;">
              ${c.rotulo
                ? `<div style="font-size:10pt;">${escaparTexto(c.rotulo)}</div>` : ''}
              ${c.nombre
                ? `<div style="font-size:11pt;font-weight:bold;">${escaparTexto(c.nombre)}</div>`
                : '<div style="font-size:11pt;">&nbsp;</div>'}
              ${c.detalle
                ? `<div style="font-size:9pt;">${escaparTexto(c.detalle)}</div>` : ''}
            </div>
          </td>`).join('')}
      </tr>
    </table>`;
}

/** Encabezado con logo y membrete de la unidad */
export function membreteWord(empresa, logoDataUrl) {
  return `
    <table style="width:100%;border-bottom:2pt solid #1b5e20;
                  padding-bottom:6pt;margin-bottom:10pt;">
      <tr>
        ${logoDataUrl
          ? `<td style="width:90pt;vertical-align:middle;">
               <img src="${logoDataUrl}" style="height:58pt;">
             </td>` : ''}
        <td style="vertical-align:middle;">
          <div style="font-size:14pt;font-weight:bold;color:#1b5e20;">
            ${escaparTexto(empresa || 'Empresa')}
          </div>
          <div style="font-size:9pt;letter-spacing:0.5pt;">
            DEPARTAMENTO DE SEGURIDAD Y SALUD OCUPACIONAL
          </div>
        </td>
      </tr>
    </table>`;
}

/**
 * El logo debe viajar dentro del archivo: una ruta relativa
 * se rompe en cuanto el documento sale de la carpeta de la
 * aplicación, y estos documentos se envían por correo.
 */
export async function logoEnBase64(ruta = 'logo.png') {
  try {
    const r = await fetch(ruta);
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise((resolver) => {
      const lector = new FileReader();
      lector.onloadend = () => resolver(lector.result);
      lector.onerror = () => resolver(null);
      lector.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Bloque DE / PARA / C.C. / FECHA / ASUNTO */
export function encabezadoMemo(campos) {
  return `
    <table style="width:100%;margin-bottom:10pt;">
      ${campos.filter((c) => c).map((c) => `
        <tr>
          <td style="width:70pt;vertical-align:top;font-weight:bold;
                     padding:2pt 0;font-size:11pt;">
            ${escaparTexto(c.etiqueta)}
          </td>
          <td style="vertical-align:top;padding:2pt 0;font-size:11pt;">
            ${escaparTexto(c.valor)}
            ${c.detalle
              ? `<div style="font-size:10pt;">${escaparTexto(c.detalle)}</div>` : ''}
          </td>
        </tr>`).join('')}
    </table>`;
}

function escaparTexto(t) {
  return String(t ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export { escaparTexto };

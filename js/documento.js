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

/* Paleta de documentos.
   No se usan variables CSS: Word no resuelve var() al abrir
   un HTML, y el documento saldría sin color. Los valores
   duplican los de css/documentos.css a propósito; si allí
   cambian, aquí también. */
const PALETA = {
  verde:      '#1b5e20',
  verdeClaro: '#e6f0e6',
  verdeTenue: '#f2f7f2',
  borde:      '#555555',
  textoSuave: '#444444',
  textoTenue: '#555555'
};

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
      font-size: 12pt;
      color: #000;
      line-height: 1.4;
    }
    td, th { font-size: 11pt; }
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
                   font-size:10pt;">
          Pegue aquí la fotografía
        </td>
      </tr>
      <tr>
        <td style="text-align:center;font-size:10.5pt;font-weight:bold;
                   padding-top:4pt;">
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

  /* El hueco va como celda de tabla, no como div: Word colapsa
     la altura de un div al alto de su línea y las firmas
     terminaban pegadas al último renglón. Una celda sí
     conserva la medida. */
  const espaciador = espacioMm > 0
    ? `<table style="width:100%;"><tr>
         <td style="height:${Math.round(espacioMm * MM)}pt;
                    line-height:${Math.round(espacioMm * MM)}pt;
                    font-size:1pt;">&nbsp;</td>
       </tr></table>`
    : '';

  return `
    ${espaciador}
    <table style="width:100%;" class="no-partir" data-firmas>
      <tr>
        ${columnas.map((c) => `
          <td style="width:${ancho}%;text-align:center;vertical-align:top;
                     padding:0 8pt;">
            <div style="border-top:1pt solid #000;padding-top:4pt;">
              ${c.rotulo
                ? `<div style="font-size:11pt;">${escaparTexto(c.rotulo)}</div>` : ''}
              ${c.nombre
                ? `<div style="font-size:12pt;font-weight:bold;">${escaparTexto(c.nombre)}</div>`
                : '<div style="font-size:12pt;">&nbsp;</div>'}
              ${c.detalle
                ? `<div style="font-size:10pt;">${escaparTexto(c.detalle)}</div>` : ''}
            </div>
          </td>`).join('')}
      </tr>
    </table>`;
}

/** Encabezado con logo y membrete de la unidad */
/**
 * Membrete con la paleta de la orden de compra de farmacia.
 *
 * @param {string} empresa
 * @param {string} logo  base64 para el .doc que se envía por
 *   correo, o ruta relativa cuando el documento se imprime
 *   desde la propia aplicación.
 */
export function membreteWord(empresa, logo) {
  return `
    <table style="width:100%;margin-bottom:4pt;">
      <tr>
        ${logo
          ? `<td style="width:46pt;vertical-align:middle;padding-right:10pt;">
               <img src="${logo}" style="height:34pt;">
             </td>` : ''}
        <td style="vertical-align:middle;">
          <div style="font-size:14pt;font-weight:bold;color:${PALETA.verde};">
            ${escaparTexto(empresa || 'Empresa')}
          </div>
          <div style="font-size:9.5pt;letter-spacing:0.5pt;color:#333;">
            DEPARTAMENTO DE SEGURIDAD Y SALUD OCUPACIONAL
          </div>
        </td>
      </tr>
    </table>
    <div style="border-bottom:2pt solid ${PALETA.verde};margin-bottom:10pt;"></div>`;
}

/**
 * Encabezado reducido para las páginas de continuación.
 *
 * Repetir el membrete completo en cada hoja de un informe de
 * once botiquines hace que el logo domine el documento y deje
 * poco sitio al contenido. Basta una franja que identifique
 * la empresa y diga de qué informe forma parte la página.
 */
export function membreteCompacto(empresa, logo, referencia) {
  return `
    <table style="width:100%;border-bottom:1pt solid ${PALETA.verde};
                  margin-bottom:8pt;padding-bottom:3pt;">
      <tr>
        ${logo
          ? `<td style="width:26pt;vertical-align:middle;padding-right:6pt;">
               <img src="${logo}" style="height:20pt;">
             </td>` : ''}
        <td style="vertical-align:middle;font-size:9.5pt;
                   font-weight:bold;color:${PALETA.verde};">
          ${escaparTexto(empresa || '')}
        </td>
        <td style="vertical-align:middle;text-align:right;
                   font-size:8.5pt;color:${PALETA.textoTenue};">
          ${escaparTexto(referencia || '')}
        </td>
      </tr>
    </table>`;
}

/**
 * Lista numerada o con viñetas para objetivos y normativa.
 * Word respeta mal las listas de HTML, así que se arma con
 * una tabla de dos columnas: la marca y el texto.
 */
export function listaDocumento(elementos, numerada = false) {
  return `
    <table style="width:100%;margin:4pt 0 10pt;">
      ${elementos.map((e, i) => `
        <tr>
          <td style="width:22pt;vertical-align:top;padding:2pt 0;
                     font-size:11pt;${numerada ? 'font-weight:bold;' : ''}">
            ${numerada ? (i + 1) + '.' : '•'}
          </td>
          <td style="vertical-align:top;padding:2pt 0;font-size:11pt;
                     text-align:justify;">
            ${typeof e === 'string' ? escaparTexto(e)
              : `<b>${escaparTexto(e.titulo)}</b>${
                  e.texto ? ' · ' + escaparTexto(e.texto) : ''}`}
          </td>
        </tr>`).join('')}
    </table>`;
}

/** Título de sección con la línea verde característica */
export function seccionDocumento(titulo) {
  return `
    <p style="font-size:12pt;font-weight:bold;color:${PALETA.verde};
              border-bottom:1pt solid ${PALETA.verde};
              margin:14pt 0 4pt;padding-bottom:2pt;">
      ${escaparTexto(titulo)}
    </p>`;
}

/**
 * Banda de título del documento.
 *
 * El fondo se declara con el atributo bgcolor además del CSS:
 * Word descarta background en la hoja de estilos al abrir un
 * HTML, y sin el atributo el documento sale en blanco y negro.
 */
export function bandaTitulo(titulo, subtitulo) {
  return `
    <table style="width:100%;margin-bottom:10pt;" bgcolor="${PALETA.verdeClaro}">
      <tr bgcolor="${PALETA.verdeClaro}">
        <td bgcolor="${PALETA.verdeClaro}"
            style="background:${PALETA.verdeClaro};border-top:0.75pt solid ${PALETA.verde};
                   border-bottom:0.75pt solid ${PALETA.verde};
                   padding:6pt 8pt;text-align:center;">
          <div style="font-size:13pt;font-weight:bold;letter-spacing:0.5pt;">
            ${escaparTexto(titulo)}
          </div>
          ${subtitulo
            ? `<div style="font-size:10.5pt;color:#333;padding-top:2pt;">${
                escaparTexto(subtitulo)}</div>` : ''}
        </td>
      </tr>
    </table>`;
}

/**
 * Tabla con encabezado coloreado.
 *
 * @param {Array} columnas [{ titulo, ancho, centrado }]
 * @param {Array} filas    array de arrays de celdas ya escapadas
 */
export function tablaWord(columnas, filas) {
  /* Comillas invertidas: con comillas simples la expresión
     viajaría literal al documento y el navegador
     descartaría el borde por inválido. */
  const borde = `border:1pt solid ${PALETA.borde};padding:4pt 6pt;font-size:11pt;`;

  const cabecera = columnas.map((c) => `
    <td bgcolor="${PALETA.verdeClaro}" width="${c.ancho}%"
        style="${borde}background:${PALETA.verdeClaro};font-weight:bold;font-size:10.5pt;
               text-align:${c.centrado ? 'center' : 'left'};">
      ${escaparTexto(c.titulo)}
    </td>`).join('');

  const cuerpo = filas.map((f) => `
    <tr>
      ${f.map((celda, i) => `
        <td style="${borde}text-align:${columnas[i]?.centrado ? 'center' : 'left'};
                   vertical-align:top;">${celda}</td>`).join('')}
    </tr>`).join('');

  return `
    <table style="width:100%;margin-bottom:10pt;border-collapse:collapse;
                  border:1.25pt solid ${PALETA.verde};" border="1"
           cellspacing="0" cellpadding="0">
      <tr bgcolor="${PALETA.verdeClaro}">${cabecera}</tr>
      ${cuerpo}
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
          <td style="width:80pt;vertical-align:top;font-weight:bold;
                     padding:3pt 0;font-size:12pt;">
            ${escaparTexto(c.etiqueta)}
          </td>
          <td style="vertical-align:top;padding:3pt 0;font-size:12pt;">
            ${escaparTexto(c.valor)}
            ${c.detalle
              ? `<div style="font-size:11pt;">${escaparTexto(c.detalle)}</div>` : ''}
          </td>
        </tr>`).join('')}
    </table>`;
}

function escaparTexto(t) {
  return String(t ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export { escaparTexto };

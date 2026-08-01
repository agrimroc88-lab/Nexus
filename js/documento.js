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
/* Escala tipográfica.
   El acta y el informe tienen exigencias opuestas: una se lee
   de pie mientras se firma y le sobra hoja; el otro debe caber
   en ocho páginas. En lugar de mantener dos plantillas que
   acabarían divergiendo, se multiplican los cuerpos de letra.

   Se fija justo antes de construir cada documento; la
   generación es síncrona, así que no hay riesgo de que dos
   documentos se pisen. */
let escala = 1;

export function fijarEscala(n) {
  escala = n && n > 0 ? n : 1;
}

/** Tamaño en puntos aplicando la escala vigente */
function pt(n) {
  return Math.round(n * escala * 10) / 10;
}

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
    { superior: 15, inferior: 15, izquierdo: 20, derecho: 15 },
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
      <!-- Sin esto Word añade un espacio automático detrás de
           cada párrafo y de cada celda al abrir un HTML. Con
           doscientas filas de tabla, ese margen invisible
           llegaba a duplicar la extensión del documento. -->
      <w:DontUseHTMLParagraphAutoSpacing/>
      <w:DoNotPromoteQF/>
      <w:Compatibility>
        <w:UseWord2002TableStyleRules/>
        <w:DontGrowAutofit/>
      </w:Compatibility>
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
      font-size: ${pt(10.5)}pt;
      color: #000;
      line-height: 1.2;
    }

    /* Word aplica su estilo Normal a todo lo que abre, con
       ocho puntos de separación bajo cada párrafo. Hay que
       neutralizarlo por nombre: la regla de body no le llega. */
    p.MsoNormal, li.MsoNormal, div.MsoNormal,
    p, td, th, div, li {
      margin-top: 0;
      margin-bottom: 0;
      mso-para-margin-top: 0;
      mso-para-margin-bottom: 0;
      mso-line-height-rule: exactly;
      line-height: 1.2;
    }

    p { margin: 3pt 0; mso-para-margin-top: 3.0pt; mso-para-margin-bottom: 3.0pt; }

    td, th {
      font-size: ${pt(9.5)}pt;
      mso-line-height-rule: exactly;
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
    <table style="width:100%;margin:3pt 0 2pt;" class="no-partir">
      <tr>
        <td style="height:${Math.round(altoMm * MM)}pt;
                   border:1pt dashed #999;
                   text-align:center;
                   vertical-align:middle;
                   color:#999;
                   font-size:8.5pt;">
          Pegue aquí la fotografía
        </td>
      </tr>
      <tr>
        <td style="text-align:center;font-size:8.5pt;font-weight:bold;
                   padding-top:2pt;">
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

  /* Espaciador y firmas viajan juntos dentro del mismo
     bloque: separados, Word podía dejar el hueco al final de
     una hoja y las rayas solas en la siguiente. */
  return `
    <div class="no-partir">
    ${espaciador}
    <table style="width:100%;" data-firmas>
      <tr>
        ${columnas.map((c) => `
          <td style="width:${ancho}%;text-align:center;vertical-align:top;
                     padding:0 8pt;">
            <div style="border-top:1pt solid #000;padding-top:4pt;">
              ${c.rotulo
                ? `<div style="font-size:${pt(10)}pt;">${escaparTexto(c.rotulo)}</div>` : ''}
              ${c.nombre
                ? `<div style="font-size:${pt(11)}pt;font-weight:bold;">${escaparTexto(c.nombre)}</div>`
                : `<div style="font-size:${pt(11)}pt;">&nbsp;</div>`}
              ${c.detalle
                ? `<div style="font-size:${pt(9)}pt;">${escaparTexto(c.detalle)}</div>` : ''}
            </div>
          </td>`).join('')}
      </tr>
    </table>
    </div>`;
}

/** Encabezado con logo y membrete de la unidad */
/**
 * Membrete con la paleta de la orden de compra de farmacia.
 *
 * El alto de la imagen va como atributo HTML además de en el
 * estilo: Word descarta height cuando viene de CSS y muestra
 * la imagen a su tamaño original, que en un logotipo de
 * varios centenares de píxeles ocupa media hoja.
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
          ? `<td style="width:66pt;vertical-align:middle;padding-right:10pt;">
               <img src="${logo}" height="76" style="height:57pt;width:auto;">
             </td>` : ''}
        <td style="vertical-align:middle;">
          <div style="font-size:${pt(12.5)}pt;font-weight:bold;color:${PALETA.verde};">
            ${escaparTexto(empresa || 'Empresa')}
          </div>
          <div style="font-size:${pt(8.5)}pt;letter-spacing:0.5pt;color:#333;">
            DEPARTAMENTO DE SEGURIDAD Y SALUD OCUPACIONAL
          </div>
        </td>
      </tr>
    </table>
    <div style="border-bottom:1.5pt solid ${PALETA.verde};margin-bottom:6pt;"></div>`;
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
          ? `<td style="width:44pt;vertical-align:middle;padding-right:8pt;">
               <img src="${logo}" height="49" style="height:37pt;width:auto;">
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
    <table style="width:100%;margin:2pt 0 6pt;">
      ${elementos.map((e, i) => `
        <tr>
          <td style="width:16pt;vertical-align:top;padding:1pt 0;
                     font-size:${pt(9.5)}pt;${numerada ? 'font-weight:bold;' : ''}">
            ${numerada ? (i + 1) + '.' : '•'}
          </td>
          <td style="vertical-align:top;padding:1pt 0;font-size:${pt(9.5)}pt;
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
    <p style="font-size:${pt(10.5)}pt;font-weight:bold;color:${PALETA.verde};
              border-bottom:0.75pt solid ${PALETA.verde};
              margin:8pt 0 3pt;padding-bottom:1pt;">
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
    <table style="width:100%;margin-bottom:7pt;" bgcolor="${PALETA.verdeClaro}">
      <tr bgcolor="${PALETA.verdeClaro}">
        <td bgcolor="${PALETA.verdeClaro}"
            style="background:${PALETA.verdeClaro};border-top:0.75pt solid ${PALETA.verde};
                   border-bottom:0.75pt solid ${PALETA.verde};
                   padding:4pt 6pt;text-align:center;">
          <div style="font-size:${pt(11.5)}pt;font-weight:bold;letter-spacing:0.4pt;">
            ${escaparTexto(titulo)}
          </div>
          ${subtitulo
            ? `<div style="font-size:${pt(9.5)}pt;color:#333;padding-top:1pt;">${
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
  const borde = `border:0.75pt solid ${PALETA.borde};padding:${pt(2.5)}pt ${pt(4)}pt;font-size:${pt(9.5)}pt;`;

  const cabecera = columnas.map((c) => `
    <td bgcolor="${PALETA.verdeClaro}" width="${c.ancho}%"
        style="${borde}background:${PALETA.verdeClaro};font-weight:bold;font-size:${pt(9)}pt;
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
    <table style="width:100%;margin-bottom:6pt;border-collapse:collapse;
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
    <table style="width:100%;margin-bottom:7pt;">
      ${campos.filter((c) => c).map((c) => `
        <tr>
          <td style="width:66pt;vertical-align:top;font-weight:bold;
                     padding:${pt(1.5)}pt 0;font-size:${pt(10)}pt;">
            ${escaparTexto(c.etiqueta)}
          </td>
          <td style="vertical-align:top;padding:${pt(1.5)}pt 0;font-size:${pt(10)}pt;">
            ${escaparTexto(c.valor)}
            ${c.detalle
              ? `<div style="font-size:${pt(9)}pt;">${escaparTexto(c.detalle)}</div>` : ''}
          </td>
        </tr>`).join('')}
    </table>`;
}

function escaparTexto(t) {
  return String(t ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export { escaparTexto };

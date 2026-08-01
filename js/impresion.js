/* ============================================
   NEXUS · impresion.js

   Espacio de firma en los documentos impresos.

   El problema:
     Una firma necesita sitio. Con el margen fijo que traían
     las hojas quedaban dos centímetros escasos, y encima la
     rúbrica se traza SOBRE la línea, así que el hueco real
     era menor todavía. Firmar ahí obliga a apretar el trazo.

   Por qué no basta el CSS:
     margin-top: 5cm resuelve el espacio pero no sabe cuánta
     hoja queda. Si el documento termina a media página, las
     firmas saltan solas a una hoja nueva y queda una página
     suelta con dos rayas. Ningún selector puede consultar
     el espacio restante.

   Cómo se resuelve:
     Se mide el documento antes de llamar a print(). Si los
     5 cm caben, se aplican. Si no caben, el bloque se baja
     al pie de la página en curso: menos aire, pero sin hoja
     huérfana. Y si no cabe ni el mínimo, se deja saltar,
     que es lo único sensato.
   ============================================ */

/* Medidas de la hoja, en milímetros.
   Coinciden con @page { margin: 1.5cm } de las hojas. */
const HOJA = {
  alto:          297,   // A4
  margenSuperior: 15,
  margenInferior: 15
};

const ESPACIO_DESEADO = 50;   // 5 cm de blanco antes de la firma
const ESPACIO_MINIMO  = 12;   // por debajo de esto no vale la pena apretar

/* Bloques de firma de los distintos documentos */
const SELECTOR_FIRMAS = '.gp-firmas, .oc-firmas, .em-firmas, [data-firmas]';

/**
 * Cuántos píxeles mide un milímetro en este navegador.
 * Se pregunta al propio DOM en lugar de asumir 96 ppp:
 * el zoom del navegador y la densidad de pantalla cambian
 * la equivalencia.
 */
function pxPorMm() {
  const regla = document.createElement('div');
  regla.style.cssText = 'position:absolute;visibility:hidden;height:100mm;';
  document.body.appendChild(regla);
  const px = regla.offsetHeight / 100;
  regla.remove();
  return px || 3.78;   // 96 ppp como respaldo
}

/**
 * Ajusta el espacio sobre los bloques de firma de una hoja.
 *
 * @param {HTMLElement} $zona  contenedor de impresión
 */
export function ajustarFirmas($zona) {
  if (!$zona) return;

  const firmas = $zona.querySelectorAll(SELECTOR_FIRMAS);
  if (firmas.length === 0) return;

  /* La zona vive oculta hasta que se imprime, y lo oculto no
     tiene medidas. Se hace medible fuera de la vista, con el
     ancho real del papel, para que los saltos de línea
     coincidan con los de la hoja. */
  const estiloPrevio = $zona.getAttribute('style') || '';
  $zona.style.cssText =
    'display:block;position:absolute;left:-10000px;top:0;'
    + 'width:180mm;visibility:hidden;';

  const mm = pxPorMm();
  const alturaPagina = (HOJA.alto - HOJA.margenSuperior - HOJA.margenInferior) * mm;

  firmas.forEach((bloque) => {
    /* Se mide sin margen para conocer la posición real del
       contenido que lo precede. */
    bloque.style.marginTop = '0px';

    const inicio = bloque.offsetTop;
    const alto   = bloque.offsetHeight;

    /* Dónde cae ese punto dentro de su página */
    const usadoEnPagina = inicio % alturaPagina;
    const restante = alturaPagina - usadoEnPagina;

    const deseado = ESPACIO_DESEADO * mm;
    const minimo  = ESPACIO_MINIMO * mm;

    let margen;
    if (restante - alto >= deseado) {
      margen = deseado;                    // cabe holgado
    } else if (restante - alto >= minimo) {
      margen = restante - alto;            // al pie de esta página
    } else {
      margen = deseado;                    // no cabe: que salte con aire
    }

    bloque.style.marginTop = Math.round(margen) + 'px';
  });

  /* Devolver la zona a su estado original: el CSS de
     impresión se encarga de mostrarla. */
  $zona.setAttribute('style', estiloPrevio);
}

/**
 * Imprime una hoja ya inyectada en su contenedor.
 * Reúne lo que antes repetía cada módulo: ajustar firmas,
 * cambiar el título —el navegador lo estampa en el margen—,
 * imprimir y devolver todo a su sitio.
 *
 * @param {string} idZona    contenedor de impresión
 * @param {string} claseBody clase que oculta la aplicación
 * @param {string} titulo    rótulo del margen de la hoja
 */
export async function imprimirHoja(idZona, claseBody, titulo) {
  const $zona = document.getElementById(idZona);
  if (!$zona) return;

  ajustarFirmas($zona);

  /* Antes de imprimir hay que esperar a las imágenes. El
     navegador no las descarga hasta que el elemento entra en
     el documento, y print() no espera por ellas: si se llama
     de inmediato, la vista previa sale sin el logo y a veces
     aparece a medio dibujar. */
  await esperarImagenes($zona);

  const tituloPrevio = document.title;
  if (titulo) document.title = titulo;

  document.body.classList.add(claseBody);
  window.print();

  setTimeout(() => {
    document.body.classList.remove(claseBody);
    document.title = tituloPrevio;
  }, 500);
}

/**
 * Espera a que las imágenes de un contenedor estén listas.
 *
 * Nunca deja colgada la impresión: si alguna no carga —logo
 * ausente, red caída— se sigue adelante pasado el tiempo
 * límite. Un documento sin logo es mejor que un botón que no
 * responde.
 */
export function esperarImagenes($zona, msMaximo = 3000) {
  const imagenes = [...$zona.querySelectorAll('img')];
  if (imagenes.length === 0) return Promise.resolve();

  const cargadas = imagenes.map((img) => {
    if (img.complete && img.naturalHeight > 0) return Promise.resolve();
    return new Promise((listo) => {
      img.addEventListener('load', listo, { once: true });
      img.addEventListener('error', listo, { once: true });
    });
  });

  return Promise.race([
    Promise.all(cargadas),
    new Promise((listo) => setTimeout(listo, msMaximo))
  ]);
}

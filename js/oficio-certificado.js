/* ============================================
   NEXUS · oficio-certificado.js

   Genera el oficio de justificación que se venía escribiendo
   a mano en Word.

   ARCHIVO COMPARTIDO — lo usan dos módulos:
     · atenciones.js    emite el oficio al cerrar la consulta
     · certificados.js  reimprime uno ya registrado

   Por eso recibe todo por parámetro y no lee nada de la
   pantalla: si leyera campos por su identificador, cada
   módulo tendría que replicar los mismos nombres y el archivo
   se rompería en cuanto uno de los dos cambiara su
   formulario.

   Formato:
     A5 vertical, 148 x 210 mm, márgenes de 12,7 mm. Es
     exactamente la configuración del documento que se venía
     usando, medida sobre el archivo y no calculada a ojo.

     Se imprimen DOS por hoja A4 con línea de corte al medio.
     La plantilla de Word ponía un A5 centrado en una A4 y
     sobraba media hoja en cada oficio; así se gasta la mitad
     de papel y el corte queda marcado.
   ============================================ */

import { supabase } from './supabase.js';
import { escapar } from './utils.js?v=12';

const VERSION = 'v4';
console.info('NEXUS · oficio-certificado', VERSION);

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
               'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const of = {
  destinatarios: [],
  config: {},
  empresaNombre: ''
};

/* ============================================
   Carga
   ============================================ */

/** Lee destinatarios y datos de membrete. Una vez por página. */
export async function cargarDatosOficio(empresaId, empresaNombre) {
  of.empresaNombre = empresaNombre || '';
  if (!empresaId) return;

  const [dest, cfg] = await Promise.all([
    supabase.from('oficio_destinatarios').select('*')
      .eq('activo', true)
      .or(`empresa_id.is.null,empresa_id.eq.${empresaId}`)
      .order('orden'),
    supabase.from('config_certificados').select('*')
      .eq('empresa_id', empresaId).maybeSingle()
  ]);

  if (dest.error) {
    console.warn('NEXUS · oficios: falta ejecutar 043_oficios_certificados.sql');
    of.destinatarios = [];
  } else {
    of.destinatarios = dest.data || [];
  }

  of.config = cfg.data || {};
}

/** Los destinatarios cargados, para armar menús a medida. */
export function destinatariosLista() {
  return of.destinatarios;
}

export function hayDestinatarios() {
  return of.destinatarios.length > 0;
}

/** Llena un desplegable con los destinatarios disponibles. */
export function llenarDestinatarios(idSelect) {
  const $s = document.getElementById(idSelect);
  if (!$s) return;

  $s.innerHTML = '';

  if (of.destinatarios.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'No hay destinatarios configurados';
    $s.appendChild(o);
    return;
  }

  of.destinatarios.forEach((d) => {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = `${d.nombre} · ${d.cargo}`;
    $s.appendChild(o);
  });
}

export function destinatarioPorId(id) {
  return of.destinatarios.find((d) => d.id === id) || null;
}

export function mostrarCiePorDefecto() {
  return of.config.oficio_mostrar_cie !== false;
}

/* ============================================
   Fechas

   El oficio nombra los días, no un rango: «14 y 15 de julio
   de 2026 (DOS DÍAS)». Es como lo lee quien lo recibe y como
   se venía escribiendo a mano.
   ============================================ */

function fechaLarga(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00');
  return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
}

export function rangoDias(inicio, dias) {
  if (!inicio || !dias || dias < 1) return '';

  const d0 = new Date(inicio + 'T00:00');
  const fechas = [];
  for (let i = 0; i < dias; i++) {
    const d = new Date(d0);
    d.setDate(d.getDate() + i);
    fechas.push(d);
  }

  const cuantos = dias === 1 ? '(UN DÍA)'
    : dias === 2 ? '(DOS DÍAS)'
    : dias === 3 ? '(TRES DÍAS)'
    : `(${dias} DÍAS)`;

  const ultimo = fechas[fechas.length - 1];
  const mismoMes = fechas.every((d) =>
    d.getMonth() === fechas[0].getMonth() && d.getFullYear() === fechas[0].getFullYear());

  /* A caballo entre dos meses, cada fecha lleva el suyo: «30
     de junio, 1 y 2 de julio» se lee bien; «30, 1 y 2 de
     julio» no se entiende. */
  if (!mismoMes) {
    return fechas.map((d) => `${d.getDate()} de ${MESES[d.getMonth()]}`)
      .join(', ') + ` de ${ultimo.getFullYear()} ${cuantos}`;
  }

  const nums = fechas.map((d) => d.getDate());
  const lista = nums.length === 1 ? `${nums[0]}`
    : `${nums.slice(0, -1).join(', ')} y ${nums[nums.length - 1]}`;

  return `${lista} de ${MESES[ultimo.getMonth()]} de ${ultimo.getFullYear()} ${cuantos}`;
}

/* ============================================
   El documento
   ============================================ */

/* Encabezado con el logo.

   En el documento de Word vivía en la cabecera de página, que
   es una parte del archivo que no se lee al extraer el
   cuerpo; por eso faltaba. Va dentro de cada oficio y no como
   cabecera de la hoja A4, porque en la hoja caben dos y cada
   uno se corta por separado: una cabecera de página saldría
   una sola vez, en el de arriba. */
function encabezado() {
  return `
    <header class="of-membrete">
      <img src="logo.png" class="of-logo" alt="">
      <div class="of-membrete-texto">
        <span class="of-empresa">${escapar(of.empresaNombre || 'Empresa')}</span>
        <span class="of-unidad">Unidad de Seguridad y Salud Ocupacional</span>
      </div>
    </header>`;
}

function membrete(dest, firmante, fecha) {
  const ciudad = of.config.oficio_ciudad || 'San Antonio';
  return `
    ${encabezado()}
    <div class="of-cabecera">
      <p class="of-para"><b>PARA:</b> ${escapar(dest.nombre)} — ${escapar(dest.cargo)}</p>
      <p class="of-para"><b>DE:</b> ${escapar(firmante || '')} — UNIDAD MÉDICA</p>
      <p class="of-fecha">${escapar(ciudad)}, ${escapar(fechaLarga(fecha))}</p>
    </div>`;
}

function pie(firmante, cargoFirmante) {
  const unidad = of.config.oficio_unidad || 'SERVICIOS MÉDICOS DE EMPRESA';
  const tel = of.config.oficio_telefono || '';
  return `
    <div class="of-firma">
      <div class="of-firma-linea"></div>
      <p class="of-firma-nombre">${escapar(firmante || '')}</p>
      <p class="of-firma-cargo">${escapar(cargoFirmante || unidad)}</p>
      <p class="of-firma-cargo">SALUD OCUPACIONAL</p>
      ${tel ? `<p class="of-firma-tel">CEL: ${escapar(tel)}</p>` : ''}
    </div>`;
}

function textoDiagnostico(d) {
  const cie = d.mostrarCie && d.cie10 ? `${d.cie10} · ` : '';
  return cie + (d.diagnostico || '');
}

/**
 * Arma e imprime el oficio.
 *
 * @param {object}   d
 * @param {string}   d.clase         'justificacion' | 'restricciones'
 * @param {object}   d.destinatario  {nombre, cargo}
 * @param {object}   d.trabajador    {nombre_completo, cargo, codigo}
 * @param {string}   d.firmante      quien tiene la sesión abierta
 * @param {string}   d.cargoFirmante
 * @param {string}   d.fecha         emisión, ISO
 * @param {string}   d.diagnostico
 * @param {string}   d.cie10
 * @param {boolean}  d.mostrarCie
 * @param {string}   d.motivo
 * @param {string}   d.reposoInicio
 * @param {number}   d.reposoDias
 * @param {string}   d.rotacion      texto ya resuelto, o vacío
 * @param {string[]} d.restricciones
 * @param {string}   d.antecedente
 * @param {string}   d.valoracion
 * @returns {boolean} false si falta la zona de impresión
 */
export function imprimirOficio(d) {
  const $z = document.getElementById('oficio-impresion');
  if (!$z) {
    alert('Falta actualizar la página en el servidor para imprimir oficios.');
    return false;
  }

  const html = d.clase === 'restricciones' ? hojaRestricciones(d) : hojaJustificacion(d);

  /* Dos copias del MISMO oficio en la misma hoja: una para el
     archivo de la empresa, otra para el trabajador —en vez de
     dejar la segunda mitad en blanco, como antes. La segunda
     copia va envuelta aparte para poder darle su propio
     margen izquierdo, sin afectar a la primera. */
  $z.innerHTML = `<div class="of-a4">${html}<div class="of-corte"></div>`
               + `<div class="of-copia-derecha">${html}</div></div>`;

  const titulo = document.title;
  document.title = `Oficio · ${d.trabajador?.nombre_completo || ''}`;
  document.body.classList.add('imprimiendo-oficio');
  window.print();

  setTimeout(() => {
    document.body.classList.remove('imprimiendo-oficio');
    document.title = titulo;
  }, 500);

  return true;
}

function encabezadoTrabajador(d) {
  const t = d.trabajador || {};
  return `
    <p class="of-parrafo">
      Mediante el presente se informa que el
      <b>SR. ${escapar((t.nombre_completo || '').toUpperCase())}</b>,
      trabajador de ${escapar(of.empresaNombre || 'la empresa')},
      como ${escapar((t.cargo || '').toUpperCase())}${
        t.codigo != null && t.codigo !== ''
          ? ` cód. ${escapar(String(t.codigo))}` : ''}.
    </p>`;
}

function hojaJustificacion(d) {
  const pagados = rangoDias(d.reposoInicio, d.reposoDias);

  return `
    <section class="of-hoja">
      ${membrete(d.destinatario, d.firmante, d.fecha)}

      <p class="of-saludo">Estimado,</p>

      ${encabezadoTrabajador(d)}

      <p class="of-parrafo">
        Por medio de la presente, justifico la inasistencia del trabajador
        mencionado, ${escapar(d.motivo
          || 'el mismo que se encuentra en proceso de recuperación.')}
      </p>

      ${d.diagnostico ? `<p class="of-dato">
        <b>DIAGNÓSTICO:</b> ${escapar(textoDiagnostico(d))}
      </p>` : ''}

      ${pagados ? `<p class="of-dato">
        <b>JUSTIFICABLE DÍA PAGADO:</b> ${escapar(pagados)}
      </p>` : ''}

      <p class="of-dato">
        <b>ROTACIÓN DE ÁREA:</b> ${escapar(d.rotacion || 'AL MOMENTO NO AMERITA')}
      </p>

      <p class="of-cierre">Atentamente:</p>

      ${pie(d.firmante, d.cargoFirmante)}
    </section>`;
}

function hojaRestricciones(d) {
  const t = d.trabajador || {};
  const lineas = (d.restricciones || []).filter(Boolean);

  return `
    <section class="of-hoja">
      ${membrete(d.destinatario, d.firmante, d.fecha)}

      <p class="of-saludo">Estimado:</p>

      <p class="of-parrafo">
        Por medio de la presente se informa que el
        <b>Sr. ${escapar((t.nombre_completo || '').toUpperCase())}</b>,
        trabajador de ${escapar(of.empresaNombre || 'la empresa')}${
          t.codigo != null && t.codigo !== ''
            ? `, con el código ${escapar(String(t.codigo))}` : ''},
        presenta ${escapar(d.antecedente || textoDiagnostico(d)
          || 'la condición referida')}.
      </p>

      ${d.valoracion ? `<p class="of-parrafo">${escapar(d.valoracion)}</p>` : ''}

      ${lineas.length > 0 ? `
        <p class="of-parrafo">
          En concordancia con dichas recomendaciones, desde la Unidad de Salud
          Ocupacional se establecen las siguientes restricciones laborales
          temporales:
        </p>
        <ul class="of-lista">
          ${lineas.map((x) => `<li>${escapar(x)}</li>`).join('')}
        </ul>` : ''}

      <p class="of-parrafo">
        Las presentes recomendaciones tienen como finalidad favorecer el control
        de su condición y prevenir su agravamiento en el desempeño de sus
        funciones.
      </p>

      ${pie(d.firmante, d.cargoFirmante)}
    </section>`;
}

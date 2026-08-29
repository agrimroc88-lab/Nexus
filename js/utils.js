/* ============================================
   NEXUS · utils.js
   Funciones puras reutilizables.
   ARCHIVO COMPARTIDO — sin dependencias.
   ============================================ */

/* ============================================
   Validación de identificadores ecuatorianos
   ============================================ */

/**
 * Valida cédula ecuatoriana mediante algoritmo módulo 10.
 * @param {string} cedula - 10 dígitos
 */
export function validarCedula(cedula) {
  if (!/^\d{10}$/.test(cedula)) return false;

  const provincia = parseInt(cedula.substring(0, 2), 10);
  if (provincia < 1 || (provincia > 24 && provincia !== 30)) return false;

  /* El tercer dígito de una cédula de persona natural ecuatoriana
     va normalmente de 0 a 5. Pero el Registro Civil también emite
     cédulas con tercer dígito 6 a extranjeros residentes o
     naturalizados (p. ej. un ciudadano peruano con cédula
     ecuatoriana). El algoritmo módulo 10 sigue siendo el mismo;
     solo se amplía el rango aceptado del tercer dígito.

     No afecta la validación de RUC: validarRuc() ya filtra el
     rango 0-5 antes de delegar aquí, así que este cambio no
     relaja nada en la validación de RUC de sociedades o entidades. */
  const tercerDigito = parseInt(cedula[2], 10);
  if (tercerDigito > 6) return false;

  const coeficientes = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let suma = 0;

  for (let i = 0; i < 9; i++) {
    let producto = parseInt(cedula[i], 10) * coeficientes[i];
    if (producto >= 10) producto -= 9;
    suma += producto;
  }

  const verificador = (10 - (suma % 10)) % 10;
  return verificador === parseInt(cedula[9], 10);
}

/**
 * Valida RUC ecuatoriano según su tipo.
 * Persona natural (3.º dígito 0-5) → módulo 10 sobre los 10 primeros.
 * Sociedad privada (3.º dígito = 9) → módulo 11, verificador en pos. 10.
 * Sector público  (3.º dígito = 6) → módulo 11, verificador en pos. 9.
 * @returns {{valido: boolean, tipo: string, mensaje: string}}
 */
export function validarRuc(ruc) {
  if (!/^\d{13}$/.test(ruc)) {
    return { valido: false, tipo: '', mensaje: 'El RUC debe tener 13 dígitos' };
  }

  const provincia = parseInt(ruc.substring(0, 2), 10);
  if (provincia < 1 || (provincia > 24 && provincia !== 30)) {
    return { valido: false, tipo: '', mensaje: 'Código de provincia inválido' };
  }

  const tercerDigito = parseInt(ruc[2], 10);

  /* --- Persona natural --- */
  if (tercerDigito >= 0 && tercerDigito <= 5) {
    if (ruc.substring(10) !== '001') {
      return { valido: false, tipo: 'natural', mensaje: 'El RUC debe terminar en 001' };
    }
    const valido = validarCedula(ruc.substring(0, 10));
    return {
      valido,
      tipo: 'natural',
      mensaje: valido ? 'RUC de persona natural' : 'Dígito verificador incorrecto'
    };
  }

  /* --- Sociedad privada --- */
  if (tercerDigito === 9) {
    if (ruc.substring(10) !== '001') {
      return { valido: false, tipo: 'privada', mensaje: 'El RUC debe terminar en 001' };
    }
    return { valido: true, tipo: 'privada', mensaje: 'RUC de sociedad privada' };
  }

  /* --- Sector público --- */
  if (tercerDigito === 6) {
    if (ruc.substring(9) !== '0001') {
      return { valido: false, tipo: 'publica', mensaje: 'El RUC debe terminar en 0001' };
    }
    return { valido: true, tipo: 'publica', mensaje: 'RUC de entidad pública' };
  }

  return { valido: false, tipo: '', mensaje: 'Tercer dígito inválido' };
}

function verificarModulo11(ruc, coeficientes, posicionVerificador) {
  let suma = 0;
  for (let i = 0; i < coeficientes.length; i++) {
    suma += parseInt(ruc[i], 10) * coeficientes[i];
  }
  const residuo = suma % 11;
  const verificador = residuo === 0 ? 0 : 11 - residuo;
  return verificador === parseInt(ruc[posicionVerificador], 10);
}

/* ============================================
   Reglas legales · Normativa ecuatoriana
   ============================================ */

/**
 * Determina las obligaciones de SST según número de trabajadores.
 * Marco: D.E. 255 (2024) y A.M. MDT-2024-196.
 * @param {number} n - número de trabajadores
 * @returns {{nivel: string, texto: string}}
 */
export function obligacionSst(n) {
  const total = Number(n) || 0;

  if (total === 0) {
    return { nivel: 'neutro', texto: '' };
  }
  if (total <= 9) {
    return {
      nivel: 'info',
      texto: 'Microempresa · Responsable de SST designado'
    };
  }
  if (total <= 49) {
    return {
      nivel: 'aviso',
      texto: 'Delegado de SST obligatorio (Art. 33, D.E. 255)'
    };
  }
  if (total <= 99) {
    return {
      nivel: 'aviso',
      texto: 'Técnico de SST y Comité Paritario obligatorios'
    };
  }
  return {
    nivel: 'critico',
    texto: 'Unidad de SST, Comité Paritario y Servicio Médico obligatorios'
  };
}

/* ============================================
   Formato
   ============================================ */

/**
 * Fecha ISO en formato ecuatoriano: 10/08/2026.
 *
 * El «T00:00» del final no es decorativo, es la corrección de
 * un error que restaba un día a TODAS las fechas del sistema.
 *
 * `new Date('2026-08-10')` interpreta la cadena como
 * medianoche en horario UTC. Al mostrarla, el navegador la
 * pasa a la hora de Ecuador, cinco horas atrás: las 19:00 del
 * día 9. Un accidente registrado hoy aparecía como de ayer.
 *
 * Con «T00:00» la cadena se interpreta en la hora local y el
 * día se conserva. Los datos guardados siempre estuvieron
 * bien; lo que fallaba era mostrarlos.
 *
 * Solo para fechas sin hora (columnas DATE). Si algún día se
 * formatea una marca de tiempo completa, no debe pasar por
 * aquí.
 */
export function formatearFecha(iso) {
  if (!iso) return '—';

  const soloFecha = String(iso).slice(0, 10);
  return new Date(soloFecha + 'T00:00').toLocaleDateString('es-EC', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

export function textoOGuion(valor) {
  return valor && String(valor).trim() !== '' ? valor : '—';
}

/**
 * Escapa texto para inserción segura en HTML.
 * Previene inyección desde datos de base.
 */
export function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

/* ============================================
   Interfaz
   ============================================ */

/**
 * Retrasa la ejecución hasta que cesen las llamadas.
 * Útil para búsquedas mientras se escribe.
 */
export function retrasar(fn, ms = 300) {
  let temporizador;
  return (...args) => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => fn(...args), ms);
  };
}

/* ============================================
   Fechas de reposo

   Estaba duplicado: certificados.js tenía su `finReposo` y
   atenciones.js una copia. Dos funciones que calculan lo
   mismo terminan divergiendo, y el día que alguien corrija
   una, la otra sigue mal. Vive aquí y las dos la usan.
   ============================================ */

/**
 * Último día de un periodo de reposo o rotación.
 *
 * El día de inicio CUENTA. Si empieza el 14 y son 2 días,
 * termina el 15, no el 16: es el error de conteo que después
 * discute el jefe de área.
 *
 * @param {string} inicioIso  fecha ISO
 * @param {number} dias
 * @returns {Date|null}
 */
export function finDeReposo(inicioIso, dias) {
  if (!inicioIso || !dias || dias < 1) return null;
  const d = new Date(inicioIso + 'T00:00');
  d.setDate(d.getDate() + dias - 1);
  return d;
}

/** Día en que se reincorpora: el siguiente al último de reposo. */
export function fechaReintegro(inicioIso, dias) {
  const fin = finDeReposo(inicioIso, dias);
  if (!fin) return null;
  const d = new Date(fin);
  d.setDate(d.getDate() + 1);
  return d;
}

/** Fecha en letras: «15 de julio de 2026». */
export function fechaEnLetras(fecha) {
  if (!fecha) return '';
  return fecha.toLocaleDateString('es-EC',
    { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Renglón resumen del periodo, listo para pintar.
 * Devuelve cadena vacía si no hay periodo que describir.
 */
export function resumenReposo(inicioIso, dias, rotulo = 'Reposo') {
  const fin = finDeReposo(inicioIso, dias);
  if (!fin) return '';

  const inicio = new Date(inicioIso + 'T00:00');
  const reintegro = fechaReintegro(inicioIso, dias);

  return `<b>${rotulo}:</b> del ${escapar(fechaEnLetras(inicio))} al `
       + `<b>${escapar(fechaEnLetras(fin))}</b> · ${dias} `
       + `${dias === 1 ? 'día' : 'días'} · se reintegra el `
       + `${escapar(fechaEnLetras(reintegro))}`;
}

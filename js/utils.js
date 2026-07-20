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

  const tercerDigito = parseInt(cedula[2], 10);
  if (tercerDigito > 5) return false;

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

export function formatearFecha(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-EC', {
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

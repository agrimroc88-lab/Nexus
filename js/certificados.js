/* ============================================
   NEXUS · certificados.js
   Registro de certificados médicos: reposo,
   reubicación, ausentismo y configuración.
   ============================================ */

import { supabase } from './supabase.js';
import { protegerPagina, empresasPermitidas } from './auth.js';
import { montarNavegacion } from './nav.js';
import { escapar, textoOGuion, retrasar, formatearFecha } from './utils.js';

/* Roles que pueden registrar. El técnico solo lee. */
const ROLES_ESCRITURA = ['admin', 'medico_ocupacional', 'enfermeria', 'psicologo', 'trabajo_social'];

const ORIGENES = {
  interno: 'Interno de la empresa',
  msp: 'Ministerio de Salud Pública',
  iess: 'IESS',
  particular: 'Particular'
};

const estado = {
  perfil: null,
  empresaId: null,
  puedeEscribir: false,
  certificados: [],
  ausentismo: [],
  config: null,
  trabajador: null,     // trabajador del formulario
  certActual: null,     // certificado en edición
  verId: null,
  vista: 'certificados'
};

const HOY = () => new Date().toISOString().slice(0, 10);

const $empresa  = document.getElementById('empresa-activa');
const $area     = document.getElementById('area-trabajo');
const $avisoIni = document.getElementById('aviso-inicial');

iniciar();

async function iniciar() {
  const perfil = await protegerPagina();
  if (!perfil) return;

  estado.perfil = perfil;
  estado.puedeEscribir = ROLES_ESCRITURA.includes(perfil.rol);
  estado.esAdmin = perfil.rol === 'admin';
  montarNavegacion(perfil, 'certificados');

  prepararAnios();
  await cargarEmpresas();
  conectarEventos();
}

function prepararAnios() {
  const actual = new Date().getFullYear();
  const $sel = document.getElementById('cert-anio');
  for (let a = actual; a >= actual - 5; a--) {
    const o = document.createElement('option');
    o.value = a; o.textContent = a;
    $sel.appendChild(o);
  }
}

/* ============================================
   Datos
   ============================================ */

async function cargarEmpresas() {
  const data = await empresasPermitidas(estado.perfil);
  const error = null;

  if (error) { alert('No fue posible cargar las empresas: ' + error.message); return; }

  (data || []).forEach((e) => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.razon_social;
    $empresa.appendChild(o);
  });

  const guardada = sessionStorage.getItem('nexus_empresa');
  if (guardada && (data || []).some((e) => e.id === guardada)) {
    $empresa.value = guardada;
    await seleccionarEmpresa();
  }
}

async function cargarCertificados() {
  const { data, error } = await supabase
    .from('v_certificados').select('*')
    .eq('empresa_id', estado.empresaId)
    .order('fecha_emision', { ascending: false })
    .limit(1000);
  estado.certificados = error ? [] : (data || []);
}

async function cargarAusentismo() {
  const { data, error } = await supabase
    .from('v_ausentismo_certificados').select('*')
    .eq('empresa_id', estado.empresaId)
    .order('num_certificados', { ascending: false });
  estado.ausentismo = error ? [] : (data || []);
}

async function cargarConfig() {
  const { data } = await supabase
    .from('config_certificados').select('*')
    .eq('empresa_id', estado.empresaId).maybeSingle();

  estado.config = data || {
    aviso_dias_1: 7, aviso_dias_2: 3,
    ausentismo_ventana: 15, ausentismo_certif: 2, ausentismo_dias: 3
  };
  pintarConfig();
}

/* ============================================
   Resumen
   ============================================ */

function pintarResumen() {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = hoy.getMonth() + 1;
  const hoyStr = HOY();

  const delAnio = estado.certificados.filter((c) => new Date(c.fecha_emision + 'T00:00').getFullYear() === anio);
  const delMes = delAnio.filter((c) => new Date(c.fecha_emision + 'T00:00').getMonth() + 1 === mes);
  const enReposo = estado.certificados.filter((c) =>
    c.reposo_fin && c.reposo_inicio &&
    c.reposo_inicio <= hoyStr && c.reposo_fin >= hoyStr);

  document.getElementById('kpi-mes').textContent = delMes.length;
  document.getElementById('kpi-anio').textContent = delAnio.length;
  document.getElementById('kpi-reposo').textContent = enReposo.length;
  document.getElementById('kpi-ausentismo').textContent = estado.ausentismo.length;
}

/* ============================================
   Vista · Certificados
   ============================================ */

function pintarCertificados() {
  const anio = parseInt(document.getElementById('cert-anio').value, 10);
  const mes = parseInt(document.getElementById('cert-mes').value, 10);
  const origen = document.getElementById('cert-origen').value;
  const texto = document.getElementById('cert-busqueda').value.trim().toLowerCase();
  const $cuerpo = document.getElementById('cuerpo-certificados');

  const visibles = estado.certificados.filter((c) => {
    const f = new Date(c.fecha_emision + 'T00:00');
    if (f.getFullYear() !== anio) return false;
    if (mes !== 0 && f.getMonth() + 1 !== mes) return false;
    if (origen && c.origen !== origen) return false;
    if (!texto) return true;
    return [String(c.codigo_trabajador), c.nombre_completo, c.cedula]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(texto));
  });

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-certificados').hidden = visibles.length > 0;

  const frag = document.createDocumentFragment();
  visibles.forEach((c) => frag.appendChild(filaCertificado(c)));
  $cuerpo.appendChild(frag);
}

function filaCertificado(c) {
  const fila = document.createElement('tr');
  fila.innerHTML = `
    <td class="celda-centro celda-mono">${formatearFecha(c.fecha_emision)}</td>
    <td class="celda-centro"><span class="codigo">${c.codigo_trabajador}</span></td>
    <td>
      <span class="principal">${escapar(c.nombre_completo)}</span>
      ${c.cargo ? `<span class="secundario">${escapar(c.cargo)}</span>` : ''}
    </td>
    <td><span class="origen-chip origen-${c.origen}">${ORIGENES[c.origen] || c.origen}</span></td>
    <td>${c.diagnostico ? escapar(c.diagnostico) : '<span class="celda-tenue">—</span>'}</td>
    <td class="celda-centro">${c.reposo_dias > 0 ? `<span class="reposo">${c.reposo_dias}</span>` : '—'}</td>
    <td class="celda-centro celda-mono">${c.reposo_fin ? formatearFecha(c.reposo_fin) : '—'}</td>
    <td class="celda-centro">${c.amerita_reubicacion ? '<span class="chip-reubica">Sí</span>' : '—'}</td>
    <td class="celda-derecha"></td>`;

  const acc = fila.querySelector('td:last-child');
  const ver = document.createElement('button');
  ver.className = 'boton-icono';
  ver.textContent = 'Ver';
  ver.addEventListener('click', () => verCertificado(c.id));
  acc.appendChild(ver);

  if (estado.esAdmin) {
    const ed = document.createElement('button');
    ed.className = 'boton-icono';
    ed.textContent = 'Editar';
    ed.addEventListener('click', () => abrirCertificado(c));
    acc.appendChild(ed);
  }
  return fila;
}

/* ============================================
   Vista · Ausentismo
   ============================================ */

function pintarAusentismo() {
  const $cuerpo = document.getElementById('cuerpo-ausentismo');
  const cfg = estado.config || {};
  document.getElementById('nota-ausentismo').textContent =
    `Alerta cuando en los últimos ${cfg.ausentismo_ventana ?? 15} días un trabajador acumula ` +
    `${cfg.ausentismo_certif ?? 2} o más certificados, o más de ${cfg.ausentismo_dias ?? 3} días de reposo.`;

  $cuerpo.innerHTML = '';
  document.getElementById('vacio-ausentismo').hidden = estado.ausentismo.length > 0;

  const frag = document.createDocumentFragment();
  estado.ausentismo.forEach((r) => {
    const motivos = [];
    if (r.por_frecuencia) motivos.push('Frecuencia de certificados');
    if (r.por_dias) motivos.push('Días de reposo acumulados');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="celda-centro"><span class="codigo">${r.codigo_trabajador}</span></td>
      <td class="principal">${escapar(r.nombre_completo)}</td>
      <td>${escapar(textoOGuion(r.area))}</td>
      <td class="celda-centro"><span class="saldo">${r.num_certificados}</span></td>
      <td class="celda-centro">${r.dias_reposo}</td>
      <td class="celda-centro celda-mono">${formatearFecha(r.ultimo_certificado)}</td>
      <td>${motivos.map((m) => `<span class="chip-alerta">${m}</span>`).join(' ')}</td>`;
    frag.appendChild(tr);
  });
  $cuerpo.appendChild(frag);
}

/* ============================================
   Vista · Configuración
   ============================================ */

function pintarConfig() {
  const c = estado.config;
  document.getElementById('cfg_aviso1').value = c.aviso_dias_1 ?? 7;
  document.getElementById('cfg_aviso2').value = c.aviso_dias_2 ?? 3;
  document.getElementById('cfg_ventana').value = c.ausentismo_ventana ?? 15;
  document.getElementById('cfg_certif').value = c.ausentismo_certif ?? 2;
  document.getElementById('cfg_dias').value = c.ausentismo_dias ?? 3;

  document.getElementById('btn-guardar-config').hidden = !estado.puedeEscribir;
  document.querySelectorAll('#vista-config input').forEach((i) => {
    i.disabled = !estado.puedeEscribir;
  });
}

async function guardarConfig() {
  const fila = {
    empresa_id: estado.empresaId,
    aviso_dias_1: parseInt(document.getElementById('cfg_aviso1').value, 10) || 0,
    aviso_dias_2: parseInt(document.getElementById('cfg_aviso2').value, 10) || 0,
    ausentismo_ventana: parseInt(document.getElementById('cfg_ventana').value, 10) || 15,
    ausentismo_certif: parseInt(document.getElementById('cfg_certif').value, 10) || 2,
    ausentismo_dias: parseInt(document.getElementById('cfg_dias').value, 10) || 3
  };

  const { error } = await supabase
    .from('config_certificados')
    .upsert(fila, { onConflict: 'empresa_id' });

  const $g = document.getElementById('config-guardado');
  if (error) {
    const $a = document.getElementById('alerta-config');
    $a.textContent = 'No fue posible guardar: ' + error.message;
    $a.hidden = false;
    return;
  }
  document.getElementById('alerta-config').hidden = true;
  estado.config = fila;
  $g.textContent = 'Configuración guardada';
  setTimeout(() => { $g.textContent = ''; }, 2500);
  await cargarAusentismo();
  pintarResumen();
}

/* ============================================
   Modal certificado
   ============================================ */

function abrirNuevo() {
  estado.certActual = null;
  estado.trabajador = null;
  limpiarForm();
  document.getElementById('cert-modal-titulo').textContent = 'Nuevo certificado médico';
  document.getElementById('btn-eliminar-cert').hidden = true;
  document.getElementById('ce_emision').value = HOY();
  document.getElementById('ce_reposo_inicio').value = HOY();
  document.getElementById('modal-cert').hidden = false;
  document.getElementById('ce_codigo').focus();
}

async function abrirCertificado(c) {
  estado.certActual = c;
  limpiarForm();

  document.getElementById('cert-modal-titulo').textContent = 'Editar certificado médico';
  document.getElementById('btn-eliminar-cert').hidden = !estado.esAdmin;

  document.getElementById('ce_codigo').value = c.codigo_trabajador ?? '';
  document.getElementById('ce_emision').value = c.fecha_emision ?? HOY();
  document.getElementById('ce_origen').value = c.origen ?? 'particular';
  document.getElementById('ce_cie').value = c.codigo_cie10 ?? '';
  document.getElementById('ce_diagnostico').value = c.diagnostico ?? '';
  document.getElementById('ce_reposo_inicio').value = c.reposo_inicio ?? '';
  document.getElementById('ce_reposo_dias').value = c.reposo_dias ?? 0;
  document.getElementById('ce_reubica').checked = c.amerita_reubicacion ?? false;
  document.getElementById('ce_rot_inicio').value = c.rotacion_inicio ?? '';
  document.getElementById('ce_rot_dias').value = c.rotacion_dias ?? 0;
  document.getElementById('ce_rot_detalle').value = c.rotacion_detalle ?? '';
  document.getElementById('ce_medico').value = c.medico_emisor ?? '';
  document.getElementById('ce_url').value = c.url_certificado ?? '';
  document.getElementById('ce_observacion').value = c.observacion ?? '';

  document.getElementById('modal-cert').hidden = false;
  await buscarTrabajadorCert();
  ajustarReubica();
  calcularReposoFin();
  calcularRotFin();
}

function limpiarForm() {
  ['ce_cie', 'ce_diagnostico', 'ce_rot_detalle', 'ce_medico', 'ce_url', 'ce_observacion']
    .forEach((id) => { document.getElementById(id).value = ''; });
  const $bn = document.getElementById('ce_buscar_nombre');
  if ($bn) $bn.value = '';
  const $ns = document.getElementById('ce_nombre_sug');
  if ($ns) $ns.hidden = true;
  document.getElementById('ce_reposo_dias').value = 0;
  document.getElementById('ce_rot_dias').value = 0;
  document.getElementById('ce_rot_inicio').value = '';
  document.getElementById('ce_origen').value = 'particular';
  document.getElementById('ce_reubica').checked = false;
  document.getElementById('ce-ficha').hidden = true;
  document.getElementById('ce-bloque').hidden = true;
  document.getElementById('ce-bloque-reubica').hidden = true;
  document.getElementById('ce-reposo-fin').textContent = '—';
  document.getElementById('ce-rot-fin').textContent = '—';
  document.getElementById('ce-ayuda-trabajador').textContent = '';
  document.getElementById('alerta-cert').hidden = true;

  const escribible = estado.puedeEscribir;
  document.getElementById('btn-guardar-cert').hidden = !escribible;
  document.querySelectorAll('#modal-cert input, #modal-cert select, #modal-cert textarea')
    .forEach((i) => { i.disabled = !escribible; });
}

/* Buscar trabajador por NOMBRE al crear certificado.
   Al elegir, llena el código y carga la ficha completa. */
const buscarNombreCert = retrasar(async () => {
  const texto = document.getElementById('ce_buscar_nombre').value.trim();
  const $sug = document.getElementById('ce_nombre_sug');
  if (texto.length < 2) { $sug.hidden = true; return; }

  const { data } = await supabase
    .from('v_trabajadores').select('codigo, nombre_completo, cedula, cargo')
    .eq('empresa_id', estado.empresaId)
    .or(`nombres.ilike.%${texto}%,apellidos.ilike.%${texto}%,cedula.ilike.%${texto}%`)
    .limit(8);

  if (!data || data.length === 0) { $sug.hidden = true; return; }
  $sug.innerHTML = '';
  data.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'sugerencia'; b.type = 'button';
    b.innerHTML = `<span class="cie-chip">${t.codigo}</span>
                   <span class="sugerencia-nombre">${escapar(t.nombre_completo)} · ${escapar(t.cedula || '')}</span>`;
    b.addEventListener('click', () => {
      document.getElementById('ce_codigo').value = t.codigo;
      document.getElementById('ce_buscar_nombre').value = t.nombre_completo;
      $sug.hidden = true;
      buscarTrabajadorCert();  // carga la ficha completa por código
    });
    $sug.appendChild(b);
  });
  $sug.hidden = false;
}, 350);

const buscarTrabajadorCert = retrasar(async () => {
  const codigo = parseInt(document.getElementById('ce_codigo').value, 10);
  const $ayuda = document.getElementById('ce-ayuda-trabajador');
  if (!codigo) { $ayuda.textContent = ''; ocultarFicha(); return; }

  const { data } = await supabase
    .from('v_trabajadores').select('*')
    .eq('empresa_id', estado.empresaId).eq('codigo', codigo).maybeSingle();

  if (!data) {
    $ayuda.textContent = 'No existe un trabajador con ese código.';
    $ayuda.className = 'ayuda ayuda-error';
    ocultarFicha();
    return;
  }
  $ayuda.textContent = data.activo ? 'Trabajador identificado' : `${data.nombre_completo} · inactivo`;
  $ayuda.className = 'ayuda ' + (data.activo ? 'ayuda-ok' : 'ayuda-aviso');
  estado.trabajador = data;

  document.getElementById('ce-f-nombre').textContent = data.nombre_completo;
  document.getElementById('ce-f-cedula').textContent = data.cedula;
  document.getElementById('ce-f-cargo').textContent = textoOGuion(data.cargo);
  document.getElementById('ce-f-area').textContent = textoOGuion(data.area);
  document.getElementById('ce-ficha').hidden = false;
  document.getElementById('ce-bloque').hidden = false;
}, 350);

function ocultarFicha() {
  estado.trabajador = null;
  document.getElementById('ce-ficha').hidden = true;
  document.getElementById('ce-bloque').hidden = true;
}

function ajustarReubica() {
  document.getElementById('ce-bloque-reubica').hidden = !document.getElementById('ce_reubica').checked;
}

function calcularReposoFin() {
  const dias = parseInt(document.getElementById('ce_reposo_dias').value, 10) || 0;
  const ini = document.getElementById('ce_reposo_inicio').value || document.getElementById('ce_emision').value;
  document.getElementById('ce-reposo-fin').textContent = finReposo(ini, dias);
}

function calcularRotFin() {
  const dias = parseInt(document.getElementById('ce_rot_dias').value, 10) || 0;
  const ini = document.getElementById('ce_rot_inicio').value || document.getElementById('ce_emision').value;
  document.getElementById('ce-rot-fin').textContent = finReposo(ini, dias);
}

function finReposo(inicioStr, dias) {
  if (dias < 1 || !inicioStr) return '—';
  const d = new Date(inicioStr + 'T00:00');
  d.setDate(d.getDate() + dias - 1);
  return d.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/* Buscar por NOMBRE de la enfermedad en el campo diagnóstico.
   Al elegir, llena la descripción Y el código CIE-10. */
const buscarDiagCert = retrasar(async () => {
  const texto = document.getElementById('ce_diagnostico').value.trim();
  const $sug = document.getElementById('ce_diag_sug');
  if (texto.length < 2) { $sug.hidden = true; return; }

  const { data } = await supabase
    .from('cie10').select('codigo, descripcion')
    .ilike('descripcion', '%' + texto + '%')
    .limit(8);

  if (!data || data.length === 0) { $sug.hidden = true; return; }
  $sug.innerHTML = '';
  data.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'sugerencia'; b.type = 'button';
    b.innerHTML = `<span class="cie-chip">${escapar(c.codigo)}</span>
                   <span class="sugerencia-nombre">${escapar(c.descripcion)}</span>`;
    b.addEventListener('click', () => {
      document.getElementById('ce_diagnostico').value = c.descripcion;
      document.getElementById('ce_cie').value = c.codigo;  // llena el CIE-10
      $sug.hidden = true;
    });
    $sug.appendChild(b);
  });
  $sug.hidden = false;
}, 350);

const buscarCieCert = retrasar(async () => {
  const texto = document.getElementById('ce_cie').value.trim();
  const $sug = document.getElementById('ce_cie_sug');
  if (texto.length < 2) { $sug.hidden = true; return; }

  // Buscar por código (empieza con) o por descripción (contiene), en dos
  // consultas y combinando, porque el .or() con % no siempre funciona.
  const patronDesc = '%' + texto + '%';
  const patronCod = texto + '%';

  const [porCodigo, porDesc] = await Promise.all([
    supabase.from('cie10').select('codigo, descripcion').ilike('codigo', patronCod).limit(8),
    supabase.from('cie10').select('codigo, descripcion').ilike('descripcion', patronDesc).limit(8)
  ]);

  // Combinar resultados sin duplicados
  const mapa = new Map();
  (porCodigo.data || []).forEach((c) => mapa.set(c.codigo, c));
  (porDesc.data || []).forEach((c) => mapa.set(c.codigo, c));
  const data = [...mapa.values()].slice(0, 8);

  if (data.length === 0) { $sug.hidden = true; return; }
  $sug.innerHTML = '';
  data.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'sugerencia'; b.type = 'button';
    b.innerHTML = `<span class="cie-chip">${escapar(c.codigo)}</span>
                   <span class="sugerencia-nombre">${escapar(c.descripcion)}</span>`;
    b.addEventListener('click', () => {
      document.getElementById('ce_cie').value = c.codigo;
      document.getElementById('ce_diagnostico').value = c.descripcion;
      $sug.hidden = true;
    });
    $sug.appendChild(b);
  });
  $sug.hidden = false;
}, 300);

async function guardarCertificado() {
  const $alerta = document.getElementById('alerta-cert');
  const codigo = parseInt(document.getElementById('ce_codigo').value, 10);

  if (!estado.trabajador || estado.trabajador.codigo !== codigo) {
    $alerta.textContent = 'Busque y confirme un trabajador válido.';
    $alerta.hidden = false; return;
  }

  const reubica = document.getElementById('ce_reubica').checked;
  const rotDias = parseInt(document.getElementById('ce_rot_dias').value, 10) || 0;
  if (reubica && rotDias < 1) {
    $alerta.textContent = 'Si amerita reubicación, indique los días de rotación.';
    $alerta.hidden = false; return;
  }

  const reposoDias = parseInt(document.getElementById('ce_reposo_dias').value, 10) || 0;
  const emision = document.getElementById('ce_emision').value || HOY();
  const url = document.getElementById('ce_url').value.trim() || null;
  if (url && !/^https?:\/\//i.test(url)) {
    $alerta.textContent = 'El enlace debe comenzar con http:// o https://';
    $alerta.hidden = false; return;
  }

  const fila = {
    empresa_id: estado.empresaId,
    trabajador_id: estado.trabajador.id,
    origen: document.getElementById('ce_origen').value,
    fecha_emision: emision,
    codigo_cie10: document.getElementById('ce_cie').value.trim() || null,
    diagnostico: document.getElementById('ce_diagnostico').value.trim() || null,
    reposo_inicio: reposoDias > 0 ? (document.getElementById('ce_reposo_inicio').value || emision) : null,
    reposo_dias: reposoDias,
    amerita_reubicacion: reubica,
    rotacion_inicio: reubica && rotDias > 0 ? (document.getElementById('ce_rot_inicio').value || emision) : null,
    rotacion_dias: reubica ? rotDias : 0,
    rotacion_detalle: reubica ? (document.getElementById('ce_rot_detalle').value.trim() || null) : null,
    medico_emisor: document.getElementById('ce_medico').value.trim() || null,
    url_certificado: url,
    observacion: document.getElementById('ce_observacion').value.trim() || null
  };

  const $btn = document.getElementById('btn-guardar-cert');
  $btn.disabled = true;

  const { error } = estado.certActual
    ? await supabase.from('certificados_medicos').update(fila).eq('id', estado.certActual.id)
    : await supabase.from('certificados_medicos').insert(fila);

  $btn.disabled = false;
  if (error) { $alerta.textContent = 'No fue posible guardar: ' + error.message; $alerta.hidden = false; return; }

  document.getElementById('modal-cert').hidden = true;
  await recargar();
}

async function eliminarCertificado() {
  if (!estado.esAdmin) { alert('Solo el administrador puede eliminar certificados.'); return; }
  if (!estado.certActual) return;
  if (!confirm('¿Eliminar este certificado? Esta acción no se puede deshacer.')) return;

  const { error } = await supabase
    .from('certificados_medicos').delete().eq('id', estado.certActual.id);
  if (error) { alert('No fue posible eliminar: ' + error.message); return; }

  document.getElementById('modal-cert').hidden = true;
  await recargar();
}

/* ============================================
   Ver / imprimir
   ============================================ */

function verCertificado(id) {
  const c = estado.certificados.find((x) => x.id === id);
  if (!c) return;
  estado.verId = id;
  document.getElementById('verc-titulo').textContent =
    `Certificado médico · ${formatearFecha(c.fecha_emision)}`;
  document.getElementById('verc-cuerpo').innerHTML = cuerpoVer(c);
  document.getElementById('modal-ver-cert').hidden = false;
}

function linea(etq, val) {
  if (!val && val !== 0) return '';
  return `<div><span class="ver-etiqueta">${etq}</span> ${escapar(String(val))}</div>`;
}

function cuerpoVer(c) {
  return `
    <div class="ver-datos">
      ${linea('Trabajador', c.nombre_completo)}
      ${linea('Código', c.codigo_trabajador)}
      ${linea('Cédula', c.cedula)}
      ${linea('Cargo', textoOGuion(c.cargo))}
      ${linea('Origen', ORIGENES[c.origen] || c.origen)}
      ${linea('Fecha de emisión', formatearFecha(c.fecha_emision))}
      ${linea('Médico / entidad', textoOGuion(c.medico_emisor))}
    </div>
    ${c.diagnostico ? `<div class="ver-campo"><span class="ver-etiqueta">Diagnóstico</span><p class="ver-texto">${escapar(c.codigo_cie10 ? c.codigo_cie10 + ' · ' : '')}${escapar(c.diagnostico)}</p></div>` : ''}
    ${c.reposo_dias > 0 ? `<div class="ver-campo"><span class="ver-etiqueta">Reposo</span><p class="ver-texto">${c.reposo_dias} día(s) · del ${formatearFecha(c.reposo_inicio)} al ${formatearFecha(c.reposo_fin)} · se reincorpora al día siguiente</p></div>` : ''}
    ${c.amerita_reubicacion ? `<div class="ver-campo"><span class="ver-etiqueta">Reubicación / rotación</span><p class="ver-texto">${c.rotacion_dias} día(s) · del ${formatearFecha(c.rotacion_inicio)} al ${formatearFecha(c.rotacion_fin)}${c.rotacion_detalle ? ' · ' + escapar(c.rotacion_detalle) : ''}</p></div>` : ''}
    ${c.observacion ? `<div class="ver-campo"><span class="ver-etiqueta">Observación</span><p class="ver-texto">${escapar(c.observacion)}</p></div>` : ''}
    ${c.url_certificado ? `<div class="ver-campo"><a href="${escapar(c.url_certificado)}" target="_blank" rel="noopener">Ver certificado escaneado ↗</a></div>` : ''}`;
}

function imprimirCertificado() {
  const c = estado.certificados.find((x) => x.id === estado.verId);
  if (!c) return;
  const $z = document.getElementById('zona-impresion');
  $z.innerHTML = `
    <div class="hoja">
      <header class="hoja-cabecera">
        <h1>Certificado Médico</h1>
        <p>${escapar(c.nombre_completo)} · Código ${c.codigo_trabajador} · Cédula ${escapar(c.cedula)}</p>
        <p>Origen: ${ORIGENES[c.origen] || c.origen} · Emisión: ${formatearFecha(c.fecha_emision)}</p>
      </header>
      ${c.cargo ? bloque('Cargo', c.cargo) : ''}
      ${c.diagnostico ? bloque('Diagnóstico', (c.codigo_cie10 ? c.codigo_cie10 + ' · ' : '') + c.diagnostico) : ''}
      ${c.reposo_dias > 0 ? bloque('Reposo', `${c.reposo_dias} día(s), del ${formatearFecha(c.reposo_inicio)} al ${formatearFecha(c.reposo_fin)}. Se reincorpora al día siguiente.`) : ''}
      ${c.amerita_reubicacion ? bloque('Reubicación / rotación', `${c.rotacion_dias} día(s), del ${formatearFecha(c.rotacion_inicio)} al ${formatearFecha(c.rotacion_fin)}.${c.rotacion_detalle ? ' ' + c.rotacion_detalle : ''}`) : ''}
      ${c.medico_emisor ? bloque('Médico / entidad emisora', c.medico_emisor) : ''}
      ${c.observacion ? bloque('Observación', c.observacion) : ''}
      <div class="hoja-firma"><div class="firma-linea"></div><p>${escapar(c.registrado_por || 'Servicio Médico')}</p></div>
    </div>`;
  window.print();
}

function bloque(etq, val) {
  if (!val) return '';
  return `<section class="hoja-bloque"><h2>${etq}</h2><p>${escapar(String(val))}</p></section>`;
}

/* ============================================
   Pestañas y empresa
   ============================================ */

/* ============================================
   Estadísticas
   ============================================ */

function poblarAniosEstadisticas() {
  const $sel = document.getElementById('est-anio');
  if ($sel.options.length > 0) return;  // ya poblado
  const anios = new Set();
  estado.certificados.forEach((c) => {
    if (c.fecha_emision) anios.add(new Date(c.fecha_emision + 'T00:00').getFullYear());
  });
  const actual = new Date().getFullYear();
  anios.add(actual);
  [...anios].sort((a, b) => b - a).forEach((a) => {
    const o = document.createElement('option');
    o.value = a; o.textContent = a;
    $sel.appendChild(o);
  });
  $sel.value = actual;
}

function pintarEstadisticas() {
  poblarAniosEstadisticas();
  const anio = parseInt(document.getElementById('est-anio').value, 10) || new Date().getFullYear();
  const lista = estado.certificados.filter(
    (c) => c.fecha_emision && new Date(c.fecha_emision + 'T00:00').getFullYear() === anio
  );

  // Tarjetas
  const totalReposo = lista.reduce((s, c) => s + (parseInt(c.reposo_dias, 10) || 0), 0);
  const reubic = lista.filter((c) => c.amerita_reubicacion).length;
  const trabajadores = new Set(lista.map((c) => c.trabajador_id).filter(Boolean));

  document.getElementById('est-total').textContent = lista.length;
  document.getElementById('est-reposo').textContent = totalReposo;
  document.getElementById('est-reubicaciones').textContent = reubic;
  document.getElementById('est-trabajadores').textContent = trabajadores.size;

  // Diagnósticos más frecuentes
  const diag = {};
  lista.forEach((c) => {
    const clave = c.diagnostico || c.codigo_cie10 || 'Sin diagnóstico';
    diag[clave] = (diag[clave] || 0) + 1;
  });
  pintarBarras('est-diagnosticos', Object.entries(diag).sort((a, b) => b[1] - a[1]).slice(0, 8), lista.length);

  // Por origen
  const orig = {};
  lista.forEach((c) => { const o = ORIGENES[c.origen] || c.origen || 'Otro'; orig[o] = (orig[o] || 0) + 1; });
  pintarBarras('est-origen', Object.entries(orig).sort((a, b) => b[1] - a[1]), lista.length);

  // Por mes
  const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const porMes = new Array(12).fill(0);
  lista.forEach((c) => { porMes[new Date(c.fecha_emision + 'T00:00').getMonth()]++; });
  const maxMes = Math.max(1, ...porMes);
  pintarBarras('est-meses', meses.map((m, i) => [m, porMes[i]]), maxMes, true);

  // Trabajadores con más certificados
  const porTrab = {};
  lista.forEach((c) => {
    const nom = c.nombre_completo || ('Código ' + c.codigo_trabajador);
    porTrab[nom] = (porTrab[nom] || 0) + 1;
  });
  pintarBarras('est-top-trab', Object.entries(porTrab).sort((a, b) => b[1] - a[1]).slice(0, 8), lista.length);
}

/* Dibuja una lista de barras horizontales simple (nombre + barra + número) */
function pintarBarras(idCont, pares, maximo, mostrarTodos) {
  const $c = document.getElementById(idCont);
  $c.innerHTML = '';
  const datos = mostrarTodos ? pares : pares.filter((p) => p[1] > 0);
  if (datos.length === 0) {
    $c.innerHTML = '<p class="est-vacio">Sin datos para este año.</p>';
    return;
  }
  datos.forEach(([nombre, valor]) => {
    const fila = document.createElement('div');
    fila.className = 'est-fila';
    const pct = maximo > 0 ? Math.round((valor / maximo) * 100) : 0;
    fila.innerHTML =
      `<span class="est-fila-nombre">${escapar(String(nombre))}</span>` +
      `<span class="est-fila-barra"><span class="est-fila-relleno" style="width:${pct}%"></span></span>` +
      `<span class="est-fila-valor">${valor}</span>`;
    $c.appendChild(fila);
  });
}

function cambiarVista(v) {
  estado.vista = v;
  document.querySelectorAll('.pestana').forEach((p) => p.classList.toggle('activa', p.dataset.vista === v));
  ['certificados', 'ausentismo', 'estadisticas', 'config'].forEach((x) =>
    document.getElementById('vista-' + x).hidden = x !== v);
  if (v === 'certificados') pintarCertificados();
  if (v === 'ausentismo') pintarAusentismo();
  if (v === 'estadisticas') pintarEstadisticas();
  if (v === 'config') pintarConfig();
}

async function seleccionarEmpresa() {
  estado.empresaId = $empresa.value || null;
  if (!estado.empresaId) {
    sessionStorage.removeItem('nexus_empresa');
    $area.hidden = true; $avisoIni.hidden = false; return;
  }
  sessionStorage.setItem('nexus_empresa', estado.empresaId);
  $area.hidden = false; $avisoIni.hidden = true;

  document.getElementById('btn-nuevo-cert').hidden = !estado.puedeEscribir;
  await recargar();
}

async function recargar() {
  await Promise.all([cargarCertificados(), cargarAusentismo(), cargarConfig()]);
  pintarResumen();
  if (estado.vista === 'certificados') pintarCertificados();
  if (estado.vista === 'ausentismo') pintarAusentismo();
}

/* ============================================
   Eventos
   ============================================ */

function conectarEventos() {
  $empresa.addEventListener('change', seleccionarEmpresa);

  document.querySelectorAll('.pestana').forEach((p) =>
    p.addEventListener('click', () => cambiarVista(p.dataset.vista)));

  const $bn = document.getElementById('ce_buscar_nombre');
  if ($bn) $bn.addEventListener('input', buscarNombreCert);
  const $estAnio = document.getElementById('est-anio');
  if ($estAnio) $estAnio.addEventListener('change', pintarEstadisticas);
  const $btnImpEst = document.getElementById('btn-imprimir-est');
  if ($btnImpEst) $btnImpEst.addEventListener('click', () => {
    document.body.classList.add('imprimiendo-est');
    window.print();
    setTimeout(() => document.body.classList.remove('imprimiendo-est'), 500);
  });

  document.querySelectorAll('[data-cierra]').forEach((b) =>
    b.addEventListener('click', () => { document.getElementById(b.dataset.cierra).hidden = true; }));

  document.getElementById('cert-anio').addEventListener('change', pintarCertificados);
  document.getElementById('cert-mes').addEventListener('change', pintarCertificados);
  document.getElementById('cert-origen').addEventListener('change', pintarCertificados);
  document.getElementById('cert-busqueda').addEventListener('input', retrasar(pintarCertificados, 200));

  document.getElementById('btn-nuevo-cert').addEventListener('click', abrirNuevo);
  document.getElementById('btn-guardar-cert').addEventListener('click', guardarCertificado);
  document.getElementById('btn-eliminar-cert').addEventListener('click', eliminarCertificado);
  document.getElementById('ce_codigo').addEventListener('input', buscarTrabajadorCert);
  document.getElementById('ce_cie').addEventListener('input', buscarCieCert);
  document.getElementById('ce_diagnostico').addEventListener('input', buscarDiagCert);
  document.getElementById('ce_reubica').addEventListener('change', ajustarReubica);
  document.getElementById('ce_reposo_dias').addEventListener('input', calcularReposoFin);
  document.getElementById('ce_reposo_inicio').addEventListener('change', calcularReposoFin);
  document.getElementById('ce_emision').addEventListener('change', () => { calcularReposoFin(); calcularRotFin(); });
  document.getElementById('ce_rot_dias').addEventListener('input', calcularRotFin);
  document.getElementById('ce_rot_inicio').addEventListener('change', calcularRotFin);

  document.getElementById('btn-imprimir-cert').addEventListener('click', imprimirCertificado);
  document.getElementById('btn-guardar-config').addEventListener('click', guardarConfig);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['modal-ver-cert', 'modal-cert']) {
      const $m = document.getElementById(id);
      if (!$m.hidden) { $m.hidden = true; return; }
    }
  });
}

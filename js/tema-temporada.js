/* ============================================
   NEXUS · tema-temporada.js

   Decide qué tema (Halloween, Navidad, etc.) se muestra en la
   bienvenida y en el login. Primero revisa si hay algo elegido
   a mano desde Configuración → Apariencia (tabla
   config_tema_visual); si no hay nada forzado, o si lo forzado
   ya venció (fecha_fin pasada) o no ha empezado (fecha_inicio
   futura), elige solo según la fecha de hoy.

   Se consulta a la base porque login.html e index.html se abren
   SIN sesión iniciada todavía — no hay otra forma de que ambas
   páginas (y la de elegir empresa) se enteren del mismo valor
   sin repetirlo cada una por su cuenta.
   ============================================ */

import { supabase } from './supabase.js';

const TEMPORADAS = [
  { id: 'halloween', desdeMD: [10, 20], hastaMD: [10, 31] },
  { id: 'navidad',   desdeMD: [12, 10], hastaMD: [12, 27] },
  { id: 'finanio',   desdeMD: [12, 28], hastaMD: [1, 2]   },
  { id: 'reyes',     desdeMD: [1, 5],   hastaMD: [1, 6]   },
];

function fechaEnRango(hoy, [mesDesde, diaDesde], [mesHasta, diaHasta]) {
  const num = (mes, dia) => mes * 100 + dia;
  const actual = num(hoy.getMonth() + 1, hoy.getDate());
  const desde = num(mesDesde, diaDesde);
  const hasta = num(mesHasta, diaHasta);
  return desde <= hasta ? (actual >= desde && actual <= hasta) : (actual >= desde || actual <= hasta);
}

function temaAutomatico() {
  const hoy = new Date();
  const activa = TEMPORADAS.find((t) => fechaEnRango(hoy, t.desdeMD, t.hastaMD));
  return activa ? activa.id : null;
}

function hoyISO() {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** Devuelve el id del tema activo ahora mismo ('navidad', etc.),
    o null si corresponde el video normal (sin tema). Si la base
    no responde por cualquier motivo (sin internet, tabla
    todavía no creada, etc.), se cae solo al criterio automático
    por fecha, para que el acceso nunca dependa de esto. */
export async function temaActivo() {
  try {
    const { data, error } = await supabase
      .from('config_tema_visual')
      .select('tema, fecha_inicio, fecha_fin')
      .eq('clave', 'global')
      .maybeSingle();

    if (!error && data && data.tema) {
      const hoy = hoyISO();
      const yaEmpezo = !data.fecha_inicio || hoy >= data.fecha_inicio;
      const noHaTerminado = !data.fecha_fin || hoy <= data.fecha_fin;
      if (yaEmpezo && noHaTerminado) {
        return data.tema === 'ninguno' ? null : data.tema;
      }
    }
  } catch (e) {
    console.warn('NEXUS · tema-temporada: no se pudo consultar config_tema_visual, se usa el automático', e);
  }
  return temaAutomatico();
}

/** Nombre del archivo de video que le corresponde al tema
    activo, para el fondo del login (o seleccionar-empresa). */
export async function videoDeLogin() {
  const tema = await temaActivo();
  return tema ? `img/login-fondo-${tema}.mp4` : 'img/login-fondo.mp4';
}

/** Lo mismo, pero para la bienvenida. Si no existe todavía un
    video de bienvenida para ese tema, bienvenida.js ya sabe
    caer de vuelta al de siempre (ver su propio manejo del
    evento "error" del <video>). */
export async function videoDeBienvenida() {
  const tema = await temaActivo();
  return tema ? `img/bienvenida-${tema}.mp4` : 'img/bienvenida.mp4';
}

-- ============================================
-- NEXUS · 050_seguridad_paso1_funciones.sql
--
-- PASO 1 de 2 · Prepara el ingreso seguro. NO cambia nada de lo
-- que funciona hoy: solo agrega tablas y funciones nuevas.
-- Ejecutar ANTES de subir el código nuevo. Reejecutable.
--
-- Cómo funciona el ingreso nuevo:
--   1. El navegador envía cédula + contraseña a iniciar_sesion().
--   2. La base compara contra la contraseña CIFRADA y, si es
--      correcta, entrega un "pase" aleatorio válido por 12 horas.
--   3. Cada consulta posterior lleva ese pase (cabecera x-sesion).
--   4. En el paso 2 se activa un portero (verificar_sesion) que
--      rechaza toda consulta sin pase válido.
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- --- Pases de sesión ---------------------------------------------
-- Se guarda la HUELLA (sha256) del pase, no el pase: si alguien
-- llegara a leer esta tabla, no podría usar lo que ve.
CREATE TABLE IF NOT EXISTS sesiones_app (
  token_hash  TEXT PRIMARY KEY,
  usuario_id  UUID NOT NULL REFERENCES usuarios_app(id) ON DELETE CASCADE,
  creada_en   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_en   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sesiones_app_usuario ON sesiones_app(usuario_id);
ALTER TABLE sesiones_app ENABLE ROW LEVEL SECURITY;      -- sin políticas:
REVOKE ALL ON sesiones_app FROM anon, authenticated;     -- nadie la lee por la API

-- --- Intentos fallidos (freno a quien prueba contraseñas) --------
CREATE TABLE IF NOT EXISTS intentos_login (
  cedula           TEXT PRIMARY KEY,
  fallidos         INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta  TIMESTAMPTZ
);
ALTER TABLE intentos_login ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON intentos_login FROM anon, authenticated;

-- --- Utilidades internas -----------------------------------------
CREATE OR REPLACE FUNCTION public.huella(texto TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE
SET search_path = public, extensions AS $$
  SELECT encode(extensions.digest(texto, 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION public.es_hash_bcrypt(texto TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(texto ~ '^\$2[abxy]\$[0-9]{2}\$', false)
$$;

-- Pase que trae la consulta actual (cabecera x-sesion), o NULL.
CREATE OR REPLACE FUNCTION public.token_actual()
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.headers', true)::json ->> 'x-sesion', '')
$$;

-- Usuario dueño del pase actual (si el pase es válido y el
-- usuario sigue activo), o NULL.
CREATE OR REPLACE FUNCTION public.usuario_sesion_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions AS $$
  SELECT s.usuario_id
  FROM sesiones_app s
  JOIN usuarios_app u ON u.id = s.usuario_id
  WHERE s.token_hash = huella(token_actual())
    AND s.expira_en > NOW()
    AND u.activo
$$;

CREATE OR REPLACE FUNCTION public.rol_sesion()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT rol FROM usuarios_app WHERE id = usuario_sesion_id()
$$;

-- --- Iniciar sesión ----------------------------------------------
CREATE OR REPLACE FUNCTION public.iniciar_sesion(p_cedula TEXT, p_clave TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_ced    TEXT := regexp_replace(coalesce(p_cedula, ''), '\D', '', 'g');
  v_int    intentos_login;
  v_u      usuarios_app;
  v_ok     BOOLEAN;
  v_token  TEXT;
BEGIN
  SELECT * INTO v_int FROM intentos_login WHERE cedula = v_ced;
  IF v_int.bloqueado_hasta IS NOT NULL AND v_int.bloqueado_hasta > NOW() THEN
    RETURN jsonb_build_object('ok', false,
      'mensaje', 'Demasiados intentos fallidos. Espere 15 minutos e intente de nuevo.');
  END IF;

  SELECT * INTO v_u FROM usuarios_app WHERE cedula = v_ced;

  -- Mientras dure la transición se aceptan las dos formas:
  -- contraseña cifrada (nueva) o en texto (vieja, hasta el paso 2).
  v_ok := v_u.id IS NOT NULL AND CASE
            WHEN es_hash_bcrypt(v_u.pass) THEN v_u.pass = extensions.crypt(coalesce(p_clave, ''), v_u.pass)
            ELSE v_u.pass = p_clave
          END;

  IF NOT coalesce(v_ok, false) THEN
    INSERT INTO intentos_login (cedula, fallidos) VALUES (v_ced, 1)
    ON CONFLICT (cedula) DO UPDATE
      SET fallidos = CASE WHEN intentos_login.bloqueado_hasta < NOW() THEN 1
                          ELSE intentos_login.fallidos + 1 END,
          bloqueado_hasta = CASE
            WHEN intentos_login.bloqueado_hasta < NOW() THEN NULL
            WHEN intentos_login.fallidos + 1 >= 5 THEN NOW() + INTERVAL '15 minutes'
            ELSE NULL END;
    RETURN jsonb_build_object('ok', false, 'mensaje', 'Cédula o contraseña incorrectas');
  END IF;

  DELETE FROM intentos_login WHERE cedula = v_ced;

  IF NOT v_u.activo THEN
    RETURN jsonb_build_object('ok', false,
      'mensaje', 'Usuario desactivado. Contacte al administrador.');
  END IF;

  DELETE FROM sesiones_app WHERE expira_en < NOW();   -- limpieza de vencidos

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO sesiones_app (token_hash, usuario_id, expira_en)
  VALUES (huella(v_token), v_u.id, NOW() + INTERVAL '12 hours');

  RETURN jsonb_build_object(
    'ok', true,
    'token', v_token,
    'perfil', to_jsonb(v_u) - 'pass'      -- todo el perfil, nunca la contraseña
  );
END $$;

-- --- Perfil de la sesión actual (o NULL si el pase no vale) -------
CREATE OR REPLACE FUNCTION public.mi_perfil()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT to_jsonb(u) - 'pass' FROM usuarios_app u WHERE u.id = usuario_sesion_id()
$$;

-- --- Cerrar sesión (anula el pase en la base) ---------------------
CREATE OR REPLACE FUNCTION public.cerrar_sesion_app()
RETURNS VOID LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public, extensions AS $$
  DELETE FROM sesiones_app WHERE token_hash = huella(token_actual())
$$;

-- --- Permisos de ejecución ----------------------------------------
REVOKE EXECUTE ON FUNCTION public.iniciar_sesion(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mi_perfil()                 FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cerrar_sesion_app()         FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.iniciar_sesion(TEXT, TEXT) TO anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mi_perfil()                 TO anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cerrar_sesion_app()         TO anon, authenticated;

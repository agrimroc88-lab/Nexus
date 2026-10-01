-- ============================================
-- NEXUS · 051_seguridad_paso2_bloqueo.sql
--
-- PASO 2 de 2 · CIERRA LA PUERTA.
-- Ejecutar SOLO DESPUÉS de haber subido el código nuevo y de
-- comprobar que el ingreso funciona.
-- Si algo sale mal: ejecutar 059_seguridad_revertir.sql.
-- Reejecutable.
-- ============================================

BEGIN;

-- 1 · Cifrar todas las contraseñas que siguen en texto ----------------
UPDATE usuarios_app
SET pass = extensions.crypt(pass, extensions.gen_salt('bf'))
WHERE NOT es_hash_bcrypt(pass);

-- 2 · Toda contraseña nueva o cambiada se cifra sola -----------------
--     (el módulo Usuarios sigue enviándola igual que antes)
CREATE OR REPLACE FUNCTION public.fn_cifrar_pass()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = public, extensions AS $$
BEGIN
  IF NEW.pass IS NOT NULL AND NOT es_hash_bcrypt(NEW.pass) THEN
    NEW.pass := extensions.crypt(NEW.pass, extensions.gen_salt('bf'));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tg_cifrar_pass ON usuarios_app;
CREATE TRIGGER tg_cifrar_pass
  BEFORE INSERT OR UPDATE OF pass ON usuarios_app
  FOR EACH ROW EXECUTE FUNCTION fn_cifrar_pass();

-- 3 · La columna de contraseñas deja de ser legible por la API -------
DO $$
DECLARE v_cols TEXT;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ')
  INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'usuarios_app'
    AND column_name <> 'pass';

  EXECUTE 'REVOKE SELECT ON public.usuarios_app FROM anon, authenticated';
  EXECUTE format('GRANT SELECT (%s) ON public.usuarios_app TO anon, authenticated', v_cols);
END $$;

-- 4 · Solo el administrador crea, cambia o borra usuarios y sus ----
--     empresas asignadas (antes cualquiera podía volverse admin).
--     Son políticas RESTRICTIVAS: se suman a las que ya existan.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuarios_app', 'usuario_empresas'] LOOP
    -- Si la tabla no tenía RLS ni ninguna política permisiva, se le
    -- da una abierta para que la restrictiva tenga sobre qué actuar
    -- (una restrictiva sola lo bloquearía todo, incluso la lectura).
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = t
                     AND permissive = 'PERMISSIVE') THEN
      EXECUTE format('CREATE POLICY "acceso %1$s" ON public.%1$I FOR ALL USING (true) WITH CHECK (true)', t);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "solo admin crea" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "solo admin cambia" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "solo admin borra" ON public.%I', t);
    EXECUTE format('CREATE POLICY "solo admin crea" ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK (rol_sesion() = ''admin'')', t);
    EXECUTE format('CREATE POLICY "solo admin cambia" ON public.%I AS RESTRICTIVE FOR UPDATE USING (rol_sesion() = ''admin'') WITH CHECK (rol_sesion() = ''admin'')', t);
    EXECUTE format('CREATE POLICY "solo admin borra" ON public.%I AS RESTRICTIVE FOR DELETE USING (rol_sesion() = ''admin'')', t);
  END LOOP;
END $$;

-- 5 · EL PORTERO ---------------------------------------------------
--     Se ejecuta antes de CADA consulta que llega por la API (tablas,
--     vistas y funciones). Sin un pase de sesión válido, la consulta
--     se rechaza con error 401. Solo dejan pasar sin pase:
--       · el propio login
--       · el tema visual de temporada (videos de bienvenida/login)
CREATE OR REPLACE FUNCTION public.verificar_sesion()
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions AS $$
DECLARE
  v_ruta TEXT := ltrim(coalesce(current_setting('request.path', true), ''), '/');
  v_rol  TEXT := coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '');
BEGIN
  IF v_rol = 'service_role' THEN RETURN; END IF;     -- procesos internos de Supabase
  IF v_ruta IN ('rpc/iniciar_sesion', 'config_tema_visual') THEN RETURN; END IF;

  IF usuario_sesion_id() IS NULL THEN
    RAISE EXCEPTION 'Sesión no válida o vencida. Ingrese de nuevo.'
      USING ERRCODE = 'PT401';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.verificar_sesion() TO anon, authenticated;

COMMIT;

-- 6 · Encender el portero (fuera de la transacción) ------------------
ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.verificar_sesion';
NOTIFY pgrst, 'reload config';

-- Verificación: debe mostrar public.verificar_sesion
SELECT rolconfig FROM pg_roles WHERE rolname = 'authenticator';

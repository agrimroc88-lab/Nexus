-- ============================================
-- NEXUS · 001_tablas.sql
-- Núcleo relacional del sistema.
-- Ejecutar en Supabase → SQL Editor.
-- ============================================


-- ============================================
-- BLOQUE 1 · PERFILES DE USUARIO
-- Extiende auth.users con rol y datos personales.
-- Es la base del control de acceso de todo el sistema.
-- ============================================

CREATE TYPE rol_sistema AS ENUM (
  'admin',
  'medico_ocupacional',
  'tecnico_sst',
  'ergonomo',
  'consulta'
);

CREATE TABLE perfiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nombres         TEXT NOT NULL,
  apellidos       TEXT NOT NULL,
  cedula          TEXT UNIQUE,
  rol             rol_sistema NOT NULL DEFAULT 'consulta',
  registro_msp    TEXT,                    -- Registro profesional (médicos)
  activo          BOOLEAN NOT NULL DEFAULT TRUE,

  -- Auditoría
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  creado_por      UUID REFERENCES auth.users(id),
  modificado_en   TIMESTAMPTZ,
  modificado_por  UUID REFERENCES auth.users(id)
);

CREATE INDEX idx_perfiles_rol ON perfiles(rol);
CREATE INDEX idx_perfiles_activo ON perfiles(activo);

COMMENT ON TABLE perfiles IS 'Perfil extendido de cada usuario autenticado. Determina el rol y el alcance de acceso.';
COMMENT ON COLUMN perfiles.registro_msp IS 'Número de registro profesional ante el Ministerio de Salud Pública. Aplica a médicos.';


-- ============================================
-- BLOQUE 2 · FUNCIÓN DE PERMISO CLÍNICO
-- Se declara aquí porque las políticas RLS
-- de todo el sistema dependen de ella.
-- ============================================

CREATE OR REPLACE FUNCTION rol_actual()
RETURNS rol_sistema
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT rol FROM perfiles WHERE id = auth.uid() AND activo = TRUE;
$$;

COMMENT ON FUNCTION rol_actual() IS 'Devuelve el rol del usuario autenticado. SECURITY DEFINER evita recursión en políticas RLS.';


CREATE OR REPLACE FUNCTION tiene_permiso_clinico()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT rol_actual() IN ('admin', 'medico_ocupacional');
$$;

COMMENT ON FUNCTION tiene_permiso_clinico() IS 'Verdadero para admin y medico_ocupacional. Protege el secreto médico frente a roles no clínicos.';


CREATE OR REPLACE FUNCTION es_administrador()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT rol_actual() = 'admin';
$$;


-- ============================================
-- BLOQUE 3 · ESTRUCTURA ORGANIZACIONAL
-- Empresa → Sucursal → Área → Cargo
-- ============================================

CREATE TABLE empresas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ruc                 TEXT NOT NULL UNIQUE,
  razon_social        TEXT NOT NULL,
  nombre_comercial    TEXT,
  actividad_economica TEXT,
  ciiu                TEXT,                -- Código CIIU
  riesgo_ciiu         SMALLINT,            -- Nivel de riesgo 1-5 (IESS)
  representante_legal TEXT,
  direccion           TEXT,
  canton              TEXT,
  provincia           TEXT,
  telefono            TEXT,
  correo              TEXT,
  num_trabajadores    INTEGER DEFAULT 0,
  activo              BOOLEAN NOT NULL DEFAULT TRUE,

  creado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  creado_por          UUID REFERENCES auth.users(id),
  modificado_en       TIMESTAMPTZ,
  modificado_por      UUID REFERENCES auth.users(id)
);

CREATE INDEX idx_empresas_ruc ON empresas(ruc);
CREATE INDEX idx_empresas_activo ON empresas(activo);

COMMENT ON COLUMN empresas.riesgo_ciiu IS 'Nivel de riesgo de la actividad según clasificación IESS (1 = mínimo, 5 = máximo).';
COMMENT ON COLUMN empresas.num_trabajadores IS 'Determina obligaciones legales: Delegado de SST obligatorio para 10-49 trabajadores (Art. 33, D.E. 255).';


CREATE TABLE sucursales (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  direccion       TEXT,
  canton          TEXT,
  provincia       TEXT,
  activo          BOOLEAN NOT NULL DEFAULT TRUE,

  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  creado_por      UUID REFERENCES auth.users(id),
  modificado_en   TIMESTAMPTZ,
  modificado_por  UUID REFERENCES auth.users(id),

  UNIQUE (empresa_id, nombre)
);

CREATE INDEX idx_sucursales_empresa ON sucursales(empresa_id);


CREATE TABLE areas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id     UUID NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  descripcion     TEXT,
  activo          BOOLEAN NOT NULL DEFAULT TRUE,

  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  creado_por      UUID REFERENCES auth.users(id),
  modificado_en   TIMESTAMPTZ,
  modificado_por  UUID REFERENCES auth.users(id),

  UNIQUE (sucursal_id, nombre)
);

CREATE INDEX idx_areas_sucursal ON areas(sucursal_id);


CREATE TABLE cargos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id         UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  nombre          TEXT NOT NULL,
  descripcion     TEXT,
  tareas          TEXT,
  activo          BOOLEAN NOT NULL DEFAULT TRUE,

  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  creado_por      UUID REFERENCES auth.users(id),
  modificado_en   TIMESTAMPTZ,
  modificado_por  UUID REFERENCES auth.users(id),

  UNIQUE (area_id, nombre)
);

CREATE INDEX idx_cargos_area ON cargos(area_id);

COMMENT ON TABLE cargos IS 'Nodo central de la inteligencia del sistema: de aquí cuelgan los factores de riesgo que determinan los protocolos de exámenes.';


-- ============================================
-- BLOQUE 4 · AUDITORÍA AUTOMÁTICA
-- ============================================

CREATE OR REPLACE FUNCTION fn_auditoria()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    NEW.creado_en  := NOW();
    NEW.creado_por := auth.uid();
  ELSIF (TG_OP = 'UPDATE') THEN
    NEW.creado_en      := OLD.creado_en;
    NEW.creado_por     := OLD.creado_por;
    NEW.modificado_en  := NOW();
    NEW.modificado_por := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auditoria_perfiles
  BEFORE INSERT OR UPDATE ON perfiles
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

CREATE TRIGGER trg_auditoria_empresas
  BEFORE INSERT OR UPDATE ON empresas
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

CREATE TRIGGER trg_auditoria_sucursales
  BEFORE INSERT OR UPDATE ON sucursales
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

CREATE TRIGGER trg_auditoria_areas
  BEFORE INSERT OR UPDATE ON areas
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

CREATE TRIGGER trg_auditoria_cargos
  BEFORE INSERT OR UPDATE ON cargos
  FOR EACH ROW EXECUTE FUNCTION fn_auditoria();


-- ============================================
-- BLOQUE 5 · ROW LEVEL SECURITY
-- ============================================

ALTER TABLE perfiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sucursales ENABLE ROW LEVEL SECURITY;
ALTER TABLE areas      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cargos     ENABLE ROW LEVEL SECURITY;

-- --- perfiles ---

CREATE POLICY "perfil propio visible"
  ON perfiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "admin ve todos los perfiles"
  ON perfiles FOR SELECT
  USING (es_administrador());

CREATE POLICY "admin gestiona perfiles"
  ON perfiles FOR ALL
  USING (es_administrador())
  WITH CHECK (es_administrador());

-- --- estructura organizacional ---
-- Lectura: cualquier usuario activo. No hay dato clínico aquí.
-- Escritura: admin y tecnico_sst.

CREATE POLICY "lectura organizacional"
  ON empresas FOR SELECT USING (rol_actual() IS NOT NULL);

CREATE POLICY "escritura organizacional"
  ON empresas FOR ALL
  USING (rol_actual() IN ('admin', 'tecnico_sst'))
  WITH CHECK (rol_actual() IN ('admin', 'tecnico_sst'));

CREATE POLICY "lectura sucursales"
  ON sucursales FOR SELECT USING (rol_actual() IS NOT NULL);

CREATE POLICY "escritura sucursales"
  ON sucursales FOR ALL
  USING (rol_actual() IN ('admin', 'tecnico_sst'))
  WITH CHECK (rol_actual() IN ('admin', 'tecnico_sst'));

CREATE POLICY "lectura areas"
  ON areas FOR SELECT USING (rol_actual() IS NOT NULL);

CREATE POLICY "escritura areas"
  ON areas FOR ALL
  USING (rol_actual() IN ('admin', 'tecnico_sst'))
  WITH CHECK (rol_actual() IN ('admin', 'tecnico_sst'));

CREATE POLICY "lectura cargos"
  ON cargos FOR SELECT USING (rol_actual() IS NOT NULL);

CREATE POLICY "escritura cargos"
  ON cargos FOR ALL
  USING (rol_actual() IN ('admin', 'tecnico_sst'))
  WITH CHECK (rol_actual() IN ('admin', 'tecnico_sst'));

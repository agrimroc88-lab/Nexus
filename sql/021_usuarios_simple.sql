-- ============================================
-- NEXUS · 021_usuarios_simple.sql
-- Sistema de usuarios simple (método directo, sin Edge Functions).
-- Igual que el otro software del Dr. Arias: una tabla con la
-- cédula y la contraseña; el login compara contra esta tabla.
--
-- Ejecutar en Supabase → SQL Editor. Reejecutable.
-- ============================================

-- Tabla de usuarios de la aplicación
CREATE TABLE IF NOT EXISTS usuarios_app (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cedula        TEXT NOT NULL UNIQUE,
  pass          TEXT NOT NULL,
  nombres       TEXT NOT NULL,
  apellidos     TEXT NOT NULL,
  rol           TEXT NOT NULL DEFAULT 'consulta',
  registro_msp  TEXT,
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_cedula_app CHECK (cedula ~ '^[0-9]{10}$')
);

CREATE INDEX IF NOT EXISTS idx_usuarios_app_cedula ON usuarios_app(cedula);

COMMENT ON TABLE usuarios_app IS 'Usuarios de acceso a NEXUS. Método simple: cédula + contraseña comparadas en el login. Separado de Supabase Auth.';

-- Admin inicial: Dr. Jorge Leonardo Arias Espinoza
-- Cédula 0705191229 · contraseña temporal 'nexus2026' (cámbiela en el módulo Usuarios)
INSERT INTO usuarios_app (cedula, pass, nombres, apellidos, rol, activo)
VALUES ('0705191229', 'nexus2026', 'Jorge Leonardo', 'Arias Espinoza', 'admin', true)
ON CONFLICT (cedula) DO NOTHING;

-- ============================================
-- RLS: la tabla es accesible con la clave anónima (como en el
-- otro software). El control real de acceso lo hace el login
-- de la aplicación comparando cédula + contraseña.
-- ============================================
ALTER TABLE usuarios_app ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "acceso usuarios_app" ON usuarios_app;
CREATE POLICY "acceso usuarios_app"
  ON usuarios_app FOR ALL
  USING (true)
  WITH CHECK (true);

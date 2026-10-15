-- ============================================
-- NEXUS · 082_docente_learning.sql
-- Casilla "Docente en Nexus Learning" en el módulo Usuarios.
-- Ejecutar en Supabase de NEXUS → SQL Editor. Reejecutable.
--
-- Al marcarla, NEXUS avisa a Nexus Learning (puente-nexus) y la
-- persona aparece en la lista de docentes de Learning, lista para
-- asignarla a sus programas. Entra con su misma cédula y contraseña.
-- ============================================

ALTER TABLE public.usuarios_app
  ADD COLUMN IF NOT EXISTS docente_learning BOOLEAN NOT NULL DEFAULT FALSE;

-- La lectura de usuarios_app es por columnas (ver 051): se habilita la nueva.
GRANT SELECT (docente_learning) ON public.usuarios_app TO anon, authenticated;

SELECT count(*) FILTER (WHERE docente_learning) AS docentes_marcados, count(*) AS usuarios
FROM public.usuarios_app;

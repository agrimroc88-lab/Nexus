-- ============================================
-- NEXUS · 070_capacitaciones_learning.sql
-- Ejecutar en el proyecto NEXUS (no en nexus-learning).
-- Es seguro ejecutarlo más de una vez. No borra datos.
--
-- Agrega a "capacitaciones" la referencia a la capacitación de
-- Nexus Learning con la que se llenó automáticamente cada fila
-- (módulo Nexus Learning → "Registrar en Seguridad o Salud").
--
-- · No cambia las reglas de seguridad: escribir sigue permitido
--   solo a quien ya podía hacerlo.
-- · Una capacitación de Learning se vincula con UNA sola fila
--   (empresa + tema + año).
-- ============================================

ALTER TABLE public.capacitaciones
  ADD COLUMN IF NOT EXISTS learning_convocatoria_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS capacitaciones_learning_conv_uq
  ON public.capacitaciones (learning_convocatoria_id)
  WHERE learning_convocatoria_id IS NOT NULL;

COMMENT ON COLUMN public.capacitaciones.learning_convocatoria_id IS
  'Capacitación (convocatoria) de Nexus Learning vinculada. Se llena desde el módulo Nexus Learning.';

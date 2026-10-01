-- ============================================
-- NEXUS · 059_seguridad_revertir.sql
-- SOLO para emergencias: apaga el portero de 051 al instante, por
-- si después de activarlo algo dejara de funcionar.
-- Las contraseñas siguen cifradas (el login nuevo las entiende);
-- no hace falta deshacer nada más.
-- ============================================
ALTER ROLE authenticator RESET pgrst.db_pre_request;
NOTIFY pgrst, 'reload config';

-- =====================================================================
-- NEXUS · HABITACIONES · ETAPA 6 · PASILLO DISTINTO EN CADA PLANTA
-- Ejecutar UNA vez en Supabase de NEXUS → SQL Editor.
-- Es seguro ejecutarlo más de una vez. No borra ni cambia datos.
--
-- Ejemplo: planta baja con cuartos espalda con espalda (sin pasillo
-- interno) y plantas 2 y 3 con pasillo en medio.
--   pasillos_planta = {"1": "ninguno", "2": "central"}
-- La planta que no aparece usa el pasillo general del edificio.
-- =====================================================================

alter table public.viv_edificios
  add column if not exists pasillos_planta jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'viv_edificios_pasillos_planta_chk') then
    alter table public.viv_edificios add constraint viv_edificios_pasillos_planta_chk
      check (jsonb_typeof(pasillos_planta) = 'object');
  end if;
end $$;

-- Verificación
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'viv_edificios' and column_name = 'pasillos_planta';

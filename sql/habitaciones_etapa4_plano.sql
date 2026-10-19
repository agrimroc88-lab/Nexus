-- =====================================================================
-- NEXUS · HABITACIONES · ETAPA 4 · PLANO INTERIOR DE CADA PLANTA
-- Ejecutar UNA vez en Supabase de NEXUS → SQL Editor.
-- Es seguro ejecutarlo más de una vez. No borra ni cambia datos.
--
-- Guarda dónde va cada espacio en el plano (a ojo, cuadrícula 40 × 25)
-- y sus puertas: [{"l": "n|s|e|o", "p": 0.5}]  (pared y posición 0–1).
-- Vacío = el espacio todavía no está ubicado en el plano.
-- Usa los mismos permisos que ya tiene viv_espacios (no cambia la RLS).
-- =====================================================================

alter table public.viv_espacios
  add column if not exists plano_x smallint,
  add column if not exists plano_y smallint,
  add column if not exists plano_w smallint,
  add column if not exists plano_h smallint,
  add column if not exists plano_puertas jsonb not null default '[]'::jsonb;

-- Valores dentro de la cuadrícula (se ignoran si ya existen)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'viv_espacios_plano_chk') then
    alter table public.viv_espacios add constraint viv_espacios_plano_chk check (
      (plano_x is null and plano_y is null and plano_w is null and plano_h is null)
      or (plano_x between 0 and 39 and plano_y between 0 and 24
          and plano_w between 1 and 40 and plano_h between 1 and 25
          and plano_x + plano_w <= 40 and plano_y + plano_h <= 25)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'viv_espacios_puertas_chk') then
    alter table public.viv_espacios add constraint viv_espacios_puertas_chk
      check (jsonb_typeof(plano_puertas) = 'array' and jsonb_array_length(plano_puertas) <= 3);
  end if;
end $$;

-- Verificación: deben aparecer las 5 columnas
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'viv_espacios' and column_name like 'plano%'
order by column_name;

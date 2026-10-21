-- =====================================================================
-- NEXUS · 090 · CÉDULA EXTRANJERA (DNI, cédula de otro país o pasaporte)
-- Ejecutar UNA vez en Supabase de NEXUS → SQL Editor.
-- Es seguro ejecutarlo más de una vez. No borra ni cambia datos.
--
-- Antes: la cédula debía tener exactamente 10 dígitos (ecuatoriana).
-- Ahora también acepta documentos extranjeros: 5 a 20 letras o
-- números en mayúscula, sin espacios (ej.: DNI peruano 74424600).
-- Se aplica a trabajadores y personas externas (pacientes).
-- No toca usuarios_app (los usuarios del sistema siguen con 10 dígitos).
-- =====================================================================

do $$
declare
  r record;
begin
  -- Quita las reglas que exigían exactamente 10 dígitos en la cédula
  for r in
    select c.conrelid::regclass as tabla, c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and c.contype = 'c'
      and t.relname in ('trabajadores', 'personas_externas')
      and pg_get_constraintdef(c.oid) ilike '%cedula%'
  loop
    execute format('alter table %s drop constraint %I', r.tabla, r.conname);
    raise notice 'Regla quitada: %.%', r.tabla, r.conname;
  end loop;

  -- Nueva regla: ecuatoriana (10 dígitos) o documento extranjero
  if to_regclass('public.trabajadores') is not null then
    alter table public.trabajadores add constraint ck_cedula_formato
      check (cedula is null or cedula ~ '^[0-9]{10}$' or cedula ~ '^[A-Z0-9]{5,20}$');
  end if;
  if to_regclass('public.personas_externas') is not null then
    alter table public.personas_externas add constraint ck_pe_cedula_formato
      check (cedula is null or cedula ~ '^[0-9]{10}$' or cedula ~ '^[A-Z0-9]{5,20}$');
  end if;
end $$;

-- Verificación: reglas actuales sobre la cédula
select c.conrelid::regclass as tabla, c.conname as regla, pg_get_constraintdef(c.oid) as definicion
from pg_constraint c
where c.contype = 'c' and c.conrelid::regclass::text in ('trabajadores', 'personas_externas')
  and pg_get_constraintdef(c.oid) ilike '%cedula%';

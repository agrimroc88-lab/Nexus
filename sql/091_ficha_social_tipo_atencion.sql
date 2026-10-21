-- =====================================================================
-- NEXUS · 091 · TIPO DE ATENCIÓN EN LA FICHA SOCIAL
-- Ejecutar UNA vez en Supabase de NEXUS → SQL Editor.
-- Es seguro ejecutarlo más de una vez. No borra datos.
--
-- Cada ficha social cuenta sola en la pestaña Atenciones de Trabajo
-- Social, en el mes de su fecha y según su tipo. Las fichas que ya
-- existen quedan como «ingreso».
-- =====================================================================

alter table public.fichas_sociales
  add column if not exists tipo_atencion text not null default 'ingreso';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fichas_sociales_tipo_atencion_chk') then
    alter table public.fichas_sociales add constraint fichas_sociales_tipo_atencion_chk
      check (tipo_atencion in ('ingreso', 'periodica', 'asistencial', 'seguimiento'));
  end if;
end $$;

-- Verificación: cuántas fichas hay de cada tipo
select tipo_atencion, count(*) as fichas from public.fichas_sociales group by tipo_atencion;

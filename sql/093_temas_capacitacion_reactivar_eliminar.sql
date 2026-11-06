-- =====================================================================
-- NEXUS · 093 · TEMAS DE CAPACITACIÓN: RETIRAR, REACTIVAR Y ELIMINAR
-- Ejecutar en Supabase de NEXUS → SQL Editor. Es seguro ejecutarlo más de una vez.
--
-- · Retirar (✕ en «Faltan por cubrir» de GTH-09 o «Quitar tema»):
--   el tema deja de exigirse y el porcentaje de GTH-09 se recalcula.
-- · Reactivar: el tema vuelve a la lista y a GTH-09; si ya tenía
--   registro de asistencia, vuelve a contar como entregado.
-- · Eliminar (solo administrador/supervisor, solo temas retirados):
--   borra el tema y sus registros en todas las empresas.
-- =====================================================================

-- ¿Quien llama puede escribir en este ámbito?
create or replace function public.puede_gestionar_temas(p_ambito ambito_sst, p_solo_admin boolean default false)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_rol text;
  v_ok  boolean;
begin
  begin
    execute 'select public.rol_sesion()' into v_rol;
  exception when undefined_function then
    return true;   -- sin control de sesión (archivo 050 no ejecutado)
  end;
  if v_rol in ('admin', 'supervisor') then return true; end if;
  if p_solo_admin or v_rol is null then return false; end if;
  begin
    execute 'select public.puede_escribir_ambito($1)' into v_ok using p_ambito;
    return coalesce(v_ok, false);
  exception when undefined_function then
    return case p_ambito::text
      when 'salud' then v_rol in ('medico_ocupacional','enfermeria','psicologo','trabajo_social','psico_social','ergonomo')
      when 'seguridad' then v_rol in ('tecnico_sst','ergonomo')
      else false end;
  end;
end;
$$;

-- Recalcula el estado de GTH-09 en todas las empresas del ámbito
create or replace function public.recalcular_gth09(p_ambito ambito_sst)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_esperadas int;
begin
  select count(*) into v_esperadas from requisito_evidencias
  where requisito_codigo = 'GTH-09' and (ambito is null or ambito = p_ambito);

  update cumplimientos c set estado = x.nuevo
  from (
    select c2.id,
      (case
        when coalesce(e.n, 0) = 0 then 'pendiente'
        when v_esperadas > 0 and e.n >= v_esperadas then 'cumplido'
        else 'en_proceso'
      end)::estado_cumplimiento as nuevo
    from cumplimientos c2
    left join lateral (
      select count(distinct ce.evidencia_id) n from cumplimiento_enlaces ce
      where ce.cumplimiento_id = c2.id and ce.evidencia_id is not null
    ) e on true
    where c2.requisito_codigo = 'GTH-09' and c2.ambito = p_ambito and c2.estado <> 'no_aplica'
  ) x
  where c.id = x.id and c.estado is distinct from x.nuevo;
end;
$$;
revoke all on function public.recalcular_gth09(ambito_sst) from public, anon;

-- Retirar
create or replace function public.retirar_tema_capacitacion(p_tema uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t capacitacion_temas;
begin
  select * into t from capacitacion_temas where id = p_tema;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'El tema ya no existe.'); end if;
  if not public.puede_gestionar_temas(t.ambito) then
    return jsonb_build_object('ok', false, 'motivo', 'No tiene permiso para retirar temas.');
  end if;

  update capacitacion_temas set activo = false where id = p_tema;   -- el trigger lo saca de GTH-09
  perform public.recalcular_gth09(t.ambito);
  return jsonb_build_object('ok', true);
end;
$$;

-- Reactivar
create or replace function public.reactivar_tema_capacitacion(p_tema uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t    capacitacion_temas;
  v_ev uuid;
  c    record;
begin
  select * into t from capacitacion_temas where id = p_tema;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'El tema ya no existe.'); end if;
  if not public.puede_gestionar_temas(t.ambito) then
    return jsonb_build_object('ok', false, 'motivo', 'No tiene permiso para reactivar temas.');
  end if;

  update capacitacion_temas set activo = true where id = p_tema;   -- el trigger lo devuelve a GTH-09
  select id into v_ev from requisito_evidencias where requisito_codigo = 'GTH-09' and tema_id = p_tema;

  -- El tema vuelve a la lista de cada empresa y año que ya estaban abiertos
  insert into capacitaciones (empresa_id, tema_id, anio)
  select distinct c2.empresa_id, p_tema, c2.anio
  from capacitaciones c2 join capacitacion_temas t2 on t2.id = c2.tema_id
  where t2.ambito = t.ambito
  on conflict (empresa_id, tema_id, anio) do nothing;

  -- Documentos que quedaron como «Adicional» al retirarlo: vuelven a contar
  if v_ev is not null then
    update cumplimiento_enlaces ce set evidencia_id = v_ev
    from (
      select distinct on (ce2.cumplimiento_id) ce2.id
      from cumplimiento_enlaces ce2
      join cumplimientos cu on cu.id = ce2.cumplimiento_id
      where cu.requisito_codigo = 'GTH-09' and cu.ambito = t.ambito
        and ce2.evidencia_id is null
        and lower(btrim(ce2.etiqueta)) = lower(btrim(t.nombre))
        and not exists (select 1 from cumplimiento_enlaces x
                        where x.cumplimiento_id = ce2.cumplimiento_id and x.evidencia_id = v_ev)
      order by ce2.cumplimiento_id, ce2.fecha_registro desc nulls last, ce2.creado_en desc
    ) o
    where ce.id = o.id;
  end if;

  -- Registros de asistencia cargados (aunque se hayan cargado con el tema retirado)
  for c in
    select id from capacitaciones
    where tema_id = p_tema and url_registro is not null
    order by anio
  loop
    update capacitaciones set url_registro = url_registro where id = c.id;   -- dispara el reflejo en GTH-09
  end loop;

  -- Copias sueltas del mismo registro que ya quedaron vinculadas
  if v_ev is not null then
    delete from cumplimiento_enlaces ce
    using cumplimientos cu
    where cu.id = ce.cumplimiento_id
      and cu.requisito_codigo = 'GTH-09' and cu.ambito = t.ambito
      and ce.evidencia_id is null
      and lower(btrim(ce.etiqueta)) = lower(btrim(t.nombre))
      and exists (select 1 from cumplimiento_enlaces x
                  where x.cumplimiento_id = ce.cumplimiento_id and x.evidencia_id = v_ev and x.url = ce.url);
  end if;

  perform public.recalcular_gth09(t.ambito);
  return jsonb_build_object('ok', true);
end;
$$;

-- Eliminar definitivamente (solo temas ya retirados)
create or replace function public.eliminar_tema_capacitacion(p_tema uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t capacitacion_temas;
begin
  select * into t from capacitacion_temas where id = p_tema;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'El tema ya no existe.'); end if;
  if not public.puede_gestionar_temas(t.ambito, true) then
    return jsonb_build_object('ok', false, 'motivo', 'Solo el administrador puede eliminar temas.');
  end if;
  if t.activo then
    return jsonb_build_object('ok', false, 'motivo', 'Primero retire el tema; luego podrá eliminarlo.');
  end if;

  -- Documentos sueltos que dejó en GTH-09
  delete from cumplimiento_enlaces ce
  using cumplimientos cu
  where cu.id = ce.cumplimiento_id
    and cu.requisito_codigo = 'GTH-09' and cu.ambito = t.ambito
    and ce.evidencia_id is null
    and lower(btrim(ce.etiqueta)) = lower(btrim(t.nombre));

  delete from capacitacion_temas where id = p_tema;   -- borra sus capacitaciones (cascade)
  perform public.recalcular_gth09(t.ambito);
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.retirar_tema_capacitacion(uuid)   from public;
revoke all on function public.reactivar_tema_capacitacion(uuid) from public;
revoke all on function public.eliminar_tema_capacitacion(uuid)  from public;
grant execute on function public.retirar_tema_capacitacion(uuid)   to anon, authenticated;
grant execute on function public.reactivar_tema_capacitacion(uuid) to anon, authenticated;
grant execute on function public.eliminar_tema_capacitacion(uuid)  to anon, authenticated;

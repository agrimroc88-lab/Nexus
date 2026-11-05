-- =====================================================================
-- NEXUS · 092 · QUITAR UN MEDICAMENTO (O ELIMINAR UNA ATENCIÓN) SIN BORRAR EL KÁRDEX
-- Ejecutar en Supabase de NEXUS → SQL Editor. Es seguro ejecutarlo más de una vez.
--
-- El kárdex es inmutable (trg_kardex_inmutable): no se pueden borrar ni
-- cambiar sus movimientos. Antes, «Quitar» y «Eliminar atención»
-- intentaban BORRAR la salida y la regla lo impedía.
--
-- Ahora se registra un movimiento de AJUSTE + al mismo lote, por la misma
-- cantidad, con la nota «Devolución…». El saldo vuelve solo y el kárdex
-- conserva la historia completa: salida por la atención → devolución.
--
-- Solo el ADMINISTRADOR puede quitar medicamentos o eliminar atenciones
-- (también se revisa aquí, no solo en la página).
-- =====================================================================

-- ¿Quien llama es administrador? (si aún no existe el control de sesión
-- del archivo 050, se deja pasar: la página ya oculta los botones)
create or replace function public.es_admin_sesion()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_rol text;
begin
  begin
    execute 'select public.rol_sesion()' into v_rol;
  exception when undefined_function then
    return true;
  end;
  return coalesce(v_rol, '') = 'admin';
end;
$$;

create or replace function public.quitar_medicamento_atencion(p_atencion_medicamento_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  am      record;
  k       record;
  v_fecha date;
begin
  if not public.es_admin_sesion() then
    return jsonb_build_object('ok', false, 'motivo', 'Solo el administrador puede quitar medicamentos de una atención.');
  end if;
  select * into am from atencion_medicamentos where id = p_atencion_medicamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'Ese medicamento ya no está en la atención.');
  end if;

  -- Si se entregó: devolución al mismo lote con un ajuste positivo
  if am.kardex_id is not null then
    select * into k from kardex where id = am.kardex_id;
    if found then
      select fecha into v_fecha from atenciones where id = am.atencion_id;
      insert into kardex (empresa_id, medicamento_id, lote_id, tipo, fecha, cantidad, observacion)
      values (k.empresa_id, k.medicamento_id, k.lote_id, 'ajuste_positivo', current_date, k.cantidad,
              'Devolución: se quitó de la atención del ' || to_char(coalesce(v_fecha, k.fecha), 'DD/MM/YYYY'));
    end if;
  end if;

  delete from atencion_medicamentos where id = p_atencion_medicamento_id;
  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.eliminar_atencion(p_atencion_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  k        record;
  v_insumo record;
  v_fecha  date;
begin
  if not public.es_admin_sesion() then
    return jsonb_build_object('ok', false, 'motivo', 'Solo el administrador puede eliminar una atención.');
  end if;
  select fecha into v_fecha from atenciones where id = p_atencion_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'La atención ya no existe.');
  end if;

  /* Medicamentos entregados: devolución al mismo lote con un ajuste
     positivo (el kárdex no se borra; el saldo se recalcula solo). */
  for k in
    select kx.* from atencion_medicamentos am
    join kardex kx on kx.id = am.kardex_id
    where am.atencion_id = p_atencion_id
  loop
    insert into kardex (empresa_id, medicamento_id, lote_id, tipo, fecha, cantidad, observacion)
    values (k.empresa_id, k.medicamento_id, k.lote_id, 'ajuste_positivo', current_date, k.cantidad,
            'Devolución: se eliminó la atención del ' || to_char(coalesce(v_fecha, k.fecha), 'DD/MM/YYYY'));
  end loop;

  delete from atencion_medicamentos where atencion_id = p_atencion_id;

  /* Insumos entregados: llevan un campo fijo de stock, así que se
     devuelve la cantidad antes de borrar el consumo (igual que antes). */
  for v_insumo in
    select insumo_id, cantidad from insumos_kardex
    where atencion_id = p_atencion_id and tipo = 'salida_consumo'
  loop
    update insumos set stock_disponible = stock_disponible + v_insumo.cantidad
    where id = v_insumo.insumo_id;
  end loop;

  delete from insumos_kardex where atencion_id = p_atencion_id;
  delete from atencion_diagnosticos where atencion_id = p_atencion_id;
  delete from atenciones where id = p_atencion_id;

  return jsonb_build_object('ok', true);
end;
$function$;

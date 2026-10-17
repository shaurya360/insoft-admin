-- =====================================================================
-- 002 — Vendor point of contact (POC)
-- vendors.name / phone / address are the company details
-- (phone = owner mobile). Adds an optional contact person + number.
-- =====================================================================

begin;

alter table public.vendors
  add column if not exists poc_name  text check (poc_name is null or length(poc_name) <= 160),
  add column if not exists poc_phone text check (poc_phone is null or length(poc_phone) <= 40);

comment on column public.vendors.name      is 'Company name';
comment on column public.vendors.phone     is 'Owner mobile';
comment on column public.vendors.poc_name  is 'Our point of contact at the vendor';
comment on column public.vendors.poc_phone is 'Point of contact number';

-- Recreate the directory view + search function to include the POC fields.
drop function if exists public.search_vendors(uuid, uuid, text);
drop view if exists public.vendor_directory;

create view public.vendor_directory with (security_invoker = true) as
select v.id, v.name, v.phone, v.address, v.created_at, v.updated_at,
       coalesce((
         select jsonb_agg(jsonb_build_object(
                  'category_id', c.id,
                  'category',    c.name,
                  'brands', coalesce((
                     select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) order by lower(b.name))
                     from public.vendor_offerings o2
                     join public.brands b on b.id = o2.brand_id
                     where o2.vendor_id = v.id and o2.category_id = c.id), '[]'::jsonb))
                order by lower(c.name))
         from public.categories c
         where exists (select 1 from public.vendor_offerings o
                       where o.vendor_id = v.id and o.category_id = c.id)
       ), '[]'::jsonb) as offerings,
       coalesce((select sum(pv.balance) from public.payables_view pv where pv.vendor_id = v.id), 0)::numeric(14,2)
         as outstanding,
       v.poc_name, v.poc_phone
from public.vendors v;

create function public.search_vendors(
  p_category_id uuid default null, p_brand_id uuid default null, p_query text default null)
returns setof public.vendor_directory
language plpgsql stable set search_path = '' as $$
declare
  v_q      text := public.clean_text(p_query);
  v_like   text;
  v_digits text;
begin
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_digits := regexp_replace(v_q, '\D', '', 'g');
  end if;
  return query
  select d.*
  from public.vendor_directory d
  where (
          (p_category_id is null and p_brand_id is null)
          or exists (select 1 from public.vendor_offerings o
                     where o.vendor_id = d.id
                       and (p_category_id is null or o.category_id = p_category_id)
                       and (p_brand_id is null or o.brand_id = p_brand_id))
        )
    and (
          v_q is null
          or d.name ilike v_like
          or d.address ilike v_like
          or d.poc_name ilike v_like
          or (length(v_digits) >= 3 and (public.phone_key(d.phone) like '%' || v_digits || '%'
                                         or public.phone_key(d.poc_phone) like '%' || v_digits || '%'))
          or exists (select 1
                     from public.vendor_offerings o
                     join public.categories c on c.id = o.category_id
                     left join public.brands b on b.id = o.brand_id
                     where o.vendor_id = d.id
                       and (c.name ilike v_like or b.name ilike v_like))
        )
  order by lower(d.name);
end $$;

-- save_vendor gains the POC parameters.
drop function if exists public.save_vendor(uuid, text, text, text, jsonb);

create function public.save_vendor(
  p_id uuid, p_name text, p_phone text, p_address text, p_offerings jsonb,
  p_poc_name text default null, p_poc_phone text default null)
returns uuid language plpgsql set search_path = '' as $$
declare
  v_id    uuid;
  v_item  jsonb;
  v_cat   uuid;
  v_brand text;
begin
  if not public.is_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if public.clean_text(p_name) is null then
    raise exception 'Company name is required' using errcode = 'check_violation';
  end if;
  if p_offerings is not null and jsonb_typeof(p_offerings) <> 'array' then
    raise exception 'Offerings must be a list';
  end if;

  if p_id is null then
    insert into public.vendors (name, phone, address, poc_name, poc_phone)
    values (public.clean_text(p_name), public.clean_text(p_phone), nullif(btrim(coalesce(p_address, '')), ''),
            public.clean_text(p_poc_name), public.clean_text(p_poc_phone))
    returning id into v_id;
  else
    update public.vendors
       set name = public.clean_text(p_name),
           phone = public.clean_text(p_phone),
           address = nullif(btrim(coalesce(p_address, '')), ''),
           poc_name = public.clean_text(p_poc_name),
           poc_phone = public.clean_text(p_poc_phone)
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Vendor not found'; end if;
  end if;

  delete from public.vendor_offerings where vendor_id = v_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_offerings, '[]'::jsonb)) loop
    continue when public.clean_text(v_item ->> 'category') is null;
    v_cat := public.ensure_category(v_item ->> 'category');
    if jsonb_typeof(v_item -> 'brands') <> 'array'
       or not exists (select 1 from jsonb_array_elements_text(v_item -> 'brands') b
                      where public.clean_text(b) is not null) then
      insert into public.vendor_offerings (vendor_id, category_id, brand_id)
      values (v_id, v_cat, null) on conflict do nothing;
    else
      for v_brand in select jsonb_array_elements_text(v_item -> 'brands') loop
        continue when public.clean_text(v_brand) is null;
        insert into public.vendor_offerings (vendor_id, category_id, brand_id)
        values (v_id, v_cat, public.ensure_brand(v_brand)) on conflict do nothing;
      end loop;
    end if;
  end loop;

  return v_id;
end $$;

-- Grants (same rules as 001)
revoke all on public.vendor_directory from anon;
grant select on public.vendor_directory to authenticated;
revoke execute on function public.search_vendors(uuid, uuid, text) from public, anon;
grant execute on function public.search_vendors(uuid, uuid, text) to authenticated;
revoke execute on function public.save_vendor(uuid, text, text, text, jsonb, text, text) from public, anon;
grant execute on function public.save_vendor(uuid, text, text, text, jsonb, text, text) to authenticated;

commit;

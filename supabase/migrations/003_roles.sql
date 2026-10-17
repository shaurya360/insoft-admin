-- =====================================================================
-- 003 — Roles: admin and employee
--
--   admin    : everything (as before)
--   employee : quotations, clients, vendor directory (add / edit).
--              NO access to payables, receivables, payments or any
--              finance totals. Cannot delete vendors, clients or
--              saved quotations.
--
-- Replaces public.app_admins with public.app_users (user_id, role).
-- Existing admins are carried over as 'admin'.
-- =====================================================================

begin;

-- 1. Users + roles ------------------------------------------------------
create table if not exists public.app_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null check (role in ('admin', 'employee')),
  created_at timestamptz not null default now()
);
alter table public.app_users enable row level security;
revoke all on public.app_users from anon, authenticated;   -- not editable through the API

insert into public.app_users (user_id, role, created_at)
select user_id, 'admin', created_at from public.app_admins
on conflict (user_id) do nothing;

-- 2. Role helpers (security definer: they read app_users, which the API cannot)
create or replace function public.my_role()
returns text language sql stable security definer set search_path = '' as $$
  select role from public.app_users where user_id = (select auth.uid());
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users where user_id = (select auth.uid()) and role = 'admin');
$$;

-- any signed-in user who has a role (admin or employee)
create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_users where user_id = (select auth.uid()));
$$;

drop table public.app_admins;

-- 3. Shared (non-finance) tables: members read/write, only admins delete ----
do $$
declare t text;
begin
  foreach t in array array['vendors', 'clients', 'categories', 'brands', 'vendor_offerings', 'quotations'] loop
    execute format('drop policy if exists admin_select on public.%I', t);
    execute format('drop policy if exists admin_insert on public.%I', t);
    execute format('drop policy if exists admin_update on public.%I', t);
    execute format('drop policy if exists admin_delete on public.%I', t);
    execute format($p$create policy member_select on public.%I for select to authenticated
                      using ((select public.is_member()))$p$, t);
    execute format($p$create policy member_insert on public.%I for insert to authenticated
                      with check ((select public.is_member()))$p$, t);
    execute format($p$create policy member_update on public.%I for update to authenticated
                      using ((select public.is_member())) with check ((select public.is_member()))$p$, t);
  end loop;

  -- deletes: admin only, except vendor_offerings (save_vendor rewrites a vendor's offerings)
  foreach t in array array['vendors', 'clients', 'categories', 'brands', 'quotations'] loop
    execute format($p$create policy admin_delete on public.%I for delete to authenticated
                      using ((select public.is_admin()))$p$, t);
  end loop;
  create policy member_delete on public.vendor_offerings for delete to authenticated
    using ((select public.is_member()));
end $$;

-- Finance tables (payables, receivables, *_payments) keep their admin-only
-- policies from 001; the finance views are security_invoker, so employees
-- see no rows through them either.

-- 4. Functions -------------------------------------------------------------
-- save_vendor: allowed for any member (was admin-only)
create or replace function public.save_vendor(
  p_id uuid, p_name text, p_phone text, p_address text, p_offerings jsonb,
  p_poc_name text default null, p_poc_phone text default null)
returns uuid language plpgsql set search_path = '' as $$
declare
  v_id    uuid;
  v_item  jsonb;
  v_cat   uuid;
  v_brand text;
begin
  if not public.is_member() then
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

-- dashboard_stats: finance figures only for admins (null for employees)
create or replace function public.dashboard_stats()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'role',                   public.my_role(),
    'vendors',                (select count(*) from public.vendors),
    'clients',                (select count(*) from public.clients),
    'quotations',             (select count(*) from public.quotations),
    'payable_outstanding',    case when public.is_admin() then (select coalesce(sum(balance), 0) from public.payables_view) end,
    'payable_paid',           case when public.is_admin() then (select coalesce(sum(amount_paid), 0) from public.payables_view) end,
    'receivable_outstanding', case when public.is_admin() then (select coalesce(sum(balance), 0) from public.receivables_view) end,
    'receivable_received',    case when public.is_admin() then (select coalesce(sum(amount_paid), 0) from public.receivables_view) end
  );
$$;

-- vendor_directory.outstanding is computed from payables_view (security_invoker),
-- so it is always 0 for employees — no finance data leaks through the directory.

revoke execute on function public.my_role(), public.is_member() from public, anon;
grant execute on function public.my_role(), public.is_member() to authenticated;

commit;

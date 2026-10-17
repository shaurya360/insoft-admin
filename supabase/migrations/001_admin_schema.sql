-- =====================================================================
-- INSOFT Admin — core schema
-- Shared vendors / clients, vendor offerings (category + brand),
-- payables / receivables with payment history, quotations.
--
-- Safe to run once on a fresh project or on the project that still
-- holds the tables from the earlier attempt (they are archived into the
-- `legacy` schema — nothing is deleted).
-- =====================================================================

begin;

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 0. Archive tables from the earlier attempt (data is preserved)
--    The `legacy` schema is not exposed through the Supabase API.
-- ---------------------------------------------------------------------
create schema if not exists legacy;
revoke all on schema legacy from public, anon, authenticated;

do $$
begin
  -- old vendors table had a free-text `products` array
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'vendors' and column_name = 'products') then
    alter table public.vendors set schema legacy;
  end if;
  -- old clients table used integer ids
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'clients'
               and column_name = 'id' and data_type = 'integer') then
    alter table public.clients set schema legacy;
  end if;
  if to_regclass('public.money_records') is not null then
    alter table public.money_records set schema legacy;
  end if;
end $$;

alter table if exists legacy.vendors       enable row level security;
alter table if exists legacy.clients       enable row level security;
alter table if exists legacy.money_records enable row level security;

-- ---------------------------------------------------------------------
-- 1. Administrator allow-list
--    Only users listed here can touch business data. Not readable or
--    writable through the API (RLS on, no policies).
-- ---------------------------------------------------------------------
create table if not exists public.app_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_admins where user_id = (select auth.uid()));
$$;

-- ---------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Collapse whitespace; used for names.
create or replace function public.clean_text(p text)
returns text language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), '');
$$;

-- Last 10 digits of a phone number (+91 98765 43210 -> 9876543210).
create or replace function public.phone_key(p text)
returns text language sql immutable set search_path = '' as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '');
$$;

-- ---------------------------------------------------------------------
-- 3. Vendors, clients, categories, brands, offerings
-- ---------------------------------------------------------------------
create table public.vendors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (public.clean_text(name) is not null and length(name) <= 160),
  phone      text check (phone is null or length(phone) <= 40),
  address    text check (address is null or length(address) <= 500),
  phone_key  text generated always as (public.phone_key(phone)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Duplicate protection: the same phone number cannot belong to two vendors;
-- two vendors without a phone cannot share the same name.
create unique index vendors_phone_key_uq on public.vendors (phone_key)
  where phone_key is not null and length(phone_key) >= 7;
create unique index vendors_name_nophone_uq on public.vendors (lower(public.clean_text(name)))
  where phone_key is null or length(phone_key) < 7;
create index vendors_name_idx on public.vendors (lower(name));
create trigger vendors_updated_at before update on public.vendors
  for each row execute function public.set_updated_at();

create table public.clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (public.clean_text(name) is not null and length(name) <= 160),
  phone      text check (phone is null or length(phone) <= 40),
  address    text check (address is null or length(address) <= 500),
  phone_key  text generated always as (public.phone_key(phone)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index clients_phone_key_uq on public.clients (phone_key)
  where phone_key is not null and length(phone_key) >= 7;
create unique index clients_name_nophone_uq on public.clients (lower(public.clean_text(name)))
  where phone_key is null or length(phone_key) < 7;
create index clients_name_idx on public.clients (lower(name));
create trigger clients_updated_at before update on public.clients
  for each row execute function public.set_updated_at();

create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (public.clean_text(name) is not null and length(name) <= 80),
  created_at timestamptz not null default now()
);
create unique index categories_name_uq on public.categories (lower(public.clean_text(name)));

create table public.brands (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (public.clean_text(name) is not null and length(name) <= 80),
  created_at timestamptz not null default now()
);
create unique index brands_name_uq on public.brands (lower(public.clean_text(name)));

-- One row = one brand supplied by one vendor in one category.
-- brand_id may be null when a vendor supplies a category without a specific brand.
create table public.vendor_offerings (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references public.vendors (id) on delete cascade,
  category_id uuid not null references public.categories (id) on delete restrict,
  brand_id    uuid references public.brands (id) on delete restrict,
  created_at  timestamptz not null default now(),
  constraint vendor_offerings_uq unique nulls not distinct (vendor_id, category_id, brand_id)
);
create index vendor_offerings_category_idx on public.vendor_offerings (category_id, brand_id);
create index vendor_offerings_brand_idx on public.vendor_offerings (brand_id);

-- ---------------------------------------------------------------------
-- 4. Payables (I owe vendors) and receivables (clients owe me)
--    Amount paid/received is always derived from the payment tables.
-- ---------------------------------------------------------------------
create table public.payables (
  id               uuid primary key default gen_random_uuid(),
  vendor_id        uuid not null references public.vendors (id) on delete restrict,
  description      text not null check (public.clean_text(description) is not null and length(description) <= 300),
  total_amount     numeric(14,2) not null check (total_amount > 0),
  transaction_date date not null default current_date,
  due_date         date,
  notes            text check (notes is null or length(notes) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (due_date is null or due_date >= transaction_date)
);
create index payables_vendor_idx on public.payables (vendor_id);
create index payables_txn_date_idx on public.payables (transaction_date);
create trigger payables_updated_at before update on public.payables
  for each row execute function public.set_updated_at();

create table public.payable_payments (
  id           uuid primary key default gen_random_uuid(),
  payable_id   uuid not null references public.payables (id) on delete restrict,
  amount       numeric(14,2) not null check (amount > 0),
  payment_date date not null default current_date,
  notes        text check (notes is null or length(notes) <= 1000),
  created_at   timestamptz not null default now()
);
create index payable_payments_payable_idx on public.payable_payments (payable_id);

create table public.receivables (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete restrict,
  description      text not null check (public.clean_text(description) is not null and length(description) <= 300),
  total_amount     numeric(14,2) not null check (total_amount > 0),
  transaction_date date not null default current_date,
  due_date         date,
  notes            text check (notes is null or length(notes) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (due_date is null or due_date >= transaction_date)
);
create index receivables_client_idx on public.receivables (client_id);
create index receivables_txn_date_idx on public.receivables (transaction_date);
create trigger receivables_updated_at before update on public.receivables
  for each row execute function public.set_updated_at();

create table public.receivable_payments (
  id            uuid primary key default gen_random_uuid(),
  receivable_id uuid not null references public.receivables (id) on delete restrict,
  amount        numeric(14,2) not null check (amount > 0),
  payment_date  date not null default current_date,
  notes         text check (notes is null or length(notes) <= 1000),
  created_at    timestamptz not null default now()
);
create index receivable_payments_receivable_idx on public.receivable_payments (receivable_id);

-- Payments may not exceed the remaining balance. The parent row is locked
-- (FOR UPDATE) so two concurrent payments cannot both slip through.
create or replace function public.check_payable_payment()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_total numeric(14,2);
  v_paid  numeric(14,2);
begin
  select total_amount into v_total from public.payables where id = new.payable_id for update;
  if not found then
    raise exception 'Payable record not found';
  end if;
  select coalesce(sum(amount), 0) into v_paid
    from public.payable_payments where payable_id = new.payable_id and id <> new.id;
  if v_paid + new.amount > v_total then
    raise exception 'Payment exceeds the remaining balance (remaining: %)', v_total - v_paid
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payable_payments_check before insert or update on public.payable_payments
  for each row execute function public.check_payable_payment();

create or replace function public.check_receivable_payment()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_total numeric(14,2);
  v_paid  numeric(14,2);
begin
  select total_amount into v_total from public.receivables where id = new.receivable_id for update;
  if not found then
    raise exception 'Receivable record not found';
  end if;
  select coalesce(sum(amount), 0) into v_paid
    from public.receivable_payments where receivable_id = new.receivable_id and id <> new.id;
  if v_paid + new.amount > v_total then
    raise exception 'Receipt exceeds the remaining balance (remaining: %)', v_total - v_paid
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger receivable_payments_check before insert or update on public.receivable_payments
  for each row execute function public.check_receivable_payment();

-- The total of a record cannot be reduced below what was already paid.
create or replace function public.check_payable_total()
returns trigger language plpgsql set search_path = '' as $$
declare v_paid numeric(14,2);
begin
  select coalesce(sum(amount), 0) into v_paid from public.payable_payments where payable_id = new.id;
  if new.total_amount < v_paid then
    raise exception 'Total amount cannot be less than the amount already paid (%)', v_paid
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger payables_total_check before update of total_amount on public.payables
  for each row execute function public.check_payable_total();

create or replace function public.check_receivable_total()
returns trigger language plpgsql set search_path = '' as $$
declare v_paid numeric(14,2);
begin
  select coalesce(sum(amount), 0) into v_paid from public.receivable_payments where receivable_id = new.id;
  if new.total_amount < v_paid then
    raise exception 'Total amount cannot be less than the amount already received (%)', v_paid
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger receivables_total_check before update of total_amount on public.receivables
  for each row execute function public.check_receivable_total();

-- ---------------------------------------------------------------------
-- 5. Quotations / purchase orders (from the quotation generator)
--    party_name / party_address are a snapshot of what was printed.
-- ---------------------------------------------------------------------
create table public.quotations (
  id            uuid primary key default gen_random_uuid(),
  ref_no        text not null check (public.clean_text(ref_no) is not null and length(ref_no) <= 60),
  doc_type      text not null default 'QUOTATION' check (doc_type in ('QUOTATION', 'PURCHASE ORDER')),
  client_id     uuid references public.clients (id) on delete set null,
  vendor_id     uuid references public.vendors (id) on delete set null,
  party_name    text,
  party_address text,
  doc_date      date not null default current_date,
  items         jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  terms         jsonb not null default '{}'::jsonb check (jsonb_typeof(terms) = 'object'),
  subtotal      numeric(14,2) not null default 0,
  gst_amount    numeric(14,2) not null default 0,
  grand_total   numeric(14,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint quotations_ref_uq unique (ref_no),
  constraint quotations_one_party check (client_id is null or vendor_id is null)
);
create index quotations_client_idx on public.quotations (client_id);
create index quotations_vendor_idx on public.quotations (vendor_id);
create index quotations_date_idx on public.quotations (doc_date desc);
create trigger quotations_updated_at before update on public.quotations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 6. Read views (security_invoker => caller's RLS applies)
-- ---------------------------------------------------------------------
create view public.payables_view with (security_invoker = true) as
select p.id, p.vendor_id, p.description, p.total_amount, p.transaction_date, p.due_date,
       p.notes, p.created_at, p.updated_at,
       v.name  as party_name,
       v.phone as party_phone,
       coalesce(s.paid, 0)::numeric(14,2)                  as amount_paid,
       (p.total_amount - coalesce(s.paid, 0))::numeric(14,2) as balance,
       case when coalesce(s.paid, 0) >= p.total_amount then 'Paid'
            when coalesce(s.paid, 0) > 0 then 'Partially Paid'
            else 'Unpaid' end                              as status,
       s.last_payment_date,
       coalesce(s.payment_count, 0)::int                   as payment_count
from public.payables p
join public.vendors v on v.id = p.vendor_id
left join (
  select payable_id, sum(amount) as paid, max(payment_date) as last_payment_date, count(*) as payment_count
  from public.payable_payments group by payable_id
) s on s.payable_id = p.id;

create view public.receivables_view with (security_invoker = true) as
select r.id, r.client_id, r.description, r.total_amount, r.transaction_date, r.due_date,
       r.notes, r.created_at, r.updated_at,
       c.name  as party_name,
       c.phone as party_phone,
       coalesce(s.paid, 0)::numeric(14,2)                  as amount_paid,
       (r.total_amount - coalesce(s.paid, 0))::numeric(14,2) as balance,
       case when coalesce(s.paid, 0) >= r.total_amount then 'Paid'
            when coalesce(s.paid, 0) > 0 then 'Partially Paid'
            else 'Unpaid' end                              as status,
       s.last_payment_date,
       coalesce(s.payment_count, 0)::int                   as payment_count
from public.receivables r
join public.clients c on c.id = r.client_id
left join (
  select receivable_id, sum(amount) as paid, max(payment_date) as last_payment_date, count(*) as payment_count
  from public.receivable_payments group by receivable_id
) s on s.receivable_id = r.id;

-- Vendor with its offerings grouped by category, plus outstanding balance.
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
         as outstanding
from public.vendors v;

-- Distinct category/brand pairs actually in use (drives the filter dropdowns).
create view public.offering_pairs with (security_invoker = true) as
select distinct o.category_id, o.brand_id
from public.vendor_offerings o;

-- ---------------------------------------------------------------------
-- 7. RPC functions (security invoker: RLS still applies)
-- ---------------------------------------------------------------------
create or replace function public.ensure_category(p_name text)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid; v_name text := public.clean_text(p_name);
begin
  if v_name is null then raise exception 'Category name is required'; end if;
  select id into v_id from public.categories where lower(public.clean_text(name)) = lower(v_name);
  if v_id is null then
    insert into public.categories (name) values (v_name)
      on conflict ((lower(public.clean_text(name)))) do nothing
      returning id into v_id;
    if v_id is null then
      select id into v_id from public.categories where lower(public.clean_text(name)) = lower(v_name);
    end if;
  end if;
  return v_id;
end $$;

create or replace function public.ensure_brand(p_name text)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid; v_name text := public.clean_text(p_name);
begin
  if v_name is null then raise exception 'Brand name is required'; end if;
  select id into v_id from public.brands where lower(public.clean_text(name)) = lower(v_name);
  if v_id is null then
    insert into public.brands (name) values (v_name)
      on conflict ((lower(public.clean_text(name)))) do nothing
      returning id into v_id;
    if v_id is null then
      select id into v_id from public.brands where lower(public.clean_text(name)) = lower(v_name);
    end if;
  end if;
  return v_id;
end $$;

-- Create or update a vendor together with its offerings, atomically.
-- p_offerings: [{"category": "Lighting", "brands": ["Philips", "Havells"]}, ...]
create or replace function public.save_vendor(
  p_id uuid, p_name text, p_phone text, p_address text, p_offerings jsonb)
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
    raise exception 'Vendor name is required' using errcode = 'check_violation';
  end if;
  if p_offerings is not null and jsonb_typeof(p_offerings) <> 'array' then
    raise exception 'Offerings must be a list';
  end if;

  if p_id is null then
    insert into public.vendors (name, phone, address)
    values (public.clean_text(p_name), public.clean_text(p_phone), nullif(btrim(coalesce(p_address, '')), ''))
    returning id into v_id;
  else
    update public.vendors
       set name = public.clean_text(p_name),
           phone = public.clean_text(p_phone),
           address = nullif(btrim(coalesce(p_address, '')), '')
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

-- Vendor search: category / brand filters use the offering relationships;
-- free-text search matches name, phone, category or brand.
create or replace function public.search_vendors(
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
          or (length(v_digits) >= 3 and public.phone_key(d.phone) like '%' || v_digits || '%')
          or exists (select 1
                     from public.vendor_offerings o
                     join public.categories c on c.id = o.category_id
                     left join public.brands b on b.id = o.brand_id
                     where o.vendor_id = d.id
                       and (c.name ilike v_like or b.name ilike v_like))
        )
  order by lower(d.name);
end $$;

-- Create a payable plus an optional initial payment in one transaction.
create or replace function public.create_payable(
  p_vendor_id uuid, p_description text, p_total_amount numeric,
  p_transaction_date date, p_due_date date default null, p_notes text default null,
  p_initial_amount numeric default null, p_initial_date date default null)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  insert into public.payables (vendor_id, description, total_amount, transaction_date, due_date, notes)
  values (p_vendor_id, public.clean_text(p_description), p_total_amount,
          coalesce(p_transaction_date, current_date), p_due_date, nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  if coalesce(p_initial_amount, 0) > 0 then
    insert into public.payable_payments (payable_id, amount, payment_date, notes)
    values (v_id, p_initial_amount, coalesce(p_initial_date, p_transaction_date, current_date), 'Initial payment');
  elsif p_initial_amount < 0 then
    raise exception 'Payment amount cannot be negative' using errcode = 'check_violation';
  end if;
  return v_id;
end $$;

create or replace function public.create_receivable(
  p_client_id uuid, p_description text, p_total_amount numeric,
  p_transaction_date date, p_due_date date default null, p_notes text default null,
  p_initial_amount numeric default null, p_initial_date date default null)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  insert into public.receivables (client_id, description, total_amount, transaction_date, due_date, notes)
  values (p_client_id, public.clean_text(p_description), p_total_amount,
          coalesce(p_transaction_date, current_date), p_due_date, nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  if coalesce(p_initial_amount, 0) > 0 then
    insert into public.receivable_payments (receivable_id, amount, payment_date, notes)
    values (v_id, p_initial_amount, coalesce(p_initial_date, p_transaction_date, current_date), 'Initial receipt');
  elsif p_initial_amount < 0 then
    raise exception 'Receipt amount cannot be negative' using errcode = 'check_violation';
  end if;
  return v_id;
end $$;

-- Next serial for refs like INS/2026/007.
create or replace function public.next_quotation_serial(p_year int)
returns int language sql stable set search_path = '' as $$
  select coalesce(max((regexp_match(ref_no, '^INS/' || p_year || '/(\d+)$'))[1]::int), 0) + 1
  from public.quotations
  where ref_no like 'INS/' || p_year || '/%';
$$;

create or replace function public.dashboard_stats()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'vendors',              (select count(*) from public.vendors),
    'clients',              (select count(*) from public.clients),
    'quotations',           (select count(*) from public.quotations),
    'payable_outstanding',  (select coalesce(sum(balance), 0) from public.payables_view),
    'payable_paid',         (select coalesce(sum(amount_paid), 0) from public.payables_view),
    'receivable_outstanding', (select coalesce(sum(balance), 0) from public.receivables_view),
    'receivable_received',  (select coalesce(sum(amount_paid), 0) from public.receivables_view)
  );
$$;

-- ---------------------------------------------------------------------
-- 8. Row Level Security — only listed administrators
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['vendors', 'clients', 'categories', 'brands', 'vendor_offerings',
                           'payables', 'receivables', 'quotations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format($p$create policy admin_select on public.%I for select to authenticated
                      using ((select public.is_admin()))$p$, t);
    execute format($p$create policy admin_insert on public.%I for insert to authenticated
                      with check ((select public.is_admin()))$p$, t);
    execute format($p$create policy admin_update on public.%I for update to authenticated
                      using ((select public.is_admin())) with check ((select public.is_admin()))$p$, t);
    execute format($p$create policy admin_delete on public.%I for delete to authenticated
                      using ((select public.is_admin()))$p$, t);
  end loop;

  -- Payment history: insert and delete (to correct a mistake) only, never edit in place.
  foreach t in array array['payable_payments', 'receivable_payments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, delete on public.%I to authenticated', t);
    execute format($p$create policy admin_select on public.%I for select to authenticated
                      using ((select public.is_admin()))$p$, t);
    execute format($p$create policy admin_insert on public.%I for insert to authenticated
                      with check ((select public.is_admin()))$p$, t);
    execute format($p$create policy admin_delete on public.%I for delete to authenticated
                      using ((select public.is_admin()))$p$, t);
  end loop;

  foreach t in array array['payables_view', 'receivables_view', 'vendor_directory', 'offering_pairs'] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- Functions: callable by signed-in users only (each one is still gated by
-- is_admin() or by RLS on the tables it touches).
revoke execute on function
  public.is_admin(),
  public.ensure_category(text),
  public.ensure_brand(text),
  public.save_vendor(uuid, text, text, text, jsonb),
  public.search_vendors(uuid, uuid, text),
  public.create_payable(uuid, text, numeric, date, date, text, numeric, date),
  public.create_receivable(uuid, text, numeric, date, date, text, numeric, date),
  public.next_quotation_serial(int),
  public.dashboard_stats()
from public, anon;

grant execute on function
  public.is_admin(),
  public.ensure_category(text),
  public.ensure_brand(text),
  public.save_vendor(uuid, text, text, text, jsonb),
  public.search_vendors(uuid, uuid, text),
  public.create_payable(uuid, text, numeric, date, date, text, numeric, date),
  public.create_receivable(uuid, text, numeric, date, date, text, numeric, date),
  public.next_quotation_serial(int),
  public.dashboard_stats()
to authenticated;

revoke execute on function
  public.set_updated_at(), public.check_payable_payment(), public.check_receivable_payment(),
  public.check_payable_total(), public.check_receivable_total()
from public, anon, authenticated;

commit;

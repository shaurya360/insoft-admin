-- =====================================================================
-- 005 — Read-only vendor export for Google Sheets
--
-- export_vendors(p_key) returns the vendor directory (company, owner mobile,
-- address, point of contact, categories and brands) — no payables, balances,
-- clients or any other data. It is callable with the public anon key, but only
-- returns rows when p_key matches the secret export key, whose SHA-256 hash is
-- stored in private.export_keys (a schema not exposed through the API).
--
-- Set or rotate the key (run in the SQL editor; keep the plain key secret):
--   insert into private.export_keys (name, key_hash)
--   values ('vendor_sheet', encode(extensions.digest('<new key>', 'sha256'), 'hex'))
--   on conflict (name) do update set key_hash = excluded.key_hash, rotated_at = now();
-- =====================================================================

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.export_keys (
  name       text primary key,
  key_hash   text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  rotated_at timestamptz not null default now()
);
revoke all on private.export_keys from public, anon, authenticated;

create or replace function public.export_vendors(p_key text)
returns table (
  company      text,
  owner_mobile text,
  address      text,
  poc_name     text,
  poc_phone    text,
  categories   text,
  brands       text,
  updated_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  select k.key_hash into v_hash from private.export_keys k where k.name = 'vendor_sheet';
  if v_hash is null
     or p_key is null
     or length(p_key) < 32
     or encode(extensions.digest(p_key, 'sha256'), 'hex') <> v_hash then
    raise exception 'Invalid export key' using errcode = '28000';
  end if;

  return query
  select v.name,
         v.phone,
         v.address,
         v.poc_name,
         v.poc_phone,
         coalesce((select string_agg(c.name, ', ' order by lower(c.name))
                   from public.categories c
                   where exists (select 1 from public.vendor_offerings o
                                 where o.vendor_id = v.id and o.category_id = c.id)), ''),
         -- "Category: Brand, Brand; Category: Brand"
         coalesce((select string_agg(x.line, '; ' order by x.sort)
                   from (select lower(c.name) as sort,
                                c.name || ': ' || string_agg(b.name, ', ' order by lower(b.name)) as line
                         from public.vendor_offerings o
                         join public.categories c on c.id = o.category_id
                         join public.brands b on b.id = o.brand_id
                         where o.vendor_id = v.id
                         group by c.name) x), ''),
         v.updated_at
  from public.vendors v
  order by lower(v.name);
end;
$$;

revoke all on function public.export_vendors(text) from public;
grant execute on function public.export_vendors(text) to anon, authenticated;

commit;

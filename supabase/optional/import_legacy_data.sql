-- OPTIONAL: import rows from the earlier attempt (archived in the `legacy` schema
-- by 001_admin_schema.sql) into the new tables.
--
-- NOTE: the 15 vendors in legacy.vendors were seeded TEST data by the old backend
-- ("Apex Tech Solutions", ...). Only run this if those records are real, or
-- delete the unwanted legacy rows first. Run in the SQL Editor (as postgres).
-- Legacy tables are not modified.

begin;

-- Clients (skip if same phone or same name already exists)
insert into public.clients (name, phone, address)
select public.clean_text(l.name), public.clean_text(l.phone), nullif(btrim(l.address), '')
from legacy.clients l
where public.clean_text(l.name) is not null
  and not exists (
    select 1 from public.clients c
    where lower(c.name) = lower(public.clean_text(l.name))
       or (length(c.phone_key) >= 7 and c.phone_key = public.phone_key(l.phone)));

-- Vendors + offerings ("Category|Brand" strings → real relationships)
do $$
declare r record; v uuid; p text;
begin
  for r in select * from legacy.vendors loop
    select id into v from public.vendors
     where (length(phone_key) >= 7 and phone_key = public.phone_key(r.phone))
        or lower(name) = lower(public.clean_text(r.name))
     limit 1;
    if v is null then
      insert into public.vendors (name, phone, address)
      values (public.clean_text(r.name), public.clean_text(r.phone), nullif(btrim(r.address), ''))
      returning id into v;
    end if;
    foreach p in array coalesce(r.products, '{}') loop
      continue when public.clean_text(split_part(p, '|', 1)) is null;
      insert into public.vendor_offerings (vendor_id, category_id, brand_id)
      values (v, public.ensure_category(split_part(p, '|', 1)),
              case when public.clean_text(split_part(p, '|', 2)) is not null
                   then public.ensure_brand(split_part(p, '|', 2)) end)
      on conflict do nothing;
    end loop;
  end loop;
end $$;

-- Money records: direction 'to_us' → client receivable, otherwise → vendor payable.
-- Records marked 'paid' get one payment entry for the full amount.
do $$
declare r record; party uuid; rec uuid; d date; due date;
begin
  for r in select * from legacy.money_records where amount > 0 loop
    d := r.created_at::date;
    due := case when r.due_date ~ '^\d{4}-\d{2}-\d{2}$' and r.due_date::date >= d then r.due_date::date end;
    if r.direction = 'to_us' then
      select id into party from public.clients where lower(name) = lower(public.clean_text(r.party_name)) limit 1;
      if party is null then
        insert into public.clients (name, phone, address)
        values (public.clean_text(r.party_name), public.clean_text(r.phone), nullif(btrim(r.address), ''))
        returning id into party;
      end if;
      insert into public.receivables (client_id, description, total_amount, transaction_date, due_date, notes)
      values (party, coalesce(public.clean_text(r.notes), 'Imported record #' || r.id), r.amount, d, due,
              'Imported from the previous system')
      returning id into rec;
      if r.status = 'paid' then
        insert into public.receivable_payments (receivable_id, amount, payment_date, notes)
        values (rec, r.amount, d, 'Marked paid in the previous system');
      end if;
    else
      select id into party from public.vendors where lower(name) = lower(public.clean_text(r.party_name)) limit 1;
      if party is null then
        insert into public.vendors (name, phone, address)
        values (public.clean_text(r.party_name), public.clean_text(r.phone), nullif(btrim(r.address), ''))
        returning id into party;
      end if;
      insert into public.payables (vendor_id, description, total_amount, transaction_date, due_date, notes)
      values (party, coalesce(public.clean_text(r.notes), 'Imported record #' || r.id), r.amount, d, due,
              'Imported from the previous system')
      returning id into rec;
      if r.status = 'paid' then
        insert into public.payable_payments (payable_id, amount, payment_date, notes)
        values (rec, r.amount, d, 'Marked paid in the previous system');
      end if;
    end if;
  end loop;
end $$;

commit;

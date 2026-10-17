-- TEST DATA — dummy vendors, clients, payables, receivables and payments.
-- Test vendor phones are +91 98100 100xx and test client phones are +91 98200 200xx,
-- so supabase/optional/remove_test_data.sql deletes exactly these rows.
-- Dates are relative to today. Run in the SQL Editor (as postgres).
-- Safe to re-run: previous test rows are removed first.

begin;

-- 0. remove earlier test rows ------------------------------------------------
delete from public.payable_payments where payable_id in (
  select p.id from public.payables p join public.vendors v on v.id = p.vendor_id where v.phone_key like '98100100%');
delete from public.payables where vendor_id in (select id from public.vendors where phone_key like '98100100%');
delete from public.receivable_payments where receivable_id in (
  select r.id from public.receivables r join public.clients c on c.id = r.client_id where c.phone_key like '98200200%');
delete from public.receivables where client_id in (select id from public.clients where phone_key like '98200200%');
delete from public.vendors where phone_key like '98100100%';
delete from public.clients where phone_key like '98200200%';

-- 1. vendors with category → brand offerings ---------------------------------
do $$
declare
  v jsonb; o jsonb; b text; vid uuid;
  data jsonb := $json$[
    {"name": "Nehru Place IT Hub", "phone": "+91 98100 10001", "poc_name": "Rohit Malhotra", "poc_phone": "+91 98110 22001", "address": "Shop 12, Nehru Place, New Delhi - 110019",
     "offers": [{"c": "Laptops", "b": ["HP", "Dell", "Lenovo"]}, {"c": "Monitors", "b": ["Dell", "LG"]}]},
    {"name": "Shree Ganesh Computers", "phone": "+91 98100 10002", "poc_name": "Suresh Gupta", "poc_phone": "+91 98110 22002", "address": "Lajpat Rai Market, Chandni Chowk, Delhi - 110006",
     "offers": [{"c": "Laptops", "b": ["HP", "Acer"]}, {"c": "Printers", "b": ["HP", "Canon", "Epson"]}]},
    {"name": "Delhi Network Solutions", "phone": "+91 98100 10003", "poc_name": "Imran Khan", "poc_phone": "+91 98110 22003", "address": "Okhla Industrial Area Phase 2, New Delhi - 110020",
     "offers": [{"c": "Networking", "b": ["Cisco", "TP-Link", "D-Link"]}, {"c": "CCTV", "b": ["Hikvision", "CP Plus"]}]},
    {"name": "PowerSafe Systems", "phone": "+91 98100 10004", "poc_name": "Neha Verma", "poc_phone": "+91 98110 22004", "address": "Sector 63, Noida, Uttar Pradesh - 201301",
     "offers": [{"c": "UPS", "b": ["APC", "Luminous"]}, {"c": "Batteries", "b": ["Exide", "Amaron"]}]},
    {"name": "Bright Lights Traders", "phone": "+91 98100 10005", "poc_name": "Amit Jain", "poc_phone": null, "address": "Bhagirath Palace, Chandni Chowk, Delhi - 110006",
     "offers": [{"c": "Lighting", "b": ["Philips", "Havells"]}]},
    {"name": "Lumina Electricals", "phone": "+91 98100 10006", "address": "Karol Bagh, New Delhi - 110005",
     "offers": [{"c": "Lighting", "b": ["Havells", "Wipro"]}, {"c": "Fans", "b": ["Havells", "Crompton"]}]},
    {"name": "Polycab Wire House", "phone": "+91 98100 10007", "poc_name": "Vikas Sharma", "poc_phone": "+91 98110 22007", "address": "Lal Kuan, Ghaziabad, Uttar Pradesh - 201009",
     "offers": [{"c": "Wires", "b": ["Polycab", "Finolex"]}, {"c": "Switches", "b": ["Anchor", "Legrand"]}]},
    {"name": "Om Peripherals", "phone": "+91 98100 10008", "address": "Gaffar Market, Karol Bagh, New Delhi - 110005",
     "offers": [{"c": "Keyboards & Mice", "b": ["Logitech", "HP"]}, {"c": "Monitors", "b": ["Samsung", "LG"]}, {"c": "Cables & Accessories", "b": []}]}
  ]$json$;
begin
  for v in select * from jsonb_array_elements(data) loop
    insert into public.vendors (name, phone, address, poc_name, poc_phone)
    values (v->>'name', v->>'phone', v->>'address', v->>'poc_name', v->>'poc_phone') returning id into vid;
    for o in select * from jsonb_array_elements(v->'offers') loop
      if jsonb_array_length(o->'b') = 0 then
        insert into public.vendor_offerings (vendor_id, category_id, brand_id)
        values (vid, public.ensure_category(o->>'c'), null) on conflict do nothing;
      else
        for b in select jsonb_array_elements_text(o->'b') loop
          insert into public.vendor_offerings (vendor_id, category_id, brand_id)
          values (vid, public.ensure_category(o->>'c'), public.ensure_brand(b)) on conflict do nothing;
        end loop;
      end if;
    end loop;
  end loop;
end $$;

-- 2. clients ----------------------------------------------------------------
insert into public.clients (name, phone, address) values
  ('Spice Money Ltd',           '+91 98200 20001', 'Spice Tower, Sector 18, Noida, Uttar Pradesh - 201301'),
  ('BuildWell Infra',           '+91 98200 20002', 'Whitefield, Bengaluru, Karnataka - 560066'),
  ('Sharma & Associates',       '+91 98200 20003', 'Chartered Accountants, Lajpat Nagar II, New Delhi - 110024'),
  ('Green Valley Public School','+91 98200 20004', 'Sector 45, Gurugram, Haryana - 122003'),
  ('Metro Diagnostics',         '+91 98200 20005', 'Sector 16, Faridabad, Haryana - 121002'),
  ('Apex Logistics Pvt Ltd',    '+91 98200 20006', 'Site IV, Sahibabad, Ghaziabad, Uttar Pradesh - 201010');

-- 3. vendor payables (offsets are days from today) ---------------------------
insert into public.payables (vendor_id, description, total_amount, transaction_date, due_date, notes)
select v.id, x.descr, x.total, current_date + x.txn, current_date + x.due, 'Test data'
from (values
  ('Nehru Place IT Hub',      'Invoice NPH/1182 — 10× HP ProBook laptops',         520000.00, -40, -10),
  ('Shree Ganesh Computers',  'Invoice SGC/0457 — 4× Canon printers',               86400.00, -25,   5),
  ('Delhi Network Solutions', 'Invoice DNS/2209 — Cisco switches & cabling',       145000.00, -10,  20),
  ('PowerSafe Systems',       'Invoice PSS/0098 — 6× APC UPS 1 kVA',                63900.00, -60, -30),
  ('Bright Lights Traders',   'Bill BLT/341 — Philips LED panels (office fit-out)', 48250.50,  -7,  23),
  ('Polycab Wire House',      'Bill PWH/7781 — Polycab 2.5 sq mm wire, 20 coils',   37800.00,  -3, null::int),
  ('Lumina Electricals',      'Bill LE/119 — Havells ceiling fans',                 22500.00, -90, -60)
) as x(vendor, descr, total, txn, due)
join public.vendors v on v.name = x.vendor and v.phone_key like '98100100%';

insert into public.payable_payments (payable_id, amount, payment_date, notes)
select p.id, y.amt, current_date + y.d, y.note
from (values
  ('Invoice NPH/1182 — 10× HP ProBook laptops',         200000.00, -35, 'NEFT — first instalment'),
  ('Invoice NPH/1182 — 10× HP ProBook laptops',         120000.00, -12, 'NEFT — second instalment'),
  ('Invoice SGC/0457 — 4× Canon printers',               86400.00,  -5, 'Cheque no. 004512'),
  ('Invoice PSS/0098 — 6× APC UPS 1 kVA',                30000.00, -50, 'UPI'),
  ('Bill PWH/7781 — Polycab 2.5 sq mm wire, 20 coils',   10000.00,  -3, 'Advance (cash)'),
  ('Bill LE/119 — Havells ceiling fans',                 22500.00, -70, 'NEFT')
) as y(descr, amt, d, note)
join public.payables p on p.description = y.descr and p.notes = 'Test data';

-- 4. client receivables -------------------------------------------------------
insert into public.receivables (client_id, description, total_amount, transaction_date, due_date, notes)
select c.id, x.descr, x.total, current_date + x.txn, current_date + x.due, 'Test data'
from (values
  ('Spice Money Ltd',            'INS/2026/014 — 25× Dell Latitude laptops',      1475000.00, -30,   0),
  ('BuildWell Infra',            'INS/2026/017 — Site networking & CCTV',          312000.00, -45, -15),
  ('Sharma & Associates',        'INS/2026/019 — 3× HP printers + AMC',             74340.00, -20,  -5),
  ('Green Valley Public School', 'INS/2026/021 — Computer lab, 15 desktops',       618000.00, -12,  18),
  ('Metro Diagnostics',          'INS/2026/022 — UPS & batteries',                  95580.00,  -5,  25),
  ('Apex Logistics Pvt Ltd',     'INS/2026/009 — Annual maintenance contract',      59000.00, -100, -70),
  ('Spice Money Ltd',            'INS/2026/024 — 10× Samsung 24" monitors',        177000.00,  -2,  28)
) as x(client, descr, total, txn, due)
join public.clients c on c.name = x.client and c.phone_key like '98200200%';

insert into public.receivable_payments (receivable_id, amount, payment_date, notes)
select r.id, y.amt, current_date + y.d, y.note
from (values
  ('INS/2026/014 — 25× Dell Latitude laptops',   500000.00, -28, 'Advance — RTGS'),
  ('INS/2026/014 — 25× Dell Latitude laptops',   475000.00,  -6, 'RTGS — on delivery'),
  ('INS/2026/017 — Site networking & CCTV',      100000.00, -40, 'Advance — cheque'),
  ('INS/2026/019 — 3× HP printers + AMC',         74340.00,  -2, 'NEFT — full'),
  ('INS/2026/022 — UPS & batteries',              20000.00,  -5, 'UPI advance'),
  ('INS/2026/009 — Annual maintenance contract',  59000.00, -80, 'NEFT — full')
) as y(descr, amt, d, note)
join public.receivables r on r.description = y.descr and r.notes = 'Test data';

commit;

-- Summary
select 'vendors' as what, count(*) from public.vendors where phone_key like '98100100%'
union all select 'clients', count(*) from public.clients where phone_key like '98200200%'
union all select 'payables', count(*) from public.payables where notes = 'Test data'
union all select 'receivables', count(*) from public.receivables where notes = 'Test data';

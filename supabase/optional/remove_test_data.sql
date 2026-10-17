-- Removes the rows created by seed_test_data.sql (test vendor phones +91 98100 100xx,
-- test client phones +91 98200 200xx) and their payables/receivables/payments.
-- Real records are not touched. Run in the SQL Editor (as postgres).

begin;

delete from public.payable_payments where payable_id in (
  select p.id from public.payables p join public.vendors v on v.id = p.vendor_id where v.phone_key like '98100100%');
delete from public.payables where vendor_id in (select id from public.vendors where phone_key like '98100100%');
delete from public.receivable_payments where receivable_id in (
  select r.id from public.receivables r join public.clients c on c.id = r.client_id where c.phone_key like '98200200%');
delete from public.receivables where client_id in (select id from public.clients where phone_key like '98200200%');
delete from public.vendors where phone_key like '98100100%';   -- offerings are removed with the vendor
delete from public.clients where phone_key like '98200200%';   -- quotations keep their printed name

-- Categories / brands no longer used by any vendor
delete from public.categories c where not exists (select 1 from public.vendor_offerings o where o.category_id = c.id);
delete from public.brands b where not exists (select 1 from public.vendor_offerings o where o.brand_id = b.id);

commit;

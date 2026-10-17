-- =====================================================================
-- 004 — Website enquiries
-- The public website (insofttechnology.in) saves contact-form submissions
-- here through submit_enquiry(). Visitors can only insert via that
-- function; only signed-in admin/employee users can read or update.
-- =====================================================================

begin;

create table public.enquiries (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (public.clean_text(name) is not null and length(name) <= 120),
  phone       text check (phone is null or length(phone) <= 40),
  email       text check (email is null or length(email) <= 200),
  company     text check (company is null or length(company) <= 160),
  topic       text check (topic is null or length(topic) <= 80),
  message     text not null check (public.clean_text(message) is not null and length(message) <= 4000),
  status      text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  source      text not null default 'website' check (length(source) <= 40),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (phone is not null or email is not null)
);
create index enquiries_created_idx on public.enquiries (created_at desc);
create index enquiries_status_idx on public.enquiries (status);
create trigger enquiries_updated_at before update on public.enquiries
  for each row execute function public.set_updated_at();

alter table public.enquiries enable row level security;
revoke all on public.enquiries from anon;
grant select, update, delete on public.enquiries to authenticated;   -- inserts only via submit_enquiry()
create policy member_select on public.enquiries for select to authenticated using ((select public.is_member()));
create policy member_update on public.enquiries for update to authenticated
  using ((select public.is_member())) with check ((select public.is_member()));
create policy admin_delete on public.enquiries for delete to authenticated using ((select public.is_admin()));

-- Public entry point. Validates input and limits floods:
--   at most 5 enquiries per phone/email per hour, 60 per hour overall.
create or replace function public.submit_enquiry(
  p_name text, p_phone text, p_email text, p_company text, p_topic text, p_message text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_phone text := public.clean_text(p_phone);
  v_email text := lower(public.clean_text(p_email));
  v_id    uuid;
begin
  if public.clean_text(p_name) is null then
    raise exception 'Please enter your name.' using errcode = 'check_violation';
  end if;
  if public.clean_text(p_message) is null then
    raise exception 'Please enter a message.' using errcode = 'check_violation';
  end if;
  if v_phone is null and v_email is null then
    raise exception 'Please enter a phone number or email address.' using errcode = 'check_violation';
  end if;
  if v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) not between 7 and 15 then
    raise exception 'Please enter a valid phone number.' using errcode = 'check_violation';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Please enter a valid email address.' using errcode = 'check_violation';
  end if;

  if (select count(*) from public.enquiries
      where created_at > now() - interval '1 hour'
        and ((v_phone is not null and public.phone_key(phone) = public.phone_key(v_phone))
          or (v_email is not null and email = v_email))) >= 5
     or (select count(*) from public.enquiries where created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many enquiries — please call or WhatsApp us instead.' using errcode = 'P0001';
  end if;

  insert into public.enquiries (name, phone, email, company, topic, message)
  values (left(public.clean_text(p_name), 120), left(v_phone, 40), left(v_email, 200),
          left(public.clean_text(p_company), 160), left(public.clean_text(p_topic), 80),
          left(btrim(p_message), 4000))
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.submit_enquiry(text, text, text, text, text, text) from public;
grant execute on function public.submit_enquiry(text, text, text, text, text, text) to anon, authenticated;

commit;

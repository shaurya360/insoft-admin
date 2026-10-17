-- Grant administrator access to the single admin account.
-- 1. Create the user first: Supabase Dashboard → Authentication → Users → "Add user"
--    → "Create new user" (tick "Auto Confirm User").
-- 2. Replace the email below and run this in the SQL Editor.

insert into public.app_admins (user_id)
select id from auth.users where lower(email) = lower('admin@example.com')
on conflict do nothing;

-- Should return exactly one row:
select a.user_id, u.email, a.created_at
from public.app_admins a join auth.users u on u.id = a.user_id;

-- Add (or change) a user of the admin app.
--
-- 1. Create the login: Supabase Dashboard → Authentication → Users → "Add user"
--    → "Create new user" (tick "Auto Confirm User"). Give the person their email + password.
-- 2. Set the email and role below, then run this in the SQL Editor.
--      'admin'    → everything, including Money Manager and finance totals
--      'employee' → quotations, clients and vendor directory only (no finance, no deleting)
--    Running it again for the same email changes that person's role.

insert into public.app_users (user_id, role)
select id, 'employee'                      -- ← 'admin' or 'employee'
from auth.users where lower(email) = lower('person@example.com')   -- ← their email
on conflict (user_id) do update set role = excluded.role;

-- Everyone who can use the app:
select u.email, a.role, a.created_at
from public.app_users a join auth.users u on u.id = a.user_id
order by a.role, u.email;

-- To remove someone's access (keeps their login):
--   delete from public.app_users where user_id = (select id from auth.users where lower(email) = lower('person@example.com'));
-- To delete the login entirely: Authentication → Users → … → Delete user.

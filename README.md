# INSOFT Admin

Private admin dashboard for INSOFT TECHNOLOGY with three features on one Supabase database:

- **Quotation Generator.** Your existing generator, unchanged in how it calculates, previews, prints and exports PDFs. It now also has login protection, a picker for saved clients/vendors, and saving to the database.
- **Money Manager.** Vendor payables and client receivables, with partial payments and a full payment history.
- **Vendor Directory.** Find vendors by product category and brand.

Vendors and clients are stored once and shared by all three features.

---

## 1. How it is built

| Part | Choice | Why |
|---|---|---|
| Frontend | Plain HTML, CSS and JavaScript modules, no framework | Matches the existing generator, so it runs unchanged. No build toolchain to maintain. |
| Data | Supabase Postgres | One central database |
| Login | Supabase Auth (email + password), single admin, no signup page | |
| Security | Row Level Security on every table, plus an `app_admins` allow-list | Hiding pages is not security; the database itself refuses everyone else |
| Hosting | Any static host (Vercel config included) | No server to run |

```
insoft-admin-app/
├── index.html            → redirects to dashboard (which redirects to login if signed out)
├── login.html            → sign-in page
├── dashboard.html        → feature cards, live totals, upcoming dues
├── quotation.html        → the existing generator + admin integration
├── money.html            → Money Manager (#payables, #receivables, #clients)
├── vendors.html          → Vendor Directory
├── logo.jpg
├── css/   base.css (page globals) · app.css (components) · quotation.css (generator integration only)
├── js/    supabase.js (client + auth guard) · ui.js · layout.js · entities.js (shared vendor/client forms)
│   └── pages/  login · dashboard · money · vendors · quotation
├── supabase/
│   ├── migrations/001_admin_schema.sql   ← schema, triggers, views, functions, RLS
│   ├── setup_admin.sql                   ← add a user / set their role (admin or employee)
│   └── optional/import_legacy_data.sql   ← import rows from the old attempt (optional)
├── scripts/  build-config.mjs · dev-server.mjs
├── .env.example
└── vercel.json
```

---

## 2. Setup

### 2.1 Database (already applied to project `zllvrsgkywsembcxfpnd`)

`supabase/migrations/001_admin_schema.sql` through `005_vendor_sheet_export.sql` have **already been run** on your project. For a new project, open **SQL Editor → New query** and run each file once, in order.

What it did to the earlier attempt's tables (`vendors`, `clients`, `money_records`):

- Moved them unchanged into a schema called `legacy`. Nothing was deleted.
- That schema is not reachable through the API.
- Their RLS was turned **on**. Before this, those tables had RLS off, so anyone holding the anon key could read and change them.

`legacy.vendors` holds the 15 test vendors the old backend seeded automatically. They were **not** imported. If any old rows are real, review and run `supabase/optional/import_legacy_data.sql`.

> ⚠️ If the old Express backend (`insoft-admin-backend`) is still deployed, **shut it down**. On startup it runs `CREATE TABLE IF NOT EXISTS money_records …`, which would recreate a table with RLS off in `public`.

### 2.2 Create the single administrator account

1. Supabase Dashboard → **Authentication → Users → Add user → Create new user**.
   - Enter your email and a strong password.
   - Tick **Auto Confirm User**.
2. Turn off public signups: **Authentication → Sign In / Providers → "Allow new users to sign up" → off**.
   - This is extra protection. Even if signups stayed on, a new account could not see or change any data, because every policy checks `app_admins`.
3. Open `supabase/setup_admin.sql`, set your email and the role `'admin'`, and run it in the SQL Editor.

To change the password later, use the dashboard (**Users → … → Send password recovery**), or update it there directly.

### 2.2a Users and roles

Two roles are enforced in the database (`supabase/migrations/003_roles.sql`):

| | Admin | Employee |
|---|---|---|
| Quotation Generator | ✓ | ✓ |
| Vendor Directory (search, add, edit) | ✓ | ✓, with no owed amounts or payables |
| Clients (add, edit) | ✓ | ✓, via the quotation page |
| Money Manager, payables, receivables, payments, finance totals, dues | ✓ | ✗ |
| Delete vendors, clients, saved quotations | ✓ | ✗ |

**To add a user:**
1. Create their login under **Authentication → Users → Add user**, ticking *Auto Confirm User*.
2. Run `supabase/setup_admin.sql` with their email and either `'admin'` or `'employee'`.
   - Running it again for the same email changes their role.
   - Deleting the login removes their access.

### 2.3 Configure the app

```bash
cd insoft-admin-app
cp .env.example .env
```

Fill in `.env` from **Project Settings → API Keys**:

```
SUPABASE_URL=https://zllvrsgkywsembcxfpnd.supabase.co
SUPABASE_ANON_KEY=<anon / publishable key>
```

The anon/publishable key is **meant to be public**: it ends up in the browser, and the data stays protected by RLS. **Never** use the `service_role`/secret key; `build-config.mjs` refuses to run if you do. The database password is not used by the app.

### 2.4 Run locally

Requires Node 18+. There are no npm dependencies.

```bash
npm run dev        # writes js/config.js from .env, serves on http://localhost:5173
```

Pages use JavaScript modules, so open them through this server rather than as `file://`.

### 2.5 Deploy (Vercel)

1. Push `insoft-admin-app/` to a Git repo. `.env` and `js/config.js` are git-ignored.
2. Import it in Vercel. `vercel.json` already sets the build command (`npm run build`) and the output folder (`dist`).
3. In **Settings → Environment Variables**, add `SUPABASE_URL` and `SUPABASE_ANON_KEY`, then deploy.
4. In Supabase, open **Authentication → URL Configuration** and set **Site URL** to your Vercel URL. Password recovery emails use it.

Any other static host also works: run `npm run build` and upload the contents of `dist/`.

---

## 3. Database design

```
vendors ──< vendor_offerings >── categories
                 │
                 └──────────────> brands          (one row = vendor × category × brand)

vendors ──< payables ──< payable_payments
clients ──< receivables ──< receivable_payments
clients / vendors ──< quotations                  (client_id OR vendor_id, plus a snapshot of the printed name/address)
auth.users ──< app_admins                         (admin allow-list)
```

How this differs from the proposed schema, and why:

- **Two payment tables** (`payable_payments`, `receivable_payments`) instead of one shared table. Each has a real foreign key to its parent record, so a payment can never point at the wrong kind of record.
- **`vendor_offerings.brand_id` may be null.** This covers a vendor who supplies a category without any specific brand. A `UNIQUE NULLS NOT DISTINCT (vendor_id, category_id, brand_id)` constraint prevents duplicate offerings.
- **`phone_key`** is a generated column holding the last 10 digits of the phone number. It drives duplicate protection:
  - No two vendors (or two clients) can share a phone number.
  - Two records **without** a phone cannot share a name.
  - Matching names *with* different phones are allowed: the form warns and asks you to confirm.
- **Amount paid is never stored.** It is always the sum of the payment rows, and `payables_view` / `receivables_view` derive the paid amount, balance and status from them. There is no second copy that could drift.
- **`quotations`** is a new table; the generator had no storage before. It saves the form exactly as entered (items, terms, totals) and links to a shared client or vendor. Purchase orders usually go to vendors, so both are selectable.
- **Money** uses `numeric(14,2)` everywhere. The browser does its sums in integer paise.

Financial integrity is enforced in the database, not just in the UI:

- Payment amounts must be greater than 0.
- Triggers lock the parent row (`SELECT … FOR UPDATE`) and reject any payment that would exceed the remaining balance, even when two payments arrive at the same time.
- A record's total cannot be edited below what has already been paid.
- The due date cannot be before the transaction date.
- `create_payable` / `create_receivable` insert the record and its optional initial payment in one transaction.
- Payments cannot be edited in place; there is no UPDATE grant. They can be deleted to correct a mistake, after a confirmation dialog.
- Records that have payments cannot be deleted. Neither can vendors or clients that have payables or receivables (`ON DELETE RESTRICT`).

Security:

- Every table has RLS on, with policies `TO authenticated USING (is_admin())`.
- `is_admin()` checks the `app_admins` table. That table has no API policies, so nobody can add themselves through the API.
- Anonymous users have no grants on any table, view or function.
- Views use `security_invoker` so RLS applies through them.
- Functions use `SET search_path = ''`.

---

## 4. Using the app

- **Login.** Email and password. Sessions persist across refreshes; logging out from any page ends the session. Internal pages redirect to the login page, then back to the page you asked for.
- **Dashboard.** Vendor count, client count, outstanding payable and outstanding receivable (all live totals), plus the next balances due.
- **Money Manager**
  - **Add New Vendor / Add New Client** buttons at the top. Vendors and clients can also be added while creating a record.
  - **Vendor Payables / Client Receivables** tabs: search, filter by vendor or client, status and date range, with filtered totals in the table footer.
  - Click a row to see its full payment history, record a payment, edit, or delete. A record can only be deleted while it has no payments.
  - Summary cards show the **remaining balance** (outstanding) separately from the total already paid or received.
  - **Clients** tab: edit or delete clients, or start a new receivable for one.
- **Vendor details**
  - **Company details:** Company name (required), Owner mobile, and Address.
  - **Point of contact:** the person you deal with there, with their contact number.
  - Everything except the company name is optional.
  - Every number has Call, WhatsApp and Copy buttons. WhatsApp opens `wa.me`, and 10-digit numbers are treated as Indian (+91).
  - The card's main **WhatsApp** / **Call** buttons go to the point of contact if one is set, otherwise to the owner.
  - Clients have WhatsApp buttons in the Money Manager → Clients list and in record details.
- **Vendor Directory**
  - Category filter, plus a brand filter whose options narrow to brands in the selected category.
  - Free-text search across name, category, brand, phone and address.
  - Filtering runs in the database on the actual relationships (`search_vendors`).
  - Each vendor card has Call, Copy phone, Details and Edit. Details shows the outstanding balance and recent payables.
  - Filters are kept in the URL, so you can bookmark them.
- **Quotation Generator**
  - Start typing in **Company / Person Name** to see matching saved clients and vendors. Picking one fills in the name and address and links the document to that record.
  - You can still type any name; "Save as new client" adds it to the shared list.
  - **Save** stores the document.
  - **Download PDF** saves it too, then moves the Ref No. on to the next number (for example 002 → 003) for your next document. The form contents stay, so a similar quotation is quick to make; click **New** for a blank one.
  - A document reopened from **Saved documents** keeps its own number when downloaded again. That list also lets you duplicate or delete saved documents.
  - The reference number continues from the higher of: the last saved document, or the serial the generator stored in this browser before.

### Test data

- `supabase/optional/seed_test_data.sql` loads dummy data: 8 vendors with categories and brands, 6 clients, and 7 payables plus 7 receivables with payments. Re-running it resets that data.
- `supabase/optional/remove_test_data.sql` deletes only that data. Test vendor phone numbers are `+91 98100 100xx` and test client numbers are `+91 98200 200xx`.

### Vendor list in Google Sheets

The vendor directory can be copied into a Google Sheet that refreshes every hour. The copy has company, owner mobile, address, contact person, contact number, categories and brands. Clients, payables, balances and payments are **not** included.

How it works:
- The script in `google-sheets/VendorSync.gs` runs inside your Google account (Apps Script). It calls the database function `export_vendors(p_key)` (migration 005).
- That function only returns data for the correct export key. It is read-only and returns nothing else.
- The key is stored only as a SHA-256 hash in `private.export_keys`, a schema the API can't reach. The plain key is in the git-ignored `.env.db` as `VENDOR_SHEET_EXPORT_KEY`.

Setup:
1. Create a Google Sheet. Choose **Extensions → Apps Script**, replace the code with `google-sheets/VendorSync.gs`, and save.
2. Under **Project Settings → Script properties**, add `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `VENDOR_EXPORT_KEY`.
3. Select `installHourlySync` and click **Run**. Allow access when Google asks. This syncs immediately and then every hour.
4. Reload the sheet. The **Insoft → Sync vendors now** menu runs a sync on demand.

The sheet is a copy. Add and edit vendors in the admin app; manual edits in the sheet are overwritten by the next sync.

To rotate the key (for example, if it was shared by mistake), run the SQL in the header of `005_vendor_sheet_export.sql` with a new random key, then update the script property.

---

## 5. Known limitations

- **One currency, fixed GST.** INR only, with GST fixed at 18% as in the original generator.
- **Overpayment is not supported.** You can't record more than the remaining balance; enter an advance as a separate record.
- **No link between quotations and receivables.** Turning a quotation into a receivable is manual: create the receivable in the Money Manager.
- **No vendor change on existing records.** Editing a record keeps its vendor or client. If one was chosen wrongly, delete the record (only possible while it has no payments) and create it again.
- **Browser-side filtering in the Money Manager.** Its lists are loaded in full (paged past the 1,000-row API limit) and filtered in the browser. This is fast for thousands of records; for far larger volumes it would need server-side paging.
- **Unescaped item names in the preview.** The original generator inserts item names into the preview without HTML-escaping. That code was deliberately left unchanged. It only affects what you type yourself.
- **CDN dependencies.** Fonts and libraries (Supabase JS, html2pdf) load from CDNs, so you need internet access.

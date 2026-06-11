# SpendWell

Budgets & spending, beautifully tracked. A lightweight budgeting app: import bank CSVs or auto-sync a Google Sheet, auto-categorise transactions, and track monthly/yearly (optionally rolling) budgets.

## Architecture

```
index.html          App shell (loads pinned, integrity-checked CDN libs)
styles.css          All styling
js/config.js        Public Supabase config (URL + anon key) — safe to commit
js/storage.js       Persistence & auth: Supabase cloud mode, or local encrypted vault
js/app.js           UI + domain logic (charts, import, budgets, categories)
supabase/schema.sql Database table + Row Level Security policies
vercel.json         Security headers (CSP etc.) for Vercel
spendwell-v1.html   Legacy single-file version (kept for reference; not deployed)
```

The frontend is a static site (no build step). Authentication and storage are handled by **Supabase**:

- **Passwords** are hashed and verified by Supabase Auth (bcrypt) — they never touch this codebase and are never stored in plain text.
- **Sessions** are JWT access + refresh tokens managed by `supabase-js` (auto-refresh, revocable).
- **Data isolation** is enforced server-side with Postgres **Row Level Security**: every query runs as the signed-in user, and the policies in `schema.sql` only ever match `auth.uid() = user_id`. One user can never read another's rows, even with the public API key.
- **Cross-device sync**: state is stored per-user in the `user_state` table with an optimistic `rev` counter; if two devices write concurrently the app detects it, reloads, and tells you.

If `js/config.js` is left empty the app runs in **local mode**: the original behaviour, where data is AES-GCM-encrypted with a passphrase (PBKDF2, 310k iterations) and kept in that browser only.

## Setup

### 1. Supabase (database + auth)

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste the contents of `supabase/schema.sql`, **Run**.
3. In **Authentication → Sign In / Up**, make sure **Email** provider is enabled.
   - "Confirm email" ON (recommended): users must click an emailed link before signing in.
4. In **Authentication → URL Configuration**, set **Site URL** to your deployed URL (e.g. `https://your-app.vercel.app`). This is where password-reset links land.
5. Copy from **Project Settings → API**:
   - Project URL → `SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY`

   Paste both into `js/config.js`.

> **Why is it OK to commit the anon key?** It is a publishable key, designed to ship to browsers — like a Stripe publishable key. All authorisation happens server-side via RLS. The key that must **never** appear in this repo or any frontend code is the `service_role` key (it bypasses RLS).

### 2. GitHub

```bash
git remote add origin git@github.com:<you>/spendwell.git
git push -u origin main
```

### 3. Vercel

1. [vercel.com](https://vercel.com) → **Add New → Project** → import the GitHub repo.
2. Framework preset: **Other**. No build command, output directory: root. Deploy.
3. `vercel.json` automatically applies the security headers (CSP, frame denial, etc.).
4. Update Supabase **Site URL** (step 1.4) to the final Vercel domain.

No Vercel environment variables are needed for this static setup — the only config the frontend needs (`js/config.js`) is public by design. If you later add server-side endpoints (e.g. a sheet-sync proxy), put secrets in Vercel env vars, never in the repo.

## Google Sheet sync

Connect via the ⚙ button: deploy a Google Apps Script **web app** (access: *Anyone*) on your sheet that returns `{fields, rows}` JSON, and paste its `/exec` URL.

```js
// Apps Script: Extensions -> Apps Script -> paste -> Deploy -> New deployment -> Web app
function doGet() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const values = sh.getDataRange().getValues();
  const fields = values.shift().map(String);
  const rows = values.map(r => Object.fromEntries(fields.map((f, i) =>
    [f, r[i] instanceof Date ? Utilities.formatDate(r[i], "Europe/London", "yyyy-MM-dd") : r[i]])));
  return ContentService.createTextOutput(JSON.stringify({ fields, rows }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

If the sheet has a **Category** column, it is detected automatically and its values are used as-is — no manual re-categorising. Categories that don't exist yet are created on import; blank values fall back to your merchant rules and keyword auto-categorisation.

⚠️ The Apps Script URL is effectively a read token for your transaction data — anyone who has it can read the sheet output. Don't share it; disconnect (and redeploy the script) if it leaks.

## Migrating data from the old single-file version

Open the old `spendwell-v1.html`, press **↓ Backup** to download a JSON file, then in the deployed app sign in and press **⟳ Restore**. (Old *unencrypted* data found in the same browser is imported automatically on first sign-in.)

## Security notes

- No secrets live in this repo. `js/config.js` holds only publishable values.
- All user input rendered into the DOM goes through an HTML-escaping helper (`esc`).
- CDN scripts are version-pinned with Subresource Integrity hashes.
- CSP restricts scripts to self + jsDelivr and network calls to Supabase + Google Apps Script. (`'unsafe-inline'` is currently required by the app's inline-handler rendering style — migrating to event delegation would allow removing it.)
- Known limitation: in cloud mode, data is encrypted in transit (TLS) and at rest by Supabase, but not end-to-end encrypted — that trade-off enables cross-device sync and password resets without data loss.

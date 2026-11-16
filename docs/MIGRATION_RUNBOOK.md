# Go-live runbook: provision → migrate → cut over

Total hands-on time: about 1–2 hours. Plan a short **write freeze** (typically 15–30 minutes) on the
old portal between the final export and the DNS switch.

## 0. Prerequisites
- A Cloudflare account on the **Workers Paid** plan (USD 5/month). This is needed for the CPU time
  used to check legacy bcrypt passwords on each user's first login (after that, logins are cheap).
- Node 22 and this repository.
- The old backend's `.env` values (spreadsheet IDs plus the Google service-account email and key).
- **Rotate every credential that was in the ZIP** (see `CHANGES_FROM_LEGACY.md` → Security).
  Create new keys first. Revoke the old ones after cut-over.

## 1. Provision Cloudflare resources (once)
```bash
cd api && npm ci
npx wrangler login
npx wrangler d1 create epil-db            # copy database_id into api/wrangler.jsonc
npx wrangler r2 bucket create epil-files   # only if FILE_STORAGE=r2
npx wrangler secret put JWT_SECRET            # e.g. `openssl rand -base64 48`
npx wrangler secret put FILE_URL_SECRET       # a different random value
npx wrangler secret put ADMIN_REGISTRATION_KEY
npx wrangler secret put META_WA_TOKEN         # the NEW, rotated WhatsApp token
npx wrangler secret put META_WA_PHONE_ID
npx wrangler secret put CLOUDINARY_CLOUD_NAME   # + CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
npm run db:migrate:remote                     # creates all tables
```
Set `CORS_ORIGINS` (in `wrangler.jsonc`, or as the GitHub variable used by `deploy.yml`) to the two
portal URLs, for example `https://portal.epil.biz,https://admin.epil.biz`.

## 2. Rehearse first (recommended, against a throw-away database)
```bash
npx wrangler d1 create epil-db-rehearsal     # temporarily point wrangler.jsonc at it, or use --local
```
Then run steps 3–5 against it, log in as a few real users, and review `out/report.json` with
the business owner.

## 3. Export Google Sheets
```bash
cd migration && npm ci
cp /path/to/EPILBACKEND/.env .env.migration   # gitignored; never commit
node --env-file=.env.migration export-sheets.mjs
```
This writes `out/sheets/*.json`, one file per tab with the exact strings the old API read. If you
can't use the service account, download each tab as CSV into `out/csv/<key>.csv`. The keys are
listed in `sources.mjs`.

## 4. Copy files from Cloudinary to R2 (only if FILE_STORAGE=r2)
Skip this step with the default `FILE_STORAGE=cloudinary`: migrated file links stay on Cloudinary and keep working.
Create an R2 API token (R2 → Manage API tokens → Object Read & Write on `epil-files`), then:
```bash
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... node migrate-files.mjs
```
The script can be re-run safely. It writes `out/file-map.json` and retries only the failures.

## 5. Transform, load, verify
```bash
node transform.mjs                     # → out/seed.sql + out/report.json
cd ../api
npx wrangler d1 execute epil-db --remote --file ../migration/out/seed.sql
cd ../migration && node verify.mjs --remote   # row counts must all be OK
```
**Read `out/report.json` before going live.** It lists every row that was repaired or skipped,
with the reason: duplicate IDs, blank or guessed designations, invalid frequencies, orphan questions,
names that don't match any user, and Cloudinary files not yet copied. If an admin was re-numbered
because of an ID collision, tell them their new login ID.

`seed.sql` expects an **empty** database. To re-run: `wrangler d1 execute epil-db --remote --command
"DELETE FROM ..."` for each table, or recreate the database and re-apply migrations.

## 6. Deploy
Either push to `main` (GitHub Actions `deploy.yml`) or deploy manually:
```bash
cd api && npx wrangler deploy
cd ../frontend/doer  && npm ci --legacy-peer-deps && REACT_APP_BASE_URL=https://api.epil.biz npm run deploy
cd ../admin          && npm ci --legacy-peer-deps && REACT_APP_BASE_URL=https://api.epil.biz npm run deploy
```
Attach custom domains in the dashboard (Workers → each Worker → Settings → Domains & Routes).

GitHub settings for automated deploys:
- Secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit, D1 Edit; R2 Edit only if using R2), `CLOUDFLARE_ACCOUNT_ID`, `ANTHROPIC_API_KEY` (optional, for `@claude`).
- Variables (environment `production`): `API_URL` (e.g. `https://api.epil.biz`) and `CORS_ORIGINS`.

## 7. Cut over
1. Announce the freeze, then stop writes on the old portal (stop the Render service).
2. Re-run steps 3–5 to capture the last changes. Use a fresh empty database, or clear tables first.
3. Smoke test: `curl https://api.../health`, log in as one admin and one employee, open every page.
4. Point the old portal URLs at the new Workers, or share the new URLs.
5. Keep the Google Sheets **read-only** for 30 days as a fallback, then archive them.

## Rollback
Until the Sheets are archived, rollback means restarting the old Render service and pointing DNS
back. Any data entered in the new system during the trial would then need to be re-entered there.
D1 also has **Time Travel** (point-in-time restore for 30 days):
`wrangler d1 time-travel restore epil-db --timestamp=<ISO time>`.

## Portals: fallback deploy
If the Workers static-assets upload is not reachable (e.g. behind a proxy that rewrites the upload
token), deploy a portal as a single self-contained Worker instead:
`cd frontend && npm --prefix doer run build && node deploy-embedded.mjs doer` (same for `admin`).
A later normal `npm run deploy` or GitHub Actions run replaces it.

## Ongoing operations
- **Backups**: D1 Time Travel is automatic. For off-platform copies, schedule `wrangler d1 export epil-db --remote --output backup.sql`.
- **Logs**: Workers → `epil-api` → Observability (enabled in `wrangler.jsonc`).
- **Cron**: `GET /health` shows whether this month's checklist generation has run. An admin can
  force it with `POST /admin/generate-now`.
- **Password resets**: admin calls `POST /api/auth/reset-password { employeeID, newPassword }`.

# EPIL Work Management Portal — guide for AI agents (Claude Code)

This repo is the Cloudflare rebuild of the EPIL portal that used to run on Express + Google Sheets.
Read this before changing anything.

## Layout
| Path | What | Runtime |
|---|---|---|
| `api/` | REST API — Hono on Cloudflare Workers, D1 (SQLite), R2, Cron | `wrangler` |
| `api/migrations/` | D1 schema migrations (forward-only, numbered) | `wrangler d1 migrations` |
| `frontend/doer/` | Employee ("Doer") portal — React 19 (CRA) + Tailwind | Workers static assets |
| `frontend/admin/` | Admin portal — React 19 (CRA) + Tailwind | Workers static assets |
| `migration/` | One-time Google Sheets → D1 and Cloudinary → R2 tooling | Node 22 |
| `docs/` | Architecture, data mapping, runbooks, legacy differences | — |

## Commands
```bash
cd api && npm ci && npm run typecheck && npm test        # API tests run inside workerd
cd api && npm run db:migrate:local && npm run dev         # local API on :8787 (needs .dev.vars)
cd migration && npm ci && npm test                        # full migration rehearsal (fixtures → D1 → API)
cd frontend/doer && npm ci --legacy-peer-deps && npm start   # REACT_APP_BASE_URL=http://localhost:8787
```
`api/.dev.vars` (never commit) needs `JWT_SECRET=...` and `FILE_URL_SECRET=...`.

## Non-negotiable rules
1. **API contract is frozen.** The two React apps call exact paths and read exact JSON keys
   (`TaskID`, `Taskcompletedapproval`, `IssuePhoto`, …). Never rename response fields or paths.
   Add new fields/endpoints instead. Module path segments are matched case-insensitively
   (`/api/helpTickets` == `/api/helptickets`) — keep `getPath` in `api/src/index.ts`.
2. **Every route declares its access level.** Use `requireAuth` (all module routers already do),
   then `requireAdmin` for admin-only, or `scopedName()` / owner checks for "self or admin".
   A new route without an explicit decision is a bug. Add a case to the RBAC test.
3. **Schema changes = new migration file** (`api/migrations/000N_name.sql`). Never edit an
   applied migration. Keep columns `NOT NULL DEFAULT ''` (the legacy data is string-based).
4. **Dates** stay in the legacy display formats the UI parses: `DD/MM/YYYY HH:mm:ss` (IST via
   `formatDateIST`) for timestamps, `DD/MM/YYYY` for dates. Use helpers in `api/src/lib/dates.ts`.
5. **Files** go through `storeUpload()` and are returned via `publicFileUrl()`. Storage is chosen by
   `FILE_STORAGE`: `cloudinary` (production, owner's decision — public URLs as in the legacy system)
   or `r2` (private bucket, signed expiring URLs; used by the test suite). Never hard-code one backend.
6. **Secrets** only via `wrangler secret put` / GitHub secrets. Nothing secret in `REACT_APP_*`
   (it is bundled into public JS — CI fails the build if a token pattern appears).
7. **Google Sheets backup.** Every synced table has D1 triggers (migration 0003) that queue changed
   keys; `api/src/lib/sheetsSync.ts` maps rows to the legacy sheet layouts. A new synced table needs
   triggers in a new migration AND a `SheetSpec`. Never write formula columns (Master!H,
   SupportTicketsMaster L/P/Q, HelpTicketsMaster I/J). Use `RETURNING` to count updated rows —
   `meta.changes` also counts trigger inserts.
8. People are referenced **by name** across modules (legacy design). When adding features prefer
   `employee_id`, but keep name columns populated for compatibility.
9. Business rules that were deliberately preserved (do not "fix" without a product decision):
   dashboard scoring maths, the 3-day ticket SLA, support tickets fan-out to every MIS member,
   training = COMMON + designation templates with 2 self + 2 with-doer views per item.

## Definition of done for a change
- `npm run typecheck && npm test` in `api/` pass; new behaviour has a test in `api/test/`.
- If it touches the data model: migration file + `docs/ARCHITECTURE.md` table list updated.
- If it touches a frontend: `npm run build` passes for that app.
- Behaviour that differs from the legacy system is recorded in `docs/CHANGES_FROM_LEGACY.md`.

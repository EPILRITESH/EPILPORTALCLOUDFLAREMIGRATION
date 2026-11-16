# Architecture

## Before → after

| Concern | Legacy (ZIP) | Cloudflare rebuild |
|---|---|---|
| Frontends | 2 × CRA apps on a static host | Same apps, served by **Workers static assets** (`epil-portal`, `epil-admin`) |
| Backend | Express 5 on Render (one Node process) | **Hono on Cloudflare Workers** (`epil-api`), global, no servers |
| Database | 9 Google spreadsheets / 14 tabs via service account | **Cloudflare D1** (`epil-db`), 17 tables, indexed, transactional batches |
| Files | Cloudinary, public URLs | **Cloudinary**, public URLs (owner's decision; uploads signed server-side). Switchable to a private **R2** bucket with signed URLs via `FILE_STORAGE=r2` |
| Scheduler | `node-cron` hourly + `last-generate.txt` on local disk | **Cron Trigger** hourly + `job_runs` table (idempotent) |
| Auth | JWT (no role claim), bcrypt | JWT HS256 **with role**, PBKDF2 (legacy bcrypt verified & upgraded on login) |
| Authorization | Any logged-in user could call any route | **RBAC**: admin-only, self-only and owner-or-admin enforced server-side |
| WhatsApp | Token in backend *and* bundled into admin browser JS | Server-side only (`/api/whatsapp/*`) |
| Concurrency | Read-modify-write of whole sheet ranges (lost updates, row shifts) | Row-level SQL updates; atomic ticket counters |

```
 Browser (Doer)  ── HTTPS ──▶  epil-portal  (static assets, SPA fallback)
 Browser (Admin) ── HTTPS ──▶  epil-admin   (static assets, SPA fallback)
        │
        └── XHR /api/* ─────▶  epil-api  (Hono Worker) ──▶ D1  epil-db
                                    │   ├────────────────▶ Cloudinary (uploads; public URLs)
                                    │   └── fetch ───────▶ WhatsApp Cloud API
                               Cron 0 * * * * → checklist next-month generation
```

## Modules and access

| Module (`/api/...`) | Employee | Admin |
|---|---|---|
| `auth`, `adminauth` | login, register (employee), change password | login, register admin (bootstrap / key / admin token), reset passwords |
| `employee` | list, own profile, update own profile | + designations |
| `delegations` | own tasks, create for self, done/shift own | all, create for anyone, update, delete, approve |
| `checklist` | own open items, mark own done | search all, templates, delete, manual generation |
| `helpTickets` | create, created/assigned, status on own tickets | all |
| `support-tickets` | create (fans out to all MIS), MIS workflow, creator approves | all, approve any |
| `worklist` | own CRUD, bulk (self), AI time on own | all, admin edit/delete, occupancy, AI sheet |
| `training` | approved list, my learnings, start, progress (answers hidden) | templates/indices/QA CRUD, approval, records, summary |
| `allDashboard` | own scorecard only | any / all employees |
| `additionalfeature` | own links | own links |
| `em-sheet`, `whatsapp` | — | yes |

## Data model (D1)

| Table | Legacy source | Key | Notes |
|---|---|---|---|
| `users` | `Employee!A:BW`, `Admin!A:F` | `employee_id` (login ID) | `role` = admin/employee; 54 HR fields in `hr_details` JSON |
| `user_documents` | Employee KYC URL columns | (`user_id`,`kind`) | `r2:` refs |
| `delegations` | `DelegationMaster!A:R` | `task_id` | cols O–R preserved in `extra` |
| `checklist_tasks` | checklist `Master!A:K` (+ `Consolidated`) | `task_id` | unique (`name`,`task`,`planned`) makes generation idempotent |
| `checklist_templates` | `MasterTasks!A:I` | `template_id` | freq D/W/M/Y |
| `help_tickets` | `HelpTicketsMaster!A:H` | `ticket_id` (`#00001`) | IDs from `counters` |
| `support_tickets` | `SupportTicketsMaster!A:O` | `ticket_id` | `group_key` links the per-MIS copies |
| `worklists` | `WorkList!A:J` | `worklist_id` | `position` preserves sheet order |
| `training_templates` / `training_indices` | `MasterTemplateData` (one row per index) | `template_id` / (`template_id`,`position`) | normalised: template once, indices separately |
| `training_questions` | `AQData` | `qa_id` | correct answer never sent to employees |
| `training_records` | `EmployeeTrainingData` | (`employee_name`,`template_id`) | `progress` JSON unchanged |
| `additional_features` | `AdditionalFeature!A:D` | id | |
| `em_sheet_rows` | EM spreadsheet grid | `row_index` | raw grid, parsed exactly like before; admins can replace via `PUT /api/em-sheet/em-sheet` |
| `counters`, `job_runs`, `audit_log` | new | | atomic IDs, cron idempotency, who-did-what |

Design choices worth knowing:
- **Legacy IDs are kept** (EmployeeID, TaskID, ticket numbers) so people's habits and exports still work.
- **Names as references**: the sheets linked records by person name; historical rows reference
  ex-employees, so hard foreign keys would reject real data. Names are indexed; `docs/ROADMAP.md`
  describes moving to `employee_id` references.
- **Dates as legacy strings**: the UI parses `DD/MM/YYYY`; storing those strings guarantees identical
  reports. ISO `created_at`/`updated_at` columns are kept for auditing.

## Google Sheets backup (D1 → Sheets)
The legacy Google Sheets stay a live, human-readable backup of all data.

```
portal write → D1 row → trigger → sheet_sync_queue ──(immediately after the save; cron every minute as safety net)──▶ legacy Google Sheets
hand edits in Sheets / old portal ──(pull, every minute, all tabs)──▶ D1   (portal wins on conflicts)
EM report (formulas in Sheets) ──(every 10 minutes, read-only)──▶ D1 em_sheet_rows → /api/em-sheet
```
- **Capture**: triggers on every synced table (migration 0003) record the changed row's key, so API
  writes, cron jobs and manual SQL are all captured.
- **Apply** (`api/src/lib/sheetsSync.ts`): per tab, read the ID column, then update the row in place,
  append new rows (growing the grid if needed) or clear rows deleted in the portal — the same way the
  legacy backend wrote these sheets. Batched (`values:batchUpdate`), lease-locked, retried on failure;
  a failing tab keeps only its own changes queued.
- **Formula columns are never written**: `Master!H` (Actual) is fed by writing completions into
  `Consolidated`, exactly as before; `SupportTicketsMaster` L/P/Q and `HelpTicketsMaster` I/J are skipped.
- **Formula injection**: text starting with `=`, `@`, or a non-numeric `+`/`-` is written as plain text.
- **Admin controls**: `GET /api/sheets-sync/status`, `POST /api/sheets-sync/run`,
  `POST /api/sheets-sync/clear-queue`, `POST /api/sheets-sync/sync-now`, `POST /api/sheets-sync/pull {full?}`, `POST /api/sheets-sync/backfill {since}`,
  `POST /api/sheets-sync/pull-em-sheet`.
- **Real-time**: after every successful write the API pushes the queue in the background (a few
  seconds); the sync keeps draining while new changes arrive, and the every-minute cron catches anything left.
- **Pull** (`api/src/lib/sheetsPull.ts`, `SHEETS_PULL_ENABLED`): every minute, edits made in Google Sheets
  (by hand or by the old portal) in **all** synced tabs are copied into D1 — Employee/Admin profiles,
  delegations, checklist rows + completions (Consolidated), templates, tickets, worklist, training templates/
  indices/questions/records, additional features. Each tab is fingerprinted in 500-row blocks and only changed
  blocks are compared with D1 (first run ≈25 s for all tabs; later runs only touch what changed). A record with
  a pending portal change is never overwritten (portal wins, checked atomically); rows deleted in a sheet are
  not deleted in D1; passwords are never read from a sheet; person-name keys match ignoring case/whitespace;
  the pull's own writes are not echoed back.
- **Admin page**: Admin portal → **Backup & Sync** — live status per sheet, pending changes, last push/pull,
  links to each sheet, and a **Sync Now** button (`POST /api/sheets-sync/sync-now`: pull, then push).
- **Switches**: `SHEETS_SYNC_ENABLED` (D1 → Sheets) and `SHEETS_PULL_ENABLED` (Sheets → D1);
  `SHEETS_TAB_PREFIX` targets test/staging tabs (e.g. `ZZTEST_`).

| Sheet tab | Source table | Key column | Written columns |
|---|---|---|---|
| Employee / Admin | `users` (+ `user_documents`) | A (ID) | A–BW / A–G |
| AdditionalFeature | `additional_features` | A+B+C | A–D |
| DelegationMaster | `delegations` | A | A–N |
| Master / Consolidated | `checklist_tasks` | D / A | A–G, I–K / A–B (done date) |
| MasterTasks | `checklist_templates` | A | A–I |
| HelpTicketsMaster | `help_tickets` | A | A–H |
| SupportTicketsMaster | `support_tickets` | A | A–K, M–O |
| WorkList | `worklists` | A | A–J |
| MasterTemplateData | `training_templates` + `training_indices` | A (one row per index) | A–H |
| AQData | `training_questions` | B | A–H |
| EmployeeTrainingData | `training_records` | A+D | A–P |

## Security controls
- JWT 2-day expiry; role in token; admin routes return 403 for employees.
- Passwords: PBKDF2-SHA256 100k iterations; legacy bcrypt verified then rehashed.
- Admin self-registration requires `ADMIN_REGISTRATION_KEY` or an admin token (open only when zero admins exist).
- Uploads: type allow-list (JPG/PNG/GIF/WEBP/PDF), 5 MB cap, random object keys, private bucket, signed URLs.
- CORS allow-list (`CORS_ORIGINS`), secure headers on API and SPAs, `audit_log` for writes.
- All SQL is parameterised (`prepare().bind()`); no string-built queries with user input.

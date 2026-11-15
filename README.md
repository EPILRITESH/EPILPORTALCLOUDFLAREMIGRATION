# EPIL Work Management Portal — Cloudflare edition

The EPIL portal (delegations, checklists, help and support tickets, worklists, training,
performance dashboards) rebuilt to run entirely on Cloudflare:

- **API**: Cloudflare Workers + Hono → [`api/`](api)
- **Database**: Cloudflare D1, replacing 9 Google spreadsheets → [`api/migrations/`](api/migrations)
- **Files**: Cloudflare R2 (private, signed URLs), replacing Cloudinary
- **Portals**: Doer and Admin React apps on Workers static assets → [`frontend/`](frontend)
- **Scheduler**: Cron Trigger for monthly checklist generation
- **Migration**: Sheets → D1 and Cloudinary → R2 tooling with verification → [`migration/`](migration)
- **Automation**: GitHub Actions CI, auto-deploy, and `@claude` AI pair-development → [`.github/workflows/`](.github/workflows)

Start here:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it fits together, data model, access rules
- [docs/MIGRATION_RUNBOOK.md](docs/MIGRATION_RUNBOOK.md): provisioning, data migration and go-live
- [docs/CHANGES_FROM_LEGACY.md](docs/CHANGES_FROM_LEGACY.md): security and bug fixes vs. the ZIP version
- [CLAUDE.md](CLAUDE.md): rules for AI-driven development on this repo

## Quick start (local)
```bash
cd api && npm ci
printf 'JWT_SECRET=dev\nFILE_URL_SECRET=dev2\n' > .dev.vars
npm run db:migrate:local && npm run dev          # http://localhost:8787/health
# first admin (allowed while no admin exists):
curl -X POST localhost:8787/api/adminauth/admin/register -H 'content-type: application/json' \
  -d '{"name":"Admin","mobile":"9999999999","password":"change-me","department":"Management"}'

cd ../frontend/admin && npm ci --legacy-peer-deps
REACT_APP_BASE_URL=http://localhost:8787 PORT=3001 npm start
```

## Tests
| Suite | Command | What it proves |
|---|---|---|
| API | `cd api && npm test` | 17 integration tests inside the Workers runtime (auth, RBAC, every module's workflow, R2 signed URLs, cron idempotency) |
| Migration | `cd migration && npm test` | Messy sheet fixtures → transform → D1 → running API: legacy logins work, data is served unchanged, problems are reported |

## Run it on your computer (no Cloudflare account needed)
Requires Node.js 20+ (https://nodejs.org). In the project folder:
```bash
node start-local.mjs
```
First run installs dependencies and creates a demo database (about 1–2 minutes). Then open
http://localhost:3000 (Doer: `e1AAAA` / `legacy123`) and http://localhost:3001 (Admin: `a1ZZZZ` / `legacy123`).
Use `node start-local.mjs --reset` to wipe the demo data, and `node start-local.mjs --list-users` to see every login ID.

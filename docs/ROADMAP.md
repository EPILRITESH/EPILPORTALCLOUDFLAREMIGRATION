# Suggested next steps (not required for go-live)

1. **Real AI question generation**: replace the template-based `/training/qa/ai-generate` with
   Workers AI or the Claude API, reading the training document text. Keep the admin review step.
2. **Reference people by ID**: add `*_employee_id` columns next to name columns, backfill them from
   `users`, and switch queries over. Renaming an employee would then no longer orphan their history.
3. **ISO date shadow columns** (`deadline_at`, `planned_at`, …) so dashboards can filter in SQL
   instead of in the Worker as data grows (comfortable today up to roughly 50k rows per table).
4. **Move the session to an HttpOnly cookie** instead of localStorage, with the API and portals on
   the same parent domain.
5. **Cloudflare Access** in front of the admin portal for SSO and MFA.
6. **Frontend modernisation**: move from CRA (unmaintained) to Vite. The code is compatible; this is
   a build-tooling swap plus env-variable renames (`REACT_APP_` → `VITE_`).
7. **WhatsApp automations on cron**: e.g. the daily pending-task reminders that admins send by hand today.

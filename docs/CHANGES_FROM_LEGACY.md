# Differences from the legacy system

The goal was **no loss of functionality or data**. Every endpoint the two React apps call still
exists, with the same paths, request bodies and response keys. The changes below are deliberate.

## Security fixes (behaviour changes)
| # | Legacy problem | Now |
|---|---|---|
| S1 | The ZIP's `EPILBACKEND/.env` contained live secrets in plaintext: the Google service-account private key, Cloudinary keys, the Meta/WhatsApp token and app secret, and the JWT secret. The admin `.env` repeated the WhatsApp token as `REACT_APP_*`. | **Rotate all of them.** The new system keeps secrets in Wrangler/GitHub secrets only. CI fails if a token pattern shows up in a frontend bundle. |
| S2 | The WhatsApp token was compiled into the admin website's JavaScript, so anyone could read it. | Bulk report sending goes through `POST /api/whatsapp/send-workreport`. |
| S3 | No authorization: any employee's token could approve or delete delegations, edit other people's worklists, read all tickets, and manage training. | Role in the JWT, plus admin-only, self-only and owner-or-admin checks on every route. |
| S4 | `POST /api/adminauth/admin/register` was public, so anyone could create an admin account. | Allowed only when no admin exists yet, or with `ADMIN_REGISTRATION_KEY`, or with an admin's token. The admin Register page gained a "Registration Key" field. |
| S5 | `POST /api/checklist/auto-generate-next-month` trusted the header `x-cron-job: true`. | Admin-only. The scheduler calls the code directly. |
| S6 | `GET /api/training/qa/:id` without `forTest=1` returned the correct answers to anyone. | Correct answers are returned to admins only. |
| S7 | Aadhaar, PAN, bank passbook and certificate images were public Cloudinary URLs. | Private R2 bucket. The API hands out signed links that expire after 7 days. |

## Bug fixes
| # | Legacy behaviour | Now |
|---|---|---|
| B1 | Refreshing the browser on any page went back to the home page (auth state was read too late). | The page you were on stays open. |
| B2 | The doer profile editor called `PUT /employee/update-profile`, which did not exist, so it always failed. | Implemented, including the profile picture upload. |
| B3 | Checklist "create template" wrote the current month's tasks into an unused `TestMaster` tab, so doers never saw them. | Tasks are created as real checklist items. |
| B4 | Shifting a delegation never saved Revision 1 / Revision 2. The UI showed them until the next reload. | Saved. |
| B5 | Admins couldn't mark done or shift other people's delegations (404). | Allowed for admins. |
| B6 | The doer dashboard's "All weeks" option returned 400. | An empty week means the whole month. |
| B7 | `DELETE /worklist/:id` (doer) did not exist. | Owner or admin can delete. |
| B8 | Ticket numbers came from "last row + 1" and could repeat after edits. Sheet deletes rewrote whole ranges, which could lose concurrent updates. | Atomic counters and row-level SQL updates. |
| B9 | Support-ticket copies were linked by identical Issue text, so two unrelated tickets with the same text moved together. | New tickets share a `group_key`. Migrated tickets keep the old text-based grouping, so history behaves exactly as before. |
| B10 | A blank Designation picked up the "Created" timestamp as a designation through the fallback heuristic. | Timestamps are skipped, and every guessed designation is listed in the migration report. |
| B11 | The checklist "done" date lived in a separate `Consolidated` tab and relied on a sheet formula. | Stored directly on the task. Migration merges `Consolidated` into it. |

## Unchanged on purpose (business rules)
The dashboard scoring formula (`pending% × 0.8 + avg delay% × 0.2`), Monday-based week numbering,
the 3-day ticket SLA, support tickets fanning out to every MIS employee, the MIS ticket workflow,
training assignment (COMMON plus designation) with 2 self and 2 with-doer views per item, the
sequential index unlock, and the "AI generate" question drafts (still the same rule-based generator,
not an AI model; see ROADMAP).

## Removed
- The legacy per-user `<Name>_Checklist` sheet router (`utils/recurrence.js`). It was not mounted in
  `server.js` and no frontend used it.
- The `diag_*` scripts, logs and `parse_check` files. These were development leftovers, not features.

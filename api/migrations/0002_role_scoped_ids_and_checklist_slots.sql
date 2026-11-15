-- 0002 — fixes found while migrating the real Google Sheets data
--
-- 1) Login IDs are unique PER ROLE, not globally. The legacy system kept admins
--    and employees in separate sheets, and real data has the same ID in both
--    (admin "aman" = Aman Agarwal, employee "aman" = Aman Thakur). Each login
--    endpoint already looks users up by (role, employee_id).
-- 2) Checklist (name, task, planned) is NOT unique in real data: 102 slots hold
--    two distinct tasks (different TaskIDs and completion dates). Keep them all;
--    auto-generation now checks for an existing slot before inserting.
--
-- Rebuilds `users` (SQLite cannot drop a column constraint) preserving all rows.

PRAGMA defer_foreign_keys = true;

CREATE TABLE users_new (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id        TEXT    NOT NULL,
  role               TEXT    NOT NULL CHECK (role IN ('admin','employee')),
  name               TEXT    NOT NULL,
  mobile             TEXT    NOT NULL,
  password_hash      TEXT    NOT NULL,
  department         TEXT    NOT NULL DEFAULT '',
  designation        TEXT    NOT NULL DEFAULT '',
  company_name       TEXT    NOT NULL DEFAULT '',
  date_of_birth      TEXT    NOT NULL DEFAULT '',
  joining_date       TEXT    NOT NULL DEFAULT '',
  profile_picture    TEXT    NOT NULL DEFAULT '',
  doer_name          TEXT    NOT NULL DEFAULT '',
  shift_start_time   TEXT    NOT NULL DEFAULT '',
  shift_end_time     TEXT    NOT NULL DEFAULT '',
  total_working_hours TEXT   NOT NULL DEFAULT '',
  hr_details         TEXT    NOT NULL DEFAULT '{}',
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (role, employee_id)
);
INSERT INTO users_new SELECT id, employee_id, role, name, mobile, password_hash, department, designation,
  company_name, date_of_birth, joining_date, profile_picture, doer_name, shift_start_time, shift_end_time,
  total_working_hours, hr_details, is_active, created_at, updated_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX idx_users_role_name ON users(role, name);
CREATE INDEX idx_users_role_mobile ON users(role, mobile);
CREATE INDEX idx_users_name ON users(name);
CREATE INDEX idx_users_department ON users(department);

DROP INDEX IF EXISTS uq_checklist_slot;
CREATE INDEX idx_checklist_slot ON checklist_tasks(name, task, planned);

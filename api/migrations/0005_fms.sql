-- 0005 — FMS (Flow Management System)
--
-- Dynamic, spreadsheet-style process flows (the "FMS sheets" EPIL runs in Google Sheets):
--   fms_definitions  one FMS (e.g. "CRM ACTIVITY FMS"): access, calendar, recurrence, settings
--   fms_fields       its dynamic columns (case data) and step-level inputs (step_id set)
--   fms_steps        STEP-1..n: WHAT (name) / WHO (seat or direct assignment) / HOW / WHEN (TAT)
--   fms_seats        "seating": named responsibilities (CRM, PC-1 …) mapped to departments,
--   fms_seat_members designations or employees, with optional start/end dates
--   fms_records      one row of the FMS (a case) with dynamic data JSON and a per-FMS UID
--   fms_record_steps Planned / Actual / Status / Delay for every step of every row
--   fms_step_history every action on a step (draft, submit, approve, reject, reassign …)
--   fms_attachments, fms_comments, fms_notifications, fms_holidays, fms_versions, fms_saved_filters
-- Audit of definition/seating changes goes to audit_log (entity 'fms*').

CREATE TABLE fms_definitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  fms_id        TEXT    NOT NULL UNIQUE,                 -- system reference, e.g. FMS-0001
  code          TEXT    NOT NULL UNIQUE COLLATE NOCASE,  -- business code, e.g. FMS-20
  name          TEXT    NOT NULL,
  category      TEXT    NOT NULL DEFAULT '',
  description   TEXT    NOT NULL DEFAULT '',
  instructions  TEXT    NOT NULL DEFAULT '',
  priority      TEXT    NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low','Medium','High','Critical')),
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  archived      INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  is_template   INTEGER NOT NULL DEFAULT 0,
  access        TEXT    NOT NULL DEFAULT '{}',           -- {"departments":[],"designations":[],"employees":[]}
  calendar      TEXT    NOT NULL DEFAULT '{}',           -- {"workStart":"10:00","workEnd":"19:00","weeklyOff":[0]}
  frequency     TEXT    NOT NULL DEFAULT 'on_demand' CHECK (frequency IN ('on_demand','one_time','daily','weekly','monthly','quarterly','yearly')),
  schedule      TEXT    NOT NULL DEFAULT '{}',           -- recurrence details {"days":[1],"dates":[1],"time":"10:00","defaults":{}}
  start_date    TEXT    NOT NULL DEFAULT '',             -- YYYY-MM-DD
  due_date      TEXT    NOT NULL DEFAULT '',
  start_field   TEXT    NOT NULL DEFAULT '',             -- field key holding the row start time ('' = created time)
  uid_prefix    TEXT    NOT NULL DEFAULT 'UID-',
  next_uid      INTEGER NOT NULL DEFAULT 1,
  settings      TEXT    NOT NULL DEFAULT '{}',           -- reminders, escalation, custom settings
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_fms_def_state ON fms_definitions(deleted, archived, status);

CREATE TABLE fms_seats (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL UNIQUE COLLATE NOCASE,   -- e.g. CRM, PC-1
  name         TEXT    NOT NULL DEFAULT '',
  description  TEXT    NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE fms_seat_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_id     INTEGER NOT NULL REFERENCES fms_seats(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('department','designation','employee')),
  value       TEXT    NOT NULL,                          -- department/designation name or employee_id
  start_date  TEXT    NOT NULL DEFAULT '',               -- YYYY-MM-DD ('' = open)
  end_date    TEXT    NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_fms_seat_members ON fms_seat_members(seat_id);

CREATE TABLE fms_steps (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  fms_id             INTEGER NOT NULL REFERENCES fms_definitions(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  code               TEXT    NOT NULL DEFAULT '',          -- STEP-1
  name               TEXT    NOT NULL,                     -- WHAT
  seat_id            INTEGER REFERENCES fms_seats(id) ON DELETE SET NULL,  -- WHO (seat)
  assign             TEXT    NOT NULL DEFAULT '{}',        -- WHO (direct): {"departments":[],"designations":[],"employees":[]}
  how                TEXT    NOT NULL DEFAULT '',          -- HOW
  tat                TEXT    NOT NULL DEFAULT '{}',        -- WHEN: {"type":"days|hours|before_field|after_field|none","value":1,"field":"","from":"previous|start"}
  condition          TEXT    NOT NULL DEFAULT '',          -- run only if: {"field":"...","op":"eq|neq|in|not_in|empty|not_empty","value":...}
  requires_approval  INTEGER NOT NULL DEFAULT 0,
  approver           TEXT    NOT NULL DEFAULT '{}',        -- {"seat_id":null,"employees":[],"departments":[],"designations":[]}  (admins can always approve)
  status_options     TEXT    NOT NULL DEFAULT '["Done"]',
  reminder           TEXT    NOT NULL DEFAULT '{}',        -- {"beforeHours":2}
  escalation         TEXT    NOT NULL DEFAULT '{}',        -- {"afterHours":24,"notifyAdmins":true,"employees":[]}
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_fms_steps_fms ON fms_steps(fms_id, position);

CREATE TABLE fms_fields (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fms_id         INTEGER NOT NULL REFERENCES fms_definitions(id) ON DELETE CASCADE,
  step_id        INTEGER REFERENCES fms_steps(id) ON DELETE CASCADE,   -- NULL = row (case) field
  key            TEXT    NOT NULL,
  label          TEXT    NOT NULL,
  type           TEXT    NOT NULL DEFAULT 'text' CHECK (type IN ('text','textarea','number','date','datetime','select','multiselect','email','phone','url','checkbox','file','employee')),
  options        TEXT    NOT NULL DEFAULT '[]',
  required       INTEGER NOT NULL DEFAULT 0,
  default_value  TEXT    NOT NULL DEFAULT '',
  help           TEXT    NOT NULL DEFAULT '',
  position       INTEGER NOT NULL DEFAULT 0,
  in_list        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (fms_id, key)
);
CREATE INDEX idx_fms_fields_fms ON fms_fields(fms_id, step_id, position);

CREATE TABLE fms_records (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  fms_id           INTEGER NOT NULL REFERENCES fms_definitions(id) ON DELETE CASCADE,
  uid              TEXT    NOT NULL,
  data             TEXT    NOT NULL DEFAULT '{}',
  status           TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  priority         TEXT    NOT NULL DEFAULT '',
  current_step     INTEGER NOT NULL DEFAULT 0,          -- position of the active step (0 = none)
  start_at         TEXT    NOT NULL DEFAULT '',          -- ISO, base for STEP-1 planning
  deleted          INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT    NOT NULL DEFAULT '',
  created_by_name  TEXT    NOT NULL DEFAULT '',
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at     TEXT    NOT NULL DEFAULT '',
  UNIQUE (fms_id, uid)
);
CREATE INDEX idx_fms_records_fms ON fms_records(fms_id, deleted, status);

CREATE TABLE fms_record_steps (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id         INTEGER NOT NULL REFERENCES fms_records(id) ON DELETE CASCADE,
  step_id           INTEGER NOT NULL REFERENCES fms_steps(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','pending','in_progress','submitted','rejected','done','skipped')),
  outcome           TEXT    NOT NULL DEFAULT '',          -- chosen status option, e.g. Done / Close
  planned_at        TEXT    NOT NULL DEFAULT '',
  actual_at         TEXT    NOT NULL DEFAULT '',
  assigned_to       TEXT    NOT NULL DEFAULT '',          -- employee_id override (reassignment)
  done_by           TEXT    NOT NULL DEFAULT '',
  done_by_name      TEXT    NOT NULL DEFAULT '',
  step_values       TEXT    NOT NULL DEFAULT '{}',
  remarks           TEXT    NOT NULL DEFAULT '',
  submitted_at      TEXT    NOT NULL DEFAULT '',
  approved_by       TEXT    NOT NULL DEFAULT '',
  approved_at       TEXT    NOT NULL DEFAULT '',
  rejection_reason  TEXT    NOT NULL DEFAULT '',
  delay_minutes     INTEGER NOT NULL DEFAULT 0,
  reminded_at       TEXT    NOT NULL DEFAULT '',
  escalated_at      TEXT    NOT NULL DEFAULT '',
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (record_id, step_id)
);
CREATE INDEX idx_fms_rs_step_status ON fms_record_steps(step_id, status);
CREATE INDEX idx_fms_rs_status_planned ON fms_record_steps(status, planned_at);

CREATE TABLE fms_step_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id       INTEGER NOT NULL REFERENCES fms_records(id) ON DELETE CASCADE,
  record_step_id  INTEGER,
  action          TEXT    NOT NULL,
  actor           TEXT    NOT NULL DEFAULT '',
  actor_name      TEXT    NOT NULL DEFAULT '',
  remarks         TEXT    NOT NULL DEFAULT '',
  detail          TEXT    NOT NULL DEFAULT '{}',
  at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_fms_history_record ON fms_step_history(record_id, id);

CREATE TABLE fms_attachments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id         INTEGER NOT NULL REFERENCES fms_records(id) ON DELETE CASCADE,
  record_step_id    INTEGER,
  url               TEXT    NOT NULL,
  name              TEXT    NOT NULL DEFAULT '',
  mime              TEXT    NOT NULL DEFAULT '',
  size              INTEGER NOT NULL DEFAULT 0,
  uploaded_by       TEXT    NOT NULL DEFAULT '',
  uploaded_by_name  TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_fms_attachments_record ON fms_attachments(record_id);

CREATE TABLE fms_comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id       INTEGER NOT NULL REFERENCES fms_records(id) ON DELETE CASCADE,
  record_step_id  INTEGER,
  author          TEXT    NOT NULL,
  author_name     TEXT    NOT NULL DEFAULT '',
  body            TEXT    NOT NULL,
  internal        INTEGER NOT NULL DEFAULT 0,          -- internal note: admins only
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_fms_comments_record ON fms_comments(record_id);

CREATE TABLE fms_notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient       TEXT    NOT NULL,                    -- employee_id
  recipient_role  TEXT    NOT NULL DEFAULT 'employee', -- employee | admin
  kind            TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  body            TEXT    NOT NULL DEFAULT '',
  fms_id          INTEGER,
  record_id       INTEGER,
  record_step_id  INTEGER,
  read_at         TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_fms_notifications_recipient ON fms_notifications(recipient_role, recipient, read_at);

CREATE TABLE fms_holidays (
  date  TEXT PRIMARY KEY,                              -- YYYY-MM-DD
  name  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE fms_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fms_id      INTEGER NOT NULL REFERENCES fms_definitions(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  snapshot    TEXT    NOT NULL,
  created_by  TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_fms_versions ON fms_versions(fms_id, version);

CREATE TABLE fms_saved_filters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner       TEXT    NOT NULL,
  scope       TEXT    NOT NULL DEFAULT '',             -- e.g. records:<fms id> | tasks
  name        TEXT    NOT NULL,
  filters     TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO counters (name, value) VALUES ('fms', 0);

-- =====================================================================
-- EPIL Work Management Portal — Cloudflare D1 schema (v1)
--
-- Design notes
-- * Every former Google-Sheet tab maps to one table (see docs/DATA_MAPPING.md).
-- * Public IDs (EmployeeID, TaskID, TicketID, TemplateID...) are kept exactly
--   as they were in Sheets so existing links, exports and habits keep working.
-- * Cross-module references use the person's NAME, exactly like the Sheets
--   did. Legacy rows reference ex-employees and admins by name, so a hard
--   foreign key would reject real historical data. Name columns are indexed.
-- * Date columns keep the legacy display strings (DD/MM/YYYY[ HH:mm:ss]) the
--   frontends parse; created_at/updated_at are ISO-8601 audit columns.
-- * File columns hold either "r2:<object-key>" (Cloudflare R2) or a legacy
--   https URL that has not been migrated yet.
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- USERS  (Sheets: Employee!A:BW  +  Admin!A:F)
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id        TEXT    NOT NULL UNIQUE,          -- login ID (nanoid 6)
  role               TEXT    NOT NULL CHECK (role IN ('admin','employee')),
  name               TEXT    NOT NULL,
  mobile             TEXT    NOT NULL,
  password_hash      TEXT    NOT NULL,                 -- bcrypt (legacy) or pbkdf2$...
  department         TEXT    NOT NULL DEFAULT '',
  designation        TEXT    NOT NULL DEFAULT '',
  company_name       TEXT    NOT NULL DEFAULT '',
  date_of_birth      TEXT    NOT NULL DEFAULT '',      -- DD/MM/YYYY
  joining_date       TEXT    NOT NULL DEFAULT '',      -- DD/MM/YYYY
  profile_picture    TEXT    NOT NULL DEFAULT '',      -- r2:key | url
  doer_name          TEXT    NOT NULL DEFAULT '',
  shift_start_time   TEXT    NOT NULL DEFAULT '',
  shift_end_time     TEXT    NOT NULL DEFAULT '',
  total_working_hours TEXT   NOT NULL DEFAULT '',
  hr_details         TEXT    NOT NULL DEFAULT '{}',    -- JSON: remaining HR/payroll/KYC fields
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (role, name),
  UNIQUE (role, mobile)
);
CREATE INDEX idx_users_name ON users(name);
CREATE INDEX idx_users_department ON users(department);

-- Uploaded KYC / certificate documents (Employee!BA, BC, BE, BH, BL ...)
CREATE TABLE user_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,     -- aadhaarCard | panCard | bankPassbook | educationCert | experienceCert
  file_ref    TEXT    NOT NULL,     -- r2:key | url
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, kind)
);

-- ---------------------------------------------------------------------
-- DELEGATIONS  (Sheet: DelegationMaster!A:R)
-- ---------------------------------------------------------------------
CREATE TABLE delegations (
  task_id        TEXT PRIMARY KEY,                    -- A
  name           TEXT NOT NULL,                       -- B  doer
  task_name      TEXT NOT NULL,                       -- C
  created_date   TEXT NOT NULL DEFAULT '',            -- D  DD/MM/YYYY HH:mm:ss (IST)
  deadline       TEXT NOT NULL DEFAULT '',            -- E
  revision1      TEXT NOT NULL DEFAULT '',            -- F
  revision2      TEXT NOT NULL DEFAULT '',            -- G
  final_date     TEXT NOT NULL DEFAULT '',            -- H  completion date
  revisions      INTEGER NOT NULL DEFAULT 0,          -- I
  priority       TEXT NOT NULL DEFAULT '',            -- J
  status         TEXT NOT NULL DEFAULT 'Pending',     -- K  Pending|Completed|Shifted
  followup       TEXT NOT NULL DEFAULT '',            -- L  AssignBy / notes
  done_week      TEXT NOT NULL DEFAULT '',            -- M  monday of completion week
  approval       TEXT NOT NULL DEFAULT 'Pending',     -- N  Taskcompletedapproval
  extra          TEXT NOT NULL DEFAULT '[]',          -- O..R preserved verbatim (JSON array)
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_delegations_name ON delegations(name COLLATE NOCASE);
CREATE INDEX idx_delegations_followup ON delegations(followup COLLATE NOCASE);

-- ---------------------------------------------------------------------
-- CHECKLIST  (Checklist spreadsheet: Master!A:K, MasterTasks!A:I, Consolidated!A:B)
-- ---------------------------------------------------------------------
CREATE TABLE checklist_templates (                    -- MasterTasks
  template_id  TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL DEFAULT '',
  department   TEXT NOT NULL DEFAULT '',
  task         TEXT NOT NULL,
  freq         TEXT NOT NULL CHECK (freq IN ('D','W','M','Y')),
  day_or_date  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_checklist_templates_status ON checklist_templates(status);

CREATE TABLE checklist_tasks (                        -- Master
  task_id      TEXT PRIMARY KEY,                       -- D
  name         TEXT NOT NULL,                          -- A
  email        TEXT NOT NULL DEFAULT '',               -- B
  department   TEXT NOT NULL DEFAULT '',               -- C
  freq         TEXT NOT NULL DEFAULT '',               -- E
  task         TEXT NOT NULL,                          -- F
  planned      TEXT NOT NULL DEFAULT '',               -- G  DD/MM/YYYY HH:mm:ss
  actual       TEXT NOT NULL DEFAULT '',               -- H  (was a formula over Consolidated)
  source       TEXT NOT NULL DEFAULT '',               -- I  'AUTO' for generated
  template_id  TEXT NOT NULL DEFAULT '',               -- J
  archive      TEXT NOT NULL DEFAULT '',               -- K
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_checklist_tasks_name ON checklist_tasks(name COLLATE NOCASE);
-- idempotent auto-generation (same person + task + planned slot only once)
CREATE UNIQUE INDEX uq_checklist_slot ON checklist_tasks(name, task, planned);

-- ---------------------------------------------------------------------
-- HELP TICKETS  (Sheet: HelpTicketsMaster!A:H)
-- ---------------------------------------------------------------------
CREATE TABLE help_tickets (
  ticket_id     TEXT PRIMARY KEY,                      -- #00001
  created_by    TEXT NOT NULL,
  assigned_to   TEXT NOT NULL,
  issue         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Pending',
  created_date  TEXT NOT NULL DEFAULT '',
  done_date     TEXT NOT NULL DEFAULT '',
  issue_photo   TEXT NOT NULL DEFAULT '',              -- r2:key | url
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_help_created_by ON help_tickets(created_by COLLATE NOCASE);
CREATE INDEX idx_help_assigned_to ON help_tickets(assigned_to COLLATE NOCASE);

-- ---------------------------------------------------------------------
-- SUPPORT TICKETS  (Sheet: SupportTicketsMaster!A:O)
-- One row per MIS member; rows raised together share group_key and move
-- through the workflow together (Sheets did this by matching Issue text).
-- ---------------------------------------------------------------------
CREATE TABLE support_tickets (
  ticket_id     TEXT PRIMARY KEY,
  group_key     TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  assigned_to   TEXT NOT NULL,
  issue         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Pending',       -- Pending|InProgress|Done
  created_date  TEXT NOT NULL DEFAULT '',
  done_date     TEXT NOT NULL DEFAULT '',
  issue_photo   TEXT NOT NULL DEFAULT '',
  work_by       TEXT NOT NULL DEFAULT '',
  approval      TEXT NOT NULL DEFAULT 'Pending',       -- Taskcompletedapproval
  col_k         TEXT NOT NULL DEFAULT '',
  col_l         TEXT NOT NULL DEFAULT '',
  problem       TEXT NOT NULL DEFAULT '',
  solution      TEXT NOT NULL DEFAULT '',
  department    TEXT NOT NULL DEFAULT '',              -- creator's department
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_support_group ON support_tickets(group_key);
CREATE INDEX idx_support_created_by ON support_tickets(created_by COLLATE NOCASE);
CREATE INDEX idx_support_assigned_to ON support_tickets(assigned_to COLLATE NOCASE);

-- ---------------------------------------------------------------------
-- WORKLIST  (Sheet: WorkList!A:J)
-- ---------------------------------------------------------------------
CREATE TABLE worklists (
  worklist_id     TEXT PRIMARY KEY,
  employee_name   TEXT NOT NULL,
  worklist_name   TEXT NOT NULL,
  frequency       TEXT NOT NULL CHECK (frequency IN ('Daily','Weekly','Monthly','Yearly')),
  working_time    TEXT NOT NULL DEFAULT '',            -- e.g. "30M"
  template_link   TEXT NOT NULL DEFAULT '',
  remark          TEXT NOT NULL DEFAULT '',
  schedule_days   TEXT NOT NULL DEFAULT '',
  schedule_dates  TEXT NOT NULL DEFAULT '',
  ai_time         TEXT NOT NULL DEFAULT '',
  position        INTEGER NOT NULL DEFAULT 0,          -- preserves sheet row order
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_worklists_employee ON worklists(employee_name);

-- ---------------------------------------------------------------------
-- TRAINING  (Training spreadsheet: MasterTemplateData, AQData, EmployeeTrainingData)
-- ---------------------------------------------------------------------
CREATE TABLE training_templates (
  template_id    TEXT PRIMARY KEY,                     -- TMP-XXXXXXXX
  designation    TEXT NOT NULL,                        -- 'COMMON' or a designation
  training_name  TEXT NOT NULL DEFAULT '',
  score          TEXT NOT NULL DEFAULT '100',
  approval       TEXT NOT NULL DEFAULT 'Pending',      -- Pending|Approved
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE training_indices (                         -- one per MasterTemplateData row
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id   TEXT NOT NULL REFERENCES training_templates(template_id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  index_name    TEXT NOT NULL,
  document      TEXT NOT NULL DEFAULT '',
  video         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_training_indices_tpl ON training_indices(template_id, position);

CREATE TABLE training_questions (                       -- AQData
  qa_id           TEXT PRIMARY KEY,
  template_id     TEXT NOT NULL REFERENCES training_templates(template_id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  option_a        TEXT NOT NULL DEFAULT '',
  option_b        TEXT NOT NULL DEFAULT '',
  option_c        TEXT NOT NULL DEFAULT '',
  option_d        TEXT NOT NULL DEFAULT '',
  correct_option  TEXT NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_training_questions_tpl ON training_questions(template_id, position);

CREATE TABLE training_records (                         -- EmployeeTrainingData
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_name    TEXT NOT NULL,
  designation      TEXT NOT NULL DEFAULT '',
  template_name    TEXT NOT NULL DEFAULT '',
  template_id      TEXT NOT NULL,                       -- no FK: records outlive deleted templates
  document_score   INTEGER NOT NULL DEFAULT 0,
  video_score      INTEGER NOT NULL DEFAULT 0,
  qa_score         INTEGER NOT NULL DEFAULT 0,
  total_score      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'In Progress',
  start_date       TEXT NOT NULL DEFAULT '',
  end_date         TEXT NOT NULL DEFAULT '',
  last_update      TEXT NOT NULL DEFAULT '',
  tools_documents  TEXT NOT NULL DEFAULT '',
  tools_translite  TEXT NOT NULL DEFAULT '',
  tools_summary    TEXT NOT NULL DEFAULT '',
  progress         TEXT NOT NULL DEFAULT '{}',          -- JSON (docs/vids/views/qa)
  UNIQUE (employee_name, template_id)
);

-- ---------------------------------------------------------------------
-- ADDITIONAL FEATURES  (Sheet: AdditionalFeature!A:D)
-- ---------------------------------------------------------------------
CREATE TABLE additional_features (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  added_by      TEXT NOT NULL,
  feature_name  TEXT NOT NULL,
  feature_url   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_features_added_by ON additional_features(added_by);

-- ---------------------------------------------------------------------
-- EM SHEET  (separate spreadsheet, tab "EM SHEET WITH RITEH SIR", A1:M1000)
-- Stored as the raw grid so the existing report parser is reproduced 1:1.
-- ---------------------------------------------------------------------
CREATE TABLE em_sheet_rows (
  row_index  INTEGER PRIMARY KEY,                      -- 0 = header row
  cells      TEXT NOT NULL                             -- JSON array of 13 strings (A..M)
);

-- ---------------------------------------------------------------------
-- PLATFORM TABLES
-- ---------------------------------------------------------------------
CREATE TABLE counters (                                -- atomic sequential IDs
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);
INSERT INTO counters (name, value) VALUES ('help_ticket', 0), ('support_ticket', 0);

CREATE TABLE job_runs (                                -- cron idempotency (replaces last-generate.txt)
  job        TEXT NOT NULL,
  period     TEXT NOT NULL,
  ran_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  result     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (job, period)
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor       TEXT NOT NULL,                           -- employee_id or 'system'
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

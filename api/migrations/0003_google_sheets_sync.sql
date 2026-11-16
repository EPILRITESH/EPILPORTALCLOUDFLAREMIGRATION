-- 0003 — Google Sheets backup sync (D1 → Sheets, one-way)
--
-- Every insert/update/delete on a synced table is captured by a trigger into
-- sheet_sync_queue (table + the row's natural key). A scheduled job drains the
-- queue and upserts/clears the matching rows in the legacy Google Sheets.
-- Triggers mean nothing can bypass capture (API, cron, manual SQL).

CREATE TABLE sheet_sync_queue (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl  TEXT NOT NULL,
  k    TEXT NOT NULL,
  at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sheet_sync_queue_tbl ON sheet_sync_queue(tbl, id);

-- lock + per-tab status (last success / last error)
CREATE TABLE sheet_sync_state (
  name        TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO sheet_sync_state (name, value) VALUES ('lock', '0');

CREATE TRIGGER trg_sync_users_ins AFTER INSERT ON users BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('users', NEW.role || ':' || NEW.employee_id); END;
CREATE TRIGGER trg_sync_users_upd AFTER UPDATE ON users BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('users', NEW.role || ':' || NEW.employee_id); END;
CREATE TRIGGER trg_sync_users_del AFTER DELETE ON users BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('users', OLD.role || ':' || OLD.employee_id); END;

CREATE TRIGGER trg_sync_delegations_ins AFTER INSERT ON delegations BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('delegations', NEW.task_id); END;
CREATE TRIGGER trg_sync_delegations_upd AFTER UPDATE ON delegations BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('delegations', NEW.task_id); END;
CREATE TRIGGER trg_sync_delegations_del AFTER DELETE ON delegations BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('delegations', OLD.task_id); END;

CREATE TRIGGER trg_sync_checklist_tasks_ins AFTER INSERT ON checklist_tasks BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('checklist_tasks', NEW.task_id); END;
CREATE TRIGGER trg_sync_checklist_tasks_upd AFTER UPDATE ON checklist_tasks BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('checklist_tasks', NEW.task_id); END;
CREATE TRIGGER trg_sync_checklist_tasks_del AFTER DELETE ON checklist_tasks BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('checklist_tasks', OLD.task_id); END;

CREATE TRIGGER trg_sync_checklist_templates_ins AFTER INSERT ON checklist_templates BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('checklist_templates', NEW.template_id); END;
CREATE TRIGGER trg_sync_checklist_templates_upd AFTER UPDATE ON checklist_templates BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('checklist_templates', NEW.template_id); END;
CREATE TRIGGER trg_sync_checklist_templates_del AFTER DELETE ON checklist_templates BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('checklist_templates', OLD.template_id); END;

CREATE TRIGGER trg_sync_help_tickets_ins AFTER INSERT ON help_tickets BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('help_tickets', NEW.ticket_id); END;
CREATE TRIGGER trg_sync_help_tickets_upd AFTER UPDATE ON help_tickets BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('help_tickets', NEW.ticket_id); END;
CREATE TRIGGER trg_sync_help_tickets_del AFTER DELETE ON help_tickets BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('help_tickets', OLD.ticket_id); END;

CREATE TRIGGER trg_sync_support_tickets_ins AFTER INSERT ON support_tickets BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('support_tickets', NEW.ticket_id); END;
CREATE TRIGGER trg_sync_support_tickets_upd AFTER UPDATE ON support_tickets BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('support_tickets', NEW.ticket_id); END;
CREATE TRIGGER trg_sync_support_tickets_del AFTER DELETE ON support_tickets BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('support_tickets', OLD.ticket_id); END;

CREATE TRIGGER trg_sync_worklists_ins AFTER INSERT ON worklists BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('worklists', NEW.worklist_id); END;
CREATE TRIGGER trg_sync_worklists_upd AFTER UPDATE ON worklists BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('worklists', NEW.worklist_id); END;
CREATE TRIGGER trg_sync_worklists_del AFTER DELETE ON worklists BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('worklists', OLD.worklist_id); END;

CREATE TRIGGER trg_sync_training_templates_ins AFTER INSERT ON training_templates BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_templates', NEW.template_id); END;
CREATE TRIGGER trg_sync_training_templates_upd AFTER UPDATE ON training_templates BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_templates', NEW.template_id); END;
CREATE TRIGGER trg_sync_training_templates_del AFTER DELETE ON training_templates BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_templates', OLD.template_id); END;

CREATE TRIGGER trg_sync_training_indices_ins AFTER INSERT ON training_indices BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_indices', NEW.template_id); END;
CREATE TRIGGER trg_sync_training_indices_upd AFTER UPDATE ON training_indices BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_indices', NEW.template_id); END;
CREATE TRIGGER trg_sync_training_indices_del AFTER DELETE ON training_indices BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_indices', OLD.template_id); END;

CREATE TRIGGER trg_sync_training_questions_ins AFTER INSERT ON training_questions BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_questions', NEW.qa_id); END;
CREATE TRIGGER trg_sync_training_questions_upd AFTER UPDATE ON training_questions BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_questions', NEW.qa_id); END;
CREATE TRIGGER trg_sync_training_questions_del AFTER DELETE ON training_questions BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_questions', OLD.qa_id); END;

CREATE TRIGGER trg_sync_training_records_ins AFTER INSERT ON training_records BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_records', NEW.employee_name || '|||' || NEW.template_id); END;
CREATE TRIGGER trg_sync_training_records_upd AFTER UPDATE ON training_records BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_records', NEW.employee_name || '|||' || NEW.template_id); END;
CREATE TRIGGER trg_sync_training_records_del AFTER DELETE ON training_records BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('training_records', OLD.employee_name || '|||' || OLD.template_id); END;

CREATE TRIGGER trg_sync_additional_features_ins AFTER INSERT ON additional_features BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('additional_features', NEW.added_by || '|||' || NEW.feature_name || '|||' || NEW.feature_url); END;
CREATE TRIGGER trg_sync_additional_features_upd AFTER UPDATE ON additional_features BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('additional_features', NEW.added_by || '|||' || NEW.feature_name || '|||' || NEW.feature_url); END;
CREATE TRIGGER trg_sync_additional_features_del AFTER DELETE ON additional_features BEGIN INSERT INTO sheet_sync_queue (tbl, k) VALUES ('additional_features', OLD.added_by || '|||' || OLD.feature_name || '|||' || OLD.feature_url); END;

-- KYC document changes re-sync the owning employee's row
CREATE TRIGGER trg_sync_user_documents_ins AFTER INSERT ON user_documents BEGIN
  INSERT INTO sheet_sync_queue (tbl, k) SELECT 'users', role || ':' || employee_id FROM users WHERE id = NEW.user_id; END;
CREATE TRIGGER trg_sync_user_documents_upd AFTER UPDATE ON user_documents BEGIN
  INSERT INTO sheet_sync_queue (tbl, k) SELECT 'users', role || ':' || employee_id FROM users WHERE id = NEW.user_id; END;

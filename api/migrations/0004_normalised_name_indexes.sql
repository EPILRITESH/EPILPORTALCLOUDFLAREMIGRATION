-- 0004 — match people by name ignoring case and extra whitespace
--
-- Legacy sheets store names like "Mohammad Sami " (trailing space), "Muskan  Khan" (double
-- space) and "chandani Rai" (case) while the user record holds the clean name, which hid
-- 1,842 rows from their owners. The API now compares NAME_SQL(column) = normName(value)
-- (api/src/lib/util.ts). These expression indexes use the IDENTICAL expression so lookups stay
-- indexed. Data is not rewritten (the old portal still writes the spaced names).

CREATE INDEX idx_delegations_name_norm ON delegations(lower(trim(replace(replace(replace(name, char(9), ' '), '  ', ' '), '  ', ' '))));
CREATE INDEX idx_delegations_followup_norm ON delegations(lower(trim(replace(replace(replace(followup, char(9), ' '), '  ', ' '), '  ', ' '))));
CREATE INDEX idx_checklist_tasks_name_norm ON checklist_tasks(lower(trim(replace(replace(replace(name, char(9), ' '), '  ', ' '), '  ', ' '))));
CREATE INDEX idx_help_tickets_created_by_norm ON help_tickets(lower(trim(replace(replace(replace(created_by, char(9), ' '), '  ', ' '), '  ', ' '))));
CREATE INDEX idx_help_tickets_assigned_to_norm ON help_tickets(lower(trim(replace(replace(replace(assigned_to, char(9), ' '), '  ', ' '), '  ', ' '))));
CREATE INDEX idx_support_tickets_created_by_norm ON support_tickets(lower(trim(replace(replace(replace(created_by, char(9), ' '), '  ', ' '), '  ', ' '))));
CREATE INDEX idx_support_tickets_assigned_to_norm ON support_tickets(lower(trim(replace(replace(replace(assigned_to, char(9), ' '), '  ', ' '), '  ', ' '))));
CREATE INDEX idx_worklists_employee_name_norm ON worklists(lower(trim(replace(replace(replace(employee_name, char(9), ' '), '  ', ' '), '  ', ' '))));
CREATE INDEX idx_training_records_employee_name_norm ON training_records(lower(trim(replace(replace(replace(employee_name, char(9), ' '), '  ', ' '), '  ', ' '))));
CREATE INDEX idx_additional_features_added_by_norm ON additional_features(lower(trim(replace(replace(replace(added_by, char(9), ' '), '  ', ' '), '  ', ' '))));

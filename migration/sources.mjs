// Every Google Sheet tab the legacy backend read or wrote.
// `env` is the variable name from EPILBACKEND/.env that held the spreadsheet ID.
export const SOURCES = [
  { key: "employee", env: "GOOGLE_SHEET_ID", tab: "Employee", range: "A1:BZ" },
  { key: "admin", env: "GOOGLE_SHEET_ID", tab: "Admin", range: "A1:L" },
  { key: "additional_feature", env: "GOOGLE_SHEET_ID", tab: "AdditionalFeature", range: "A1:D" },
  { key: "delegation", env: "GOOGLE_SHEET_ID_DELEGATION", tab: "DelegationMaster", range: "A1:R" },
  { key: "checklist_master", env: "GOOGLE_SHEET_ID_CHECKLIST", tab: "Master", range: "A1:K" },
  { key: "checklist_templates", env: "GOOGLE_SHEET_ID_CHECKLIST", tab: "MasterTasks", range: "A1:I", optional: true },
  { key: "checklist_consolidated", env: "GOOGLE_SHEET_ID_CHECKLIST", tab: "Consolidated", range: "A1:B", optional: true },
  { key: "help_tickets", env: "GOOGLE_SHEET_ID_HELPTICKET", tab: "HelpTicketsMaster", range: "A1:H" },
  { key: "support_tickets", env: "GOOGLE_SHEET_ID_SUPPORTTICKET", tab: "SupportTicketsMaster", range: "A1:Z" },
  { key: "worklist", env: "GOOGLE_SHEET_ID_WORKLIST", tab: "WorkList", range: "A1:J" },
  { key: "training_master", env: "GOOGLE_SHEET_ID_TRAINING", tab: "MasterTemplateData", range: "A1:I" },
  { key: "training_qa", env: "GOOGLE_SHEET_ID_TRAINING", tab: "AQData", range: "A1:H" },
  { key: "training_records", env: "GOOGLE_SHEET_ID_TRAINING", tab: "EmployeeTrainingData", range: "A1:R" },
  { key: "em_sheet", env: "GOOGLE_SHEET_ID_EMSHEET", tab: process.env.EM_SHEET_TAB_NAME || "EM SHEET WITH RITEH SIR", range: "A1:M1000", optional: true },
];

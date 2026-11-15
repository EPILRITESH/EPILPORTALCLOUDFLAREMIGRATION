// Generates realistic legacy sheet exports (same shapes as export-sheets.mjs output),
// including the messy cases seen in hand-edited Google Sheets.
import { mkdir, writeFile } from "node:fs/promises";
import bcrypt from "../../api/node_modules/bcryptjs/index.js";

export async function makeFixtures(dir) {
  await mkdir(`${dir}/sheets`, { recursive: true });
  const hash = bcrypt.hashSync("legacy123", 10);
  const put = (key, rows) => writeFile(`${dir}/sheets/${key}.json`, JSON.stringify({ rows }));

  const empHeader = ["EmployeeID", "Name", "Mobile", "Password", "Department", "Created", "Company", "DOB", "Joining", "Profile", "Designation", "DoerName"];
  const empRow = (id, name, mobile, dept, desig, extra = {}) => {
    const r = new Array(75).fill("");
    Object.assign(r, { 0: id, 1: name, 2: mobile, 3: hash, 4: dept, 5: "2025-01-02T10:00:00.000Z", 6: "EPIL", 7: "01/02/1990", 8: "15/03/2024", 10: desig }, extra);
    return r;
  };
  await put("employee", [
    empHeader,
    empRow("e1AAAA", "Asha", "9000000002", "Accounts", "Accountant", { 9: "https://res.cloudinary.com/demo/image/upload/v1700/employee_documents/asha.jpg", 47: "SBI", 54: "https://res.cloudinary.com/demo/image/upload/v1700/employee_documents/aadhaar_1.jpg" }),
    empRow("e2BBBB", "Ravi", "9000000003", "MIS", "MIS Executive"),
    empRow("e3CCCC", "Meena", "9000000004", "MIS", ""), // blank designation -> fallback heuristic
    [], // blank row
    empRow("e2BBBB", "Ravi Duplicate", "9000000099", "MIS", "MIS Executive"), // duplicate id
  ]);
  await put("admin", [["ID", "Name", "Mobile", "Password", "Department", "Created"], ["a1ZZZZ", "Ritesh", "9000000001", hash, "Management", "2024-12-01T00:00:00.000Z"]]);
  await put("additional_feature", [["AddedBy", "Name", "URL", "At"], ["Asha", "Tally", "https://tally.example", "2025-02-01T00:00:00.000Z"]]);
  await put("delegation", [
    ["TaskID", "Name", "TaskName", "Created", "Deadline", "R1", "R2", "Final", "Revisions", "Priority", "Status", "Followup", "Week", "Approval"],
    ["d1", "Asha", "File GST", "01/03/2026 10:00:00", "05/03/2026", "", "", "04/03/2026 11:00:00", "0", "High", "Completed", "Ritesh", "02/03/2026 10:00:00", "Approved"],
    ["d2", "Asha", "Bank recon", "02/03/2026 10:00:00", "03/03/2026", "04/03/2026", "", "", "1", "Low", "Shifted", "Ritesh", "", "Pending"],
    ["d1", "Ravi", "Duplicate id task", "02/03/2026 10:00:00", "03/03/2026"],
    ["", "", "", "", ""],
  ]);
  await put("checklist_master", [
    ["Name", "Email", "Department", "TaskID", "Freq", "Task", "Planned", "Actual", "I", "J", "K"],
    ["Asha", "", "Accounts", "c1", "D", "Cash count", "02/03/2026 23:59:59", "", "AUTO", "t1", ""],
    ["Asha", "", "Accounts", "c2", "D", "Cash count", "03/03/2026 23:59:59", "", "AUTO", "t1", ""],
    ["Asha", "", "Accounts", "c3", "D", "Cash count", "03/03/2026 23:59:59", "", "AUTO", "t1", ""], // duplicate slot
    [], // cleared row
  ]);
  await put("checklist_consolidated", [["TaskID", "Done"], ["c1", "02/03/2026 18:00:00"]]);
  await put("checklist_templates", [["TemplateID", "Name", "Email", "Dept", "Task", "Freq", "DayOrDate", "CreatedAt", "Status"], ["t1", "Asha", "", "Accounts", "Cash count", "D", "", "2026-02-01T00:00:00Z", "active"]]);
  await put("help_tickets", [
    ["TicketID", "CreatedBy", "AssignedTo", "Issue", "Status", "Created", "Done", "Photo"],
    ["#00001", "Asha", "Ravi", "Printer jam", "Done", "01/03/2026 09:00:00", "02/03/2026 09:00:00", "https://res.cloudinary.com/demo/image/upload/v1/employee_documents/help_1.jpg"],
    ["#00007", "Asha", "Ravi", "Mouse", "Pending", "03/03/2026 09:00:00", "", ""],
  ]);
  await put("support_tickets", [
    ["TicketID", "CreatedBy", "AssignedTo", "Issue", "Status", "Created", "Done", "Photo", "WorkBy", "Approval", "K", "L", "Problem", "Solution", "Dept"],
    ["#00001", "Asha", "Ravi", "VPN down", "InProgress", "01/03/2026 09:00:00", "", "", "Ravi", "Pending", "", "", "", "", "Accounts"],
    ["#00002", "Asha", "Meena", "VPN down", "InProgress", "01/03/2026 09:00:00", "", "", "Ravi", "Pending", "", "", "", "", "Accounts"],
    ["#00002", "Asha", "Ravi", "Email", "Pending", "02/03/2026 09:00:00", "", "", "", "Pending", "", "", "", "", "Accounts"], // duplicate id
  ]);
  await put("worklist", [
    ["ID", "Employee", "Name", "Freq", "Time", "Link", "Remark", "Days", "Dates", "AI"],
    ["w1", "Asha", "Daily MIS", "Daily", "60M", "", "", "", "", "20M"],
    ["w2", "Asha", "Odd one", "Fortnightly", "10M"], // invalid frequency
  ]);
  await put("training_master", [
    ["Template ID", "Designation", "Index", "Doc", "Video", "Score", "Approval", "Training Name"],
    ["TMP-1", "COMMON", "Safety", "https://docs/1", "https://yt/1", "100", "Approved", "Induction"],
    ["TMP-1", "COMMON", "Quality", "https://docs/2", "https://yt/2", "100", "Approved", "Induction"],
    ["TMP-2", "Accountant", "Tally", "https://docs/3", "https://yt/3", "100", "Pending", "Tally"],
  ]);
  await put("training_qa", [
    ["Template", "QA", "Q", "A", "B", "C", "D", "Correct"],
    ["TMP-1", "QA-1", "Wear PPE?", "Yes", "No", "", "", "A"],
    ["TMP-9", "QA-9", "Orphan", "x", "y", "", "", "A"],
  ]);
  await put("training_records", [
    ["Employee", "Designation", "Template", "TemplateID", "Doc", "Video", "QA", "Total", "Status", "Start", "End", "Last", "M", "N", "O", "Progress"],
    ["Asha", "Accountant", "Induction", "TMP-1", "50", "50", "0", "100", "In Progress", "01/03/2026", "", "02/03/2026 10:00:00", "", "", "", JSON.stringify({ docs: ["1"], vids: ["1"], views: { doc: { 1: 4 }, video: { 1: 4 } } })],
  ]);
  await put("em_sheet", [
    ["NO", "DOER NAME"], ["", "WEEK NO.-09 (02/03 TO 08/03)"], ["1", "Asha", "10", "2", "20.00%", "1", "5%", "4", "1", "25.00%", "0", "5%", "NO"], ["", "TOTAL DOER", "3"],
  ]);
}

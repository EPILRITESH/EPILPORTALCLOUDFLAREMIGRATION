import React, { useState, useEffect, useCallback } from "react";
import {
  getApprovedTrainings, getTrainingQuestionsForTest, getMyTrainings, startTraining, updateTrainingProgress, getUserProfile,
} from "../api/services";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

const STATUS_BADGE = {
  Pending: "bg-amber-100 text-amber-800",
  "In Progress": "bg-blue-100 text-blue-800",
  Completed: "bg-emerald-100 text-emerald-800",
};

const isUrl = (s) => /^https?:\/\//i.test(s || "");
const isYoutube = (u) => /(youtube\.com|youtu\.be)/i.test(u || "");
const isGoogle = (u) => /(drive\.google\.com|docs\.google\.com)/i.test(u || "");
// Rule (UI par "15 minutes" dikhta hai): 2 self + 2 with-doer = 4 total, actual gap 2 min (fast complete).
// Video ke case me video ka apna timeframe — video slot ka cooldown bhi 2 min.
const REQUIRED_SELF_VIEWS = 2;
const REQUIRED_WITHDOER_VIEWS = 2;
const REQUIRED_VIEWS = 4;
const isCommonTpl = (t) => String(t?.Designation ?? t?.Department ?? "").trim().toUpperCase() === "COMMON";
// views slot: {self, withDoer, lastAt} (purana number format migrate: total>=4 → 2+2 complete)
// NOTE: cooldown hataya gaya — har view INSTANT count hota hai, lastAt sirf audit ke liye.
const slotOf = (views, kind, i) => {
  const raw = views?.[kind]?.[String(i)];
  if (raw && typeof raw === "object") return { self: parseInt(raw.self || "0", 10) || 0, withDoer: parseInt(raw.withDoer || "0", 10) || 0, lastAt: parseInt(raw.lastAt || "0", 10) || 0 };
  const total = parseInt(raw || "0", 10) || 0;
  return { self: Math.min(REQUIRED_SELF_VIEWS, total), withDoer: Math.min(REQUIRED_WITHDOER_VIEWS, Math.max(0, total - Math.min(REQUIRED_SELF_VIEWS, total))), lastAt: 0 };
};

const youtubeEmbed = (url) => {
  const m = url.match(/(?:v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{6,})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : "";
};
const drivePreview = (url) => {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? `https://drive.google.com/file/d/${m[1]}/preview` : "";
};
const renderableVideoUrl = (video) => {
  if (!isUrl(video)) return "";
  if (isYoutube(video)) return youtubeEmbed(video) || video;
  if (isGoogle(video)) return drivePreview(video) || video;
  return video;
};

export default function Training() {
  const [templates, setTemplates] = useState([]);
  const templatesRef = React.useRef([]);
  const tplOfRef = (id) => templatesRef.current.find((t) => t.TemplateId === id);
  const [records, setRecords] = useState([]);
  const [summary, setSummary] = useState(null); // {common, dept, total}
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("list"); // "list" | "learn"
  const [selected, setSelected] = useState(null);
  const [record, setRecord] = useState(null);
  const [views, setViews] = useState({ doc: {}, video: {} }); // 5-times protection counter
  const [currentIndex, setCurrentIndex] = useState(1);
  const [contentTab, setContentTab] = useState("document"); // document | video | qa
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [qaResult, setQaResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [userDesignation, setUserDesignation] = useState("");
  const [userDepartment, setUserDepartment] = useState("");
  const [viewMode, setViewMode] = useState("self"); // "self" | "withDoer" — kaun dekh raha hai

  // Tools
  const [tools, setTools] = useState({ documents: "", translite: "", summary: "" });
  const [savingTool, setSavingTool] = useState("");
  const [doerStatusFilter, setDoerStatusFilter] = useState("all"); // all|Pending|In Progress|Completed

  // ================= LOADERS =================
  const load = useCallback(async () => {
    setLoading(true);
    try {
      // User ki designation nikalo — training ab designation se match hoti hai
      const profileRes = await getUserProfile();
      const userDesig = profileRes.data?.designation || "";
      const userDept = profileRes.data?.department || "";
      setUserDesignation(userDesig);
      setUserDepartment(userDept);

      const [tRes, mRes] = await Promise.all([getApprovedTrainings(userDesig || userDept), getMyTrainings()]);
      setTemplates(tRes.data.templates || []);
      templatesRef.current = tRes.data.templates || [];
      setRecords(mRes.data.records || []);
      setSummary(mRes.data.summary || null);
    } catch (err) { console.error(err); toast.error("Failed to load trainings"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ================= DERIVED =================
  // records = BACKEND ASSIGNED ROWS (har assigned template ki row: record na ho → Pending/Started=false).
  // isliye yahi se total learning / pending / inProgress / completed sab nikalta hai.
  const myRecordFor = (templateId) => records.find((r) => r.TemplateId === templateId);
  const assignedRows = records; // /my ab assigned rows deta hai
  const S = summary || { common: {}, dept: {}, total: {} };
  const cS = S.common || {}; const dS = S.dept || {}; const tS = S.total || {};
  // Type bucket: backend "Designation" bhejta hai, purane client "Dept" — dono ko designation hi maano.
  const isCommonRow = (r) => String(r?.Type || "").trim().toUpperCase() === "COMMON";
  const rowsOf = (type) =>
    assignedRows.filter((r) => (type === "all" ? true : type === "Common" ? isCommonRow(r) : !isCommonRow(r)));
  const listByStatus = (arr, st) =>
    st === "all" ? arr : st === "Pending" ? arr.filter((r) => r.Status === "Pending")
      : st === "In Progress" ? arr.filter((r) => r.Status === "In Progress")
      : arr.filter((r) => r.Status === "Completed");

  const syncRecord = (newRec) => {
    setRecord(newRec);
    // assigned row shape banaye rakho (Type/Started/TemplateDepartment/Progress na khoye)
    setRecords((prev) => {
      const idx = prev.findIndex((r) => r.TemplateId === newRec.TemplateId);
      if (idx === -1) return [...prev, { ...newRec, Type: newRec.Type || "Designation", Started: true }];
      const copy = [...prev];
      copy[idx] = { ...copy[idx], ...newRec, Started: true, Progress: { ...(copy[idx].Progress || {}), ...(newRec.Progress || {}) } };
      return copy;
    });
    if (newRec.Progress && newRec.Progress.views) setViews(newRec.Progress.views);
    setTools({
      documents: newRec.ToolsDocuments || "",
      translite: newRec.ToolsTranslite || "",
      summary: newRec.ToolsSummary || "",
    });
  };

  // ================= ACTIONS =================
  const [startId, setStartId] = useState(""); // kaunsa card start/continue ho raha hai (loading label)
  const handleStart = async (template) => {
    setStartId(template.TemplateId || "new");
    setBusy(true);
    try {
      const res = await startTraining(template.TemplateId);
      // Ensure template has indices, fallback to empty array
      const templateWithIndices = { 
        ...template, 
        indices: template.indices || [] 
      };
      setSelected(templateWithIndices);
      syncRecord(res.data.record);
      if (res.data.record.Progress && res.data.record.Progress.views)
        setViews(res.data.record.Progress.views);
      else setViews({ doc: {}, video: {} });
      setCurrentIndex(1);
      setContentTab(templateWithIndices.indices[0]?.Document ? "document" : "video");
      setAnswers({});
      setQaResult(res.data.record.Progress && res.data.record.Progress.qa ? res.data.record.Progress.qa : null);
      // Set view after selected to avoid race condition
      setView("learn");
      const qRes = await getTrainingQuestionsForTest(template.TemplateId);
      setQuestions(qRes.data.questions || []);
    } catch (err) {
      toast.error(err.response?.data?.error || "Could not start training");
    } finally { setBusy(false); setStartId(""); }
  };

  const handleContinue = async (template) => {
    // PENDING row se continue dabaya to pehle /start karo (record banao)
    let rec = myRecordFor(template.TemplateId);
    if (!rec || !rec.Started) {
      const full0 = tplOfRef(template.TemplateId) || template;
      return handleStart(full0.TemplateId ? full0 : { ...template, TemplateName: template.TemplateName, Department: template.TemplateDepartment });
    }
    setStartId(template.TemplateId);
    setBusy(true);
    try {
      // assigned row me template ke indices nahi hote → approved list se lo
      const full = tplOfRef(template.TemplateId) || template;
      const templateWithIndices = {
        ...full,
        indices: full.indices || []
      };
      setSelected(templateWithIndices);
      syncRecord(rec);
      if (rec && rec.Progress && rec.Progress.views) setViews(rec.Progress.views);
      else setViews({ doc: {}, video: {} });
      setCurrentIndex(1);
      setContentTab("document");
      setQaResult(rec.Progress && rec.Progress.qa ? rec.Progress.qa : null);
      // Set view after selected to avoid race condition
      setView("learn");
      const qRes = await getTrainingQuestionsForTest(template.TemplateId);
      setQuestions(qRes.data.questions || []);
    } catch (err) { console.error(err); }
    finally { setBusy(false); setStartId(""); }
  };

  const goBackToList = async () => {
    setView("list"); setSelected(null); setRecord(null); setQuestions([]);
    await load(); // assigned rows + summary dono refresh (single source)
  };

  // Rule: 2 self + 2 with-doer views — COOLDOWN HATA DIYA, har view INSTANT count hota hai.
  // tickingRef = double-click race guard: ek request poori hone tak dusri nahi jayegi.
  const tickingRef = React.useRef({});
  const tickView = async (kind, index, mode) => {
    const m = mode || viewMode;
    const tKey = `${kind}-${index}`;
    if (tickingRef.current[tKey])
      return toast.warn("Please wait — your last view is being saved...");
    tickingRef.current[tKey] = true;
    setBusy(true);
    try {
      const res = await updateTrainingProgress({ templateId: selected.TemplateId, viewTick: { kind, index, mode: m } });
      syncRecord(res.data.record);
      toast.success(m === "self" ? "Self view counted ✅ (instant)" : "With-doer view counted ✅ (instant)");
    } catch (err) {
      const v = err.response?.data?.views;
      if (v) setViews(v);
      toast.error(err.response?.data?.error || "Update failed");
    }
    finally { tickingRef.current[tKey] = false; setBusy(false); }
  };

  const docSlot = (i) => slotOf(views, "doc", i);
  const videoSlot = (i) => slotOf(views, "video", i);
  const docViewsTotal = (i) => docSlot(i).self + docSlot(i).withDoer;
  const videoViewsTotal = (i) => videoSlot(i).self + videoSlot(i).withDoer;
  const docReady = (i) => docSlot(i).self >= REQUIRED_SELF_VIEWS && docSlot(i).withDoer >= REQUIRED_WITHDOER_VIEWS;
  const videoReady = (i) => videoSlot(i).self >= REQUIRED_SELF_VIEWS && videoSlot(i).withDoer >= REQUIRED_WITHDOER_VIEWS;

  const markDoc = async () => {
    const s = docSlot(currentIndex);
    if (!docReady(currentIndex))
      return toast.warn(`Document needs 2 self reads + 2 with-doer reads (self ${s.self}/2, with doer ${s.withDoer}/2). Then "Mark as Read" will work.`);
    setBusy(true);
    try {
      const res = await updateTrainingProgress({ templateId: selected.TemplateId, docIndex: currentIndex });
      syncRecord(res.data.record);
      toast.success("Document marked as read ✅");
    } catch (err) {
      const v = err.response?.data?.views;
      if (v) setViews(v);
      toast.error(err.response?.data?.error || "Update failed");
    }
    finally { setBusy(false); }
  };

  const markVideo = async () => {
    const s = videoSlot(currentIndex);
    if (!videoReady(currentIndex))
      return toast.warn(`Video needs 2 self views + 2 with-doer views (self ${s.self}/2, with doer ${s.withDoer}/2). Then "Mark as Watched" will work.`);
    setBusy(true);
    try {
      const res = await updateTrainingProgress({ templateId: selected.TemplateId, videoIndex: currentIndex });
      syncRecord(res.data.record);
      toast.success("Video marked as watched ✅");
    } catch (err) {
      const v = err.response?.data?.views;
      if (v) setViews(v);
      toast.error(err.response?.data?.error || "Update failed");
    }
    finally { setBusy(false); }
  };

  const submitQa = async () => {
    if (!questions.length) return toast.warn("No questions available");
    const unanswered = questions.filter((q) => !answers[q.QaId]);
    if (unanswered.length) return toast.warn("Please answer all questions");
    setBusy(true);
    try {
      const res = await updateTrainingProgress({ templateId: selected.TemplateId, qaAnswers: answers });
      syncRecord(res.data.record);
      setQaResult(res.data.record.Progress.qa);
      toast.success(`QA Test submitted ✅ Score: ${res.data.record.Progress.qa.correct}/${res.data.record.Progress.qa.total}`);
    } catch (err) { toast.error(err.response?.data?.error || "Submit failed"); }
    finally { setBusy(false); }
  };

  const saveTool = async (field) => {
    setSavingTool(field);
    try {
      const res = await updateTrainingProgress({
        templateId: selected.TemplateId,
        tools: { documents: tools.documents, translite: tools.translite, summary: tools.summary },
      });
      syncRecord(res.data.record);
      toast.success("Tool saved 💾");
    } catch (err) { toast.error("Save failed"); }
    finally { setSavingTool(""); }
  };

  // ================= DERIVED =================
  const progressOf = record ? (record.Progress && typeof record.Progress === "object" ? record.Progress : {}) : {};
  const totalIndexes = selected ? selected.indices.length : 0;
  const docsDone = (progressOf.docs || []).map(String);
  const vidsDone = (progressOf.vids || []).map(String);
  const indexLocked = (i) => {
    if (i <= 1) return false;
    const prev = String(i - 1);
    return !docsDone.includes(prev) || !vidsDone.includes(prev);
  };
  const allContentDone = totalIndexes > 0 && docsDone.length >= totalIndexes && vidsDone.length >= totalIndexes;
  const qaDone = !!(progressOf.qa && progressOf.qa.attempted);
  const allDone = allContentDone && qaDone;

  // ============================================================
  // RENDER - LIST VIEW (assigned rows = source of truth)
  // ============================================================
  // Separate assigned rows into Common and Designation
  const allCommonRows = rowsOf("Common");
  const allDeptRows = rowsOf("Dept");

  // Logic:
  // - Common trainings HAMESHA dikhein (agar available hain)
  // - Designation trainings SIRF tab dikhein jab Common COMPLETED ho ya Designation STARTED ho
  const commonRecords = allCommonRows;
  const deptRecords = allDeptRows.filter((r) => r.Started);

  const allCommonCompleted = allCommonRows.length > 0 &&
    allCommonRows.every((r) => r.Status === "Completed");

  const anyDeptStarted = allDeptRows.some((r) => r.Started && r.Status !== "Pending");
  const anyDeptCompleted = allDeptRows.some((r) => r.Status === "Completed");

  // Show designation section only if Common is completed OR designation training is started
  const showDeptSection = allCommonRows.length === 0 || allCommonCompleted || anyDeptStarted;

  // Completed Common rows (for completed section)
  const completedCommon = allCommonRows.filter((r) => r.Status === "Completed");

  // In Progress/Available Common rows
  const activeCommon = allCommonRows.filter((r) => r.Status !== "Completed");

  const tplOf = (templateId) => templates.find((t) => t.TemplateId === templateId);

  // Assigned-row based card: har row = 1 learning (pending ho ya completed)
  const renderRowCard = (r) => {
    const t = tplOfRef(r.TemplateId) || tplOf(r.TemplateId) || {};
    return (
      <div key={`${r.Type}-${r.TemplateId}`} className="bg-white rounded-xl shadow border border-gray-200 overflow-hidden flex flex-col">
        <div className="px-4 py-3 bg-gray-50">
          <div className="flex items-center justify-between">
            <h3 className="font-black text-gray-800">{r.TemplateName || r.TemplateId}</h3>
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_BADGE[r.Status] || STATUS_BADGE.Pending}`}>{r.Status}</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            🎖️ {r.TemplateDesignation || r.TemplateDepartment || t.Designation || t.Department || "-"} &nbsp;•&nbsp; 🆔 {r.TemplateId}
            {!r.Started ? " • ⏳ Not started" : ""}
          </p>
        </div>
        <div className="px-4 py-3 text-sm text-gray-600 space-y-1">
          <p>📑 Indices: <b>{t.indices ? t.indices.length : "-"}</b></p>
          <p>❓ Questions: <b>{t.QuestionCount || 0}</b></p>
          {r.Started ? (
            <p>🎯 Score: <span className="font-black text-blue-700">{r.TotalScore}/300</span>
              <span className="text-xs text-gray-400"> ({Math.min(100, Math.round(r.TotalScore / 3))}%)</span></p>
          ) : (
            <p>🎯 Max Score: <b>300</b> <span className="text-xs text-gray-400">(Doc 100 + Video 100 + Q/A 100)</span></p>
          )}
        </div>
        <div className="px-4 py-2">
          {r.Status === "In Progress" && (
            <div className="h-1 bg-blue-600 rounded-full mb-2" style={{ width: `${Math.min(100, Math.round(r.TotalScore / 3))}%` }} />
          )}
        </div>
        <div className="px-4 py-2.5 border-t border-gray-200">
          {!r.Started ? (
            <button onClick={() => handleStart(t.TemplateId ? t : { TemplateId: r.TemplateId, TemplateName: r.TemplateName, Department: r.TemplateDesignation || r.TemplateDepartment, Designation: r.TemplateDesignation || r.TemplateDepartment, indices: [], QuestionCount: 0 })} disabled={busy}
              className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-bold hover:bg-blue-700 disabled:bg-blue-300">
              {busy && startId === (t.TemplateId || r.TemplateId) ? "⏳ Starting..." : "🚀 Start Training"}
            </button>
          ) : r.Status === "Completed" ? (
            <button onClick={() => handleContinue({ TemplateId: r.TemplateId })} disabled={busy}
              className="w-full bg-emerald-600 text-white rounded-lg py-2 text-sm font-bold hover:bg-emerald-700 disabled:bg-emerald-300">
              {busy && startId === r.TemplateId ? "⏳ Opening..." : "✅ Completed - View"}
            </button>
          ) : (
            <button onClick={() => handleContinue({ TemplateId: r.TemplateId })} disabled={busy}
              className="w-full bg-indigo-600 text-white rounded-lg py-2 text-sm font-bold hover:bg-indigo-700 disabled:bg-indigo-300">
              {busy && startId === r.TemplateId ? "⏳ Opening..." : "▶ Continue Training"}
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderTemplateCard = (t) => renderRowCard({
    TemplateId: t.TemplateId, TemplateName: t.TemplateName,
    TemplateDepartment: t.Designation ?? t.Department, TemplateDesignation: t.Designation ?? t.Department, Type: isCommonTpl(t) ? "Common" : "Designation",
    TotalScore: myRecordFor(t.TemplateId)?.TotalScore || 0,
    Status: myRecordFor(t.TemplateId)?.Status || "Pending",
    Started: !!myRecordFor(t.TemplateId),
  });

  // ============================================================
  // RENDER - LIST VIEW (Common First, Then Designation)
  // ============================================================
  const renderList = () => {
    return (
      <div className="space-y-4">
        {/* Banner */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white rounded-xl shadow p-5">
          <h2 className="text-lg font-black">🎓 Training Module</h2>
          <p className="text-sm mt-1 text-blue-100">Select a template and click <b>Start Training</b>. Rule: read/watch each document &amp; video <b>2 times by yourself + 2 times with your doer</b> (total 4 views) — har view <b>instantly</b> count hota hai, step by step.</p>
        </div>

        {/* ===== SUMMARY ===== */}
        {(() => {
          const pct = tS.totalMax ? Math.min(100, Math.round((tS.totalEarned / tS.totalMax) * 100)) : 0;
          const cards = [
            { k: "all", label: "All", count: tS.assigned || 0 },
            { k: "Pending", label: "Pending", count: tS.pending || 0 },
            { k: "In Progress", label: "In Progress", count: tS.inProgress || 0 },
            { k: "Completed", label: "Completed", count: tS.completed || 0 },
          ];
          return (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-gradient-to-br from-blue-500 to-blue-700 text-white rounded-xl p-4 shadow">
                <p className="text-xs uppercase opacity-80 font-bold">📚 Total Learning</p>
                <p className="text-3xl font-black">{tS.assigned || 0}</p>
                <p className="text-xs opacity-90 mt-1">✅ {tS.completed || 0} • 🔄 {tS.inProgress || 0} • ⏳ {tS.pending || 0}</p>
                <p className="text-xs font-black mt-1">🎯 Earned: {tS.totalEarned || 0}/{tS.totalMax || 0} ({pct}%)</p>
                <div className="h-2 bg-blue-300 rounded mt-2"><div className="h-2 bg-white rounded" style={{ width: `${pct}%` }} /></div>
              </div>
              <div className="bg-gradient-to-br from-emerald-500 to-emerald-700 text-white rounded-xl p-4 shadow">
                <p className="text-xs uppercase opacity-80 font-bold">📒 Common Learning</p>
                <p className="text-3xl font-black">{cS.assigned || 0}</p>
                <p className="text-xs opacity-90 mt-1">✅ {cS.completed || 0} • 🔄 {cS.inProgress || 0} • ⏳ {cS.pending || 0}</p>
                <p className="text-xs font-black mt-1">🎯 Earned: {cS.totalEarned || 0}/{cS.totalMax || 0}</p>
              </div>
              <div className="bg-gradient-to-br from-purple-500 to-purple-700 text-white rounded-xl p-4 shadow">
                <p className="text-xs uppercase opacity-80 font-bold">🎖️ Designation Learning</p>
                <p className="text-3xl font-black">{dS.assigned || 0}</p>
                <p className="text-xs opacity-90 mt-1">✅ {dS.completed || 0} • 🔄 {dS.inProgress || 0} • ⏳ {dS.pending || 0}</p>
                <p className="text-xs font-black mt-1">🎯 Earned: {dS.totalEarned || 0}/{dS.totalMax || 0}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 bg-white rounded-xl shadow p-3">
              <span className="text-xs font-bold text-gray-600">🔎 Status filter:</span>
              {cards.map((c) => (
                <button key={c.k} onClick={() => setDoerStatusFilter(c.k)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold ${doerStatusFilter === c.k ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-700 hover:bg-gray-300"}`}>
                  {c.label} ({c.count})
                </button>
              ))}
            </div>
          </>
          );
        })()}

        {/* Designation Info */}
        {(userDesignation || userDepartment) && (
          <div className="bg-purple-600 text-white rounded-xl shadow p-3">
            <p className="text-sm font-bold">👤 Designation: <span className="font-black">{userDesignation || userDepartment}</span></p>
            {allCommonRows.length > 0 && !allCommonCompleted && (
              <p className="text-xs text-purple-200 mt-1">🌐 Complete Common Trainings first to unlock Designation trainings</p>
            )}
            {allCommonRows.length > 0 && allCommonCompleted && (
              <p className="text-xs text-green-200 mt-1">✅ Common completed! Now you can do Designation trainings.</p>
            )}
          </div>
        )}

        {loading ? <p className="text-center py-10">⏳ Loading...</p> : tS.assigned === 0 ? (
          <div className="text-center py-10 text-gray-500">📭 No approved trainings available yet!</div>
        ) : (
          <>
            {/* Common Section */}
            {allCommonRows.length > 0 && (
              <div>
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-2xl">🌐</span>
                  <h3 className="text-lg font-black">Common Trainings</h3>
                  <span className="bg-purple-100 text-purple-800 text-xs font-bold px-2 py-1 rounded-full">{allCommonRows.length}</span>
                  {allCommonCompleted && <span className="bg-emerald-100 text-emerald-800 text-xs font-bold px-2 py-1 rounded-full">✅ Done</span>}
                </div>

                <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 mb-3">
                  <p className="text-xs text-purple-700">{completedCommon.length}/{allCommonRows.length} completed{!allCommonCompleted && ` — ${allCommonRows.length - completedCommon.length} remaining`}</p>
                </div>

                {listByStatus(activeCommon, doerStatusFilter).length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-bold text-gray-500 mb-2">📝 Active:</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {listByStatus(activeCommon, doerStatusFilter).map((r) => renderRowCard(r))}
                    </div>
                  </div>
                )}

                {(doerStatusFilter === "all" || doerStatusFilter === "Completed") && completedCommon.length > 0 && (
                  <div>
                    <p className="text-xs font-bold text-gray-500 mb-2">✅ Completed:</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {completedCommon.map((r) => renderRowCard(r))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Designation Section - Only if allowed */}
            {allDeptRows.length > 0 && showDeptSection && (
              <div>
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-2xl">🎖️</span>
                  <h3 className="text-lg font-black">{userDesignation || userDepartment || "Designation"} Trainings</h3>
                  <span className="bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded-full">{allDeptRows.length}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {listByStatus(allDeptRows, doerStatusFilter).map((r) => renderRowCard(r))}
                </div>
              </div>
            )}

            {/* Designation Locked */}
            {allDeptRows.length > 0 && !showDeptSection && (
              <div className="text-center py-8 bg-gray-100 border-2 border-dashed border-gray-300 rounded-xl">
                <p className="text-4xl mb-2">🔒</p>
                <p className="font-black text-gray-600">Designation Trainings Locked</p>
                <p className="text-sm text-gray-500 mt-1">Complete {allCommonRows.length} Common Training(s) first</p>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  // ============================================================
  // RENDER - LEARN VIEW
  // ============================================================
  const curIndex = (selected && selected.indices && selected.indices.length > 0)
    ? selected.indices[Math.min(currentIndex, totalIndexes) - 1] || selected.indices[0] || { IndexName: "Index 1", Document: "", Video: "" }
    : { IndexName: "Index 1", Document: "", Video: "" };
  const locked = indexLocked(currentIndex);

  const indexIcon = (i) => {
    const s = String(i);
    const d = docsDone.includes(s);
    const v = vidsDone.includes(s);
    if (d && v) return "✅";
    if (indexLocked(i)) return "🔒";
    return "📄";
  };

  const renderDocVideo = () => {
    const docDone = docsDone.includes(String(currentIndex));
    const vidDone = vidsDone.includes(String(currentIndex));
    const dS = docSlot(currentIndex);
    const vS = videoSlot(currentIndex);
    const docTotal = dS.self + dS.withDoer;
    const vidTotal = vS.self + vS.withDoer;
    const viewModeTabs = (kind) => (
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        <button onClick={() => setViewMode("self")}
          className={`px-3 py-1 rounded-md text-[11px] font-black ${viewMode === "self" ? "bg-white shadow text-blue-700" : "text-gray-500"}`}>
          🙋 Self
        </button>
        <button onClick={() => setViewMode("withDoer")}
          className={`px-3 py-1 rounded-md text-[11px] font-black ${viewMode === "withDoer" ? "bg-white shadow text-purple-700" : "text-gray-500"}`}>
          👥 With Doer
        </button>
      </div>
    );
    if (contentTab === "document") {
      const selfFull = dS.self >= REQUIRED_SELF_VIEWS;
      const doerFull = dS.withDoer >= REQUIRED_WITHDOER_VIEWS;
      return (
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h5 className="text-sm font-black text-gray-700 mb-2">📄 Document - {curIndex.IndexName}</h5>
          <div className="text-[11px] font-bold text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-2 py-1.5 mb-2">
            📌 Rule: Read this document <b>2 times by yourself</b> + <b>2 times with your doer</b> (total 4 views).
            Har view <b>instantly</b> count hota hai — koi waiting time nahi.
          </div>
          <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mb-2">
            👁️ Views: self {dS.self}/{REQUIRED_SELF_VIEWS} • with doer {dS.withDoer}/{REQUIRED_WITHDOER_VIEWS} • total {docTotal}/{REQUIRED_VIEWS}
            {docReady(currentIndex) ? " ✅ (now press Mark as Read)" : ""}
          </p>
          {curIndex.Document ? (
            isUrl(curIndex.Document) ? (
              <iframe src={curIndex.Document} title="Document" className="w-full h-80 border rounded-lg" />
            ) : (
              <div className="bg-gray-100 rounded-lg p-6 text-sm text-gray-600">
                📄 <b>{curIndex.Document}</b><br />
                <span className="text-xs text-gray-400">(Document link/name stored as text hai.)</span>
              </div>
            )
          ) : (
            <p className="text-sm text-gray-400">Koi document upload nahi hai.</p>
          )}
          <div className="flex gap-2 mt-3 flex-wrap items-center">
            {viewModeTabs("doc")}
            {docTotal < REQUIRED_VIEWS && !docDone ? (
              <button onClick={() => tickView("doc", currentIndex)} disabled={busy || (viewMode === "self" ? selfFull : doerFull)}
                title={viewMode === "self" ? (selfFull ? "Self views complete — switch to With Doer" : "Count one self read (instant)") : (doerFull ? "With-doer views complete — switch to Self" : "Count one with-doer read (instant)")}
                className="px-4 py-2 rounded-lg text-sm font-bold bg-amber-500 text-white hover:bg-amber-600 disabled:bg-amber-300 disabled:cursor-not-allowed">
                {busy ? "⏳ Saving..." : viewMode === "self" ? `🙋 I read it — Self (${dS.self}/${REQUIRED_SELF_VIEWS})` : `👥 Read with Doer (${dS.withDoer}/${REQUIRED_WITHDOER_VIEWS})`}
              </button>
            ) : null}
            {curIndex.Document && isUrl(curIndex.Document) && (
              <a href={curIndex.Document} target="_blank" rel="noreferrer"
                className="px-3 py-2 bg-gray-700 text-white rounded-lg text-xs font-bold">↗ Open in new tab</a>
            )}
            <button onClick={markDoc} disabled={busy || docDone || !docReady(currentIndex)}
              className={`px-4 py-2 rounded-lg text-sm font-bold ${docDone ? "bg-emerald-100 text-emerald-700" : "bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300"}`}>
              {busy ? "⏳ Saving..." : docDone ? "✅ Document Read" : `✅ Mark as Read${!docReady(currentIndex) ? ` (locked self ${dS.self}/2 • doer ${dS.withDoer}/2)` : ""}`}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h5 className="text-sm font-black text-gray-700 mb-2">🎬 Video - {curIndex.IndexName}</h5>
        {!docDone && (
          <p className="text-[11px] font-bold text-red-700 bg-red-50 border border-red-200 rounded-lg px-2 py-1 mb-2">
            🔒 Pehle isi Index ka Document complete karein, phir Video khulega.
          </p>
        )}
        <div className="text-[11px] font-bold text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-2 py-1.5 mb-2">
          📌 Rule: Watch this video <b>2 times by yourself</b> + <b>2 times with your doer</b> (total 4 views).
          Har view <b>instantly</b> count hota hai — koi waiting time nahi.
        </div>
        <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mb-2">
          👁️ Views: self {vS.self}/{REQUIRED_SELF_VIEWS} • with doer {vS.withDoer}/{REQUIRED_WITHDOER_VIEWS} • total {vidTotal}/{REQUIRED_VIEWS}
          {videoReady(currentIndex) ? " ✅ (now press Mark as Watched)" : ""}
        </p>
        {curIndex.Video ? (
          isUrl(curIndex.Video) ? (
            <iframe src={renderableVideoUrl(curIndex.Video)} title="Video" className="w-full h-80 border rounded-lg" allowFullScreen />
          ) : (
            <div className="bg-gray-100 rounded-lg p-6 text-sm text-gray-600">
              🎬 <b>{curIndex.Video}</b><br />
              <span className="text-xs text-gray-400">(Video link/name stored as text hai.)</span>
            </div>
          )
        ) : (
          <p className="text-sm text-gray-400">Koi video upload nahi hai.</p>
        )}
        <div className="flex gap-2 mt-3 flex-wrap items-center">
          {viewModeTabs("video")}
          {vidTotal < REQUIRED_VIEWS && docDone && !vidDone ? (
            <button onClick={() => tickView("video", currentIndex)} disabled={busy || (viewMode === "self" ? vS.self >= REQUIRED_SELF_VIEWS : vS.withDoer >= REQUIRED_WITHDOER_VIEWS)}
              title={viewMode === "self" ? (vS.self >= REQUIRED_SELF_VIEWS ? "Self views complete — switch to With Doer" : "Count one self view (instant)") : (vS.withDoer >= REQUIRED_WITHDOER_VIEWS ? "With-doer views complete — switch to Self" : "Count one with-doer view (instant)")}
              className="px-4 py-2 rounded-lg text-sm font-bold bg-amber-500 text-white hover:bg-amber-600 disabled:bg-amber-300 disabled:cursor-not-allowed">
              {busy ? "⏳ Saving..." : viewMode === "self" ? `🙋 I watched it — Self (${vS.self}/${REQUIRED_SELF_VIEWS})` : `👥 Watched with Doer (${vS.withDoer}/${REQUIRED_WITHDOER_VIEWS})`}
            </button>
          ) : null}
          {curIndex.Video && isUrl(curIndex.Video) && docDone && (
            <a href={curIndex.Video} target="_blank" rel="noreferrer"
              className="px-3 py-2 bg-gray-700 text-white rounded-lg text-xs font-bold">↗ Open in new tab</a>
          )}
          <button onClick={markVideo} disabled={busy || vidDone || !docDone || !videoReady(currentIndex)}
            className={`px-4 py-2 rounded-lg text-sm font-bold ${vidDone ? "bg-emerald-100 text-emerald-700" : "bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300"}`}>
            {busy ? "⏳ Saving..." : vidDone ? "✅ Video Watched" : `✅ Mark as Watched${!videoReady(currentIndex) ? ` (locked self ${vS.self}/2 • doer ${vS.withDoer}/2)` : ""}`}
          </button>
        </div>
      </div>
    );
  };

  const renderQaPanel = () => {
    if (!allContentDone) {
      return (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 mt-2 text-center">
          <p className="text-4xl mb-2">🔒</p>
          <h4 className="font-black text-amber-800">Q/A Test Locked</h4>
          <p className="text-sm text-amber-700 mt-2">
            Saare Indices complete karein ({docsDone.length}/{totalIndexes} docs, {vidsDone.length}/{totalIndexes} videos) tab Q/A Test khulega.
          </p>
        </div>
      );
    }
    if (questions.length === 0) {
      return (
        <div className="bg-emerald-100 border border-emerald-300 rounded-xl p-6 mt-2 text-center">
          <p className="text-3xl mb-2">🎉</p>
          <h4 className="font-black text-emerald-800">Training Completed!</h4>
          <p className="text-sm text-emerald-700 mt-1">Is training me koi Q/A nahi tha, isliye training complete ho gayi.</p>
        </div>
      );
    }
    if (qaResult && qaResult.attempted) {
      return (
        <div className="mt-3 p-5 bg-emerald-100 border border-emerald-300 rounded-xl">
          <p className="text-3xl mb-1">🏆</p>
          <p className="font-black text-emerald-800">Q/A Test Complete!</p>
          <p className="text-sm mt-2">Score: <b>{qaResult.correct}/{qaResult.total}</b> ({Math.round((qaResult.correct / qaResult.total) * 100)}%)</p>
          <p className="text-xs text-emerald-700 mt-1">Aap training bhi complete kar chuke hain ✅</p>
        </div>
      );
    }
    return (
      <div className="space-y-3 mt-2">
        <p className="text-xs text-gray-500">* Har question ka ek option select karke <b>Submit</b> karein.</p>
        {questions.map((q, qi) => (
          <div key={q.QaId} className="border border-gray-200 rounded-lg p-3">
            <p className="text-sm font-bold text-gray-700">Q{qi + 1}. {q.Question}</p>
            <div className="flex flex-col gap-1 mt-1">
              {["A", "B", "C", "D"].map((opt) => (
                <label key={opt} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-100 rounded px-2 py-1">
                  <input type="radio" name={`qa-${q.QaId}`} checked={answers[q.QaId] === opt}
                    onChange={() => setAnswers({ ...answers, [q.QaId]: opt })} />
                  <span className={q[`Option${opt}`] ? "" : "text-gray-300"}>{opt}) {q[`Option${opt}`] || "(empty)"}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
        <button onClick={submitQa} disabled={busy}
          className="w-full bg-emerald-600 text-white rounded-lg py-2.5 font-black text-sm hover:bg-emerald-700 disabled:bg-emerald-300">
          {busy ? "Submitting..." : "✅ Submit Q/A Test"}
        </button>
      </div>
    );
  };

  const renderLeftNav = () => {
    // Defensive: return empty if selected is null
    if (!selected || !selected.indices) {
      return <div className="bg-white rounded-xl shadow p-4 text-center text-gray-500">Loading...</div>;
    }
    return (
      <div className="bg-white rounded-xl shadow p-4 space-y-1">
        {/* Designation */}
        <div className="flex items-center gap-2 px-2 py-2 bg-gray-100 rounded-lg text-sm font-black text-gray-700">
          🎖️ Designation: <span className="text-blue-700">{selected.Designation ?? selected.Department ?? "Common"}</span>
        </div>

        {/* Template Name */}
        <div className="flex items-center gap-2 px-2 py-2 bg-blue-50 rounded-lg text-xs font-bold text-blue-800">
          📄 {selected.TemplateName || selected.TemplateId}
        </div>

        {/* Overview / Start button */}
        <button onClick={() => { setCurrentIndex(1); setContentTab("document"); }}
          className="w-full text-left px-2 py-1.5 rounded-lg text-xs hover:bg-gray-100 font-bold text-gray-600">
          📌 Overview / Start
        </button>

        {/* Indices list */}
        {selected.indices.map((idx, i) => (
          <button key={i} onClick={() => { if (!indexLocked(i + 1)) { setCurrentIndex(i + 1); setContentTab(idx.Document ? "document" : "video"); } }}
            className={`w-full text-left px-2 py-1.5 rounded-lg text-xs flex items-center justify-between ${!indexLocked(i + 1) ? "hover:bg-gray-100" : "opacity-70 cursor-not-allowed"} ${currentIndex === i + 1 ? "bg-blue-100 font-bold text-blue-800" : ""}`}>
            <span>{indexIcon(i + 1)} Index {i + 1}: {idx.IndexName}</span>
          </button>
        ))}

        <div className="mt-2 pt-2 border-t border-gray-200 text-[10px] text-gray-400">
          LEARN FLOW: Document → Video → Q/A → Complete Index
        </div>
      </div>
    );
  };

  const renderTools = () => (
    <div className="bg-white rounded-xl shadow p-4 space-y-4">
      <h4 className="text-sm font-black text-gray-700">🧰 Tools</h4>
      <div>
        <p className="text-xs font-bold text-gray-600 mb-1">📝 Notes (Documents)</p>
        <textarea rows={2} className="w-full border rounded-lg px-2 py-1 text-xs" placeholder="Apne notes likhein..."
          value={tools.documents} onChange={(e) => setTools({ ...tools, documents: e.target.value })} />
        <button onClick={() => saveTool("documents")} disabled={savingTool === "documents"}
          className="px-3 py-1 bg-indigo-600 text-white rounded-lg text-xs">{savingTool === "documents" ? "Saving..." : "💾 Save"}</button>
      </div>
      <div>
        <p className="text-xs font-bold text-gray-600 mb-1">📄 Transcript (Translite)</p>
        <textarea rows={2} className="w-full border rounded-lg px-2 py-1 text-xs" placeholder="Transcript yahan save karein..."
          value={tools.translite} onChange={(e) => setTools({ ...tools, translite: e.target.value })} />
        <button onClick={() => saveTool("translite")} disabled={savingTool === "translite"}
          className="px-3 py-1 bg-indigo-600 text-white rounded-lg text-xs">{savingTool === "translite" ? "Saving..." : "💾 Save"}</button>
      </div>
      <div>
        <p className="text-xs font-bold text-gray-600 mb-1">📋 Summary</p>
        <textarea rows={2} className="w-full border rounded-lg px-2 py-1 text-xs" placeholder="Training summary likhein..."
          value={tools.summary} onChange={(e) => setTools({ ...tools, summary: e.target.value })} />
        <button onClick={() => saveTool("summary")} disabled={savingTool === "summary"}
          className="px-3 py-1 bg-indigo-600 text-white rounded-lg text-xs">{savingTool === "summary" ? "Saving..." : "💾 Save"}</button>
      </div>
      <div className="border-t border-gray-200" />
      <p className="text-xs font-bold text-gray-600 mb-1">📂 Files - {curIndex.IndexName}</p>
      <div className="text-[11px] text-gray-500 space-y-1">
        <p>📄 Document: {curIndex.Document ? <a className="text-blue-600 underline" href={curIndex.Document} target="_blank" rel="noreferrer">Open</a> : "N/A"}</p>
        <p>🎬 Video: {curIndex.Video ? <a className="text-blue-600 underline" href={curIndex.Video} target="_blank" rel="noreferrer">Open</a> : "N/A"}</p>
      </div>
      <div className="border-t border-gray-200" />
      <p className="text-xs font-bold text-gray-600 mb-1">ℹ️ About Index</p>
      <p className="text-[11px] text-gray-500">#{currentIndex} — {curIndex.IndexName}<br />🎖️ Designation: {selected.Designation ?? selected.Department}</p>
      <div className="border-t border-gray-200" />
      <p className="text-xs font-bold text-gray-600 mb-1">📊 Progress Summary</p>
      <div className="text-[11px] text-gray-500">
        <div className="flex justify-between"><span>📄 Docs</span><span>{docsDone.length}/{totalIndexes}</span></div>
        <div className="h-1 bg-blue-500 rounded" style={{ width: `${totalIndexes ? Math.round(docsDone.length / totalIndexes * 100) : 0}%` }} />
        <div className="flex justify-between mt-1"><span>🎬 Videos</span><span>{vidsDone.length}/{totalIndexes}</span></div>
        <div className="h-1 bg-blue-500 rounded" style={{ width: `${totalIndexes ? Math.round(vidsDone.length / totalIndexes * 100) : 0}%` }} />
        <div className="flex justify-between mt-1"><span>❓ Q/A</span><span>{qaDone ? `${qaResult ? qaResult.correct : 0}/${qaResult ? qaResult.total : 0}` : "Pending"}</span></div>
        <div className="h-1 bg-blue-500 rounded" style={{ width: `${qaDone ? 100 : 0}%` }} />
        <p className="mt-1 text-gray-600">🎯 Total: <b className="text-blue-700">{record ? record.TotalScore : 0}/300</b></p>
      </div>
      <div className="border-t border-gray-200" />
      <p className="text-xs font-bold text-gray-600 mb-1">👀 View Tracking</p>
      <p className="text-[11px] text-gray-500">Last update: {record && record.LastUpdate ? record.LastUpdate : "-"}</p>
      <p className="text-[11px] text-gray-500">Status: <b>{record ? record.Status : "Pending"}</b></p>
    </div>
  );

  const renderLearn = () => {
    // Defensive: return loading if selected is null
    if (!selected || !selected.indices) {
      return (
        <div className="space-y-3">
          <div className="bg-white rounded-xl shadow p-6 text-center text-gray-500">
            Loading training data...
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-3">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white rounded-xl shadow px-4 py-3">
        <div>
          <button onClick={goBackToList} disabled={loading} className="text-xs text-blue-600 underline disabled:opacity-50">{loading ? "⏳ Loading..." : "← Back to Trainings"}</button>
          <h2 className="text-lg font-black text-gray-800 mt-1">{selected.TemplateName}</h2>
          <p className="text-xs text-gray-500">🆔 {selected.TemplateId} • 🎖️ {selected.Designation ?? selected.Department} • 📑 {totalIndexes} Indices • ❓ {questions.length} Questions</p>
        </div>
        <div className="text-right">
          <span className={`text-xs px-2 py-1 rounded-full ${STATUS_BADGE[record ? record.Status : "Pending"] || STATUS_BADGE.Pending}`}>{record ? record.Status : "Pending"}</span>
          <p className="text-xs text-gray-500 mt-1">🎯 Score: <b className="text-blue-700">{record ? record.TotalScore : 0}/300</b> ({record ? Math.min(100, Math.round(record.TotalScore / 3)) : 0}%)</p>
        </div>
      </div>

      {/* 3 column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* LEFT: Training Navigation */}
        <div className="lg:col-span-3">{renderLeftNav()}</div>

        {/* CENTER: Index header + content + prev/next */}
        <div className="lg:col-span-6">
          <div className="bg-white rounded-xl shadow px-4 py-3 mb-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-black text-gray-800">📑 Index {currentIndex}: {curIndex.IndexName}</span>
              {docsDone.includes(String(currentIndex)) ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">📄 Done</span> : null}
              {vidsDone.includes(String(currentIndex)) ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">🎬 Done</span> : null}
            </div>
            <div className="flex gap-1 mt-2">
              {["document", "video", "qa"].map((t) => {
                const videoLocked = t === "video" && !docsDone.includes(String(currentIndex));
                const qaLocked = t === "qa" && !allContentDone;
                const isLocked = videoLocked || qaLocked;
                return (
                  <button key={t}
                    onClick={() => {
                      if (videoLocked) return toast.warn(`Pehle Index ${currentIndex} ka Document complete karein (5 views + Mark as Read), phir Video`);
                      if (qaLocked) return toast.warn("Pehle saare Indices ke Document + Video complete karein, tab Q/A Test khulega");
                      setContentTab(t);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold ${contentTab === t ? "bg-blue-600 text-white" : isLocked ? "bg-gray-100 text-gray-400 cursor-not-allowed" : "bg-gray-200 text-gray-700 hover:bg-gray-300"}`}>
                    {t === "document" ? "📄 Document" : t === "video" ? `🎬 Video${videoLocked ? " 🔒" : ""}` : `❓ Q/A${qaLocked ? " 🔒" : ""}`}
                  </button>
                );
              })}
            </div>
          </div>

          {locked ? (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
              <p className="text-4xl mb-2">🔒</p>
              <h4 className="font-black text-amber-800">Index Locked</h4>
              <p className="text-sm text-amber-700 mt-2">Pehle <b>Index {currentIndex - 1}</b> complete karein (Document + Video) tab yeh index khulega.</p>
            </div>
          ) : contentTab === "qa" ? renderQaPanel() : renderDocVideo()}

          {/* Previous / Next */}
          <div className="flex items-center justify-between gap-3 mt-3 bg-white rounded-xl shadow px-4 py-2.5">
            <button onClick={() => { if (currentIndex > 1) { setCurrentIndex(currentIndex - 1); setContentTab(selected.indices[currentIndex - 2].Document ? "document" : "video"); } }}
              disabled={currentIndex <= 1} className="px-4 py-2 bg-gray-200 rounded-lg text-sm font-bold text-gray-700 disabled:opacity-40">← Previous</button>
            {allDone ? (
              <button onClick={goBackToList} disabled={loading} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm font-bold hover:bg-emerald-700 disabled:bg-emerald-300">{loading ? "⏳ Loading..." : "🏆 Training Completed - Back"}</button>
            ) : currentIndex < totalIndexes ? (
              <button onClick={() => { if (docsDone.includes(String(currentIndex)) && vidsDone.includes(String(currentIndex)) && !indexLocked(currentIndex + 1)) { setCurrentIndex(currentIndex + 1); setContentTab(selected.indices[currentIndex] && selected.indices[currentIndex].Document ? "document" : "video"); } else if (!(docsDone.includes(String(currentIndex)) && vidsDone.includes(String(currentIndex)))) { toast.warn(`Pehle Index ${currentIndex} ke Document aur Video complete karein`); } }}
                className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700">Next Index →</button>
            ) : allContentDone ? (
              <button onClick={() => setContentTab("qa")} className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-bold">❓ Take Q/A Test</button>
            ) : (
              <button disabled className="px-5 py-2 bg-gray-300 text-gray-600 rounded-lg text-sm font-bold">Last Index ✅</button>
            )}
          </div>

          {allDone && (
            <div className="mt-3 p-4 bg-emerald-100 border border-emerald-300 rounded-xl text-center">
              <p className="text-2xl mb-1">🎉</p>
              <p className="font-black text-emerald-800">Congratulations! Aapne training complete kar li hai.</p>
              <p className="text-sm text-emerald-700 mt-1">Final Score: {record ? record.TotalScore : 0}/300 • Status: {record ? record.Status : ""} • End Date: {record ? record.EndDate : ""}</p>
            </div>
          )}
        </div>

        {/* RIGHT: Tools */}
        <div className="lg:col-span-3">{renderTools()}</div>
      </div>
    </div>
  );
  };
  // ============================================================
  // MAIN RENDER
  // ============================================================
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <ToastContainer position="top-right" autoClose={3000} />
      {view === "list" ? renderList() : (selected ? renderLearn() : renderList())}
    </div>
  );
  }
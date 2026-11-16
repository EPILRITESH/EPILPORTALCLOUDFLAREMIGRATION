import React, { useContext } from "react";
import { Routes, Route, Navigate } from "react-router-dom";

import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Delegation from "./pages/Delegation";
import Checklist from "./pages/Checklist";
import HelpTicket from "./pages/HelpTickets";
import SupportTicket from "./pages/SupportTickets";
import WorkList from "./pages/WorkList";
import Training from "./pages/Training";
import Login from "./pages/Login";
import Register from "./pages/Register";
import SyncStatus from "./pages/SyncStatus";
import { FmsList, FmsData, FmsApprovals } from "./fms/FmsAdmin";
import FmsBuilder from "./fms/FmsBuilder";
import FmsImport from "./fms/FmsImport";
import FmsSeating from "./fms/Seating";
import FmsReports from "./fms/Reports";
import { AuthContext } from "./context/AuthContext";

export default function App() {
  const { user } = useContext(AuthContext);
  console.log("process.env.baseURL:",process.env.REACT_APP_BASE_URL);
  

  return (
    <Routes>

      {/* DEFAULT REDIRECT */}
      <Route path="/" element={<Navigate to="/login" replace />} />
      {/* PUBLIC ROUTES */}
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      {/* PROTECTED ROUTES */}
      <Route
        path="/*"
        element={ user ? <Layout /> : <Navigate to="/login" replace /> }
      >
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="delegation" element={<Delegation />} />
        <Route path="checklist" element={<Checklist />} />
        <Route path="help-ticket" element={<HelpTicket />} />
        <Route path="support-ticket" element={<SupportTicket />} />
        <Route path="worklist" element={<WorkList />} />
        <Route path="training" element={<Training />} />
        <Route path="backup-sync" element={<SyncStatus />} />
        <Route path="fms" element={<FmsList />} />
        <Route path="fms/new" element={<FmsBuilder />} />
        <Route path="fms/import" element={<FmsImport />} />
        <Route path="fms/seating" element={<FmsSeating />} />
        <Route path="fms/approvals" element={<FmsApprovals />} />
        <Route path="fms/reports" element={<FmsReports />} />
        <Route path="fms/:id" element={<FmsData />} />
        <Route path="fms/:id/edit" element={<FmsBuilder />} />
        <Route path="*" element={<div>Page not found</div>} />
      </Route>

    </Routes>
  );
}

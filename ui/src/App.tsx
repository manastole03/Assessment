import { lazy } from "react";
import { Route, Routes } from "react-router";

import { AppShell } from "@/components/layout/app-shell";
import { EmptyState } from "@/components/page-header";
import { RequireAuth } from "@/features/auth/require-auth";
import LandingPage from "@/pages/landing";
import LoginPage from "@/pages/login";
import OverviewPage from "@/pages/overview";

// The landing page and dashboard ship in the main bundle; the rest of the studio loads on demand.
const AgentsPage = lazy(() => import("@/pages/agents"));
const CapabilitiesPage = lazy(() => import("@/pages/capabilities"));
const CapabilityPage = lazy(() => import("@/pages/capability"));
const DiscoverPage = lazy(() => import("@/pages/discover"));
const EvalRunPage = lazy(() => import("@/pages/eval-run"));
const EvalsPage = lazy(() => import("@/pages/evals"));
const EvidencePage = lazy(() => import("@/pages/evidence"));
const NewRunPage = lazy(() => import("@/pages/new-run"));
const PolicyPage = lazy(() => import("@/pages/policy"));
const RunPage = lazy(() => import("@/pages/run"));
const RunsPage = lazy(() => import("@/pages/runs"));

export default function App() {
  return (
    <Routes>
      <Route index element={<LandingPage />} />
      <Route path="login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="overview" element={<OverviewPage />} />
          <Route path="capabilities" element={<CapabilitiesPage />} />
          <Route path="capabilities/:id" element={<CapabilityPage />} />
          <Route path="run" element={<NewRunPage />} />
          <Route path="discover" element={<DiscoverPage />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="runs/:id" element={<RunPage />} />
          <Route path="evidence" element={<EvidencePage />} />
          <Route path="evals" element={<EvalsPage />} />
          <Route path="evals/:id" element={<EvalRunPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="policy" element={<PolicyPage />} />
          <Route path="*" element={<EmptyState icon={null} title="Page not found" />} />
        </Route>
      </Route>
    </Routes>
  );
}

import { useState, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getToken } from "./api/client";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ProjectsPage from "./pages/ProjectsPage";
import NewProjectPage from "./pages/NewProjectPage";
import ProjectPage from "./pages/ProjectPage";
import ImportPage from "./pages/ImportPage";
import RecordsPage from "./pages/RecordsPage";
import OverlapPage from "./pages/OverlapPage";
import ScreeningWorkspace from "./pages/ScreeningWorkspace";
import ExtractionLibrary from "./pages/ExtractionLibrary";
import LabelsPage from "./pages/LabelsPage";
import OntologyPage from "./pages/OntologyPage";
import ThematicAnalysis from "./pages/ThematicAnalysis";
import LLMScreeningPage from "./pages/LLMScreeningPage";
import TeamPage from "./pages/TeamPage";
import ConsensusPage from "./pages/ConsensusPage";
import AppShell from "./components/AppShell";
import OnboardingTour from "./components/OnboardingTour";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

function RequireAuth({ children }: { children: ReactNode }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

/** Wraps a page in AppShell (sidebar layout). */
function WithShell({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}

/** Projects page includes the onboarding tour on first visit. */
function ProjectsWithTour() {
  const [showTour, setShowTour] = useState(
    () => !localStorage.getItem("ep_tour_done")
  );
  return (
    <>
      <ProjectsPage />
      {showTour && <OnboardingTour onDone={() => setShowTour(false)} />}
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public */}
          <Route path="/login"    element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/"         element={<Navigate to="/projects" replace />} />

          {/* Authenticated — all wrapped in AppShell */}
          <Route path="/projects"     element={<WithShell><ProjectsWithTour /></WithShell>} />
          <Route path="/projects/new" element={<WithShell><NewProjectPage /></WithShell>} />

          {/* Project-scoped routes */}
          <Route path="/projects/:id"              element={<WithShell><ProjectPage /></WithShell>} />
          <Route path="/projects/:id/import"       element={<WithShell><ImportPage /></WithShell>} />
          <Route path="/projects/:id/records"      element={<WithShell><RecordsPage /></WithShell>} />
          <Route path="/projects/:id/overlap"      element={<WithShell><OverlapPage /></WithShell>} />
          <Route path="/projects/:id/screen"       element={<WithShell><ScreeningWorkspace /></WithShell>} />
          <Route path="/projects/:id/extractions"  element={<WithShell><ExtractionLibrary /></WithShell>} />
          <Route path="/projects/:id/labels"       element={<WithShell><LabelsPage /></WithShell>} />
          <Route path="/projects/:id/ontology"     element={<WithShell><OntologyPage /></WithShell>} />
          <Route path="/projects/:id/thematic"     element={<WithShell><ThematicAnalysis /></WithShell>} />
          <Route path="/projects/:id/llm-screening" element={<WithShell><LLMScreeningPage /></WithShell>} />
          <Route path="/projects/:projectId/team"      element={<WithShell><TeamPage /></WithShell>} />
          <Route path="/projects/:projectId/consensus" element={<WithShell><ConsensusPage /></WithShell>} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
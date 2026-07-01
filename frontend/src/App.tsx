import { lazy, Suspense, type ReactNode, Component, type ErrorInfo, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getToken, validateStoredToken } from "./api/client";

// ---------------------------------------------------------------------------
// ErrorBoundary — catches any unhandled render error and shows a recovery UI
// instead of a blank white screen.
// ---------------------------------------------------------------------------
interface EBState { error: Error | null }
class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(error: Error): EBState { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "3rem 2rem", maxWidth: 520, margin: "4rem auto", fontFamily: "sans-serif" }}>
          <h2 style={{ color: "#c5221f", marginBottom: "0.5rem" }}>Something went wrong</h2>
          <p style={{ color: "#444", marginBottom: "1rem", fontSize: "0.9rem" }}>
            {this.state.error.message ?? "An unexpected error occurred."}
          </p>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{ padding: "0.5rem 1.25rem", background: "#4f46e5", color: "#fff", border: "none", borderRadius: "0.375rem", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem" }}
          >
            Reload page
          </button>
          <button
            onClick={() => { window.location.href = "/projects"; }}
            style={{ marginLeft: "0.75rem", padding: "0.5rem 1.25rem", background: "#f1f5f9", color: "#374151", border: "1px solid #e2e8f0", borderRadius: "0.375rem", fontWeight: 600, cursor: "pointer", fontSize: "0.9rem" }}
          >
            Back to projects
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import LandingPage from "./pages/LandingPage";
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
import CitationSourcingPage from "./pages/CitationSourcingPage";
import LabelsPage from "./pages/LabelsPage";
import ConceptTaxonomyPage from "./pages/ConceptTaxonomyPage";
import ThematicAnalysis from "./pages/ThematicAnalysis";
import PrismaPage from "./pages/PrismaPage";
import TeamPage from "./pages/TeamPage";
import ConsensusPage from "./pages/ConsensusPage";
import ReportPage from "./pages/ReportPage";
import SearchPage from "./pages/SearchPage";
import AIPilotPage from "./pages/AIPilotPage";
import ReviewerViewPage from "./pages/ReviewerViewPage";
import AppShell from "./components/AppShell";
import { FeedbackProvider } from "./components/Feedback";
import { SkeletonRows } from "./components/Skeleton";
import { ReviewerViewProvider } from "./context/ReviewerViewContext";
import AdminPage from "./pages/AdminPage";
import SettingsPage from "./pages/SettingsPage";

// Lazy-load pages that depend on libraries (react-force-graph / AFRAME) that
// crash at module-evaluation time when loaded eagerly.
const OntologyPage    = lazy(() => import("./pages/OntologyPage"));
const LLMScreeningPage = lazy(() => import("./pages/LLMScreeningPage"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

// On mount, silently validate the stored JWT with the server.
// This catches expired tokens and stale keys before any page query fires.
function useTokenCheck() {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    validateStoredToken().finally(() => setChecked(true));
  }, []);
  return checked;
}

function RequireAuth({ children }: { children: ReactNode }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

// Wrapper that runs the token check once at the root level.
function AuthGate({ children }: { children: ReactNode }) {
  const checked = useTokenCheck();
  if (!checked) return null; // brief flash prevented by fast /auth/me call
  return <>{children}</>;
}

/** Wraps a page in AppShell (sidebar layout) with an error boundary. */
function WithShell({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>
        <ErrorBoundary>{children}</ErrorBoundary>
      </AppShell>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <FeedbackProvider>
      <ReviewerViewProvider>
      <BrowserRouter>
      <AuthGate>
        <Suspense fallback={null}>
          <Routes>
            {/* Public */}
            <Route path="/login"    element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/"         element={<LandingPage />} />

            {/* Authenticated — all wrapped in AppShell */}
            <Route path="/admin"        element={<WithShell><AdminPage /></WithShell>} />
            <Route path="/settings"     element={<WithShell><SettingsPage /></WithShell>} />
            <Route path="/projects"     element={<WithShell><ProjectsPage /></WithShell>} />
            <Route path="/projects/new" element={<WithShell><NewProjectPage /></WithShell>} />

            {/* Project-scoped routes */}
            <Route path="/projects/:id"              element={<WithShell><ProjectPage /></WithShell>} />
            <Route path="/projects/:id/import"       element={<WithShell><ImportPage /></WithShell>} />
            <Route path="/projects/:id/records"      element={<WithShell><RecordsPage /></WithShell>} />
            <Route path="/projects/:id/overlap"      element={<WithShell><OverlapPage /></WithShell>} />
            <Route path="/projects/:id/screen"       element={<WithShell><ScreeningWorkspace /></WithShell>} />
            <Route path="/projects/:id/extractions"  element={<WithShell><ExtractionLibrary /></WithShell>} />
            <Route path="/projects/:id/citations"           element={<WithShell><CitationSourcingPage /></WithShell>} />
            <Route path="/projects/:id/citations/:searchId" element={<WithShell><CitationSourcingPage /></WithShell>} />
            <Route path="/projects/:id/labels"       element={<WithShell><LabelsPage /></WithShell>} />
            <Route path="/projects/:id/ontology"     element={<WithShell><Suspense fallback={<SkeletonRows rows={8} style={{ padding: "2rem" }} />}><OntologyPage /></Suspense></WithShell>} />
            <Route path="/projects/:id/concept-taxonomy" element={<WithShell><ConceptTaxonomyPage /></WithShell>} />
            <Route path="/projects/:id/thematic"         element={<WithShell><ThematicAnalysis /></WithShell>} />
            <Route path="/projects/:id/prisma"           element={<WithShell><PrismaPage /></WithShell>} />
            <Route path="/projects/:id/report"           element={<WithShell><ReportPage /></WithShell>} />
            <Route path="/projects/:id/search"           element={<WithShell><SearchPage /></WithShell>} />
            <Route path="/projects/:id/ai-pilot"         element={<WithShell><AIPilotPage /></WithShell>} />
            <Route path="/projects/:id/llm-screening" element={<WithShell><Suspense fallback={<SkeletonRows rows={8} style={{ padding: "2rem" }} />}><LLMScreeningPage /></Suspense></WithShell>} />
            <Route path="/projects/:projectId/team"      element={<WithShell><TeamPage /></WithShell>} />
            <Route path="/projects/:projectId/consensus" element={<WithShell><ConsensusPage /></WithShell>} />
            <Route path="/projects/:id/reviewer/:reviewerId" element={<WithShell><ReviewerViewPage /></WithShell>} />
          </Routes>
        </Suspense>
      </AuthGate>
      </BrowserRouter>
      </ReviewerViewProvider>
      </FeedbackProvider>
    </QueryClientProvider>
  );
}

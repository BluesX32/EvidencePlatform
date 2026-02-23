import { type ReactNode } from "react";
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

function RequireAuth({ children }: { children: ReactNode }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<RequireAuth><ProjectsPage /></RequireAuth>} />
          <Route path="/projects/new" element={<RequireAuth><NewProjectPage /></RequireAuth>} />
          <Route path="/projects/:id" element={<RequireAuth><ProjectPage /></RequireAuth>} />
          <Route path="/projects/:id/import" element={<RequireAuth><ImportPage /></RequireAuth>} />
          <Route path="/projects/:id/records" element={<RequireAuth><RecordsPage /></RequireAuth>} />
          <Route path="/projects/:id/overlap" element={<RequireAuth><OverlapPage /></RequireAuth>} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

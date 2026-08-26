import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SessionUser } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { ClientsPage } from "./pages/ClientsPage";
import { ClientPage } from "./pages/ClientPage";
import "./index.css";

const queryClient = new QueryClient();

function Shell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { data } = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<{ user: SessionUser }>("/api/session"),
    retry: false,
  });

  async function logout() {
    await api.post("/api/auth/logout");
    cache.clear();
    navigate("/login");
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="brand-mark" />
          Photo Archive
        </Link>
        <span className="topbar-spacer" />
        {data?.user && (
          <>
            <span className="muted" style={{ fontSize: ".85rem" }}>{data.user.email}</span>
            <button type="button" className="link-btn" onClick={logout}>Sign out</button>
          </>
        )}
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

// One gate for the whole app: unauthenticated means the login page, and
// nothing behind it renders (or fetches) until the session check resolves.
function Authed({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<{ user: SessionUser }>("/api/session"),
    retry: false,
  });

  if (isLoading) return <div className="content muted">Loading…</div>;
  if (isError || !data) return <Navigate to="/login" replace />;
  return <Shell>{children}</Shell>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/app">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<Authed><ClientsPage /></Authed>} />
          <Route path="/clients/:clientId" element={<Authed><ClientPage /></Authed>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

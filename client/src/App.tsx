import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, daysUntil, type Client, type SessionUser } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { ClientsPage } from "./pages/ClientsPage";
import { ClientPage } from "./pages/ClientPage";
import "./index.css";

const queryClient = new QueryClient();

// The sidebar is the whole navigation: every client, always visible, with a
// dot showing whether it is ready to run. A tool used all day should never
// make someone go back to a list page to switch what they are working on.
function Sidebar() {
  const navigate = useNavigate();
  const cache = useQueryClient();

  const { data: session } = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<{ user: SessionUser }>("/api/session"),
    retry: false,
  });

  const { data } = useQuery({
    queryKey: ["clients"],
    queryFn: () => api.get<{ clients: Client[] }>("/api/clients"),
  });

  const clients = (data?.clients ?? []).filter((c) => !c.archived);

  async function signOut() {
    await api.post("/api/auth/logout");
    cache.clear();
    navigate("/login");
  }

  return (
    <aside className="sidebar">
      <Link to="/" className="brand">
        <span className="brand-mark">PA</span>
        Photo Archive
      </Link>

      <NavLink to="/" end className={({ isActive }) => `side-link ${isActive ? "active" : ""}`}>
        All clients
      </NavLink>

      {clients.length > 0 && <div className="side-label">Clients</div>}
      {clients.map((client) => {
        const days = daysUntil(client.cutoverDate);
        return (
          <NavLink
            key={client.id}
            to={`/clients/${client.id}`}
            className={({ isActive }) => `side-link ${isActive ? "active" : ""}`}
            title={
              client.serviceTitanConfigured
                ? days !== null && days >= 0
                  ? `${days} days to cutover`
                  : "Connected"
                : "No ServiceTitan credentials yet"
            }
          >
            <span className={`dot ${client.serviceTitanConfigured ? "dot-ok" : "dot-warn"}`} />
            <span className="name">{client.name}</span>
          </NavLink>
        );
      })}

      <div className="side-foot">
        <span className="tiny" style={{ padding: "0 .55rem" }}>{session?.user.email}</span>
        <button type="button" className="side-link" style={{ background: "none", border: "none", cursor: "pointer", font: "inherit" }} onClick={signOut}>
          Sign out
        </button>
      </div>
    </aside>
  );
}

function Authed({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<{ user: SessionUser }>("/api/session"),
    retry: false,
  });

  if (isLoading) return <div style={{ padding: "2rem" }} className="muted">Loading…</div>;
  if (isError || !data) return <Navigate to="/login" replace />;

  return (
    <div className="app">
      <Sidebar />
      <div className="main">{children}</div>
    </div>
  );
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

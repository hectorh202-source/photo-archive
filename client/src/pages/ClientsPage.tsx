import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, daysUntil, type Client } from "../api";

// The landing page is the client list, because this app's unit of work is a
// client — not a run, not a job.
export function ClientsPage() {
  const cache = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [cutover, setCutover] = useState("");
  const [error, setError] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["clients"],
    queryFn: () => api.get<{ clients: Client[] }>("/api/clients"),
  });

  const create = useMutation({
    mutationFn: () => api.post<Client>("/api/clients", { name, cutoverDate: cutover || null }),
    onSuccess: () => {
      setName("");
      setCutover("");
      setAdding(false);
      setError("");
      cache.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const clients = data?.clients ?? [];

  return (
    <div className="stack">
      <div className="row">
        <h1>Clients</h1>
        <span className="row-end" />
        <button type="button" className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "Add client"}
        </button>
      </div>

      {adding && (
        <form
          className="card row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="field" style={{ flex: "1 1 16rem" }}>
            Client name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Titanz Plumbing Inc" required />
          </label>
          <label className="field">
            ServiceTitan cutover date
            <input type="date" value={cutover} onChange={(e) => setCutover(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={create.isPending || name.trim() === ""}>
            {create.isPending ? "Adding…" : "Add"}
          </button>
          {error && <div className="flash flash-error">{error}</div>}
        </form>
      )}

      {isLoading && <p className="muted">Loading…</p>}
      {!isLoading && clients.length === 0 && (
        <p className="hint">
          No clients yet. Add one, put their ServiceTitan credentials on its Settings tab, and the archive tools open up.
        </p>
      )}

      <div className="client-grid">
        {clients.map((client) => {
          const days = daysUntil(client.cutoverDate);
          return (
            <Link key={client.id} to={`/clients/${client.id}`} className="card client-card">
              <span className="client-name">{client.name}</span>
              <div className="row" style={{ gap: ".4rem" }}>
                <span className={`badge ${client.serviceTitanConfigured ? "badge-ok" : "badge-warn"}`}>
                  {client.serviceTitanConfigured ? "connected" : "needs credentials"}
                </span>
                {client.activeRunId && <span className="badge badge-warn">archiving</span>}
                {client.archived && <span className="badge">closed</span>}
              </div>
              {/* A cutover date is a countdown, not a date field: past it, the
                  photos are unreachable at any price. */}
              {days !== null && (
                <span className={`badge ${days < 0 ? "badge-bad" : days < 60 ? "badge-warn" : ""}`}>
                  {days < 0 ? `cutover passed ${Math.abs(days)}d ago` : `${days} days to cutover`}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

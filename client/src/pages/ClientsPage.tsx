import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, daysUntil, type Client } from "../api";

// A table, not cards: the useful comparison across clients is "which one is
// ready, and whose deadline is closest", and rows compare far better than
// tiles do.
export function ClientsPage() {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [cutover, setCutover] = useState("");
  const [error, setError] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["clients"],
    queryFn: () => api.get<{ clients: Client[] }>("/api/clients"),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Client>("/api/clients", {
        name: name.trim(),
        contactName: contact.trim() || null,
        cutoverDate: cutover || null,
      }),
    onSuccess: (client) => {
      setName("");
      setContact("");
      setCutover("");
      setAdding(false);
      setError("");
      cache.invalidateQueries({ queryKey: ["clients"] });
      // Straight into the new client's settings, because a client without
      // credentials cannot do anything yet and that is the obvious next step.
      navigate(`/clients/${client.id}?tab=settings`);
    },
    onError: (e) => setError((e as Error).message),
  });

  const clients = data?.clients ?? [];

  return (
    <>
      <div className="page-head">
        <div className="row">
          <h1>Clients</h1>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            New client
          </button>
        </div>
        <p className="sub">Each client is one ServiceTitan account you retrieve photos from.</p>
      </div>

      <div className="page-body stack">
        {isLoading && <p className="muted">Loading…</p>}

        {!isLoading && clients.length === 0 && (
          <div className="card">
            <div className="empty">
              <h3>No clients yet</h3>
              <p>
                Add the contractor whose photos you are retrieving, then paste their ServiceTitan credentials on the
                Settings tab. Everything else unlocks from there.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                Add your first client
              </button>
            </div>
          </div>
        )}

        {clients.length > 0 && (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>ServiceTitan</th>
                    <th>Cutover</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((client) => {
                    const days = daysUntil(client.cutoverDate);
                    return (
                      <tr
                        key={client.id}
                        style={{ cursor: "pointer" }}
                        onClick={() => navigate(`/clients/${client.id}`)}
                      >
                        <td>
                          <div style={{ fontWeight: 600 }}>{client.name}</div>
                          {client.contactName && <div className="tiny">{client.contactName}</div>}
                        </td>
                        <td>
                          <span className={`pill ${client.serviceTitanConfigured ? "pill-ok" : "pill-warn"}`}>
                            {client.serviceTitanConfigured ? "Connected" : "Needs credentials"}
                          </span>
                          {client.activeRunId && (
                            <span className="pill pill-warn pill-live" style={{ marginLeft: ".4rem" }}>
                              Archiving
                            </span>
                          )}
                        </td>
                        <td>
                          {days === null ? (
                            <span className="muted">—</span>
                          ) : days < 0 ? (
                            <span className="pill pill-bad">Passed {Math.abs(days)}d ago</span>
                          ) : (
                            <span className={`pill ${days < 60 ? "pill-warn" : ""}`}>{days} days left</span>
                          )}
                        </td>
                        <td>
                          <span className="link-btn">Open →</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {adding && (
        <div className="overlay" onClick={() => setAdding(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <div className="card-head">
                <h2>New client</h2>
              </div>
              <div className="card-body">
                <label className="field">
                  <span>Company name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Titanz Plumbing Inc" autoFocus required />
                </label>
                <label className="field">
                  <span>Main contact</span>
                  <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Optional" />
                </label>
                <label className="field">
                  <span>ServiceTitan cutover date</span>
                  <input type="date" value={cutover} onChange={(e) => setCutover(e.target.value)} />
                  <span className="help">
                    The day their account lapses. After it, the photos cannot be retrieved at any price — so this shows
                    as a countdown everywhere.
                  </span>
                </label>
                {error && <div className="notice notice-bad">{error}</div>}
              </div>
              <div className="card-foot">
                <button type="submit" className="btn btn-primary" disabled={create.isPending || name.trim() === ""}>
                  {create.isPending ? "Adding…" : "Add client"}
                </button>
                <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, daysUntil, type Client } from "../api";
import { ArchiveTab } from "./ArchiveTab";
import { JobTab } from "./JobTab";
import { SettingsTab } from "./SettingsTab";

type Tab = "archive" | "job" | "settings";

export function ClientPage() {
  const { clientId } = useParams();
  const [tab, setTab] = useState<Tab>("archive");

  const { data: client, isLoading } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => api.get<Client>(`/api/clients/${clientId}`),
  });

  if (isLoading) return <p className="muted">Loading…</p>;
  if (!client) return <p className="muted">No such client.</p>;

  const days = daysUntil(client.cutoverDate);

  return (
    <div className="stack">
      <div className="row">
        <Link to="/" className="link-btn" style={{ textDecoration: "none" }}>← Clients</Link>
      </div>

      <div className="row">
        <h1>{client.name}</h1>
        <span className={`badge ${client.serviceTitanConfigured ? "badge-ok" : "badge-warn"}`}>
          {client.serviceTitanConfigured ? "connected" : "needs credentials"}
        </span>
        {days !== null && (
          <span className={`badge ${days < 0 ? "badge-bad" : days < 60 ? "badge-warn" : ""}`}>
            {days < 0 ? `cutover passed ${Math.abs(days)}d ago` : `${days} days to cutover`}
          </span>
        )}
      </div>

      {!client.serviceTitanConfigured && (
        <div className="flash flash-error">
          This client has no ServiceTitan credentials yet. Add them on the Settings tab — nothing else here can run
          without them.
        </div>
      )}

      <div className="tabs">
        <button type="button" className={`tab ${tab === "archive" ? "active" : ""}`} onClick={() => setTab("archive")}>
          Archive
        </button>
        <button type="button" className={`tab ${tab === "job" ? "active" : ""}`} onClick={() => setTab("job")}>
          Single job
        </button>
        <button type="button" className={`tab ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")}>
          Settings
        </button>
      </div>

      {tab === "archive" && <ArchiveTab clientId={client.id} />}
      {tab === "job" && <JobTab clientId={client.id} />}
      {tab === "settings" && <SettingsTab client={client} />}
    </div>
  );
}

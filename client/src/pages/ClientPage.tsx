import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, daysUntil, type Client } from "../api";
import { ArchiveTab } from "./ArchiveTab";
import { JobTab } from "./JobTab";
import { SettingsTab } from "./SettingsTab";

type Tab = "archive" | "job" | "settings";

const TAB_LABEL: Record<Tab, string> = {
  archive: "Photo archive",
  job: "One job",
  settings: "Settings",
};

export function ClientPage() {
  const { clientId } = useParams();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get("tab") === "settings" ? "settings" : "archive");

  const { data: client, isLoading } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => api.get<Client>(`/api/clients/${clientId}`),
  });

  if (isLoading) return <div className="page-body muted">Loading…</div>;
  if (!client) return <div className="page-body muted">No such client.</div>;

  const days = daysUntil(client.cutoverDate);

  return (
    <>
      <div className="page-head">
        <div className="row">
          <h1>{client.name}</h1>
          <span className={`pill ${client.serviceTitanConfigured ? "pill-ok" : "pill-warn"}`}>
            {client.serviceTitanConfigured ? "Connected" : "Needs credentials"}
          </span>
          {days !== null &&
            (days < 0 ? (
              <span className="pill pill-bad">Cutover passed {Math.abs(days)} days ago</span>
            ) : (
              <span className={`pill ${days < 60 ? "pill-warn" : ""}`}>{days} days to cutover</span>
            ))}
        </div>
        {client.contactName && <p className="sub">{client.contactName}</p>}

        <div className="tabs" style={{ marginTop: ".6rem" }}>
          {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
            <button key={key} type="button" className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
              {TAB_LABEL[key]}
            </button>
          ))}
        </div>
      </div>

      <div className="page-body stack">
        {!client.serviceTitanConfigured && tab !== "settings" && (
          <div className="notice notice-warn">
            <span>
              This client has no ServiceTitan credentials yet, so nothing here can run.{" "}
              <button type="button" className="link-btn" onClick={() => setTab("settings")}>
                Add them on the Settings tab
              </button>
              .
            </span>
          </div>
        )}

        {tab === "archive" && <ArchiveTab clientId={client.id} />}
        {tab === "job" && <JobTab clientId={client.id} />}
        {tab === "settings" && <SettingsTab client={client} />}
      </div>
    </>
  );
}

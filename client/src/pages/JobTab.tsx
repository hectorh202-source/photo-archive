import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

// One job, on demand — the phone-call errand: "send the adjuster the photos
// from the Whitfield job." Look it up, confirm it is the right one, download.

type Mode = "full" | "photos" | "attachments" | "records";

const MODE_LABEL: Record<Mode, string> = {
  photos: "Photos only",
  attachments: "Photos and documents",
  full: "Everything, records included",
  records: "Records only, no files",
};

interface PreviewAttachment {
  index: number;
  kind: "image" | "other" | "unknown";
  fileName: string | null;
  originalFileName: string | null;
}

interface Preview {
  jobId: number;
  jobNumber: string | null;
  matchedBy: "id" | "number";
  jobStatus: string | null;
  summary: string | null;
  customerName: string | null;
  locationAddress: string | null;
  completedOn: string | null;
  parts: { file: string; label: string; status: "ok" | "empty" | "failed"; count: number | null; error?: string }[];
  attachments: PreviewAttachment[];
  attachmentsError: string | null;
  warnings: string[];
}

export function JobTab({ clientId }: { clientId: number }) {
  const [reference, setReference] = useState("");
  const [lookedUp, setLookedUp] = useState("");
  const [mode, setMode] = useState<Mode>("photos");
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const base = `/api/clients/${clientId}/jobs`;

  const preview = useQuery({
    queryKey: ["job-preview", clientId, lookedUp, mode],
    queryFn: () => api.get<Preview>(`${base}/${encodeURIComponent(lookedUp)}/preview?mode=${mode}`),
    enabled: lookedUp !== "",
    retry: false,
    staleTime: 60_000,
  });

  async function download() {
    setDownloading(true);
    setNotice("");
    setError("");
    try {
      const res = await fetch(`${base}/${encodeURIComponent(lookedUp)}/export?mode=${mode}`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        let message = `Export failed: ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          // not JSON — keep the generic message
        }
        throw new Error(message);
      }
      const named = /filename="?([^";]+)"?/i.exec(res.headers.get("Content-Disposition") ?? "");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = named ? named[1] : `job-${lookedUp}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      const warnings = Number(res.headers.get("X-Export-Warnings") ?? "0");
      setNotice(
        warnings > 0
          ? `Downloaded. ${warnings} item${warnings === 1 ? "" : "s"} could not be pulled — the manifest inside says which.`
          : "Downloaded.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  const data = preview.data;
  const attachments = data?.attachments ?? [];
  const shown = mode === "photos" ? attachments.filter((a) => a.kind !== "other") : attachments;
  const skipped = attachments.length - shown.length;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Find a job</h2>
        </div>
        <div className="card-body">
          <form
            className="row"
            style={{ alignItems: "flex-end", gap: "1rem" }}
            onSubmit={(e) => {
              e.preventDefault();
              setNotice("");
              setError("");
              setLookedUp(reference.trim());
            }}
          >
            <label className="field" style={{ flex: "1 1 15rem" }}>
              <span>Job number</span>
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. 89496"
                maxLength={24}
              />
            </label>
            <label className="field" style={{ flex: "0 1 18rem" }}>
              <span>Include</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                {(Object.keys(MODE_LABEL) as Mode[]).map((key) => (
                  <option key={key} value={key}>{MODE_LABEL[key]}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn btn-primary" disabled={reference.trim() === "" || preview.isFetching}>
              {preview.isFetching ? "Looking…" : "Look up"}
            </button>
          </form>
          <p className="tiny">
            The number on a ServiceTitan job screen is the job number, which is not the same as the job ID — either one
            works here, and the result says which it matched.
          </p>
        </div>
      </div>

      {preview.isError && <div className="notice notice-bad">{(preview.error as Error).message}</div>}

      {data && (
        <div className="card">
          <div className="card-head">
            <h2>Job {data.jobNumber ? `#${data.jobNumber}` : data.jobId}</h2>
            {data.jobStatus && <span className="pill">{data.jobStatus}</span>}
            <span className="tiny">matched by job {data.matchedBy === "id" ? "ID" : "number"} · id {data.jobId}</span>
          </div>
          <div className="card-body">
            <div>
              <div style={{ fontWeight: 600 }}>{data.customerName ?? "Customer unknown"}</div>
              {data.locationAddress && <div className="sub">{data.locationAddress}</div>}
            </div>
            {data.summary && <p className="sub">{data.summary}</p>}

            <div className="stats">
              <div className="stat">
                <div className="stat-value">{shown.length}</div>
                <div className="stat-label">{mode === "photos" ? "photos" : "files"} to download</div>
              </div>
              {skipped > 0 && (
                <div className="stat">
                  <div className="stat-value">{skipped}</div>
                  <div className="stat-label">documents skipped in this mode</div>
                </div>
              )}
              {mode !== "photos" && mode !== "attachments" && (
                <div className="stat">
                  <div className="stat-value">{data.parts.filter((p) => p.status === "ok").length}</div>
                  <div className="stat-label">record sets included</div>
                </div>
              )}
            </div>

            {data.attachmentsError && <div className="notice notice-bad">{data.attachmentsError}</div>}

            {data.warnings.length > 0 && (
              <div className="notice notice-warn">
                <div>{data.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
              </div>
            )}
          </div>
          <div className="card-foot">
            <button type="button" className="btn btn-primary" onClick={download} disabled={downloading}>
              {downloading ? "Building zip…" : mode === "photos" ? "Download photos" : "Download zip"}
            </button>
            {notice && <span className="sub">{notice}</span>}
            {error && <span className="sub">{error}</span>}
          </div>
        </div>
      )}

      {!data && !preview.isError && (
        <div className="card">
          <div className="empty">
            <h3>Nothing looked up yet</h3>
            <p>Enter a job number above. You will see the customer and how many photos exist before downloading anything.</p>
          </div>
        </div>
      )}
    </>
  );
}

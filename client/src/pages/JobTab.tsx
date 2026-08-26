import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

// One job, pulled on demand — the errand that comes in by phone ("send the
// adjuster the pictures from the Whitfield job") rather than as a project.

type Mode = "full" | "photos" | "attachments" | "records";

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
          ? `Downloaded. ${warnings} item${warnings === 1 ? "" : "s"} couldn't be pulled — see manifest.json inside.`
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
    <div className="stack">
      <div className="card">
        <form
          className="row"
          style={{ alignItems: "flex-end" }}
          onSubmit={(e) => {
            e.preventDefault();
            setNotice("");
            setError("");
            setLookedUp(reference.trim());
          }}
        >
          <label className="field" style={{ flex: "1 1 14rem" }}>
            Job number or job ID
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. 89496" maxLength={24} />
          </label>
          <label className="field">
            Include
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="photos">Photos only</option>
              <option value="attachments">All attachments (photos + PDFs)</option>
              <option value="full">Everything, records included</option>
              <option value="records">Records only (no files)</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={reference.trim() === "" || preview.isFetching}>
            {preview.isFetching ? "Looking up…" : "Look up job"}
          </button>
        </form>
        <p className="hint" style={{ marginTop: ".7rem" }}>
          The number on a ServiceTitan job screen is the job number, which is not the job ID — either works, and the
          match is shown before you download. Photos are renamed for the customer and the job's date.
        </p>
      </div>

      {preview.isError && <div className="flash flash-error">{(preview.error as Error).message}</div>}

      {data && (
        <div className="card">
          <div className="card-head">
            <strong>Job {data.jobNumber ? `#${data.jobNumber}` : data.jobId}</strong>
            {data.jobStatus && <span className="badge">{data.jobStatus}</span>}
            <span className="muted" style={{ fontSize: ".8rem" }}>
              matched by job {data.matchedBy === "id" ? "ID" : "number"} · id {data.jobId}
            </span>
          </div>

          {data.summary && <p style={{ marginBottom: ".7rem" }}>{data.summary}</p>}
          <p className="hint">
            {data.customerName ?? "—"}
            {data.locationAddress ? ` · ${data.locationAddress}` : ""}
          </p>

          <div className="table-scroll" style={{ marginTop: ".9rem" }}>
            <table>
              <tbody>
                {mode !== "photos" && mode !== "attachments" &&
                  data.parts.map((part) => (
                    <tr key={part.file}>
                      <td>
                        {part.label}
                        {part.error && <div className="muted" style={{ fontSize: ".8rem" }}>{part.error}</div>}
                      </td>
                      <td>
                        {part.count !== null && part.status !== "failed" && (
                          <span className="num muted" style={{ marginRight: ".6rem" }}>{part.count}</span>
                        )}
                        <span className={`badge ${part.status === "ok" ? "badge-ok" : part.status === "failed" ? "badge-bad" : ""}`}>
                          {part.status === "ok" ? "included" : part.status === "failed" ? "failed" : "none"}
                        </span>
                      </td>
                    </tr>
                  ))}
                {mode !== "records" && (
                  <tr>
                    <td>
                      {mode === "photos" ? "Photos" : "Photos & attachments"}
                      {data.attachmentsError && (
                        <div className="muted" style={{ fontSize: ".8rem" }}>{data.attachmentsError}</div>
                      )}
                      {skipped > 0 && (
                        <div className="muted" style={{ fontSize: ".8rem" }}>
                          {skipped} non-image file{skipped === 1 ? "" : "s"} skipped in this mode
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="num muted" style={{ marginRight: ".6rem" }}>{shown.length}</span>
                      <span className={`badge ${data.attachmentsError ? "badge-bad" : shown.length > 0 ? "badge-ok" : ""}`}>
                        {data.attachmentsError ? "failed" : shown.length > 0 ? "included" : "none"}
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {data.warnings.length > 0 && (
            <ul className="hint" style={{ marginTop: ".8rem", paddingLeft: "1.1rem" }}>
              {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}

          <div className="row" style={{ marginTop: "1rem" }}>
            <button type="button" className="btn btn-primary" onClick={download} disabled={downloading}>
              {downloading ? "Building zip…" : mode === "photos" ? "Download photos" : "Download .zip"}
            </button>
            {notice && <span className="muted">{notice}</span>}
            {error && <span className="muted">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

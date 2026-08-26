import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatBytes, formatDuration, type Run, type RunEstimate, type RunFile, type RunFilters } from "../api";

// The whole-tenant archive: size it up, start it, watch it, download it.
// Built around a run taking hours — never a button that hangs a browser tab.

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearsAgo(n: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
}

const FILE_LABEL: Record<RunFile["status"], string> = {
  completed: "ready",
  running: "building",
  pending: "waiting",
  empty: "no photos",
  deleted: "deleted",
  failed: "failed",
};

const FILE_BADGE: Record<RunFile["status"], string> = {
  completed: "badge-ok",
  running: "badge-warn",
  pending: "",
  empty: "",
  deleted: "",
  failed: "badge-bad",
};

export function ArchiveTab({ clientId }: { clientId: number }) {
  const cache = useQueryClient();
  const base = `/api/clients/${clientId}/runs`;
  const [filters, setFilters] = useState<RunFilters>({ from: yearsAgo(7), to: today(), dateField: "completed" });
  const [estimate, setEstimate] = useState<RunEstimate | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<{ kind: "run" | "file"; run: Run; file?: RunFile } | null>(null);

  const { data } = useQuery({
    queryKey: ["runs", clientId],
    queryFn: () => api.get<{ runs: Run[] }>(base),
    // Poll only while something is moving; a finished list has no reason to.
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === "running" || r.status === "queued") ? 4000 : false,
  });

  const runs = data?.runs ?? [];
  const active = runs.find((r) => r.status === "running" || r.status === "queued");

  const sizeUp = useMutation({
    mutationFn: () => api.post<RunEstimate>(`${base}/estimate`, filters),
    onSuccess: (result) => {
      setEstimate(result);
      setError("");
    },
    onError: (e) => setError((e as Error).message),
  });

  const start = useMutation({
    mutationFn: () => api.post<Run>(base, filters),
    onSuccess: () => {
      setEstimate(null);
      setError("");
      cache.invalidateQueries({ queryKey: ["runs", clientId] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const cancel = useMutation({
    mutationFn: (id: number) => api.post(`${base}/${id}/cancel`),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["runs", clientId] }),
  });

  const removeRun = useMutation({
    mutationFn: (id: number) => api.delete(`${base}/${id}`),
    onSuccess: () => {
      setConfirming(null);
      cache.invalidateQueries({ queryKey: ["runs", clientId] });
    },
    onError: (e) => {
      setConfirming(null);
      setError((e as Error).message);
    },
  });

  const removeFile = useMutation({
    mutationFn: ({ runId, fileId }: { runId: number; fileId: number }) => api.delete(`${base}/${runId}/files/${fileId}`),
    onSuccess: () => {
      setConfirming(null);
      cache.invalidateQueries({ queryKey: ["runs", clientId] });
    },
    onError: (e) => {
      setConfirming(null);
      setError((e as Error).message);
    },
  });

  function update(patch: Partial<RunFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setEstimate(null);
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <span className="eyebrow">Full archive</span>
        </div>
        <p className="hint" style={{ marginBottom: "1rem" }}>
          Every photo from every job in the range, as one zip per month with a folder per job inside. Size it up first —
          a whole tenant is tens of thousands of requests and runs for days. It happens on the server, so you can close
          this page.
        </p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field">
            From
            <input type="date" value={filters.from} onChange={(e) => update({ from: e.target.value })} />
          </label>
          <label className="field">
            To
            <input type="date" value={filters.to} onChange={(e) => update({ to: e.target.value })} />
          </label>
          <label className="field">
            Dates refer to
            <select
              value={filters.dateField}
              onChange={(e) => update({ dateField: e.target.value as RunFilters["dateField"] })}
            >
              <option value="completed">Job completed</option>
              <option value="created">Job created</option>
            </select>
          </label>
          <button type="button" className="btn" onClick={() => sizeUp.mutate()} disabled={sizeUp.isPending}>
            {sizeUp.isPending ? "Checking…" : "Check size"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => start.mutate()}
            disabled={start.isPending || !!active}
          >
            {active ? "Archive running" : start.isPending ? "Starting…" : "Start archive"}
          </button>
        </div>
        {error && <div className="flash flash-error" style={{ marginTop: ".8rem" }}>{error}</div>}
      </div>

      {estimate && (
        <div className="card">
          <div className="card-head"><span className="eyebrow">Before you start</span></div>
          <div className="row" style={{ gap: "2rem" }}>
            <div>
              <div className="num" style={{ fontSize: "1.4rem" }}>{estimate.jobsTotal.toLocaleString()}</div>
              <span className="eyebrow">jobs, exact</span>
            </div>
            <div>
              <div className="num" style={{ fontSize: "1.4rem" }}>~{estimate.estimatedPhotos.toLocaleString()}</div>
              <span className="eyebrow">photos, projected</span>
            </div>
            <div>
              <div className="num" style={{ fontSize: "1.4rem" }}>{formatBytes(estimate.estimatedBytes)}</div>
              <span className="eyebrow">size, projected</span>
            </div>
            <div>
              <div className="num" style={{ fontSize: "1.4rem" }}>{formatDuration(estimate.estimatedMinutes)}</div>
              <span className="eyebrow">to run</span>
            </div>
          </div>
          <p className="hint" style={{ marginTop: ".9rem" }}>
            The job count is exact. The photo count is projected from {estimate.sampledJobs} sampled job
            {estimate.sampledJobs === 1 ? "" : "s"} ({estimate.photosInSample} photos,{" "}
            {Math.round(estimate.jobsWithPhotosRate * 100)}% of them had any) — counting every photo exactly would cost
            the same tens of thousands of requests as the archive itself.
          </p>
          {estimate.warnings.length > 0 && (
            <ul className="hint" style={{ marginTop: ".5rem", paddingLeft: "1.1rem" }}>
              {estimate.warnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {runs.length === 0 && <p className="muted">No archives yet.</p>}

      {runs.map((run) => {
        const pct = run.jobsTotal > 0 ? Math.round((run.jobsDone / run.jobsTotal) * 100) : 0;
        const busy = run.status === "running" || run.status === "queued";
        return (
          <div className="card" key={run.id}>
            <div className="card-head">
              <span className={`badge ${run.status === "completed" ? "badge-ok" : run.status === "failed" ? "badge-bad" : busy ? "badge-warn" : ""}`}>
                {run.status}
              </span>
              <strong>{run.filters.from} → {run.filters.to}</strong>
              <span className="muted" style={{ fontSize: ".82rem" }}>by {run.requestedByEmail}</span>
              <span className="row-end" />
              {busy ? (
                <button type="button" className="link-btn" onClick={() => cancel.mutate(run.id)}>Cancel</button>
              ) : (
                <button type="button" className="link-btn danger" onClick={() => setConfirming({ kind: "run", run })}>
                  Delete
                </button>
              )}
            </div>

            <div className="bar" style={{ marginBottom: ".6rem" }}><span style={{ width: `${pct}%` }} /></div>
            <p className="hint">
              <span className="num">{run.jobsDone.toLocaleString()}</span> of{" "}
              <span className="num">{run.jobsTotal.toLocaleString()}</span> jobs ·{" "}
              <span className="num">{run.photosTotal.toLocaleString()}</span> photos ·{" "}
              {formatBytes(run.bytesTotal)}
              {run.currentStep ? ` · ${run.currentStep}` : ""}
            </p>
            {run.error && <div className="flash flash-error" style={{ marginTop: ".6rem" }}>{run.error}</div>}

            {run.files.length > 0 && (
              <div className="table-scroll" style={{ marginTop: ".9rem" }}>
                <table>
                  <thead>
                    <tr><th>Month</th><th>Jobs</th><th>Photos</th><th>Size</th><th></th></tr>
                  </thead>
                  <tbody>
                    {run.files.map((file) => (
                      <tr key={file.id}>
                        <td className="num">{file.month}</td>
                        <td className="num">{file.jobs || "—"}</td>
                        <td className="num">{file.photos || "—"}</td>
                        <td className="num">{formatBytes(file.bytes)}</td>
                        <td>
                          {file.available ? (
                            <>
                              <a href={`${base}/${run.id}/files/${file.id}`}>Download</a>
                              <button
                                type="button"
                                className="link-btn danger"
                                style={{ marginLeft: ".7rem" }}
                                onClick={() => setConfirming({ kind: "file", run, file })}
                              >
                                Delete
                              </button>
                            </>
                          ) : (
                            <span className={`badge ${FILE_BADGE[file.status]}`} title={file.error ?? undefined}>
                              {FILE_LABEL[file.status]}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {/* Deleting destroys files that took hours of a client's API budget to
          build, so it says what goes before it goes. */}
      {confirming && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <div className="card-head"><span className="eyebrow">Confirm</span></div>
          <p style={{ marginBottom: ".9rem" }}>
            {confirming.kind === "file"
              ? `Delete ${confirming.file!.month} (${confirming.file!.photos} photos, ${formatBytes(confirming.file!.bytes)})? The rest of this archive is left alone.`
              : `Delete the archive for ${confirming.run.filters.from} → ${confirming.run.filters.to}, including ${confirming.run.files.filter((f) => f.available).length} zip file(s)?`}
            {" "}This cannot be undone — rebuilding means running the archive again.
          </p>
          <div className="row">
            <button type="button" className="btn" onClick={() => setConfirming(null)}>Keep it</button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() =>
                confirming.kind === "file"
                  ? removeFile.mutate({ runId: confirming.run.id, fileId: confirming.file!.id })
                  : removeRun.mutate(confirming.run.id)
              }
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

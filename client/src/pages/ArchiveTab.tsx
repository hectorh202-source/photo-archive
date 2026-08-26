import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatBytes, formatDuration, type Run, type RunEstimate, type RunFile, type RunFilters } from "../api";

// Three steps, in the order a person does them: pick a range, see what it
// costs, start it. Everything already run sits underneath as history.

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearsAgo(n: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
}

const FILE_LABEL: Record<RunFile["status"], string> = {
  completed: "Ready",
  running: "Building",
  pending: "Waiting",
  empty: "No photos",
  deleted: "Deleted",
  failed: "Failed",
};

const FILE_PILL: Record<RunFile["status"], string> = {
  completed: "pill-ok",
  running: "pill-warn",
  pending: "",
  empty: "",
  deleted: "",
  failed: "pill-bad",
};

const RUN_PILL: Record<Run["status"], string> = {
  completed: "pill-ok",
  running: "pill-warn pill-live",
  queued: "pill-warn",
  failed: "pill-bad",
  canceled: "",
};

function monthName(month: string): string {
  const [y, m] = month.split("-");
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return Number.isNaN(date.getTime())
    ? month
    : date.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

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
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.status === "running" || r.status === "queued") ? 4000 : false,
  });

  const runs = data?.runs ?? [];
  const active = runs.find((r) => r.status === "running" || r.status === "queued");
  const history = runs.filter((r) => r !== active);

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

  function renderRun(run: Run, live: boolean) {
    const pct = run.jobsTotal > 0 ? Math.round((run.jobsDone / run.jobsTotal) * 100) : 0;
    const busy = run.status === "running" || run.status === "queued";
    const ready = run.files.filter((f) => f.available).length;

    return (
      <div className="card" key={run.id}>
        <div className="card-head">
          <span className={`pill ${RUN_PILL[run.status]}`}>
            {run.status === "running" ? "Running" : run.status[0].toUpperCase() + run.status.slice(1)}
          </span>
          <strong>{run.filters.from} → {run.filters.to}</strong>
          <span className="tiny">
            {run.filters.dateField === "completed" ? "by completion date" : "by created date"} · started by{" "}
            {run.requestedByEmail}
          </span>
          <span className="spacer" />
          {busy ? (
            <button type="button" className="btn btn-sm" onClick={() => cancel.mutate(run.id)}>
              Stop
            </button>
          ) : (
            <button type="button" className="link-btn danger" onClick={() => setConfirming({ kind: "run", run })}>
              Delete
            </button>
          )}
        </div>

        <div className="card-body">
          {live && (
            <>
              <div className="bar"><span style={{ width: `${pct}%` }} /></div>
              <div className="row">
                <span className="sub">
                  <span className="num">{run.jobsDone.toLocaleString()}</span> of{" "}
                  <span className="num">{run.jobsTotal.toLocaleString()}</span> jobs checked ({pct}%)
                </span>
                <span className="spacer" />
                <span className="sub">{run.currentStep ?? "Working…"}</span>
              </div>
            </>
          )}

          <div className="stats">
            <div className="stat">
              <div className="stat-value">{run.photosTotal.toLocaleString()}</div>
              <div className="stat-label">photos retrieved</div>
            </div>
            <div className="stat">
              <div className="stat-value">{formatBytes(run.bytesTotal)}</div>
              <div className="stat-label">downloaded</div>
            </div>
            <div className="stat">
              <div className="stat-value">{ready}</div>
              <div className="stat-label">months ready</div>
            </div>
          </div>

          {run.error && <div className="notice notice-bad">{run.error}</div>}
        </div>

        {run.files.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Month</th><th>Jobs</th><th>Photos</th><th>Size</th><th></th></tr>
              </thead>
              <tbody>
                {run.files.map((file) => (
                  <tr key={file.id}>
                    <td>{monthName(file.month)}</td>
                    <td className="num">{file.jobs || "—"}</td>
                    <td className="num">{file.photos || "—"}</td>
                    <td className="num">{formatBytes(file.bytes)}</td>
                    <td>
                      {file.available ? (
                        <div className="row" style={{ justifyContent: "flex-end", gap: ".8rem" }}>
                          <a href={`${base}/${run.id}/files/${file.id}`}>Download</a>
                          <button
                            type="button"
                            className="link-btn danger"
                            onClick={() => setConfirming({ kind: "file", run, file })}
                          >
                            Delete
                          </button>
                        </div>
                      ) : (
                        <span className={`pill ${FILE_PILL[file.status]}`} title={file.error ?? undefined}>
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
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>New archive</h2>
          <span className="tiny">Photos from every job in the range, as one zip per month</span>
        </div>
        <div className="card-body">
          <div className="row" style={{ alignItems: "flex-end", gap: "1rem" }}>
            <label className="field">
              <span>From</span>
              <input type="date" value={filters.from} onChange={(e) => update({ from: e.target.value })} />
            </label>
            <label className="field">
              <span>To</span>
              <input type="date" value={filters.to} onChange={(e) => update({ to: e.target.value })} />
            </label>
            <label className="field">
              <span>Match jobs by</span>
              <select
                value={filters.dateField}
                onChange={(e) => update({ dateField: e.target.value as RunFilters["dateField"] })}
              >
                <option value="completed">Date completed</option>
                <option value="created">Date created</option>
              </select>
            </label>
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => sizeUp.mutate()} disabled={sizeUp.isPending}>
              {sizeUp.isPending ? "Checking…" : "Check size first"}
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

          {error && <div className="notice notice-bad">{error}</div>}

          {estimate && (
            <>
              <div className="stats">
                <div className="stat">
                  <div className="stat-value">{estimate.jobsTotal.toLocaleString()}</div>
                  <div className="stat-label">jobs — exact</div>
                </div>
                <div className="stat">
                  <div className="stat-value">~{estimate.estimatedPhotos.toLocaleString()}</div>
                  <div className="stat-label">photos — estimated</div>
                </div>
                <div className="stat">
                  <div className="stat-value">{formatBytes(estimate.estimatedBytes)}</div>
                  <div className="stat-label">size — estimated</div>
                </div>
                <div className="stat">
                  <div className="stat-value" style={{ fontSize: "1.05rem" }}>{formatDuration(estimate.estimatedMinutes)}</div>
                  <div className="stat-label">to finish</div>
                </div>
                <div className="stat">
                  <div className="stat-value">{estimate.months}</div>
                  <div className="stat-label">zip files</div>
                </div>
              </div>
              <p className="tiny">
                The job count is exact. The photo count comes from sampling {estimate.sampledJobs} jobs across the range
                ({estimate.photosInSample} photos, {Math.round(estimate.jobsWithPhotosRate * 100)}% of them had any), so
                the real number will differ — counting every photo exactly costs as many requests as the archive itself.
              </p>
              {estimate.warnings.length > 0 && (
                <div className="notice notice-warn">
                  <div>
                    {estimate.warnings.slice(0, 3).map((w, i) => <div key={i}>{w}</div>)}
                  </div>
                </div>
              )}
            </>
          )}

          {!estimate && !error && (
            <p className="tiny">
              The run happens on the server — you can close this page and come back to it. Photos only or photos plus
              documents is set on the Settings tab.
            </p>
          )}
        </div>
      </div>

      {active && renderRun(active, true)}

      {history.length > 0 && (
        <>
          <h2 style={{ marginTop: ".5rem" }}>Past archives</h2>
          {history.map((run) => renderRun(run, false))}
        </>
      )}

      {runs.length === 0 && (
        <div className="card">
          <div className="empty">
            <h3>No archives yet</h3>
            <p>Check the size of a range first, then start it. Months become downloadable as each one finishes.</p>
          </div>
        </div>
      )}

      {confirming && (
        <div className="overlay" onClick={() => setConfirming(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-head">
              <h2>
                {confirming.kind === "file"
                  ? `Delete ${monthName(confirming.file!.month)}?`
                  : "Delete this archive?"}
              </h2>
            </div>
            <div className="card-body">
              <p className="sub">
                {confirming.kind === "file"
                  ? `Removes that month's zip — ${confirming.file!.photos} photos, ${formatBytes(confirming.file!.bytes)}. The rest of the archive stays.`
                  : `Removes ${confirming.run.files.filter((f) => f.available).length} zip file(s) for ${confirming.run.filters.from} → ${confirming.run.filters.to}.`}
              </p>
              <p className="sub">
                This cannot be undone. Rebuilding means running the archive again, which spends the client's API budget
                a second time.
              </p>
            </div>
            <div className="card-foot">
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
              <button type="button" className="btn" onClick={() => setConfirming(null)}>Keep it</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

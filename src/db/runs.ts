import { db } from "./index";

// State for the batch photo export (servicetitan/batchPhotoExport.ts). A run
// takes tens of minutes and thousands of ServiceTitan calls, so its progress
// lives in SQLite rather than in memory: the page polls it, and a container
// restart mid-run leaves a row that says what happened instead of a job that
// silently vanished.

export type RunStatus = "queued" | "running" | "completed" | "failed" | "canceled";
// "deleted" is a zip removed on purpose, distinct from "failed" (never
// finished) and from a completed row whose file the retention sweep took.
// Keeping the row means the page can still say what that month held.
export type RunFileStatus = "pending" | "running" | "completed" | "failed" | "empty" | "deleted";

export interface RunFilters {
  // ISO dates (YYYY-MM-DD). Which field they filter on is dateField below.
  from: string;
  to: string;
  dateField: "completed" | "created";
  jobStatus?: string;
  businessUnitId?: string;
  jobTypeId?: string;
}

export interface RunRow {
  id: number;
  client_id: number;
  requested_by_user_id: number | null;
  requested_by_email: string;
  filters_json: string;
  status: RunStatus;
  jobs_total: number;
  jobs_done: number;
  photos_total: number;
  bytes_total: number;
  current_step: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RunFileRow {
  id: number;
  run_id: number;
  month: string;
  file_path: string;
  jobs: number;
  photos: number;
  bytes: number;
  status: RunFileStatus;
  error: string | null;
  finished_at: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO runs (client_id, requested_by_user_id, requested_by_email, filters_json, status)
  VALUES (@clientId, @userId, @email, @filtersJson, 'queued')
`);

export function createRun(input: {
  clientId: number;
  userId: number;
  email: string;
  filters: RunFilters;
}): number {
  const result = insertStmt.run({
    clientId: input.clientId,
    userId: input.userId,
    email: input.email,
    filtersJson: JSON.stringify(input.filters),
  });
  return Number(result.lastInsertRowid);
}

const getStmt = db.prepare(`SELECT * FROM runs WHERE id = ? AND client_id = ?`);

export function getRun(clientId: number, id: number): RunRow | undefined {
  return getStmt.get(id, clientId) as unknown as RunRow | undefined;
}

const listStmt = db.prepare(`
  SELECT * FROM runs WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
`);

export function listRuns(clientId: number, limit = 25): RunRow[] {
  return listStmt.all(clientId, limit) as unknown as RunRow[];
}

const activeStmt = db.prepare(`
  SELECT * FROM runs WHERE client_id = ? AND status IN ('queued', 'running') ORDER BY id LIMIT 1
`);

// One run per business at a time. Two concurrent runs would double the
// request rate against a tenant that rate-limits per app, which is the one
// resource this whole feature has to stay inside of.
export function findActiveRun(clientId: number): RunRow | undefined {
  return activeStmt.get(clientId) as unknown as RunRow | undefined;
}

// Guarded on 'queued' so it cannot resurrect a run canceled in the gap
// between the request that created the row and the runner picking it up —
// without that, an immediate Cancel is silently overwritten and the export
// proceeds anyway.
const startStmt = db.prepare(`
  UPDATE runs SET status = 'running', started_at = datetime('now'), current_step = @step
  WHERE id = @id AND status = 'queued'
`);

export function markRunStarted(id: number, step: string): void {
  startStmt.run({ id, step });
}

const progressStmt = db.prepare(`
  UPDATE runs
  SET jobs_total = @jobsTotal, jobs_done = @jobsDone, photos_total = @photosTotal,
      bytes_total = @bytesTotal, current_step = @step
  WHERE id = @id
`);

export function updateRunProgress(
  id: number,
  progress: { jobsTotal: number; jobsDone: number; photosTotal: number; bytesTotal: number; step: string },
): void {
  progressStmt.run({
    id,
    jobsTotal: progress.jobsTotal,
    jobsDone: progress.jobsDone,
    photosTotal: progress.photosTotal,
    bytesTotal: progress.bytesTotal,
    step: progress.step,
  });
}

const finishStmt = db.prepare(`
  UPDATE runs SET status = @status, error = @error, current_step = NULL, finished_at = datetime('now')
  WHERE id = @id
`);

export function finishRun(id: number, status: RunStatus, error: string | null = null): void {
  finishStmt.run({ id, status, error });
}

const cancelStmt = db.prepare(`
  UPDATE runs SET status = 'canceled', finished_at = datetime('now'), current_step = NULL
  WHERE id = ? AND client_id = ? AND status IN ('queued', 'running')
`);

export function requestRunCancel(clientId: number, id: number): boolean {
  return cancelStmt.run(id, clientId).changes > 0;
}

const statusOnlyStmt = db.prepare(`SELECT status FROM runs WHERE id = ?`);

// The runner checks this between months and between jobs — a cancel has to
// stop a run that is thousands of requests deep, and the only signal that
// crosses from an HTTP request into the running loop is this row.
export function readRunStatus(id: number): RunStatus | null {
  const row = statusOnlyStmt.get(id) as { status: RunStatus } | undefined;
  return row?.status ?? null;
}

const insertFileStmt = db.prepare(`
  INSERT INTO run_files (run_id, month, file_path, status)
  VALUES (@runId, @month, @filePath, 'pending')
`);

export function createRunFile(runId: number, month: string, filePath: string): number {
  return Number(insertFileStmt.run({ runId, month, filePath }).lastInsertRowid);
}

const updateFileStmt = db.prepare(`
  UPDATE run_files
  SET status = @status, jobs = @jobs, photos = @photos, bytes = @bytes, error = @error,
      finished_at = CASE WHEN @status IN ('completed', 'failed', 'empty') THEN datetime('now') ELSE NULL END
  WHERE id = @id
`);

export function updateRunFile(
  id: number,
  update: { status: RunFileStatus; jobs: number; photos: number; bytes: number; error?: string | null },
): void {
  updateFileStmt.run({
    id,
    status: update.status,
    jobs: update.jobs,
    photos: update.photos,
    bytes: update.bytes,
    error: update.error ?? null,
  });
}

const markFileDeletedStmt = db.prepare(`
  UPDATE run_files SET status = 'deleted', bytes = 0 WHERE id = ? AND run_id = ?
`);

// Photos and job counts are left intact — after the zip is gone they are the
// only remaining record of what that month contained.
export function markRunFileDeleted(runId: number, fileId: number): boolean {
  return markFileDeletedStmt.run(fileId, runId).changes > 0;
}

const listFilesStmt = db.prepare(`SELECT * FROM run_files WHERE run_id = ? ORDER BY month`);

export function listRunFiles(runId: number): RunFileRow[] {
  return listFilesStmt.all(runId) as unknown as RunFileRow[];
}

const getFileStmt = db.prepare(`SELECT * FROM run_files WHERE id = ? AND run_id = ?`);

export function getRunFile(runId: number, fileId: number): RunFileRow | undefined {
  return getFileStmt.get(fileId, runId) as unknown as RunFileRow | undefined;
}

const deleteStmt = db.prepare(`DELETE FROM runs WHERE id = ? AND client_id = ?`);
const deleteFilesStmt = db.prepare(`DELETE FROM run_files WHERE run_id = ?`);

export function deleteRun(clientId: number, id: number): void {
  deleteFilesStmt.run(id);
  deleteStmt.run(id, clientId);
}

// A container restart kills the in-process runner without touching its row,
// which would otherwise leave a "running" job that never moves again and
// blocks the next one (see findActiveRun). Called once at startup.
const reapStmt = db.prepare(`
  UPDATE runs
  SET status = 'failed', error = 'Interrupted by a server restart', finished_at = datetime('now'), current_step = NULL
  WHERE status IN ('queued', 'running')
`);

export function failInterruptedRuns(): number {
  return Number(reapStmt.run().changes);
}

const staleStmt = db.prepare(`
  SELECT f.* FROM run_files f
  JOIN runs b ON b.id = f.run_id
  WHERE b.finished_at IS NOT NULL AND b.finished_at < datetime('now', ?)
`);

// Monthly zips are hundreds of megabytes and live in the same volume as the
// database. Without a retention sweep they accumulate until the disk fills.
export function listExpiredRunFiles(retentionDays: number): RunFileRow[] {
  return staleStmt.all(`-${retentionDays} days`) as unknown as RunFileRow[];
}

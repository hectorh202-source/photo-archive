import { Router, type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import { z } from "zod";
import { attemptLogin, createUser, getUserById, listUsers, userCount, type User } from "../db/users";
import { createClient, deleteClient, getClient, listClients, updateClient } from "../db/clients";
import {
  getAllClientSettings,
  getServiceTitanConfig,
  getRunTuning,
  getDeliveryConfig,
  maybeSetClientSetting,
  setClientSetting,
  SECRET_KEYS,
  DEFAULT_TUNING,
} from "../db/clientSettings";
import { logAudit, listAudit } from "../db/auditLog";
import {
  createRun,
  deleteRun,
  findActiveRun,
  getRun,
  getRunFile,
  listRunFiles,
  listRuns,
  markRunFileDeleted,
  requestRunCancel,
  type RunFilters,
} from "../db/runs";
import { estimateRun, startRun, runFileExists } from "../servicetitan/archiveRun";
import { buildJobExportPreview, buildJobExportZip, JobNotFoundError, type JobExportMode } from "../servicetitan/jobExport";
import { describeError, stRequest, ServiceTitanNotConfiguredError } from "../servicetitan/httpClient";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: User;
      client?: ReturnType<typeof getClient>;
    }
  }
}

export const apiRouter = Router();

function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (req.session.userId) {
    const user = getUserById(req.session.userId);
    if (user) {
      req.currentUser = user;
      next();
      return;
    }
    req.session.userId = undefined;
  }
  res.status(401).json({ error: "unauthenticated" });
}

// --- auth ------------------------------------------------------------------

const credentialsSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
});

// Open only while the database has no users at all — the first-run bootstrap,
// which closes itself permanently the moment it succeeds.
apiRouter.get("/auth/state", (_req, res) => {
  res.json({ needsSetup: userCount() === 0 });
});

apiRouter.post("/auth/setup", (req, res) => {
  if (userCount() > 0) {
    res.status(409).json({ error: "Already set up. Sign in instead." });
    return;
  }
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter an email and a password of at least 8 characters." });
    return;
  }
  const user = createUser(parsed.data.email, parsed.data.password, true);
  req.session.userId = user.id;
  logAudit({ clientId: null, userId: user.id, userEmail: user.email, action: "user.created", target: user.email });
  res.json({ user: { id: user.id, email: user.email, isAdmin: user.isAdmin } });
});

apiRouter.post("/auth/login", (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }
  const result = attemptLogin(parsed.data.email, parsed.data.password);
  if (!result.ok) {
    // One message for wrong password, unknown email, and locked account
    // alike: anything more specific tells an attacker which of the three
    // they hit.
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }
  req.session.userId = result.user.id;
  res.json({ user: { id: result.user.id, email: result.user.email, isAdmin: result.user.isAdmin } });
});

apiRouter.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

apiRouter.get("/session", requireSession, (req, res) => {
  const user = req.currentUser!;
  res.json({ user: { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin } });
});

apiRouter.use(requireSession);

apiRouter.get("/users", (_req, res) => {
  res.json({ users: listUsers().map((u) => ({ id: u.id, email: u.email, isAdmin: u.isAdmin })) });
});

// --- clients ---------------------------------------------------------------

const clientSchema = z.object({
  name: z.string().min(1).max(200),
  contactName: z.string().max(200).nullish(),
  contactEmail: z.string().max(200).nullish(),
  cutoverDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal("")),
  notes: z.string().max(4000).nullish(),
  archived: z.boolean().optional(),
});

apiRouter.get("/clients", (_req, res) => {
  res.json({
    clients: listClients().map((client) => ({
      ...client,
      // Enough for the list to show readiness without opening each one.
      serviceTitanConfigured: getServiceTitanConfig(client.id) !== null,
      activeRunId: findActiveRun(client.id)?.id ?? null,
    })),
  });
});

apiRouter.post("/clients", (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A client needs at least a name." });
    return;
  }
  const client = createClient({ ...parsed.data, cutoverDate: parsed.data.cutoverDate || null });
  logAudit({
    clientId: client.id,
    userId: req.currentUser!.id,
    userEmail: req.currentUser!.email,
    action: "client.created",
    target: client.name,
  });
  res.status(201).json(client);
});

// Everything below is scoped to one client.
apiRouter.use("/clients/:clientId", (req, res, next) => {
  const client = getClient(Number(req.params.clientId));
  if (!client) {
    res.status(404).json({ error: "No such client" });
    return;
  }
  req.client = client;
  next();
});

apiRouter.get("/clients/:clientId", (req, res) => {
  const client = req.client!;
  res.json({
    ...client,
    serviceTitanConfigured: getServiceTitanConfig(client.id) !== null,
    tuning: getRunTuning(client.id),
    delivery: getDeliveryConfig(client.id),
  });
});

apiRouter.put("/clients/:clientId", (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A client needs at least a name." });
    return;
  }
  updateClient(req.client!.id, { ...parsed.data, cutoverDate: parsed.data.cutoverDate || null });
  logAudit({
    clientId: req.client!.id,
    userId: req.currentUser!.id,
    userEmail: req.currentUser!.email,
    action: "client.updated",
    target: parsed.data.name,
  });
  res.json(getClient(req.client!.id));
});

apiRouter.delete("/clients/:clientId", (req, res) => {
  const client = req.client!;
  if (findActiveRun(client.id)) {
    res.status(409).json({ error: "Cancel the running archive before deleting this client." });
    return;
  }
  // Files first: the filesystem has no foreign keys, so a cascade in SQLite
  // would leave gigabytes of orphaned zips behind.
  for (const run of listRuns(client.id, 1000)) {
    for (const file of listRunFiles(run.id)) fs.rmSync(file.file_path, { force: true });
  }
  deleteClient(client.id);
  logAudit({
    clientId: null,
    userId: req.currentUser!.id,
    userEmail: req.currentUser!.email,
    action: "client.deleted",
    target: client.name,
  });
  res.json({ success: true });
});

// --- settings --------------------------------------------------------------

// Values are returned for everything except secrets, which come back as a
// boolean "is it set" — a stolen session should not be able to read a
// client's ServiceTitan secret straight out of the API.
apiRouter.get("/clients/:clientId/settings", (req, res) => {
  const all = getAllClientSettings(req.client!.id);
  const values: Record<string, string> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(all)) {
    if (SECRET_KEYS.has(key)) secretsSet[key] = value.trim() !== "";
    else values[key] = value;
  }
  res.json({ values, secretsSet, defaults: DEFAULT_TUNING });
});

const settingsSchema = z.record(z.string().max(120), z.string().max(4000));

apiRouter.put("/clients/:clientId/settings", (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Settings must be a flat map of strings." });
    return;
  }
  for (const [key, value] of Object.entries(parsed.data)) {
    // Blank on a secret means "keep what's stored"; blank on anything else
    // is a real clear.
    if (SECRET_KEYS.has(key)) maybeSetClientSetting(req.client!.id, key, value);
    else setClientSetting(req.client!.id, key, value);
  }
  logAudit({
    clientId: req.client!.id,
    userId: req.currentUser!.id,
    userEmail: req.currentUser!.email,
    action: "settings.updated",
    details: { keys: Object.keys(parsed.data).join(",") },
  });
  res.json({ success: true });
});

// Real round trip against the saved credentials: token exchange plus one
// cheap read, so a wrong app key or tenant id surfaces here rather than
// three hours into a run.
apiRouter.post("/clients/:clientId/settings/test", async (req, res) => {
  const config = getServiceTitanConfig(req.client!.id);
  if (!config) {
    res.json({ success: false, error: "ServiceTitan is not fully configured yet." });
    return;
  }
  try {
    const result = await stRequest<{ totalCount?: number; data?: unknown[] }>(
      config,
      "GET",
      `/jpm/v2/tenant/${config.tenantId}/jobs`,
      { params: { pageSize: 1, includeTotal: true } },
    );
    res.json({
      success: true,
      environment: config.environment,
      jobsVisible: result.totalCount ?? null,
    });
  } catch (error) {
    res.json({ success: false, error: describeError(error) });
  }
});

// --- single job ------------------------------------------------------------

const JOB_REFERENCE = /^[A-Za-z0-9-]{1,24}$/;

function parseMode(value: unknown): JobExportMode {
  return value === "photos" || value === "records" || value === "attachments" ? value : "full";
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ServiceTitanNotConfiguredError) {
    res.status(503).json({ error: "ServiceTitan is not configured for this client." });
    return;
  }
  if (error instanceof JobNotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  res.status(502).json({ error: describeError(error) });
}

apiRouter.get("/clients/:clientId/jobs/:reference/preview", async (req, res) => {
  if (!JOB_REFERENCE.test(req.params.reference)) {
    res.status(400).json({ error: "Enter a ServiceTitan job number or job ID." });
    return;
  }
  try {
    res.json(await buildJobExportPreview(req.client!.id, req.params.reference, parseMode(req.query.mode)));
  } catch (error) {
    sendError(res, error);
  }
});

apiRouter.get("/clients/:clientId/jobs/:reference/export", async (req, res) => {
  if (!JOB_REFERENCE.test(req.params.reference)) {
    res.status(400).json({ error: "Enter a ServiceTitan job number or job ID." });
    return;
  }
  const mode = parseMode(req.query.mode);
  try {
    const result = await buildJobExportZip(req.client!.id, req.params.reference, {
      mode,
      requestedBy: req.currentUser!.email,
    });
    logAudit({
      clientId: req.client!.id,
      userId: req.currentUser!.id,
      userEmail: req.currentUser!.email,
      action: "job.exported",
      target: String(result.jobId),
      details: { mode, attachments: result.attachmentCount },
    });
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${result.fileName}"`);
    res.set("X-Export-Warnings", String(result.warnings.length));
    res.send(result.data);
  } catch (error) {
    sendError(res, error);
  }
});

// --- archive runs ----------------------------------------------------------

const BATCH_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseFilters(body: unknown): RunFilters | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  const from = typeof raw.from === "string" ? raw.from : "";
  const to = typeof raw.to === "string" ? raw.to : "";
  if (!BATCH_DATE.test(from) || !BATCH_DATE.test(to) || from > to) return null;
  const id = (value: unknown): string | undefined =>
    typeof value === "string" && /^\d{1,12}$/.test(value) ? value : undefined;
  return {
    from,
    to,
    dateField: raw.dateField === "created" ? "created" : "completed",
    jobStatus: typeof raw.jobStatus === "string" && /^[A-Za-z]{1,20}$/.test(raw.jobStatus) ? raw.jobStatus : undefined,
    businessUnitId: id(raw.businessUnitId),
    jobTypeId: id(raw.jobTypeId),
  };
}

function serializeRun(row: ReturnType<typeof getRun>) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    filters: JSON.parse(row.filters_json) as RunFilters,
    requestedByEmail: row.requested_by_email,
    jobsTotal: row.jobs_total,
    jobsDone: row.jobs_done,
    photosTotal: row.photos_total,
    bytesTotal: row.bytes_total,
    currentStep: row.current_step,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    files: listRunFiles(row.id).map((file) => ({
      id: file.id,
      month: file.month,
      status: file.status,
      jobs: file.jobs,
      photos: file.photos,
      bytes: file.bytes,
      error: file.error,
      available: file.status === "completed" && runFileExists(file.file_path),
    })),
  };
}

apiRouter.post("/clients/:clientId/runs/estimate", async (req, res) => {
  const filters = parseFilters(req.body);
  if (!filters) {
    res.status(400).json({ error: "Pick a valid date range (from and to, as YYYY-MM-DD)." });
    return;
  }
  try {
    res.json(await estimateRun(req.client!.id, filters));
  } catch (error) {
    sendError(res, error);
  }
});

apiRouter.post("/clients/:clientId/runs", (req, res) => {
  const client = req.client!;
  const filters = parseFilters(req.body);
  if (!filters) {
    res.status(400).json({ error: "Pick a valid date range (from and to, as YYYY-MM-DD)." });
    return;
  }
  const active = findActiveRun(client.id);
  if (active) {
    res.status(409).json({ error: "An archive is already running for this client.", id: active.id });
    return;
  }
  const id = createRun({
    clientId: client.id,
    userId: req.currentUser!.id,
    email: req.currentUser!.email,
    filters,
  });
  logAudit({
    clientId: client.id,
    userId: req.currentUser!.id,
    userEmail: req.currentUser!.email,
    action: "run.started",
    target: String(id),
    details: { from: filters.from, to: filters.to, dateField: filters.dateField },
  });
  startRun(id, client.id, filters);
  res.status(202).json(serializeRun(getRun(client.id, id)));
});

apiRouter.get("/clients/:clientId/runs", (req, res) => {
  res.json({ runs: listRuns(req.client!.id).map((row) => serializeRun(row)) });
});

apiRouter.post("/clients/:clientId/runs/:id/cancel", (req, res) => {
  const canceled = requestRunCancel(req.client!.id, Number(req.params.id));
  if (canceled) {
    logAudit({
      clientId: req.client!.id,
      userId: req.currentUser!.id,
      userEmail: req.currentUser!.email,
      action: "run.canceled",
      target: req.params.id,
    });
  }
  res.json({ canceled });
});

apiRouter.delete("/clients/:clientId/runs/:id", (req, res) => {
  const run = getRun(req.client!.id, Number(req.params.id));
  if (!run) {
    res.status(404).json({ error: "No such run" });
    return;
  }
  if (run.status === "running" || run.status === "queued") {
    res.status(409).json({ error: "Cancel the run before deleting it." });
    return;
  }
  for (const file of listRunFiles(run.id)) fs.rmSync(file.file_path, { force: true });
  deleteRun(req.client!.id, run.id);
  logAudit({
    clientId: req.client!.id,
    userId: req.currentUser!.id,
    userEmail: req.currentUser!.email,
    action: "run.deleted",
    target: String(run.id),
  });
  res.json({ success: true });
});

apiRouter.delete("/clients/:clientId/runs/:id/files/:fileId", (req, res) => {
  const run = getRun(req.client!.id, Number(req.params.id));
  const file = run ? getRunFile(run.id, Number(req.params.fileId)) : undefined;
  if (!run || !file) {
    res.status(404).json({ error: "No such file" });
    return;
  }
  fs.rmSync(file.file_path, { force: true });
  markRunFileDeleted(run.id, file.id);
  logAudit({
    clientId: req.client!.id,
    userId: req.currentUser!.id,
    userEmail: req.currentUser!.email,
    action: "run.file_deleted",
    target: `${run.id}/${file.month}`,
  });
  res.json({ success: true });
});

apiRouter.get("/clients/:clientId/runs/:id/files/:fileId", (req, res) => {
  const run = getRun(req.client!.id, Number(req.params.id));
  const file = run ? getRunFile(run.id, Number(req.params.fileId)) : undefined;
  if (!run || !file || file.status !== "completed" || !runFileExists(file.file_path)) {
    res.status(404).json({ error: "That month's file is not available." });
    return;
  }
  const clientSlug = req.client!.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // res.download streams: these files are hundreds of megabytes and must not
  // land in memory on their way out.
  res.download(file.file_path, `${clientSlug}-photos-${file.month}.zip`);
});

// --- audit -----------------------------------------------------------------

apiRouter.get("/audit", (req, res) => {
  const clientId = req.query.clientId ? Number(req.query.clientId) : null;
  res.json({
    entries: listAudit(Number.isFinite(clientId) ? clientId : null).map((row) => ({
      id: row.id,
      clientId: row.client_id,
      userEmail: row.user_email,
      action: row.action,
      target: row.target,
      details: row.details_json ? (JSON.parse(row.details_json) as Record<string, string>) : null,
      createdAt: row.created_at,
    })),
  });
});

import fs from "node:fs";
import path from "node:path";
import type { Archiver } from "archiver";

// @types/archiver 8 exports the classes and options but no callable factory,
// while the package's actual entry point IS that factory — an `import
// archiver from "archiver"` typechecks under one reading and throws
// "archiver is not a function" under the other. Require it and borrow the
// type, which is the combination that both compiles and runs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const createArchive = require("archiver") as (format: string, options?: Record<string, unknown>) => Archiver;
import { env } from "../config/env";
import { getRunTuning, type ServiceTitanConfig, type RunTuning } from "../db/clientSettings";
import { requireServiceTitanConfig, describeError, errorStatus } from "./httpClient";
import { fetchAllPages } from "./paginate";
import { listJobAttachments, downloadJobAttachment, classifyAttachment, looksLikeImageBytes, isImageContentType, sniffFileExtension, type JobAttachment } from "./jobAttachments";
import type { STJob } from "./jobExport";
import {
  createRunFile,
  updateRunFile,
  listRunFiles,
  markRunStarted,
  updateRunProgress,
  finishRun,
  readRunStatus,
  listExpiredRunFiles,
  type RunFilters,
} from "../db/runs";

// Every photo from every job in a date range, as one zip per month with a
// folder per job inside it.
//
// The single-job export (jobExport.ts) is the wrong shape for this and is
// deliberately not reused wholesale: it builds a zip in memory and answers an
// HTTP request. A year of jobs is thousands of requests, tens of minutes, and
// more bytes than belong in RAM — so this streams each month's zip straight
// to disk, keeps its progress in SQLite, and is driven by a background runner
// the page polls.
//
// Monthly, not one big file, for failure isolation: a run that dies in
// October still leaves January through September on disk and downloadable.

const exportsDir = path.join(env.ARCHIVE_PATH ?? path.join(path.dirname(env.DATABASE_PATH), "archives"));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Paced = <T>(work: () => Promise<T>) => Promise<T>;

// ServiceTitan rate-limits per app, and this is the one feature capable of
// spending that budget carelessly — so the rate is a per-client setting, and
// the clock it throttles against belongs to the run rather than the module.
// Two clients archiving at once are two separate tenants with two separate
// budgets; a shared global would make each unfairly slow the other.
function createPacer(tuning: RunTuning): Paced {
  const spacingMs = Math.max(20, Math.round(1000 / Math.max(0.2, tuning.requestsPerSecond)));
  let lastRequestAt = 0;

  return async function paced<T>(work: () => Promise<T>): Promise<T> {
    const wait = spacingMs - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    let lastError: unknown;
    for (let attempt = 0; attempt <= tuning.maxRetries; attempt++) {
      try {
        return await work();
      } catch (error) {
        lastError = error;
        const status = errorStatus(error);
        // 429 and 5xx are worth waiting out; a 401/403/404 will say the same
        // thing however many times it is asked.
        if (status !== 429 && status !== null && status < 500) throw error;
        const backoff = Math.min(30_000, 1000 * 2 ** attempt);
        await sleep(backoff);
        lastRequestAt = Date.now();
      }
    }
    throw lastError;
  };
}

// {customer}, {date}, {jobNumber} and {n} are the tokens the Settings tab
// documents. An unknown token is left alone rather than blanked, so a typo
// shows up in a filename instead of silently deleting part of the name.
function applyTemplate(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{(customer|date|jobNumber|n)\}/g, (match, key: string) => tokens[key] ?? match);
}

export interface MonthRange {
  // YYYY-MM, and the ISO instants bounding it.
  month: string;
  startIso: string;
  endIso: string;
}

// Inclusive of both endpoints, in whole months. The API filters are
// half-open (onOrAfter / before), so each month's end is the next month's
// start — no chance of a job on a boundary day landing in both files or
// neither.
export function monthsBetween(from: string, to: string): MonthRange[] {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const months: MonthRange[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= last) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    months.push({
      month: `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`,
      startIso: cursor.toISOString(),
      endIso: next.toISOString(),
    });
    cursor = next;
  }
  return months;
}

function jobQueryParams(filters: RunFilters, range: MonthRange): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (filters.dateField === "completed") {
    params.completedOnOrAfter = range.startIso;
    params.completedBefore = range.endIso;
  } else {
    params.createdOnOrAfter = range.startIso;
    params.createdBefore = range.endIso;
  }
  if (filters.jobStatus) params.jobStatus = filters.jobStatus;
  if (filters.businessUnitId) params.businessUnitId = filters.businessUnitId;
  if (filters.jobTypeId) params.jobTypeId = filters.jobTypeId;
  return params;
}

async function listJobsForMonth(
  config: ServiceTitanConfig,
  filters: RunFilters,
  range: MonthRange,
  paced: Paced,
): Promise<STJob[]> {
  return paced(() =>
    fetchAllPages<STJob>(config, `/jpm/v2/tenant/${config.tenantId}/jobs`, jobQueryParams(filters, range), {
      pageSize: 200,
      maxPages: 100,
    }),
  );
}

export interface RunEstimate {
  months: number;
  jobsTotal: number;
  sampledJobs: number;
  photosInSample: number;
  // Projected from the sample, not counted — saying so is the point.
  estimatedPhotos: number;
  estimatedBytes: number;
  estimatedMinutes: number;
  jobsWithPhotosRate: number;
  warnings: string[];
}

// Counting every photo exactly would mean one attachment listing per job —
// the same thousands of requests the real run makes. So the job count is
// exact (the list endpoint reports it) and the photo count is projected from
// a sample of jobs spread across the range. Cheap enough to run before
// committing to an hour, honest enough to plan around.
const SAMPLE_JOBS = 30;
const ASSUMED_BYTES_PER_PHOTO = 300 * 1024;

export async function estimateRun(clientId: number, filters: RunFilters): Promise<RunEstimate> {
  const config = requireServiceTitanConfig(clientId);
  const tuning = getRunTuning(clientId);
  const paced = createPacer(tuning);
  const ranges = monthsBetween(filters.from, filters.to);
  const warnings: string[] = [];
  const allJobs: STJob[] = [];

  for (const range of ranges) {
    try {
      allJobs.push(...(await listJobsForMonth(config, filters, range, paced)));
    } catch (error) {
      warnings.push(`${range.month}: ${describeError(error)}`);
    }
  }

  // Spread the sample across the whole range rather than taking the first N,
  // which would all come from the same month and the same crew.
  const step = Math.max(1, Math.floor(allJobs.length / SAMPLE_JOBS));
  const sample = allJobs.filter((_, index) => index % step === 0).slice(0, SAMPLE_JOBS);

  let photosInSample = 0;
  let jobsWithPhotos = 0;
  let sampled = 0;
  for (const job of sample) {
    try {
      const listing = await paced(() => listJobAttachments(config, String(job.id)));
      const photos = listing.attachments.filter(
        (a) => tuning.contents === "attachments" || classifyAttachment(a) !== "other",
      ).length;
      photosInSample += photos;
      if (photos > 0) jobsWithPhotos++;
      sampled++;
    } catch (error) {
      warnings.push(`Sampling job ${job.id}: ${describeError(error)}`);
    }
  }

  const photosPerJob = sampled > 0 ? photosInSample / sampled : 0;
  const estimatedPhotos = Math.round(photosPerJob * allJobs.length);
  // One listing call per job, one download per photo, at the pacing above.
  const requests = allJobs.length + estimatedPhotos;
  return {
    months: ranges.length,
    jobsTotal: allJobs.length,
    sampledJobs: sampled,
    photosInSample,
    estimatedPhotos,
    estimatedBytes: estimatedPhotos * ASSUMED_BYTES_PER_PHOTO,
    estimatedMinutes: Math.ceil(requests / Math.max(0.2, tuning.requestsPerSecond) / 60),
    jobsWithPhotosRate: sampled > 0 ? jobsWithPhotos / sampled : 0,
    warnings,
  };
}

function sanitizeSegment(value: string): string {
  const cleaned = Array.from(value)
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? "_" : ch))
    .join("");
  return cleaned.replace(/\s+/g, " ").trim().slice(0, 80);
}

function jobDateLabel(job: STJob): string {
  const raw = typeof job.completedOn === "string" ? job.completedOn : job.createdOn;
  if (typeof raw !== "string") return "undated";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "undated" : date.toISOString().slice(0, 10);
}

// Defaults to "89496 - Dana Whitfield - 2026-08-19": the job number first so
// a month's folders sort the way the office thinks about jobs, then who and
// when. The template is per-client because some offices file by customer.
function jobFolderName(job: STJob, customerName: string | null, template: string): string {
  return sanitizeSegment(
    applyTemplate(template, {
      jobNumber: String(job.jobNumber ?? job.id),
      customer: customerName ?? `Customer ${job.customerId ?? "unknown"}`,
      date: jobDateLabel(job),
      n: "",
    }),
  );
}

async function fetchCustomerName(config: ServiceTitanConfig, customerId: unknown, paced: Paced): Promise<string | null> {
  if (typeof customerId !== "number") return null;
  try {
    const customer = await paced(() =>
      fetchAllPages<{ id: number; name?: string }>(config, `/crm/v2/tenant/${config.tenantId}/customers`, {
        ids: String(customerId),
      }, { pageSize: 1, maxPages: 1 }),
    );
    const name = customer[0]?.name;
    return typeof name === "string" && name.trim() !== "" ? name : null;
  } catch {
    return null;
  }
}

interface MonthResult {
  jobs: number;
  photos: number;
  bytes: number;
}

async function buildMonthZip(
  config: ServiceTitanConfig,
  runId: number,
  jobs: STJob[],
  filePath: string,
  tuning: RunTuning,
  paced: Paced,
  onProgress: (delta: { jobsDone: number; photos: number; bytes: number }) => void,
): Promise<MonthResult> {
  const output = fs.createWriteStream(filePath);
  const archive = createArchive("zip", { zlib: { level: 0 } }); // photos are already compressed
  const closed = new Promise<void>((resolve, reject) => {
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);

  const result: MonthResult = { jobs: 0, photos: 0, bytes: 0 };
  const notes: string[] = [];

  for (const job of jobs) {
    if (readRunStatus(runId) === "canceled") break;
    let listing: { attachments: JobAttachment[] };
    try {
      listing = await paced(() => listJobAttachments(config, String(job.id)));
    } catch (error) {
      notes.push(`Job ${job.jobNumber ?? job.id}: attachment listing failed - ${describeError(error)}`);
      onProgress({ jobsDone: 1, photos: 0, bytes: 0 });
      continue;
    }

    // "attachments" keeps the generated invoice and estimate PDFs; "photos"
    // leaves them behind without spending a download on them.
    const candidates = listing.attachments.filter(
      (a) => tuning.contents === "attachments" || classifyAttachment(a) !== "other",
    );
    if (candidates.length === 0) {
      onProgress({ jobsDone: 1, photos: 0, bytes: 0 });
      continue;
    }

    const customerName = await fetchCustomerName(config, job.customerId, paced);
    const folder = jobFolderName(job, customerName, tuning.jobFolderTemplate);
    const dateLabel = jobDateLabel(job);
    let position = 0;
    let addedForJob = 0;

    for (const attachment of candidates) {
      if (readRunStatus(runId) === "canceled") break;
      try {
        const file = await paced(() => downloadJobAttachment(config, attachment));
        const kind = classifyAttachment(attachment);
        const isImage =
          kind === "image" || (kind === "unknown" && (isImageContentType(file.contentType) || looksLikeImageBytes(file.data)));
        if (tuning.contents !== "attachments" && !isImage) continue;
        if (file.data.length > tuning.maxFileMb * 1024 * 1024) {
            notes.push(
            `Job ${job.jobNumber ?? job.id}: skipped a ${Math.round(file.data.length / 1024 / 1024)} MB file (over the ${tuning.maxFileMb} MB limit)`,
          );
          continue;
        }
        position++;
        const label = customerName ?? `Job ${job.jobNumber ?? job.id}`;
        const extension = sniffFileExtension(file.data) ?? ".jpg";
        // A document keeps the name ServiceTitan gave it — "Invoice_89496_
        // signed" already says what it is — while a photo, whose stored name
        // is a GUID, gets the readable one.
        const readable = applyTemplate(tuning.photoNameTemplate, {
          customer: label,
          date: dateLabel,
          jobNumber: String(job.jobNumber ?? job.id),
          n: String(position).padStart(3, "0"),
        });
        const original = attachment.originalFileName ?? attachment.fileName ?? `file-${position}`;
        const name = isImage
          ? `${sanitizeSegment(readable)}${extension}`
          : `${String(position).padStart(3, "0")} - ${sanitizeSegment(original)}`;
        archive.append(file.data, { name: `${folder}/${name}` });
        result.photos++;
        result.bytes += file.data.length;
        addedForJob++;
        onProgress({ jobsDone: 0, photos: 1, bytes: file.data.length });
      } catch (error) {
        notes.push(`Job ${job.jobNumber ?? job.id}: a photo failed to download - ${describeError(error)}`);
      }
    }

    if (addedForJob > 0) result.jobs++;
    onProgress({ jobsDone: 1, photos: 0, bytes: 0 });
  }

  // Every skipped or failed file, named. A batch this size will always have
  // some, and silence about them is what turns "we exported the year" into a
  // claim nobody can check.
  if (tuning.includeManifest) {
    archive.append(
      [
      `Photos for ${jobs.length} job${jobs.length === 1 ? "" : "s"}.`,
      `${result.photos} photos from ${result.jobs} jobs had files; the rest had none.`,
      "",
      notes.length > 0 ? "Problems:" : "No problems.",
      ...notes.map((n) => `  - ${n}`),
    ].join("\n"),
      { name: "README.txt" },
    );
  }

  await archive.finalize();
  await closed;
  return result;
}

// A cancel stops the run between files, which leaves the month it landed in
// half-written and every later month untouched. Both have to be marked, or
// the page shows a partial July as a finished July and the remaining months
// sit at "pending" forever.
function markRemainingCanceled(runId: number): void {
  for (const file of listRunFiles(runId)) {
    if (file.status === "pending" || file.status === "running") {
      updateRunFile(file.id, { status: "failed", jobs: 0, photos: 0, bytes: 0, error: "Canceled" });
    }
  }
}

export async function executeRun(
  runId: number,
  clientId: number,
  filters: RunFilters,
): Promise<void> {
  const config = requireServiceTitanConfig(clientId);
  // Read once at the start: a settings change mid-run would otherwise apply
  // to some months and not others, which is the kind of inconsistency nobody
  // would think to look for later.
  const tuning = getRunTuning(clientId);
  const paced = createPacer(tuning);
  fs.mkdirSync(exportsDir, { recursive: true });
  const ranges = monthsBetween(filters.from, filters.to);

  markRunStarted(runId, "Listing jobs");
  // Cancel wins over start, whichever order they arrive in.
  if (readRunStatus(runId) === "canceled") return;
  const progress = { jobsTotal: 0, jobsDone: 0, photosTotal: 0, bytesTotal: 0 };

  const perMonth: { range: MonthRange; jobs: STJob[]; fileId: number; filePath: string }[] = [];
  for (const range of ranges) {
    const jobs = await listJobsForMonth(config, filters, range, paced);
    const filePath = path.join(exportsDir, `run-${runId}-photos-${range.month}.zip`);
    perMonth.push({ range, jobs, fileId: createRunFile(runId, range.month, filePath), filePath });
    progress.jobsTotal += jobs.length;
    updateRunProgress(runId, { ...progress, step: `Listing jobs (${range.month})` });
  }

  for (const month of perMonth) {
    if (readRunStatus(runId) === "canceled") {
      markRemainingCanceled(runId);
      return;
    }
    if (month.jobs.length === 0) {
      updateRunFile(month.fileId, { status: "empty", jobs: 0, photos: 0, bytes: 0 });
      continue;
    }
    updateRunFile(month.fileId, { status: "running", jobs: 0, photos: 0, bytes: 0 });
    try {
      const result = await buildMonthZip(config, runId, month.jobs, month.filePath, tuning, paced, (delta) => {
        progress.jobsDone += delta.jobsDone;
        progress.photosTotal += delta.photos;
        progress.bytesTotal += delta.bytes;
        updateRunProgress(runId, { ...progress, step: `Downloading photos (${month.range.month})` });
      });
      // Interrupted partway: the zip on disk holds some of the month's
      // photos and none of the rest. Offering it as that month's download
      // would be a claim packet quietly missing half its evidence, so the
      // partial file goes and the row says what happened.
      if (readRunStatus(runId) === "canceled") {
        fs.rmSync(month.filePath, { force: true });
        updateRunFile(month.fileId, {
          status: "failed",
          jobs: 0,
          photos: 0,
          bytes: 0,
          error: "Canceled partway through this month, partial file discarded",
        });
        markRemainingCanceled(runId);
        return;
      }
      // A month whose jobs all turned out to have no photos leaves a zip
      // holding only a README — worth marking as empty rather than offering
      // it as a download that disappoints.
      if (result.photos === 0) {
        fs.rmSync(month.filePath, { force: true });
        updateRunFile(month.fileId, { status: "empty", jobs: 0, photos: 0, bytes: 0 });
      } else {
        updateRunFile(month.fileId, {
          status: "completed",
          jobs: result.jobs,
          photos: result.photos,
          bytes: fs.statSync(month.filePath).size,
        });
      }
    } catch (error) {
      fs.rmSync(month.filePath, { force: true });
      updateRunFile(month.fileId, { status: "failed", jobs: 0, photos: 0, bytes: 0, error: describeError(error) });
    }
  }

  if (readRunStatus(runId) === "canceled") {
    markRemainingCanceled(runId);
    return;
  }
  finishRun(runId, "completed");
}

// Fire-and-forget: the HTTP request that starts a run returns immediately,
// and everything after that is driven by the rows this updates. Any escape
// from executeRun lands the row in "failed" with the reason rather than
// leaving it stuck at "running" forever.
export function startRun(runId: number, clientId: number, filters: RunFilters): void {
  void executeRun(runId, clientId, filters).catch((error) => {
    console.error("batch photo export failed:", describeError(error));
    finishRun(runId, "failed", describeError(error));
  });
}

export function runFileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// Monthly zips are hundreds of megabytes in the same volume as the database.
// Called at startup: anything older than the retention window goes.
export function sweepExpiredArchives(retentionDays = 14): number {
  let removed = 0;
  for (const file of listExpiredRunFiles(retentionDays)) {
    if (fs.existsSync(file.file_path)) {
      fs.rmSync(file.file_path, { force: true });
      removed++;
    }
  }
  return removed;
}

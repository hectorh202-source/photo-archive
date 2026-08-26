import JSZip from "jszip";
import type { ServiceTitanConfig } from "../db/clientSettings";
import { requireServiceTitanConfig, stRequest, describeError, errorStatus } from "./httpClient";
import { fetchAllPages } from "./paginate";
import {
  listJobAttachments,
  downloadJobAttachment,
  classifyAttachment,
  isImageContentType,
  looksLikeImageBytes,
  sniffFileExtension,
  type JobAttachment,
  type AttachmentKind,
} from "./jobAttachments";

// One job, pulled out of ServiceTitan whole: the JPM job record plus every
// sub-resource that hangs off it (notes, history, appointments, assigned
// techs, customer, location, invoices, estimates, equipment, form
// submissions) and — the part that isn't obvious from the JPM docs — the
// job's photos, which live in the Forms module (see jobAttachments.ts).
//
// Nothing here mutates anything in ServiceTitan. Every call is a GET.
//
// Design rule: an export never fails because one sub-resource failed. A
// tenant's integration app may not have every module's scope granted (Forms
// in particular is commonly missing), so each part is fetched inside its own
// try/catch and a failure becomes a warning in the manifest. Only the job
// record itself is load-bearing — no job, no export.

export class JobNotFoundError extends Error {
  constructor(reference: string) {
    super(`No ServiceTitan job found for "${reference}"`);
  }
}

export interface STJob {
  id: number;
  jobNumber?: string;
  customerId?: number;
  locationId?: number;
  jobStatus?: string;
  summary?: string;
  createdOn?: string;
  completedOn?: string | null;
  businessUnitId?: number;
  jobTypeId?: number;
  projectId?: number | null;
  invoiceId?: number | null;
  total?: number;
  [key: string]: unknown;
}

export type JobLookupMode = "id" | "number";

// What an export is for. "photos" exists because the common errand is just
// "send me the pictures off that job" — an adjuster, a customer, a warranty
// claim — and pulling the twelve JSON sub-resources to satisfy it is a dozen
// wasted API calls against a rate-limited tenant. The job lookup itself is
// the only unskippable call: an attachment listing is addressed by job *id*,
// and staff type job *numbers*.
export type JobExportMode = "full" | "photos" | "attachments" | "records";

// Modes that ship files rather than JSON. "photos" narrows those files to
// actual images; "attachments" takes whatever ServiceTitan has stapled to
// the job, PDFs included.
function shipsFilesOnly(mode: JobExportMode): boolean {
  return mode === "photos" || mode === "attachments";
}

// The number staff read off a ServiceTitan screen is the *job number*, which
// is not always the job id the API paths take — so accept either and report
// which one matched. A numeric-looking reference is tried as an id first
// (one cheap direct GET), then as a job number.
export async function resolveJob(
  config: ServiceTitanConfig,
  reference: string,
): Promise<{ job: STJob; matchedBy: JobLookupMode }> {
  const trimmed = reference.trim();
  if (/^\d+$/.test(trimmed)) {
    try {
      const job = await stRequest<STJob>(config, "GET", `/jpm/v2/tenant/${config.tenantId}/jobs/${trimmed}`);
      if (job && typeof job.id === "number") return { job, matchedBy: "id" };
    } catch (error) {
      if (errorStatus(error) !== 404) throw error;
    }
  }
  const byNumber = await fetchAllPages<STJob>(
    config,
    `/jpm/v2/tenant/${config.tenantId}/jobs`,
    { number: trimmed },
    { pageSize: 5, maxPages: 1 },
  );
  if (byNumber.length > 0) return { job: byNumber[0], matchedBy: "number" };
  throw new JobNotFoundError(trimmed);
}

export interface JobExportPart {
  // Zip path this part is written to, and the key it appears under in the
  // manifest — one string so the two can never drift.
  file: string;
  label: string;
  status: "ok" | "empty" | "failed";
  count: number | null;
  error?: string;
  data?: unknown;
}

export interface JobExportAttachmentInfo {
  index: number;
  fileName: string | null;
  originalFileName: string | null;
  createdFrom: string | null;
  createdOn: string | null;
  // Image / other / unknown, decided from the filename — lets the page say
  // which of these a photos-only export will actually bring back before
  // anyone spends the download on it.
  kind?: AttachmentKind;
  // Set once the binary has actually been fetched (download path only, not
  // preview): the name it landed under in the zip, and its size.
  zipPath?: string;
  bytes?: number;
  contentType?: string;
  error?: string;
}

export interface JobBundle {
  job: STJob;
  matchedBy: JobLookupMode;
  parts: JobExportPart[];
  attachments: JobAttachment[];
  attachmentsRaw: unknown[];
  attachmentsError: string | null;
  warnings: string[];
}

interface PartSpec {
  file: string;
  label: string;
  load: () => Promise<unknown>;
}

async function loadPart(parts: JobExportPart[], warnings: string[], spec: PartSpec): Promise<void> {
  try {
    const data = await spec.load();
    const isEmpty = data == null || (Array.isArray(data) && data.length === 0);
    parts.push({
      file: spec.file,
      label: spec.label,
      status: isEmpty ? "empty" : "ok",
      count: Array.isArray(data) ? data.length : null,
      data,
    });
  } catch (error) {
    const message = describeError(error);
    const status = errorStatus(error);
    parts.push({ file: spec.file, label: spec.label, status: "failed", count: null, error: message });
    warnings.push(
      status === 401 || status === 403
        ? `${spec.label}: ServiceTitan refused the request (${status}) — this tenant's integration app is probably missing that module's API scope.`
        : status === 404
          ? `${spec.label}: ServiceTitan returned 404 for the whole collection — that module is probably not enabled for this tenant (confirmed against the integration tenant, whose Sales Tech estimates endpoint 404s outright).`
          : `${spec.label}: ${message}`,
    );
  }
}

// The submissions endpoint documents ownerType/owners filters, and they are
// the right ones per ServiceTitan's OpenAPI document — but a real run against
// the integration tenant (2026-08-19) came back with 5,000 submissions for a
// job that has a handful: exactly page-cap x page-size, i.e. the filter was
// ignored and the whole tenant was being paged. So the filter is still sent
// (free if honored), the page budget is kept small, and every row is checked
// client-side against this job's own owner entry — the only thing that
// actually guarantees the export holds this job's forms and nothing else.
const FORM_SUBMISSION_PAGE_SIZE = 200;
const FORM_SUBMISSION_MAX_PAGES = 5;

interface FormSubmissionRow {
  owners?: { type?: string; id?: number }[] | null;
}

async function fetchJobFormSubmissions(
  config: ServiceTitanConfig,
  jobId: string,
  warnings: string[],
): Promise<FormSubmissionRow[]> {
  const rows = await fetchAllPages<FormSubmissionRow>(
    config,
    `/forms/v2/tenant/${config.tenantId}/submissions`,
    { ownerType: "Job", owners: jobId },
    { pageSize: FORM_SUBMISSION_PAGE_SIZE, maxPages: FORM_SUBMISSION_MAX_PAGES },
  );
  const mine = rows.filter((row) => (row.owners ?? []).some((owner) => owner?.type === "Job" && String(owner.id) === jobId));
  if (mine.length === rows.length) return mine;

  const truncated = rows.length >= FORM_SUBMISSION_PAGE_SIZE * FORM_SUBMISSION_MAX_PAGES;
  warnings.push(
    `Form submissions: ServiceTitan ignored the job filter and returned ${rows.length} submissions from across the tenant; ${mine.length} belong to this job and only those were exported.` +
      (truncated ? " More exist beyond the pages checked, so a form on this job could be missing." : ""),
  );
  return mine;
}

// Collects everything *except* the attachment binaries. Shared by the
// preview (which stops here) and the zip build (which then downloads the
// files), so what the preview promises is exactly what the zip delivers.
export async function collectJobBundle(
  clientId: number,
  reference: string,
  mode: JobExportMode = "full",
): Promise<JobBundle> {
  const config = requireServiceTitanConfig(clientId);
  const { job, matchedBy } = await resolveJob(config, reference);
  const jobId = String(job.id);
  const tenant = config.tenantId;
  const parts: JobExportPart[] = [];
  const warnings: string[] = [];

  // Photos mode skips the bulk sub-resources but still resolves the customer
  // and location below: two cheap GETs that are what actually let someone
  // confirm they are about to send the right job's pictures to an adjuster.
  // They are fetched, shown in the preview, and left out of a photos zip.
  const specs: PartSpec[] = shipsFilesOnly(mode) ? [] : [
    {
      file: "data/notes.json",
      label: "Job notes",
      load: () => fetchAllPages(config, `/jpm/v2/tenant/${tenant}/jobs/${jobId}/notes`),
    },
    {
      file: "data/history.json",
      label: "Job history",
      load: () => stRequest(config, "GET", `/jpm/v2/tenant/${tenant}/jobs/${jobId}/history`),
    },
    {
      file: "data/appointments.json",
      label: "Appointments",
      load: () => fetchAllPages(config, `/jpm/v2/tenant/${tenant}/appointments`, { jobId }),
    },
    {
      file: "data/appointment-assignments.json",
      label: "Technician assignments",
      load: () => fetchAllPages(config, `/dispatch/v2/tenant/${tenant}/appointment-assignments`, { jobId }),
    },
    {
      file: "data/equipment.json",
      label: "Job equipment",
      load: () => fetchAllPages(config, `/jpm/v2/tenant/${tenant}/jobs/${jobId}/equipment`),
    },
    {
      file: "data/invoices.json",
      label: "Invoices",
      load: () => fetchAllPages(config, `/accounting/v2/tenant/${tenant}/invoices`, { jobId }),
    },
    {
      file: "data/estimates.json",
      label: "Estimates",
      load: () => fetchAllPages(config, `/salestech/v2/tenant/${tenant}/estimates`, { jobId }),
    },
    {
      file: "data/form-submissions.json",
      label: "Form submissions",
      load: () => fetchJobFormSubmissions(config, jobId, warnings),
    },
  ];

  if (job.customerId) {
    specs.push(
      {
        file: "data/customer.json",
        label: "Customer",
        load: () => stRequest(config, "GET", `/crm/v2/tenant/${tenant}/customers/${job.customerId}`),
      },
      ...(shipsFilesOnly(mode)
        ? []
        : [
            {
              file: "data/customer-contacts.json",
              label: "Customer contacts",
              load: () => fetchAllPages(config, `/crm/v2/tenant/${tenant}/customers/${job.customerId}/contacts`),
            },
          ]),
    );
  }
  if (job.locationId) {
    specs.push(
      {
        file: "data/location.json",
        label: "Location",
        load: () => stRequest(config, "GET", `/crm/v2/tenant/${tenant}/locations/${job.locationId}`),
      },
      ...(shipsFilesOnly(mode)
        ? []
        : [
            {
              file: "data/location-contacts.json",
              label: "Location contacts",
              load: () => fetchAllPages(config, `/crm/v2/tenant/${tenant}/locations/${job.locationId}/contacts`),
            },
          ]),
    );
  }

  // Sequential rather than Promise.all: ServiceTitan rate-limits per app,
  // and a dozen simultaneous requests per export would make a handful of
  // concurrent exports look like a burst worth throttling. An export is an
  // interactive one-off, not a sync job — a couple of seconds is fine.
  for (const spec of specs) {
    await loadPart(parts, warnings, spec);
  }

  let attachments: JobAttachment[] = [];
  let attachmentsRaw: unknown[] = [];
  let attachmentsError: string | null = null;
  if (mode === "records") {
    return { job, matchedBy, parts, attachments, attachmentsRaw, attachmentsError, warnings };
  }
  try {
    const listing = await listJobAttachments(config, jobId);
    attachments = listing.attachments;
    attachmentsRaw = listing.raw;
  } catch (error) {
    attachmentsError = describeError(error);
    const status = errorStatus(error);
    warnings.push(
      status === 401 || status === 403
        ? `Photos and attachments: ServiceTitan refused the request (${status}) — the Forms module scope is probably not granted to this tenant's integration app, so photos can't be exported until it is.`
        : `Photos and attachments: ${attachmentsError}`,
    );
  }

  return { job, matchedBy, parts, attachments, attachmentsRaw, attachmentsError, warnings };
}

export interface JobExportPreview {
  jobId: number;
  jobNumber: string | null;
  matchedBy: JobLookupMode;
  jobStatus: string | null;
  summary: string | null;
  createdOn: string | null;
  completedOn: string | null;
  customerName: string | null;
  locationName: string | null;
  locationAddress: string | null;
  parts: { file: string; label: string; status: JobExportPart["status"]; count: number | null; error?: string }[];
  attachments: JobExportAttachmentInfo[];
  attachmentsError: string | null;
  warnings: string[];
}

function partData(bundle: JobBundle, file: string): Record<string, unknown> | null {
  const data = bundle.parts.find((p) => p.file === file)?.data;
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function formatAddress(address: unknown): string | null {
  if (typeof address !== "object" || address === null) return null;
  const a = address as Record<string, unknown>;
  const line = [a.street, a.unit, a.city, a.state, a.zip].map(text).filter(Boolean).join(", ");
  return line === "" ? null : line;
}

export async function buildJobExportPreview(
  clientId: number,
  reference: string,
  mode: JobExportMode = "full",
): Promise<JobExportPreview> {
  const bundle = await collectJobBundle(clientId, reference, mode);
  const customer = partData(bundle, "data/customer.json");
  const location = partData(bundle, "data/location.json");
  return {
    jobId: bundle.job.id,
    jobNumber: text(bundle.job.jobNumber),
    matchedBy: bundle.matchedBy,
    jobStatus: text(bundle.job.jobStatus),
    summary: text(bundle.job.summary),
    createdOn: text(bundle.job.createdOn),
    completedOn: text(bundle.job.completedOn),
    customerName: customer ? text(customer.name) : null,
    locationName: location ? text(location.name) : null,
    locationAddress: location ? formatAddress(location.address) : null,
    parts: bundle.parts.map(({ file, label, status, count, error }) => ({ file, label, status, count, error })),
    attachments: bundle.attachments.map((a, index) => ({
      index,
      fileName: a.fileName,
      originalFileName: a.originalFileName,
      createdFrom: a.createdFrom,
      createdOn: a.createdOn,
      kind: classifyAttachment(a),
    })),
    attachmentsError: bundle.attachmentsError,
    warnings: bundle.warnings,
  };
}

// Guards on a single export. A job with hundreds of photos is real (long
// remodels, warranty documentation); a job with thousands is a data problem.
// Either way the zip is built in memory and sent once, so it needs a ceiling
// it can state plainly in the manifest rather than an out-of-memory crash.
const MAX_ATTACHMENTS = 300;
const MAX_TOTAL_ATTACHMENT_BYTES = 250 * 1024 * 1024;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/tiff": ".tif",
  "application/pdf": ".pdf",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "text/plain": ".txt",
};

const RESERVED_FILENAME_CHARS = '\\/:*?"<>|';

function sanitizeFileName(name: string): string {
  // An originalFileName is whatever a technician's phone called the photo,
  // so it can hold anything — control characters and the path characters
  // Windows/macOS reject both have to go before this lands in a zip entry.
  const cleaned = Array.from(name)
    .map((ch) => (ch.charCodeAt(0) < 0x20 || RESERVED_FILENAME_CHARS.includes(ch) ? "_" : ch))
    .join("");
  return cleaned.replace(/\s+/g, " ").trim().slice(0, 120);
}

// A photo leaves here and lands in an adjuster's inbox, a customer's email,
// a claim folder — where "Attaches_1c39b4ae-60bb-4ac5-a122-d2035462a076_cdv_
// photo_001-jqg6jci0bd8.jpg" identifies nothing. Naming them for the customer
// and the job's date makes a folder of them sortable and recognizable by
// whoever receives it, with no renaming by hand.
//
// Documents keep their ServiceTitan names: "Invoice_89496_signed" already
// says what it is, and renaming it to "Dana Whitfield - 2026-08-19 - 002.pdf"
// would throw that away. manifest.json keeps the original name for every file
// either way, so nothing is lost.
export interface AttachmentNaming {
  customerLabel: string | null;
  dateLabel: string | null;
}

function jobDateLabel(job: STJob): string | null {
  const raw = text(job.completedOn) ?? text(job.createdOn);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  // YYYY-MM-DD: sorts correctly in a file listing, unambiguous everywhere.
  return date.toISOString().slice(0, 10);
}

function attachmentZipName(
  position: number,
  attachment: JobAttachment,
  file: { contentType: string; suggestedFileName: string | null; data: Buffer },
  mode: JobExportMode,
  options: { isImage: boolean; naming: AttachmentNaming },
): string {
  const original = attachment.originalFileName ?? file.suggestedFileName ?? attachment.fileName ?? `attachment-${position}`;
  const readableParts = [options.naming.customerLabel, options.naming.dateLabel].filter(Boolean);
  // A renamed photo carries its number at the end ("... - 003.jpg") and must
  // not also get one at the front. Tracked as a flag rather than sniffed back
  // out of the string: a ServiceTitan document name ending in a random id
  // like "...A6k957.pdf" reads as "already numbered" to any regex, and then
  // silently loses its prefix.
  const renamed = options.isImage && readableParts.length > 0;
  const base = renamed
    ? `${readableParts.join(" - ")} - ${String(position).padStart(3, "0")}`
    : original;
  let name = sanitizeFileName(base);
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    // Content-Type first, then the bytes. ServiceTitan sends
    // application/octet-stream for everything, so in practice it is the
    // bytes that end up naming the file.
    name += EXTENSION_BY_CONTENT_TYPE[file.contentType.toLowerCase()] ?? sniffFileExtension(file.data) ?? "";
  }
  // Numeric prefix keeps zip order stable and makes duplicate original
  // filenames (very common — three techs each uploading "IMG_0001.jpg")
  // collision-free without renaming them into something unrecognizable.
  const folder = shipsFilesOnly(mode) ? "" : "attachments/";
  const numbered = renamed ? name : `${String(position).padStart(3, "0")} - ${name}`;
  return `${folder}${numbered}`;
}

export interface JobExportResult {
  fileName: string;
  data: Buffer;
  jobId: number;
  jobNumber: string | null;
  attachmentCount: number;
  attachmentBytes: number;
  warnings: string[];
}

export async function buildJobExportZip(
  clientId: number,
  reference: string,
  options: { mode?: JobExportMode; requestedBy?: string } = {},
): Promise<JobExportResult> {
  const mode = options.mode ?? "full";
  const includeAttachments = mode !== "records";
  const config = requireServiceTitanConfig(clientId);
  const bundle = await collectJobBundle(clientId, reference, mode);
  const warnings = [...bundle.warnings];
  const zip = new JSZip();

  // A photos-only zip is photos, plus the manifest — which stays in every
  // mode because it is the only place a failed or skipped file is recorded.
  // Dropping it to make the zip "just pictures" would mean a photo silently
  // missing from a claim packet with nothing anywhere saying so.
  if (!shipsFilesOnly(mode)) {
    zip.file("job.json", JSON.stringify(bundle.job, null, 2));
    for (const part of bundle.parts) {
      if (part.status === "failed") continue;
      zip.file(part.file, JSON.stringify(part.data ?? null, null, 2));
    }
    if (bundle.attachmentsRaw.length > 0) {
      zip.file("data/attachments-index.json", JSON.stringify(bundle.attachmentsRaw, null, 2));
    }
  }

  const customerRecord = partData(bundle, "data/customer.json");
  const naming: AttachmentNaming = {
    customerLabel: customerRecord ? text(customerRecord.name) : null,
    dateLabel: jobDateLabel(bundle.job),
  };

  const attachmentInfos: JobExportAttachmentInfo[] = [];
  let attachmentBytes = 0;
  let skippedNonImages = 0;
  let includedCount = 0;

  if (includeAttachments) {
    let capped = false;
    for (const [index, attachment] of bundle.attachments.entries()) {
      const info: JobExportAttachmentInfo = {
        index,
        fileName: attachment.fileName,
        originalFileName: attachment.originalFileName,
        createdFrom: attachment.createdFrom,
        createdOn: attachment.createdOn,
      };
      const kind = classifyAttachment(attachment);
      if (mode === "photos" && kind === "other") {
        info.error = "Skipped, not an image";
        attachmentInfos.push(info);
        skippedNonImages++;
        continue;
      }
      if (index >= MAX_ATTACHMENTS || attachmentBytes >= MAX_TOTAL_ATTACHMENT_BYTES) {
        info.error = "Skipped, export size limit reached";
        attachmentInfos.push(info);
        capped = true;
        continue;
      }
      try {
        const file = await downloadJobAttachment(config, attachment);
        // Only rows with no usable extension reach a byte-level decision —
        // a name ending in .jpg is trusted, because the Content-Type never
        // disagrees usefully (it is always application/octet-stream) and
        // second-guessing it is what emptied a real photos export.
        const isImage =
          kind === "image" || (kind === "unknown" && (isImageContentType(file.contentType) || looksLikeImageBytes(file.data)));
        if (mode === "photos" && !isImage) {
          info.error = "Skipped, not an image";
          attachmentInfos.push(info);
          skippedNonImages++;
          continue;
        }
        const zipPath = attachmentZipName(includedCount + 1, attachment, file, mode, { isImage, naming });
        // STORE, not DEFLATE: these are already-compressed JPEG/PNG/PDF
        // bytes, so deflating them burns CPU on every export to save
        // roughly nothing. The JSON above stays deflated (jszip's default).
        zip.file(zipPath, file.data, { compression: "STORE" });
        info.zipPath = zipPath;
        info.bytes = file.data.length;
        info.contentType = file.contentType;
        attachmentBytes += file.data.length;
        includedCount++;
      } catch (error) {
        info.error = describeError(error);
        warnings.push(
          `Attachment ${index + 1} (${attachment.originalFileName ?? attachment.fileName ?? "unnamed"}): ${info.error}`,
        );
      }
      attachmentInfos.push(info);
    }
    if (capped) {
      warnings.push(
        `Only the first ${MAX_ATTACHMENTS} attachments (up to ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024))} MB) were included. The rest are listed in manifest.json but were not downloaded.`,
      );
    }
  } else if (bundle.attachments.length > 0) {
    warnings.push(`Attachments were excluded from this export. ${bundle.attachments.length} are available.`);
  }

  if (skippedNonImages > 0) {
    warnings.push(
      `${skippedNonImages} non-image attachment${skippedNonImages === 1 ? "" : "s"} (PDFs, documents) were left out of this photos-only export. Choose "All attachments" to include them.`,
    );
  }
  if (shipsFilesOnly(mode) && attachmentInfos.every((a) => !a.zipPath) && !bundle.attachmentsError) {
    warnings.push(
      mode === "photos"
        ? "This job has no image attachments in ServiceTitan, so the zip holds only this manifest."
        : "This job has no attachments in ServiceTitan, so the zip holds only this manifest.",
    );
  }

  const jobNumber = text(bundle.job.jobNumber);
  const exportedAt = new Date().toISOString();
  const manifest = {
    exportedAt,
    mode,
    exportedBy: options.requestedBy ?? null,
    tenantId: config.tenantId,
    environment: config.environment,
    job: {
      id: bundle.job.id,
      number: jobNumber,
      status: text(bundle.job.jobStatus),
      matchedBy: bundle.matchedBy,
      customerId: bundle.job.customerId ?? null,
      locationId: bundle.job.locationId ?? null,
    },
    parts: bundle.parts.map(({ file, label, status, count, error }) => ({ file, label, status, count, error })),
    attachments: {
      listed: bundle.attachments.length,
      skippedNonImages,
      included: attachmentInfos.filter((a) => a.zipPath).length,
      totalBytes: attachmentBytes,
      listError: bundle.attachmentsError,
      files: attachmentInfos,
    },
    warnings,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  if (!shipsFilesOnly(mode)) {
    zip.file("README.txt", buildReadme(bundle.job.id, jobNumber, exportedAt, warnings));
  }

  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const base = jobNumber ? `job-${sanitizeFileName(jobNumber)}` : `job-${bundle.job.id}`;
  const stem =
    mode === "photos"
      ? `${base}-photos`
      : mode === "attachments"
        ? `${base}-attachments`
        : mode === "records"
          ? `${base}-records`
          : base;
  return {
    fileName: `${stem}.zip`,
    data,
    jobId: bundle.job.id,
    jobNumber,
    attachmentCount: attachmentInfos.filter((a) => a.zipPath).length,
    attachmentBytes,
    warnings,
  };
}

function buildReadme(jobId: number, jobNumber: string | null, exportedAt: string, warnings: string[]): string {
  const lines = [
    "ServiceTitan job export",
    `Job ${jobNumber ? `#${jobNumber} (id ${jobId})` : `id ${jobId}`}`,
    `Exported ${exportedAt}`,
    "",
    "job.json              The job record itself (JPM v2).",
    "data/*.json           Everything hanging off it: notes, history, appointments,",
    "                      technician assignments, equipment, invoices, estimates,",
    "                      form submissions, and the customer/location records.",
    "attachments/          The job's photos and files, in the order ServiceTitan",
    "                      listed them. Names come from the original upload where",
    "                      ServiceTitan still has it.",
    "data/attachments-index.json",
    "                      The raw attachment listing as ServiceTitan returned it.",
    "manifest.json         What was pulled, what came back empty, what failed.",
    "",
    "This is a read-only copy. Editing anything in here changes nothing in",
    "ServiceTitan.",
  ];
  if (warnings.length > 0) {
    lines.push("", "Warnings:", ...warnings.map((w) => `  - ${w}`));
  }
  return lines.join("\n");
}

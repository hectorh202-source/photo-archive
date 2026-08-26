import type { ServiceTitanConfig } from "../db/clientSettings";
import { stRequest, stRequestFile, errorStatus, describeError, type ServiceTitanFile } from "./httpClient";
import type { PaginatedResponse } from "./paginate";

// Job photos/attachments live in ServiceTitan's *Forms* module, not JPM —
// GET /forms/v2/tenant/{t}/jobs/{jobId}/attachments lists them and
// GET /forms/v2/tenant/{t}/jobs/attachment/{id} downloads one. That means a
// tenant whose integration app was only granted CRM/JPM/Dispatch scopes gets
// a 401/403 here while every other part of an export succeeds — callers
// should treat an attachment failure as a warning, not a failed export
// (see jobExport.ts).
const MAX_ATTACHMENT_PAGES = 10;
const ATTACHMENT_PAGE_SIZE = 200;

export interface JobAttachment {
  fileName: string | null;
  originalFileName: string | null;
  createdFrom: string | null;
  createdOn: string | null;
  thumbnail: string | null;
  // Ordered candidates to try as {id} in the download URL. The list
  // endpoint's 200 response has NO schema in ServiceTitan's own OpenAPI
  // document (literally just "The request has succeeded"), and the download
  // endpoint only says its id is "as returned by other job API endpoints" —
  // so rather than betting on one field name, we collect every plausible one
  // and let downloadJobAttachment try them in order. The documented
  // Forms.Client.Contracts.FormAttachment schema has no `id` at all, only
  // fileName/originalFileName/thumbnail/createdFrom, which is why fileName
  // is the strongest candidate despite `id` being tried first.
  downloadKeys: string[];
  raw: Record<string, unknown>;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function toAttachment(raw: Record<string, unknown>): JobAttachment {
  const fileName = str(raw.fileName) ?? str(raw.name);
  const keys: string[] = [];
  for (const candidate of [str(raw.id), str(raw.attachmentId), fileName, str(raw.originalFileName)]) {
    if (candidate && !keys.includes(candidate)) keys.push(candidate);
  }
  return {
    fileName,
    originalFileName: str(raw.originalFileName),
    createdFrom: str(raw.createdFrom),
    createdOn: str(raw.createdOn) ?? str(raw.createdOnUtc),
    thumbnail: str(raw.thumbnail),
    downloadKeys: keys,
    raw,
  };
}

export interface JobAttachmentListing {
  attachments: JobAttachment[];
  // The untouched response rows, written into the export zip verbatim — the
  // schema being undocumented means whatever a real tenant returns here is
  // worth keeping alongside the parsed view.
  raw: unknown[];
}

export async function listJobAttachments(config: ServiceTitanConfig, jobId: string): Promise<JobAttachmentListing> {
  const path = `/forms/v2/tenant/${config.tenantId}/jobs/${jobId}/attachments`;
  const raw: unknown[] = [];
  for (let page = 1; page <= MAX_ATTACHMENT_PAGES; page++) {
    const result = await stRequest<PaginatedResponse<unknown> | unknown[]>(config, "GET", path, {
      params: { page, pageSize: ATTACHMENT_PAGE_SIZE },
    });
    if (Array.isArray(result)) {
      raw.push(...result);
      break;
    }
    raw.push(...(result.data ?? []));
    if (!result.hasMore) break;
  }
  const attachments = raw
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map(toAttachment);
  return { attachments, raw };
}

// ServiceTitan's job "attachments" are everything stapled to the job, not
// just pictures: a real production export (2026-08-20) came back with four
// technician JPEGs alongside three generated PDFs — CapturedDocs_Invoice,
// CapturedDocs_Estimate_signed. Someone asking for a job's photos to send an
// adjuster does not mean the signed estimate, so photo mode classifies each
// row before spending a download on it.
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".bmp",
]);

export type AttachmentKind = "image" | "other" | "unknown";

// "unknown" is a row whose name carries no extension — seen in the wild, and
// not worth excluding a real photo over. Those get downloaded and judged by
// their Content-Type instead (see isImageContentType).
export function classifyAttachment(attachment: JobAttachment): AttachmentKind {
  const name = attachment.originalFileName ?? attachment.fileName;
  if (!name) return "unknown";
  const dot = name.lastIndexOf(".");
  if (dot === -1 || dot === name.length - 1) return "unknown";
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase()) ? "image" : "other";
}

export function isImageContentType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("image/");
}

// ServiceTitan serves every attachment as application/octet-stream, JPEGs
// included (confirmed on a real production export, 2026-08-20), so the
// response header cannot classify anything on its own. For a row whose name
// carries no extension either, the bytes themselves are the last word.
// The extension a file's own bytes imply, for the rows that arrive with
// neither a usable name nor a usable Content-Type. Without this such a photo
// lands in the zip extensionless and will not open on a double-click.
export function sniffFileExtension(data: Buffer): string | null {
  if (data.length < 12) return null;
  const hex = data.subarray(0, 4).toString("hex").toLowerCase();
  if (hex.startsWith("ffd8ff")) return ".jpg";
  if (hex === "89504e47") return ".png";
  if (hex.startsWith("47494638")) return ".gif";
  if (hex === "49492a00" || hex === "4d4d002a") return ".tif";
  if (hex.startsWith("424d")) return ".bmp";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (data.subarray(0, 5).toString("ascii") === "%PDF-") return ".pdf";
  if (data.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = data.subarray(8, 12).toString("ascii").toLowerCase();
    if (brand.startsWith("hei") || brand.startsWith("mif")) return ".heic";
    if (brand.startsWith("avi")) return ".avif";
    return ".mp4";
  }
  return null;
}

export function looksLikeImageBytes(data: Buffer): boolean {
  if (data.length < 12) return false;
  const hex = data.subarray(0, 4).toString("hex").toLowerCase();
  if (hex.startsWith("ffd8ff")) return true; // JPEG
  if (hex === "89504e47") return true; // PNG
  if (hex.startsWith("47494638")) return true; // GIF
  if (hex === "49492a00" || hex === "4d4d002a") return true; // TIFF
  if (hex.startsWith("424d")) return true; // BMP
  const riff = data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  if (riff) return true;
  // HEIC/HEIF and other ISO-BMFF images: "ftyp" at offset 4, brand after it.
  if (data.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = data.subarray(8, 12).toString("ascii").toLowerCase();
    return brand.startsWith("hei") || brand.startsWith("mif") || brand.startsWith("avi");
  }
  return false;
}

export class AttachmentDownloadError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function downloadJobAttachment(
  config: ServiceTitanConfig,
  attachment: JobAttachment,
): Promise<ServiceTitanFile> {
  if (attachment.downloadKeys.length === 0) {
    throw new AttachmentDownloadError("Attachment row had no id or fileName to download by");
  }
  let lastError = "";
  for (const key of attachment.downloadKeys) {
    try {
      return await stRequestFile(config, `/forms/v2/tenant/${config.tenantId}/jobs/attachment/${encodeURIComponent(key)}`);
    } catch (error) {
      const status = errorStatus(error);
      lastError = describeError(error);
      // 404/400 means "wrong id format", so try the next candidate. Anything
      // else (401/403 scope, 429 rate limit, 5xx) will fail identically for
      // every candidate — stop and report it rather than hammering the API.
      if (status !== 404 && status !== 400) break;
    }
  }
  throw new AttachmentDownloadError(lastError || "Download failed");
}

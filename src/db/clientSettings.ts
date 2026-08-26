import { db } from "./index";
import { encryptField as encrypt, decryptField as decrypt } from "../lib/encryption";

// Every per-client setting, encrypted at rest. One key-value table rather
// than a wide row, because this list grows every time a delivery target or a
// tuning knob is added — and because most of these values are credentials
// that should never sit in plaintext next to a client's name.

const getStmt = db.prepare(`SELECT value FROM client_settings WHERE client_id = ? AND key = ?`);
const setStmt = db.prepare(`
  INSERT INTO client_settings (client_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(client_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare(`DELETE FROM client_settings WHERE client_id = ? AND key = ?`);
const listStmt = db.prepare(`SELECT key, value FROM client_settings WHERE client_id = ?`);

export function getClientSetting(clientId: number, key: string): string | null {
  const row = getStmt.get(clientId, key) as { value: string } | undefined;
  return row ? decrypt(row.value) : null;
}

export function setClientSetting(clientId: number, key: string, value: string): void {
  setStmt.run(clientId, key, encrypt(value));
}

// Blank means "leave what's there" for secret fields, which are rendered as
// empty boxes rather than round-tripping the real value to the browser.
export function maybeSetClientSetting(clientId: number, key: string, value: string | undefined): void {
  if (typeof value === "string" && value.trim() !== "") setClientSetting(clientId, key, value.trim());
}

export function deleteClientSetting(clientId: number, key: string): void {
  deleteStmt.run(clientId, key);
}

export function getAllClientSettings(clientId: number): Record<string, string> {
  const rows = listStmt.all(clientId) as unknown as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = decrypt(row.value);
  return out;
}

// --- app-wide settings -----------------------------------------------------

const getAppStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const setAppStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

export function getSetting(key: string): string | null {
  const row = getAppStmt.get(key) as { value: string } | undefined;
  return row ? decrypt(row.value) : null;
}

export function setSetting(key: string, value: string): void {
  setAppStmt.run(key, encrypt(value));
}

export function maybeSetSetting(key: string, value: string | undefined): void {
  if (typeof value === "string" && value.trim() !== "") setSetting(key, value.trim());
}

// --- ServiceTitan ----------------------------------------------------------

export type ServiceTitanEnvironment = "integration" | "production";

const ST_BASE_URLS: Record<ServiceTitanEnvironment, { auth: string; api: string }> = {
  integration: {
    auth: "https://auth-integration.servicetitan.io",
    api: "https://api-integration.servicetitan.io",
  },
  production: {
    auth: "https://auth.servicetitan.io",
    api: "https://api.servicetitan.io",
  },
};

export interface ServiceTitanConfig {
  environment: ServiceTitanEnvironment;
  authBaseUrl: string;
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  appKey: string;
  tenantId: string;
}

// Null unless all four credentials are present — a half-configured client
// should fail at the settings page, not three hours into a run.
export function getServiceTitanConfig(clientId: number): ServiceTitanConfig | null {
  const environment = (getClientSetting(clientId, "st.environment") as ServiceTitanEnvironment | null) ?? "production";
  const stClientId = getClientSetting(clientId, "st.clientId");
  const clientSecret = getClientSetting(clientId, "st.clientSecret");
  const appKey = getClientSetting(clientId, "st.appKey");
  const tenantId = getClientSetting(clientId, "st.tenantId");
  if (!stClientId || !clientSecret || !appKey || !tenantId) return null;

  const urls = ST_BASE_URLS[environment];
  return {
    environment,
    authBaseUrl: urls.auth,
    apiBaseUrl: urls.api,
    clientId: stClientId,
    clientSecret,
    appKey,
    tenantId,
  };
}

// --- run tuning ------------------------------------------------------------

export interface RunTuning {
  // Requests per second against the client's tenant. The default is
  // deliberately gentle: while a contractor is still running their business
  // on ServiceTitan, a dispatcher waiting on a customer lookup matters more
  // than an archive finishing sooner.
  requestsPerSecond: number;
  maxRetries: number;
  maxFileMb: number;
  maxRunGb: number;
  // "photos" | "attachments" — whether generated PDFs (invoices, signed
  // estimates) ride along with the images.
  contents: "photos" | "attachments";
  // Tokens: {customer} {date} {jobNumber} {n}
  photoNameTemplate: string;
  jobFolderTemplate: string;
  includeManifest: boolean;
}

export const DEFAULT_TUNING: RunTuning = {
  requestsPerSecond: 5,
  maxRetries: 4,
  maxFileMb: 60,
  maxRunGb: 250,
  contents: "photos",
  photoNameTemplate: "{customer} - {date} - {n}",
  jobFolderTemplate: "{jobNumber} - {customer} - {date}",
  includeManifest: true,
};

function num(value: string | null, fallback: number): number {
  const parsed = value === null ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRunTuning(clientId: number): RunTuning {
  return {
    requestsPerSecond: num(getClientSetting(clientId, "run.requestsPerSecond"), DEFAULT_TUNING.requestsPerSecond),
    maxRetries: num(getClientSetting(clientId, "run.maxRetries"), DEFAULT_TUNING.maxRetries),
    maxFileMb: num(getClientSetting(clientId, "run.maxFileMb"), DEFAULT_TUNING.maxFileMb),
    maxRunGb: num(getClientSetting(clientId, "run.maxRunGb"), DEFAULT_TUNING.maxRunGb),
    contents: getClientSetting(clientId, "run.contents") === "attachments" ? "attachments" : "photos",
    photoNameTemplate: getClientSetting(clientId, "run.photoNameTemplate") ?? DEFAULT_TUNING.photoNameTemplate,
    jobFolderTemplate: getClientSetting(clientId, "run.jobFolderTemplate") ?? DEFAULT_TUNING.jobFolderTemplate,
    includeManifest: (getClientSetting(clientId, "run.includeManifest") ?? "1") !== "0",
  };
}

// --- delivery --------------------------------------------------------------

// Where a finished archive ends up. "download" is the only target wired up
// today: the archive is built on this server and handed over by hand. The
// cloud targets are declared here because their credentials are per-client
// and belong in the same encrypted store — when one is implemented, the
// settings it needs already have a home.
export type DeliveryTarget = "download" | "googleDrive" | "dropbox" | "sharepoint" | "s3";

export interface DeliveryConfig {
  target: DeliveryTarget;
  googleDriveFolderId: string | null;
  googleDriveRefreshToken: string | null;
  dropboxPath: string | null;
  dropboxRefreshToken: string | null;
  sharepointDriveId: string | null;
  sharepointFolderPath: string | null;
  s3Bucket: string | null;
  s3Region: string | null;
  s3Endpoint: string | null;
  s3AccessKeyId: string | null;
  s3SecretAccessKey: string | null;
}

export function getDeliveryConfig(clientId: number): DeliveryConfig {
  const target = (getClientSetting(clientId, "delivery.target") ?? "download") as DeliveryTarget;
  return {
    target,
    googleDriveFolderId: getClientSetting(clientId, "delivery.googleDrive.folderId"),
    googleDriveRefreshToken: getClientSetting(clientId, "delivery.googleDrive.refreshToken"),
    dropboxPath: getClientSetting(clientId, "delivery.dropbox.path"),
    dropboxRefreshToken: getClientSetting(clientId, "delivery.dropbox.refreshToken"),
    sharepointDriveId: getClientSetting(clientId, "delivery.sharepoint.driveId"),
    sharepointFolderPath: getClientSetting(clientId, "delivery.sharepoint.folderPath"),
    s3Bucket: getClientSetting(clientId, "delivery.s3.bucket"),
    s3Region: getClientSetting(clientId, "delivery.s3.region"),
    s3Endpoint: getClientSetting(clientId, "delivery.s3.endpoint"),
    s3AccessKeyId: getClientSetting(clientId, "delivery.s3.accessKeyId"),
    s3SecretAccessKey: getClientSetting(clientId, "delivery.s3.secretAccessKey"),
  };
}

// Secrets are never sent to the browser. The settings page shows whether one
// is set and lets it be replaced, which is all an operator needs and all a
// stolen session should ever get.
export const SECRET_KEYS = new Set([
  "st.clientSecret",
  "delivery.googleDrive.refreshToken",
  "delivery.dropbox.refreshToken",
  "delivery.s3.secretAccessKey",
  "notify.smtpPassword",
]);

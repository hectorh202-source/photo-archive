// Same-origin fetch with the session cookie; a 401 anywhere but the auth
// endpoints means the session died, so bounce to the login page rather than
// letting every component invent its own handling.
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
  });

  if (res.status === 401 && !path.startsWith("/api/auth")) {
    window.location.href = "/app/login";
    return new Promise<T>(() => {});
  }

  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // not JSON — keep the generic message
    }
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export interface SessionUser { id: number; email: string; displayName: string | null; isAdmin: boolean }

export interface Client {
  id: number;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  cutoverDate: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: string;
  serviceTitanConfigured: boolean;
  activeRunId?: number | null;
  tuning?: RunTuning;
}

export interface RunTuning {
  requestsPerSecond: number;
  maxRetries: number;
  maxFileMb: number;
  maxRunGb: number;
  contents: "photos" | "attachments";
  photoNameTemplate: string;
  jobFolderTemplate: string;
  includeManifest: boolean;
}

export interface RunFilters {
  from: string;
  to: string;
  dateField: "completed" | "created";
  jobStatus?: string;
  businessUnitId?: string;
  jobTypeId?: string;
}

export interface RunFile {
  id: number;
  month: string;
  status: "pending" | "running" | "completed" | "failed" | "empty" | "deleted";
  jobs: number;
  photos: number;
  bytes: number;
  error: string | null;
  available: boolean;
}

export interface Run {
  id: number;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  filters: RunFilters;
  requestedByEmail: string;
  jobsTotal: number;
  jobsDone: number;
  photosTotal: number;
  bytesTotal: number;
  currentStep: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  files: RunFile[];
}

export interface RunEstimate {
  months: number;
  jobsTotal: number;
  sampledJobs: number;
  photosInSample: number;
  estimatedPhotos: number;
  estimatedBytes: number;
  estimatedMinutes: number;
  jobsWithPhotosRate: number;
  warnings: string[];
}

export interface SettingsPayload {
  values: Record<string, string>;
  secretsSet: Record<string, boolean>;
  defaults: RunTuning;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours}h${rest > 0 ? ` ${rest}m` : ""}`;
}

// The number that decides whether a client is a rush job: after their
// ServiceTitan account lapses, retrieval is impossible at any price.
export function daysUntil(dateIso: string | null): number | null {
  if (!dateIso) return null;
  const target = new Date(`${dateIso}T00:00:00Z`).getTime();
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - Date.now()) / (24 * 60 * 60 * 1000));
}

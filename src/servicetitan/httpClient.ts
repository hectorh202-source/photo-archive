import axios, { type Method } from "axios";
import { getServiceTitanConfig, type ServiceTitanConfig } from "../db/clientSettings";
import { getAccessToken } from "./authClient";

export class ServiceTitanNotConfiguredError extends Error {
  constructor() {
    super("ServiceTitan is not configured. Add credentials on the client's Settings tab.");
  }
}

export function requireServiceTitanConfig(clientId: number): ServiceTitanConfig {
  const config = getServiceTitanConfig(clientId);
  if (!config) throw new ServiceTitanNotConfiguredError();
  return config;
}

export async function stRequest<T>(
  config: ServiceTitanConfig,
  method: Method,
  path: string,
  options: { params?: Record<string, unknown>; data?: unknown } = {},
): Promise<T> {
  const token = await getAccessToken(config);
  const response = await axios.request<T>({
    method,
    url: `${config.apiBaseUrl}${path}`,
    params: options.params,
    data: options.data,
    headers: {
      Authorization: `Bearer ${token}`,
      "ST-App-Key": config.appKey,
    },
  });
  return response.data;
}

export interface ServiceTitanFile {
  data: Buffer;
  contentType: string;
  // Filename ServiceTitan itself suggested via Content-Disposition, if any —
  // the attachment list's own fileName is a stored GUID-ish name, so this is
  // usually the better human-readable name when it's present.
  suggestedFileName: string | null;
}

// Binary sibling of stRequest, for the endpoints that hand back a file
// rather than JSON (today: GET /forms/v2/.../jobs/attachment/{id}, the job
// photo/attachment download — see jobAttachments.ts). Same auth headers;
// the only real difference is responseType, since axios would otherwise try
// to parse a JPEG as JSON and hand back a mangled string.
export async function stRequestFile(
  config: ServiceTitanConfig,
  path: string,
  options: { params?: Record<string, unknown> } = {},
): Promise<ServiceTitanFile> {
  const token = await getAccessToken(config);
  const response = await axios.request<ArrayBuffer>({
    method: "GET",
    url: `${config.apiBaseUrl}${path}`,
    params: options.params,
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${token}`,
      "ST-App-Key": config.appKey,
    },
  });
  const contentType = response.headers["content-type"];
  const disposition = response.headers["content-disposition"];
  return {
    data: Buffer.from(response.data),
    contentType: typeof contentType === "string" ? contentType.split(";")[0].trim() : "application/octet-stream",
    suggestedFileName: typeof disposition === "string" ? parseContentDispositionFileName(disposition) : null,
  };
}

function parseContentDispositionFileName(disposition: string): string | null {
  // filename*=UTF-8''name.jpg wins over plain filename="name.jpg" per RFC 6266.
  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : null;
}

// axios' default error.message (e.g. "Request failed with status code 400")
// discards ServiceTitan's actual response body, which is where the useful
// validation detail lives — surface that instead wherever we log errors.
export function describeError(error: unknown): string {
  if (axios.isAxiosError(error) && error.response?.data) {
    const data = error.response.data;
    // A responseType:"arraybuffer" request (stRequestFile) gets its *error*
    // bodies as buffers too, and JSON.stringify would turn ServiceTitan's
    // perfectly readable JSON error into a {"0":123,...} byte dump.
    if (Buffer.isBuffer(data)) {
      const text = data.toString("utf8").trim();
      return text.length > 0 ? text.slice(0, 500) : `Request failed with status ${error.response.status}`;
    }
    return JSON.stringify(data);
  }
  return error instanceof Error ? error.message : "Unknown error";
}

export function errorStatus(error: unknown): number | null {
  return axios.isAxiosError(error) ? (error.response?.status ?? null) : null;
}

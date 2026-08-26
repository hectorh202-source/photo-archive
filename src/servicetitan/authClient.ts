import axios from "axios";
import type { ServiceTitanConfig } from "../db/clientSettings";

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Keyed by clientId:authBaseUrl rather than a single slot — each business
// has its own ServiceTitan credentials, so a single-slot cache would have
// every business's request evict the previous business's cached token the
// moment two businesses' calls interleave.
const cache = new Map<string, CachedToken>();

export async function getAccessToken(config: ServiceTitanConfig): Promise<string> {
  const cacheKey = `${config.clientId}:${config.authBaseUrl}`;
  const now = Date.now();
  const existing = cache.get(cacheKey);
  if (existing && existing.expiresAt - 60_000 > now) {
    return existing.token;
  }

  const response = await axios.post<{ access_token: string; expires_in: number }>(
    `${config.authBaseUrl}/connect/token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );

  const entry: CachedToken = {
    token: response.data.access_token,
    expiresAt: now + response.data.expires_in * 1000,
  };
  cache.set(cacheKey, entry);
  return entry.token;
}

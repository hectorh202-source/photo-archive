import crypto from "node:crypto";
import { encryptionKey } from "./encryptionKey";

const ALGO = "aes-256-gcm";

// The one shared AES-256-GCM implementation behind every encrypted-at-rest
// value in this app — settings/business_settings credentials (settings/
// store.ts) and, as of the PII-at-rest migration, call transcripts/
// summaries/customer details (db/callRecords.ts, db/callLog.ts). Pulled out
// here (rather than each caller having its own copy) so there's exactly one
// place that could get the format wrong.
export function encryptField(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptField(stored: string): string {
  const raw = Buffer.from(stored, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, encryptionKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// Most of the columns this protects (transcript_json, summary, response_json,
// internal_notes, call_log.phone) are nullable — these let call sites pass
// the raw nullable DB value straight through without an if/else at every
// call site.
export function encryptNullable(value: string | null): string | null {
  return value === null ? null : encryptField(value);
}

export function decryptNullable(value: string | null): string | null {
  return value === null ? null : decryptField(value);
}

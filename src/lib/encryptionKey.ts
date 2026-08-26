import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../config/env";

const keyPath = path.join(path.dirname(env.DATABASE_PATH), ".encryption.key");

// This is the master key protecting every encrypted client_settings
// row (see README.md). Preferred source: ENCRYPTION_KEY from the
// environment, injected at deploy time and never written into the data/
// volume that gets backed up alongside app.db — a backup or volume snapshot
// leak alone then can't also hand over the key needed to decrypt it.
//
// Falls back to the original file-based key (co-located with the DB) only
// for a deployment that hasn't migrated to the env var yet — see
// README.md for the one-time,
// zero-data-loss migration steps (moving the *existing* key, not generating
// a new one — a new key would make every already-encrypted value permanently
// unreadable).
function loadOrCreateKey(): Buffer {
  if (env.ENCRYPTION_KEY) {
    return Buffer.from(env.ENCRYPTION_KEY, "hex");
  }

  console.warn(
    "\n[SECURITY WARNING] No ENCRYPTION_KEY environment variable set. Falling back to the " +
      `encryption key file at ${keyPath}, stored in the same directory/volume as the database ` +
      "itself — a backup or volume snapshot of that directory exposes both the encrypted " +
      "credentials and the key to decrypt them. See README.md " +
      "for the one-time migration to an environment variable (moves your *existing* key — no data loss).\n",
  );

  const dir = path.dirname(keyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

export const encryptionKey = loadOrCreateKey();

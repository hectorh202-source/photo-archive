import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_PATH: z.string().default("./data/archive.db"),

  // Protects every ServiceTitan credential in the database (see
  // lib/encryptionKey.ts). Optional so a fresh install starts, but a
  // deployment holding real client credentials should always set it: kept in
  // the environment rather than the data volume, a stolen backup of that
  // volume is useless on its own.
  ENCRYPTION_KEY: z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
    z
      .string()
      .regex(/^[0-9a-f]{64}$/i, "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)")
      .optional(),
  ),

  // Where finished archives are written. Defaults next to the database so a
  // single Docker volume holds both, but a deployment with a large disk
  // mounted elsewhere should point this at it — a full archive run is
  // measured in tens of gigabytes.
  ARCHIVE_PATH: z.string().optional(),
});

export const env = envSchema.parse(process.env);

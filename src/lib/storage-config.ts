// Storage strategy switch — pure helpers so the mode/key/extension logic is
// testable without touching the actual SDK or filesystem.

import { extname } from "node:path";

export type StorageMode = "supabase" | "local";

/** Which storage backend should saveUpload() use? */
export function storageMode(): StorageMode {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? "supabase" : "local";
}

/** Bucket name (overridable for staging/test). */
export function storageBucket(): string {
  return process.env.STORAGE_BUCKET ?? "garage-uploads";
}

/** Pick an extension from a filename, falling back to the MIME subtype. */
export function pickExtension(filename: string, mime: string): string {
  const fromName = extname(filename);
  if (fromName) return fromName.toLowerCase();
  if (mime.includes("/")) return "." + mime.split("/")[1].split(";")[0].toLowerCase();
  return "";
}

/**
 * Tenant-scoped object key: `garages/{garageId}/{uniqueId}{.ext}`.
 * Stable structure so per-garage cleanup and stray-file detection are trivial.
 */
export function objectKey(garageId: string, uniqueId: string, filename: string, mime: string): string {
  const ext = pickExtension(filename, mime);
  // Keep the garageId clean — anything that's not a-z0-9-_ becomes "_".
  const safeGarage = garageId.replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
  return `garages/${safeGarage}/${uniqueId}${ext}`;
}

/** Signed URL TTL in seconds. 7 days — long enough to revisit a job card. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

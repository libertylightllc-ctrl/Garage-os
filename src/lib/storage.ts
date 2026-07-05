import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StorageClient } from "@supabase/storage-js";
import {
  storageMode,
  storageBucket,
  logoBucket,
  pickExtension,
  objectKey,
  SIGNED_URL_TTL_SECONDS,
} from "./storage-config";

// Uploads. Two backends behind one API:
//   1. Local (.uploads/ + /api/files) — dev default, no env required.
//   2. Supabase Storage — when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set.
//      Private bucket, per-tenant key prefix (garages/{garageId}/...), signed
//      URLs (1 week TTL). The service role key is server-only — it never reaches
//      the browser.
//
// The public API — saveUpload(file): Promise<string> returning a URL — is
// unchanged so every caller (techsteps, jobs, intake) keeps working.

const UPLOAD_DIR = path.join(process.cwd(), ".uploads");

function guessExt(name: string, mime: string): string {
  return pickExtension(name, mime);
}

let _storageClient: StorageClient | null = null;
function supabaseStorage(): StorageClient {
  if (_storageClient) return _storageClient;
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  // The storage-only client (no DB / no auth) — minimal blast radius.
  _storageClient = new StorageClient(`${url.replace(/\/$/, "")}/storage/v1`, {
    apikey: key,
    Authorization: `Bearer ${key}`,
  });
  return _storageClient;
}

/** Save a file and return a URL that can be put in <img src> / <audio src>. */
export async function saveUpload(file: File, garageId = "shared"): Promise<string> {
  const uniqueId = randomUUID();

  if (storageMode() === "supabase") {
    const bucket = storageBucket();
    const key = objectKey(garageId, uniqueId, file.name, file.type || "");
    const buf = Buffer.from(await file.arrayBuffer());

    const { error: upErr } = await supabaseStorage()
      .from(bucket)
      .upload(key, buf, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
    if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

    // Private bucket → time-limited signed URL. Callers store this URL on the
    // JobStep row; if it expires before someone views it, future versions can
    // refresh via a helper.
    const { data, error: signErr } = await supabaseStorage()
      .from(bucket)
      .createSignedUrl(key, SIGNED_URL_TTL_SECONDS);
    if (signErr || !data?.signedUrl) {
      throw new Error(`Signed URL failed: ${signErr?.message ?? "no url"}`);
    }
    return data.signedUrl;
  }

  // Local fallback — works in dev and during the demo without any Supabase setup.
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${uniqueId}${guessExt(file.name, file.type)}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(UPLOAD_DIR, filename), buf);
  return `/api/files/${filename}`;
}

export const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

// ─── LOGO UPLOAD ─────────────────────────────────────────────────────
// Per-garage logo upload (KEY DECISION: 2026-06-27). Public bucket,
// magic-byte type sniff, 500 KB cap, PNG/JPEG/WEBP only. Distinct
// surface from saveUpload() above because:
//   1. Logos are PUBLIC (getPublicUrl), tech photos are PRIVATE (signed
//      URL, 7-day TTL). A logo URL on a customer invoice link can't
//      expire mid-flight.
//   2. Logos go into the `garage-logos` bucket (logoBucket()), tech
//      photos go into `garage-uploads` (storageBucket()) — keeps the
//      public/private RLS distinction obvious.
//   3. Logos run through validateLogoFile() before write; the legacy
//      saveUpload() trusts its caller.

/** Hard cap for a logo upload, in bytes. */
export const LOGO_MAX_BYTES = 500 * 1024;

/** Allowed logo MIME types. SVG is excluded for stored-XSS safety. */
export const LOGO_ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"] as const;

export class LogoValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "LogoValidationError";
  }
}

/**
 * Magic-byte sniff — the file's first bytes must match the claimed
 * MIME, otherwise a forged Content-Type can hide an arbitrary payload.
 *   PNG:  89 50 4E 47 0D 0A 1A 0A
 *   JPEG: FF D8 FF
 *   WEBP: 'RIFF' .. .. .. .. 'WEBP'  (52 49 46 46 ?? ?? ?? ?? 57 45 42 50)
 */
function sniffImageType(head: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Validate a candidate logo file. Throws LogoValidationError on any
 * failure so the server action can map to a user-facing message. Reads
 * the first 12 bytes for the magic-byte check; full read happens later
 * if validation passes.
 *
 * Exported for direct unit testing AND for re-use by the server action
 * (which calls this BEFORE storing — never trust the client).
 */
export async function validateLogoFile(file: File): Promise<void> {
  // 1. Size cap. file.size is reported by the runtime — trust but verify
  //    again post-read in case the client lies.
  if (file.size === 0) {
    throw new LogoValidationError("EMPTY", "Logo file is empty.");
  }
  if (file.size > LOGO_MAX_BYTES) {
    throw new LogoValidationError(
      "TOO_LARGE",
      `Logo must be ${LOGO_MAX_BYTES / 1024} KB or smaller (got ${Math.round(file.size / 1024)} KB).`,
    );
  }

  // 2. MIME allowlist. The client controls this header; the magic-byte
  //    check below is what actually protects us, but we may as well
  //    short-circuit on obviously wrong types first.
  if (!LOGO_ALLOWED_MIME.includes(file.type as (typeof LOGO_ALLOWED_MIME)[number])) {
    throw new LogoValidationError(
      "BAD_MIME",
      `Logo must be PNG, JPEG, or WEBP (got "${file.type || "unknown"}").`,
    );
  }

  // 3. Magic-byte sniff. Forbids "rename rootkit.exe to logo.png and
  //    set Content-Type to image/png" attacks.
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const sniffed = sniffImageType(head);
  if (sniffed === null) {
    throw new LogoValidationError(
      "BAD_MAGIC",
      "Logo file content does not match its declared type.",
    );
  }
  if (sniffed !== file.type) {
    throw new LogoValidationError(
      "MIME_MISMATCH",
      `Logo declared "${file.type}" but actual content is "${sniffed}".`,
    );
  }
}

// ─── INVOICE IMAGE (OCR import) ──────────────────────────────────────
// A photographed supplier invoice for the parts-import OCR flow. Same
// magic-byte + MIME discipline as the logo, but a phone-photo-sized cap
// (invoices are 2–5 MB, not 500 KB) and stored PRIVATE via saveUpload()
// (signed URL) since it's an internal audit-trail image, not public brand.

/** Hard cap for an uploaded invoice photo, in bytes. */
export const INVOICE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Validate a candidate invoice image — reuses the logo's magic-byte sniff
 * + MIME allowlist (PNG/JPEG/WEBP; SVG excluded) but with the larger
 * phone-photo cap. Throws LogoValidationError (shared image-validation
 * error type) with a stable .code on any failure. HEIC is not accepted by
 * the vision API, so it's rejected here with a clear code.
 */
export async function validateInvoiceImage(file: File): Promise<void> {
  if (file.size === 0) {
    throw new LogoValidationError("EMPTY", "Invoice image is empty.");
  }
  if (file.size > INVOICE_MAX_BYTES) {
    throw new LogoValidationError(
      "TOO_LARGE",
      `Invoice photo must be ${INVOICE_MAX_BYTES / (1024 * 1024)} MB or smaller (got ${Math.round(file.size / (1024 * 1024))} MB).`,
    );
  }
  if (!LOGO_ALLOWED_MIME.includes(file.type as (typeof LOGO_ALLOWED_MIME)[number])) {
    throw new LogoValidationError(
      "BAD_MIME",
      `Invoice photo must be PNG, JPEG, or WEBP (got "${file.type || "unknown"}"). If it's a HEIC iPhone photo, share it as JPEG.`,
    );
  }
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const sniffed = sniffImageType(head);
  if (sniffed === null) {
    throw new LogoValidationError("BAD_MAGIC", "Invoice image content does not match its declared type.");
  }
  if (sniffed !== file.type) {
    throw new LogoValidationError(
      "MIME_MISMATCH",
      `Invoice photo declared "${file.type}" but actual content is "${sniffed}".`,
    );
  }
}

/**
 * Upload a validated logo to the public garage-logos bucket and
 * return the permanent public URL. Validates first (no escape hatch).
 * In local mode (no Supabase env), falls back to writing under
 * .uploads/ (flat, no subdir — the /api/files/[name] route is a
 * single-segment dynamic route, not a catch-all) and serving via
 * /api/files/{logo-<filename>}. The `logo-` filename prefix keeps
 * logo uploads visually distinct from tech-photo uploads in the
 * shared directory + makes parseLogoUrl's local match unambiguous.
 *
 * Garage scoping is enforced by objectKey() — the caller's garageId
 * comes from the session, never from form input.
 */
export async function saveLogoUpload(file: File, garageId: string): Promise<string> {
  await validateLogoFile(file);
  const uniqueId = randomUUID();

  if (storageMode() === "supabase") {
    const bucket = logoBucket();
    const key = objectKey(garageId, uniqueId, file.name, file.type);
    const buf = Buffer.from(await file.arrayBuffer());

    const { error: upErr } = await supabaseStorage()
      .from(bucket)
      .upload(key, buf, {
        contentType: file.type,
        upsert: false,
      });
    if (upErr) throw new Error(`Logo upload failed: ${upErr.message}`);

    const { data } = supabaseStorage().from(bucket).getPublicUrl(key);
    if (!data?.publicUrl) throw new Error("Logo upload: no public URL returned.");
    return data.publicUrl;
  }

  // Local fallback — write FLAT to .uploads/ (no logos/ subdir; the
  // /api/files/[name] route is single-segment dynamic, not catch-all)
  // with a `logo-` filename prefix so parseLogoUrl can still tell
  // logo files apart from tech-photo files in the shared directory.
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `logo-${uniqueId}${guessExt(file.name, file.type)}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(UPLOAD_DIR, filename), buf);
  return `/api/files/${filename}`;
}

/**
 * Parse a public logo URL back into a bucket key. Used by
 * deleteLogoUpload to know which object to remove. Returns null if the
 * URL doesn't match either backend shape (e.g. external CDN, legacy
 * data) so the caller can no-op rather than throw.
 *
 * Supabase public URLs look like:
 *   https://<project>.supabase.co/storage/v1/object/public/<bucket>/<key>
 * Local URLs look like:
 *   /api/files/logo-<uuid>.<ext>
 * The `logo-` filename prefix is the disambiguator so a delete call
 * here cannot wipe a tech-photo upload that shares the directory.
 */
export function parseLogoUrl(
  url: string,
): { backend: "supabase"; bucket: string; key: string } | { backend: "local"; filename: string } | null {
  // Local — single-segment match; the `logo-` prefix is required so
  // parseLogoUrl never matches a tech-photo URL by accident.
  const localMatch = url.match(/^\/api\/files\/(logo-[^/?#]+)$/);
  if (localMatch) return { backend: "local", filename: localMatch[1] };

  // Supabase public URL.
  const supaMatch = url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  if (supaMatch) return { backend: "supabase", bucket: supaMatch[1], key: supaMatch[2] };

  return null;
}

/**
 * Delete a previously-saved logo from storage. Safe to call with a URL
 * we don't recognise (no-op) so a corrupted DB row can't crash the
 * replace-logo flow. The DB write is the source of truth — this is
 * cleanup, not the security boundary.
 */
export async function deleteLogoUpload(url: string): Promise<void> {
  const parsed = parseLogoUrl(url);
  if (!parsed) return;

  if (parsed.backend === "supabase") {
    const { error } = await supabaseStorage().from(parsed.bucket).remove([parsed.key]);
    if (error) {
      // Best-effort: log but don't throw. A stale object is wasted
      // storage, not a correctness bug.
      console.warn(`[storage] failed to delete logo ${parsed.key}: ${error.message}`);
    }
    return;
  }

  // Local: unlink, ignore ENOENT (already gone). Flat path under
  // .uploads/ matching the write side in saveLogoUpload.
  try {
    await unlink(path.join(UPLOAD_DIR, parsed.filename));
  } catch (e: unknown) {
    if (!(typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "ENOENT")) {
      console.warn(`[storage] failed to delete local logo ${parsed.filename}:`, e);
    }
  }
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StorageClient } from "@supabase/storage-js";
import {
  storageMode,
  storageBucket,
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

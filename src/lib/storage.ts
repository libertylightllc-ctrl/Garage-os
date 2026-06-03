import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Local-filesystem storage for dev (photos / voice notes). Production swaps this
// for Supabase Storage / S3 — keep the saveUpload() return shape (a URL) stable.
const UPLOAD_DIR = path.join(process.cwd(), ".uploads");

function guessExt(name: string, mime: string): string {
  const e = path.extname(name);
  if (e) return e;
  if (mime.includes("/")) return "." + mime.split("/")[1].split(";")[0];
  return "";
}

export async function saveUpload(file: File): Promise<string> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${randomUUID()}${guessExt(file.name, file.type)}`;
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

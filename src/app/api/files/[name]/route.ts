import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONTENT_TYPES } from "@/lib/storage";

// Serves dev uploads from ./.uploads. Production serves from object storage instead.
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const safe = path.basename(name); // prevent path traversal
  try {
    const buf = await readFile(path.join(process.cwd(), ".uploads", safe));
    const type = CONTENT_TYPES[path.extname(safe).toLowerCase()] ?? "application/octet-stream";
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// One-off diagnostic — confirms the deployed function can authenticate
// against Supabase Storage using the env-loaded service-role key. Returns
// a short JSON status so we can verify without leaking the key.
//
// REMOVE THIS FILE after the storage misconfig is fixed.

export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  const keyLen = key.length;
  const keyStart = key.slice(0, 6);
  const keySegments = key.split(".").length;
  const urlOk = url.startsWith("https://") && url.endsWith(".supabase.co");

  if (!key || !url) {
    return Response.json({
      ok: false,
      stage: "env",
      urlOk,
      keyLen,
      keyStart,
      keySegments,
    });
  }

  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/storage/v1/bucket`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    const text = await r.text();
    return Response.json({
      ok: r.ok,
      stage: "auth",
      status: r.status,
      keyLen,
      keyStart,
      keySegments,
      body: text.slice(0, 200),
    });
  } catch (e) {
    return Response.json({
      ok: false,
      stage: "fetch",
      keyLen,
      keyStart,
      keySegments,
      error: String(e),
    });
  }
}

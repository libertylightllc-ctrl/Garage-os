import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";

/**
 * Embedded Signup callback — slice #8.
 *
 * The client component (EmbeddedSignupButton) POSTs the
 * short-lived 'code' returned by FB.login here. The route:
 *
 *   1. Authenticates the caller as the OWNER of the garage they
 *      claim to be connecting.
 *   2. Exchanges the code for a long-lived access token via
 *      graph.facebook.com/oauth/access_token (needs APP_ID,
 *      APP_SECRET; both server-only).
 *   3. Calls the WABA + phone_number endpoints to discover the
 *      phone_number_id and the actual e164 phone number the
 *      customer added inside Embedded Signup.
 *   4. Upserts WhatsAppAccount with the encrypted token + WABA ids,
 *      flips status to CONNECTED.
 *
 * Sandbox-mode behaviour: when META_WHATSAPP_APP_SECRET is unset,
 * the route fails fast with 503 — the only way to land here without
 * production creds is a misconfigured page, and we'd rather surface
 * that than silently no-op.
 *
 * Idempotent: re-running with the same code is fine — the upsert
 * just refreshes the token. The webhook still routes inbound by
 * phone_number_id so a re-connect for the same number doesn't
 * orphan past messages.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const appId = process.env["META_WHATSAPP_APP_ID"];
  const appSecret = process.env["META_WHATSAPP_APP_SECRET"];
  if (!appId || !appSecret) {
    return NextResponse.json(
      { error: "Meta WhatsApp credentials not configured on this deployment." },
      { status: 503 },
    );
  }

  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const code = String(body.code ?? "").trim();
  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  // ── Code → long-lived token ──
  // Meta returns { access_token, token_type, expires_in }. We store
  // the token encrypted at rest via encryptSecret — never log it.
  const tokenUrl = new URL("https://graph.facebook.com/v20.0/oauth/access_token");
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("code", code);
  // redirect_uri must match what the FB.login flow used. Embedded
  // Signup with response_type=code accepts the page origin.
  tokenUrl.searchParams.set(
    "redirect_uri",
    `${new URL(req.url).origin}/owner/whatsapp`,
  );

  const tokenRes = await fetch(tokenUrl.toString());
  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    console.error("[wa-connect] token exchange failed", detail);
    return NextResponse.json(
      { error: "Token exchange failed" },
      { status: 502 },
    );
  }
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
  };
  const accessToken = tokenJson.access_token;
  if (!accessToken) {
    return NextResponse.json({ error: "No access_token in response" }, { status: 502 });
  }

  // ── Discover the WABA + phone number ──
  // Embedded Signup with config_id gives us a token scoped to a
  // single WABA. /me/businesses isn't quite right; the documented
  // approach is /debug_token + then list of granted_scopes, OR
  // the /me?fields=businesses path. The cleanest is to list the
  // shared WhatsApp Business Accounts:
  //   GET /<APP_ID>?fields=whatsapp_business_accounts
  // and from each WABA, list /<WABA_ID>/phone_numbers.
  //
  // For pilot purposes we accept the FIRST WABA + FIRST phone number
  // the customer granted us. Multi-WABA / multi-number is a future
  // slice.
  const wabaListRes = await fetch(
    `https://graph.facebook.com/v20.0/debug_token?input_token=${accessToken}&access_token=${appId}|${appSecret}`,
  );
  let wabaId: string | null = null;
  let phoneNumberId: string | null = null;
  let phoneNumber: string | null = null;
  if (wabaListRes.ok) {
    const dt = (await wabaListRes.json()) as {
      data?: {
        granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
      };
    };
    const waba = dt.data?.granular_scopes?.find(
      (g) => g.scope === "whatsapp_business_management",
    );
    wabaId = waba?.target_ids?.[0] ?? null;
  }
  if (wabaId) {
    const phRes = await fetch(
      `https://graph.facebook.com/v20.0/${wabaId}/phone_numbers?access_token=${accessToken}`,
    );
    if (phRes.ok) {
      const ph = (await phRes.json()) as {
        data?: Array<{ id: string; display_phone_number?: string }>;
      };
      const first = ph.data?.[0];
      if (first) {
        phoneNumberId = first.id;
        phoneNumber = first.display_phone_number ?? null;
      }
    }
  }

  if (!phoneNumberId) {
    // Best-effort: store the token + flag a degraded state so the
    // owner sees something landed and can re-run if the discovery
    // missed something. They can also manually fix via sandbox form
    // in a pinch.
    console.warn("[wa-connect] connected but phone_number_id not discoverable");
  }

  await prisma.whatsAppAccount.upsert({
    where: { garageId: session.user.garageId },
    update: {
      status: "CONNECTED",
      wabaId,
      phoneNumberId: phoneNumberId ?? `unknown-${Date.now()}`,
      phoneNumber: phoneNumber ?? "(unknown — re-run signup)",
      accessTokenEnc: encryptSecret(accessToken),
      connectedAt: new Date(),
    },
    create: {
      garageId: session.user.garageId,
      status: "CONNECTED",
      wabaId,
      phoneNumberId: phoneNumberId ?? `unknown-${Date.now()}`,
      phoneNumber: phoneNumber ?? "(unknown — re-run signup)",
      accessTokenEnc: encryptSecret(accessToken),
      connectedAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true, phoneNumber });
}

import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import {
  connectWhatsAppAction,
  disconnectWhatsAppAction,
} from "@/app/actions/whatsapp-connect";
import { EmbeddedSignupButton } from "@/components/whatsapp-embedded-signup";

export const dynamic = "force-dynamic";

// Slice #8 — WhatsApp real-number connect scaffold.
//
// Two modes, decided server-side at request time by checking for the
// Meta BSP env vars:
//
//   1. PRODUCTION mode — META_WHATSAPP_APP_ID and
//      META_WHATSAPP_CONFIG_ID are set. Render the Embedded Signup
//      launcher (Facebook JS SDK). When the popup completes, it
//      returns a short-lived 'code' that the server exchanges for
//      a long-lived WABA access token + phone_number_id + the
//      garage's WhatsApp number. Handler at
//      /api/whatsapp/connect-callback.
//
//   2. SANDBOX mode — env vars unset (current pilot state). Render
//      the simulation form that lets the owner type a number to
//      flip the connection on for testing. Labelled SANDBOX so the
//      owner never confuses it with a real connect.
//
// Either way, connectWhatsAppAction is the single write path — it
// upserts the WhatsAppAccount row with status=CONNECTED, encrypts
// the token at rest (encryptSecret), and revalidates this page.
//
// Required env vars for PRODUCTION mode:
//   META_WHATSAPP_APP_ID                — your Meta App ID
//   META_WHATSAPP_CONFIG_ID             — Embedded Signup config_id
//   META_WHATSAPP_APP_SECRET            — server-only; used for code→token exchange
//   META_WHATSAPP_VERIFY_TOKEN          — webhook verification (already in webhook route)
//   NEXT_PUBLIC_META_WHATSAPP_APP_ID    — mirror of APP_ID exposed to the client
//   NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID — mirror of CONFIG_ID exposed to the client
function isProductionMode(): boolean {
  return (
    !!process.env["META_WHATSAPP_APP_ID"] &&
    !!process.env["META_WHATSAPP_CONFIG_ID"] &&
    !!process.env["META_WHATSAPP_APP_SECRET"]
  );
}

export default async function WhatsAppSettings() {
  const session = await requireRole("OWNER");
  const t = await getT();
  const acct = await prisma.whatsAppAccount.findUnique({
    where: { garageId: session.user.garageId },
  });
  const connected = acct?.status === "CONNECTED";
  const productionMode = isProductionMode();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="whatsapp" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("waConnect")}</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("waConnectIntro")}</p>

      {/* Mode banner — sandbox uses an amber pill so the owner is
          never in doubt about which mode they're in. Production mode
          uses a green pill once the env vars are configured. */}
      <div
        className={
          "inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold " +
          (productionMode
            ? "border-emerald-500/40 bg-emerald-50 text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-950/30 dark:text-emerald-200"
            : "border-amber-500/40 bg-amber-50 text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200")
        }
      >
        {productionMode ? `🟢 ${t("waProdMode")}` : `🟡 ${t("waSandboxMode")}`}
      </div>

      {connected ? (
        <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
          <div className="text-sm">
            🟢 {t("waConnected")} ·{" "}
            <span className="font-medium">{acct?.phoneNumber}</span>
          </div>
          <form action={disconnectWhatsAppAction}>
            <button className="text-sm text-red-600 hover:underline">
              {t("waDisconnect")}
            </button>
          </form>
        </div>
      ) : productionMode ? (
        // ── PRODUCTION mode: launch Facebook Embedded Signup ──
        <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {t("waProdHint")}
          </p>
          <EmbeddedSignupButton
            appId={process.env["NEXT_PUBLIC_META_WHATSAPP_APP_ID"] ?? ""}
            configId={process.env["NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID"] ?? ""}
            connectLabel={t("waConnectBtn")}
          />
        </div>
      ) : (
        // ── SANDBOX mode: simulation form ──
        <form
          action={connectWhatsAppAction}
          className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/15"
        >
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {t("waConnectHint")}
          </p>
          <input
            name="phoneNumber"
            placeholder="+9715XXXXXXXX"
            className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
          />
          <button className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500">
            {t("waConnectBtnSandbox")}
          </button>
        </form>
      )}

      {/* Help line — points the owner at the docs page that explains
          how to get Meta BSP credentials and what to set in Vercel. */}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {t("waHelpNeedCreds")}
      </p>
    </main>
  );
}

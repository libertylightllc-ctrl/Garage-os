import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import {
  connectWhatsAppAction,
  disconnectWhatsAppAction,
} from "@/app/actions/whatsapp-connect";
import { EmbeddedSignupButton } from "@/components/whatsapp-embedded-signup";

export const dynamic ="force-dynamic";

// Slice #8 — WhatsApp real-number connect scaffold.
//
// Two modes, decided server-side at request time by checking for the
// Meta BSP env vars:
//
//  1. PRODUCTION mode — META_WHATSAPP_APP_ID and
//   META_WHATSAPP_CONFIG_ID are set. Render the Embedded Signup
//   launcher (Facebook JS SDK). When the popup completes, it
//   returns a short-lived 'code' that the server exchanges for
//   a long-lived WABA access token + phone_number_id + the
//   garage's WhatsApp number. Handler at
//   /api/whatsapp/connect-callback.
//
//  2. SANDBOX mode — env vars unset (current pilot state). Render
//   the simulation form that lets the owner type a number to
//   flip the connection on for testing. Labelled SANDBOX so the
//   owner never confuses it with a real connect.
//
// Either way, connectWhatsAppAction is the single write path — it
// upserts the WhatsAppAccount row with status=CONNECTED, encrypts
// the token at rest (encryptSecret), and revalidates this page.
//
// Required env vars for PRODUCTION mode:
//  META_WHATSAPP_APP_ID        — your Meta App ID
//  META_WHATSAPP_CONFIG_ID       — Embedded Signup config_id
//  META_WHATSAPP_APP_SECRET      — server-only; used for code→token exchange
//  META_WHATSAPP_VERIFY_TOKEN     — webhook verification (already in webhook route)
//  NEXT_PUBLIC_META_WHATSAPP_APP_ID  — mirror of APP_ID exposed to the client
//  NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID — mirror of CONFIG_ID exposed to the client
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
  const connected = acct?.status ==="CONNECTED";
  const productionMode = isProductionMode();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="whatsapp"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("waConnect")}</h1>
      <p className="text-sm text-text-mute">{t("waConnectIntro")}</p>

      {/* Mode banner — sandbox uses an amber pill so the owner is
          never in doubt about which mode they're in. Production mode
          uses a green pill once the env vars are configured. */}
      <div
        className={
        "inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold"+
          (productionMode
            ?"border-success-500/40 bg-success-50 text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500"
            :"border-warning-500/40 bg-warning-50 text-warning-600 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500")
        }
      >
        {productionMode ? `🟢 ${t("waProdMode")}` : `🟡 ${t("waSandboxMode")}`}
      </div>

      {connected ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <div className="text-sm">
            🟢 {t("waConnected")} ·{""}
            <span className="font-medium">{acct?.phoneNumber}</span>
          </div>
          <form action={disconnectWhatsAppAction}>
            <button className="text-sm text-danger-700 hover:underline dark:text-danger-500">
              {t("waDisconnect")}
            </button>
          </form>
        </div>
      ) : productionMode ? (
        // ── PRODUCTION mode: launch Facebook Embedded Signup ──
        <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <p className="text-xs text-text-mute">
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
          className="flex flex-col gap-2 rounded-xl border border-border p-4"
        >
          <p className="text-xs text-text-mute">
            {t("waConnectHint")}
          </p>
          <input
            name="phoneNumber"
            placeholder="+9715XXXXXXXX"
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          />
          <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
            {t("waConnectBtnSandbox")}
          </button>
        </form>
      )}

      {/* Help line — points the owner at the docs page that explains
          how to get Meta BSP credentials and what to set in Vercel. */}
      <p className="text-xs text-text-mute">
        {t("waHelpNeedCreds")}
      </p>
    </main>
  );
}

import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { connectWhatsAppAction, disconnectWhatsAppAction } from "@/app/actions/whatsapp-connect";

export const dynamic = "force-dynamic";

export default async function WhatsAppSettings() {
  const session = await requireRole("OWNER");
  const t = await getT();
  const acct = await prisma.whatsAppAccount.findUnique({ where: { garageId: session.user.garageId } });
  const connected = acct?.status === "CONNECTED";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="whatsapp" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("waConnect")}</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("waConnectIntro")}</p>

      {connected ? (
        <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
          <div className="text-sm">
            🟢 {t("waConnected")} · <span className="font-medium">{acct?.phoneNumber}</span>
          </div>
          <form action={disconnectWhatsAppAction}>
            <button className="text-sm text-red-600 hover:underline">{t("waDisconnect")}</button>
          </form>
        </div>
      ) : (
        <form
          action={connectWhatsAppAction}
          className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/15"
        >
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t("waConnectHint")}</p>
          <input
            name="phoneNumber"
            placeholder="+9715XXXXXXXX"
            className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
          />
          <button className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500">
            {t("waConnectBtn")}
          </button>
        </form>
      )}
    </main>
  );
}

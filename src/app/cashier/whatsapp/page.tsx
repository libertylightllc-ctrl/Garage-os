import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { AppNav } from "@/components/app-nav";
import { WhatsAppStatusPanel } from "@/components/whatsapp-status";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

/**
  * Cashier's read-only view of the garage WhatsApp connection.
  *
  * Cashier sends WhatsApp messages via sendInvoiceToCustomerAction
  * (preview→send gate). This page tells them whether the connector is
  * actually live and lets them eyeball the recent-outbound log to
  * confirm sends went out.
  *
  * Connect / disconnect remain owner-only (/owner/whatsapp).
  */
export default async function CashierWhatsApp() {
  const session = await requireAnyRole(["CASHIER", "OWNER"]);
  const t = await getT();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="CASHIER" active="whatsapp"/>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("waStatusTitle")}
        </h1>
        <p className="text-sm text-text-mute">
          {t("waStatusSubtitleCashier")}
        </p>
      </div>

      <WhatsAppStatusPanel
        garageId={session.user.garageId}
        helpForRole="cashier"
      />

      {/* Quick shortcuts back to the cashier's main surfaces — they
          usually land here because they want to confirm an
          invoice/estimate send fired or wonder why a customer hasn't
          received one yet. */}
      <div className="flex flex-wrap gap-2">
        <Link
          href="/cashier?tab=invoices"
          className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors"
        >
          {t("waStatusGoInvoices")}
        </Link>
        <Link
          href="/cashier?tab=estimates"
          className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors"
        >
          {t("waStatusGoEstimates")}
        </Link>
      </div>
    </main>
  );
}

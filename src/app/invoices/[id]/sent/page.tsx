import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Stage 8 confirmation screen — shown after the cashier taps 'Send
 * invoice to customer'. Mirrors the existing handoff / sent-to-cashier
 * pages so every workflow handoff has the same "explicit you-did-this"
 * surface.
 */
export default async function InvoiceSent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAnyRole(["CASHIER", "OWNER", "ADVISOR"]);
  const t = await getT();
  const { id } = await params;

  const inv = await prisma.invoice.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      jobCard: {
        include: {
          vehicle: { include: { customer: { select: { name: true, phone: true } } } },
        },
      },
    },
  });
  if (!inv) notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role={session.user.role as "CASHIER" | "OWNER" | "ADVISOR"} active="accounts" />

      <section className="rounded-2xl border border-fuchsia-500/40 bg-fuchsia-50 p-6 text-center dark:bg-fuchsia-950/40">
        <div className="text-5xl">📨</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{t("invoiceSentTitle")}</h1>
        <p className="mt-2 text-base text-zinc-700 dark:text-zinc-200">
          {t("invoiceSentSubtitle")}
        </p>
        <p className="mt-2 rounded-md bg-fuchsia-100 px-3 py-2 text-xs text-fuchsia-900 dark:bg-fuchsia-900/40 dark:text-fuchsia-200">
          {t("invoiceSentMockNote")}
        </p>
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-base">
          <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            {t("handoffJobNo")}
          </dt>
          <dd className="font-semibold tabular-nums">#{inv.jobCard.number ?? "—"}</dd>

          <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            {t("secVehicle")}
          </dt>
          <dd>
            {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model}
            {inv.jobCard.vehicle.year ? ` (${inv.jobCard.vehicle.year})` : ""} ·{" "}
            <span className="font-medium">{inv.jobCard.vehicle.plate}</span>
          </dd>

          <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            {t("secCustomer")}
          </dt>
          <dd>
            {inv.jobCard.vehicle.customer.name} · {inv.jobCard.vehicle.customer.phone}
          </dd>

          {inv.jobCard.invoiceSentAt ? (
            <>
              <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {t("invoiceSentAt")}
              </dt>
              <dd className="tabular-nums">
                {inv.jobCard.invoiceSentAt.toISOString().slice(0, 16).replace("T", " ")}
              </dd>
            </>
          ) : null}

          <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{t("total")}</dt>
          <dd className="font-semibold tabular-nums">AED {Number(inv.total).toFixed(2)}</dd>
        </dl>
      </section>

      {/* Single back action — trimmed from two ('Back to invoice' +
          'Back to accounts') down to one per audit. The cashier just
          hit Send; the natural next move is back to the dashboard's
          Invoices tab to pick up the next car, not back to the same
          invoice. They can still drill into the invoice from there
          via the Receivables row. */}
      <div className="flex flex-col gap-2">
        <Link
          href="/cashier?tab=invoices"
          className="rounded-lg bg-zinc-900 px-5 py-3 text-center text-base font-semibold text-white dark:bg-white dark:text-black"
        >
          {t("invoiceBackToCashier")}
        </Link>
      </div>
    </main>
  );
}

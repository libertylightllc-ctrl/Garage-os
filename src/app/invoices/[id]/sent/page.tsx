import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { JobNumberBadge } from "@/components/job-number-badge";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

/**
  * Stage 8 confirmation screen — shown after the cashier taps 'Send
  * invoice to customer'. Mirrors the existing handoff / sent-to-advisor
  * pages so every workflow handoff has the same"explicit you-did-this"
  * surface.
  */
export default async function InvoiceSent({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAnyRole(["CASHIER","OWNER","ADVISOR","MASTER"]);
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
      <AppNav role={session.user.role as"CASHIER"|"OWNER"|"ADVISOR"} active="accounts"/>

      <section className="rounded-xl border border-success-500/40 bg-success-50 p-6 text-center dark:border-success-500/30 dark:bg-success-500/10">
        <div className="text-5xl">📨</div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{t("invoiceSentTitle")}</h1>
        <p className="mt-2 text-base text-text">
          {t("invoiceSentSubtitle")}
        </p>
        <p className="mt-2 inline-block rounded-xl border border-success-500/40 bg-success-50 px-3 py-2 text-xs text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          {t("invoiceSentMockNote")}
        </p>
      </section>

      <section className="rounded-xl border border-border p-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-base">
          <dt className="text-sm font-medium text-text-mute">
            {t("handoffJobNo")}
          </dt>
          <dd className="font-semibold tabular-nums">
            <JobNumberBadge jobCard={inv.jobCard} />
            {inv.jobCard.number ? null : "—"}
          </dd>

          <dt className="text-sm font-medium text-text-mute">
            {t("secVehicle")}
          </dt>
          <dd>
            {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model}
            {inv.jobCard.vehicle.year ? ` (${inv.jobCard.vehicle.year})` :""} ·{""}
            <span className="font-medium">{inv.jobCard.vehicle.plate}</span>
          </dd>

          <dt className="text-sm font-medium text-text-mute">
            {t("secCustomer")}
          </dt>
          <dd>
            {inv.jobCard.vehicle.customer.name} · {inv.jobCard.vehicle.customer.phone}
          </dd>

          {inv.jobCard.invoiceSentAt ? (
            <>
              <dt className="text-sm font-medium text-text-mute">
                {t("invoiceSentAt")}
              </dt>
              <dd className="tabular-nums">
                {inv.jobCard.invoiceSentAt.toISOString().slice(0, 16).replace("T","")}
              </dd>
            </>
          ) : null}

          <dt className="text-sm font-medium text-text-mute">{t("total")}</dt>
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
          className="inline-flex h-12 items-center justify-center rounded-lg px-5 text-center text-base font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        >
          {t("invoiceBackToCashier")}
        </Link>
      </div>
    </main>
  );
}

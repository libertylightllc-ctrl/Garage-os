import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { setEstimateStatusAction } from "@/app/actions/billing";
import { PrintButton } from "@/components/print-button";
import { JobNumberBadge } from "@/components/job-number-badge";
import { getT, getLocale } from "@/i18n/server";
import { translateLineDescription } from "@/lib/line-item-translations";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
  * Cashier-only preview of the customer-facing estimate render.
  *
  * Same Preview gate pattern as /invoices/[id]/preview. Inserted per
  * spec between the estimate edit page and the WhatsApp send so the
  * cashier reviews the formatted layout BEFORE the customer does.
  * From here they can:
  *  • Go Back → /estimates/[id]  (continue pricing)
  *  • Send Estimate to Customer → fires
  *            setEstimateStatusAction(status=SENT) which
  *            flips estimate to SENT, stamps sentAt, and
  *            triggers the WhatsApp send via sendWhatsApp().
  *            This is now the ONLY surface that fires that
  *            action with status=SENT, so the cashier is
  *            guaranteed to have seen the preview before
  *            the customer's phone buzzes.
  *
  * Read-only. No edit forms here so an accidental tap right before
  * sending can't mutate line items. Already-sent (status != DRAFT)
  * estimates fall through to a confirmation note instead of the Send
  * button so back-button + re-tap can't re-fire the WhatsApp.
  */
export default async function EstimatePreview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // ADVISOR included per KEY DECISION #5 (advisor prices + SENDS the
  // estimate) — it was missing here, so the editor's "Preview Estimate"
  // button bounced advisors back to their dashboard.
  const session = await requireAnyRole(["ADVISOR","CASHIER","OWNER","MASTER"]);
  const t = await getT();
  const locale = await getLocale();

  const est = await prisma.estimate.findFirst({
    where: { id, jobCard: { garageId: session.user.garageId } },
    include: {
      lines: { orderBy: { createdAt:"asc"} },
      jobCard: {
        include: {
          vehicle: { include: { customer: true } },
          garage: { select: { name: true, trn: true, country: true } },
        },
      },
    },
  });
  if (!est) notFound();

  // The preview no longer redirects on non-DRAFT: after Send this page
  // IS the permanent, printable customer-facing record of the estimate.
  // The Send button below only renders for DRAFT, so back-button +
  // re-tap can't re-fire the WhatsApp send.
  const isDraft = est.status === "DRAFT";

  const customer = est.jobCard.vehicle.customer;
  const garage = est.jobCard.garage;
  // Non-declined lines only — declined items are customer-skipped and
  // shouldn't appear on the preview the customer sees.
  const lines = est.lines.filter((l) => !l.declined);
  const subtotal = Number(est.subtotal);
  const vatAmount = Number(est.vatAmount);
  const total = Number(est.total);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 print:max-w-full print:min-h-0 print:bg-white print:p-0">
      {/* White card surface so the preview reads as a discrete document
          even in dark mode — approximates the WhatsApp / PDF render
          the customer will see. On print the card chrome drops away so
          the paper copy is just the document. */}
      <div className="rounded-xl border border-border bg-white p-6 text-zinc-900 shadow-sm dark:bg-white dark:shadow-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("estimate")}
            </h1>
            <p className="text-sm text-zinc-500">
              {est.jobCard.vehicle.make} {est.jobCard.vehicle.model} ·{""}
              {est.jobCard.vehicle.plate}
              {est.jobCard.number ? (
                <> · <JobNumberBadge jobCard={est.jobCard} className="tabular-nums" /></>
              ) : null}
            </p>
          </div>
          <div className="text-right text-sm">
            <div className="font-medium">{garage.name}</div>
            <div className="text-zinc-500">TRN: {garage.trn ??"—"}</div>
            <div className="text-zinc-500">{garage.country}</div>
          </div>
        </div>

        <div className="mt-6 flex justify-between text-sm">
          <div>
            <div className="text-zinc-500">{t("billTo")}</div>
            <div className="font-medium">{customer.name}</div>
            <div className="text-zinc-500">{customer.phone}</div>
          </div>
          <div className="text-right text-zinc-500">
            <div>
              {est.sentAt
                ? `${t("issued")}: ${est.sentAt.toISOString().slice(0, 10)}`
                : `${t("issued")}: ${est.createdAt.toISOString().slice(0, 10)}`}
            </div>
          </div>
        </div>

        {/* Line items table — read-only. Each row is one priced line.
            Empty-state message in case the cashier hit Preview with
            zero lines (the edit page gates the Preview button on
            est.lines.length > 0, but defending here too). */}
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-zinc-500">
                <th className="py-1">{t("colDescription")}</th>
                <th className="py-1 text-right">{t("colQty")}</th>
                <th className="py-1 text-right">{t("colUnit")}</th>
                <th className="py-1 text-right">{t("colAmount")}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b border-black/5">
                  <td className="py-1">{translateLineDescription(l.description, locale)}</td>
                  <td className="py-1 text-right">{Number(l.qty)}</td>
                  <td className="py-1 text-right">
                    {Number(l.unitPrice).toFixed(2)}
                  </td>
                  <td className="py-1 text-right">
                    {Number(l.lineTotal).toFixed(2)}
                  </td>
                </tr>
              ))}
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-3 text-center text-zinc-500">
                    {t("noLineItems")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Totals — three-row breakdown matching what the customer
            will see in the WhatsApp link. Estimates don't get the
            invoice-style discount control (cashier folds any discount
            into a negative FEE line during pricing) so we keep the
            unconditional subtotal / VAT / total triple. */}
        <div className="mt-6 ml-auto text-right text-base tabular-nums">
          <div className="text-zinc-600">
            {t("subtotal")}: {money(subtotal)}
          </div>
          <div className="text-zinc-600">
            {t("vat5")}: {money(vatAmount)}
          </div>
          <div className="mt-1 text-lg font-semibold">
            {t("total")}: {money(total)}
          </div>
        </div>
      </div>

      {/* Bottom action bar — Go Back + Print always; Send only while
          DRAFT (still the ONLY surface that fires
          setEstimateStatusAction(SENT)). After Send this page stays
          reachable as the printable record, with a sent badge instead
          of the button. The whole bar hides on print. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            href={`/estimates/${est.id}`}
            className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-center text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          >
            {t("estimatePreviewGoBack")}
          </Link>
          <PrintButton className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
            {t("estimatePrint")}
          </PrintButton>
        </div>
        {isDraft ? (
          <form action={setEstimateStatusAction}>
            <input type="hidden" name="estimateId" value={est.id} />
            <input type="hidden" name="status" value="SENT"/>
            <button
              type="submit"
              className="inline-flex h-12 items-center justify-center rounded-lg bg-accent-500 px-5 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            >
              {t("estimateSendToCustomer")}
            </button>
          </form>
        ) : (
          <span className="inline-flex h-12 items-center justify-center rounded-lg bg-success-50 px-5 text-base font-semibold text-success-700 dark:bg-success-500/10 dark:text-success-500">
            ✓{" "}
            {est.status === "SENT" && est.sentAt
              ? `${t("estimatePreviewSentBadge")} · ${est.sentAt.toISOString().slice(0, 10)}`
              : est.status === "SENT"
                ? t("estimatePreviewSentBadge")
                : est.status}
          </span>
        )}
      </div>

      {isDraft ? (
        <p className="text-xs text-zinc-400 print:hidden">{t("estimatePreviewMockNote")}</p>
      ) : null}
    </main>
  );
}

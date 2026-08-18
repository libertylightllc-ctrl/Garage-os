import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { sendEstimateToCustomerAction } from "@/app/actions/billing";
import { PrintButton } from "@/components/print-button";
import { DocumentHeader } from "@/components/document-header";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { translateLineDescription } from "@/lib/line-item-translations";
import {
  LINE_FORM_ERROR_CODES,
  type LineFormErrorCode,
  findZeroPricedPartLines,
} from "@/lib/billing";
import type { MessageKey } from "@/i18n/config";

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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // Optional — real Next-App-Router always supplies an empty object
  // when there is no query; keeping the property optional avoids
  // rewriting existing unit tests that call the component directly.
  searchParams?: Promise<{ formError?: string }>;
}) {
  const { id } = await params;
  // sendEstimateToCustomerAction redirects back with ?formError=<code>
  // when the exit gate refuses (today: zero-part-lines-estimate).
  // Whitelist the code against LINE_FORM_ERROR_CODES before rendering.
  const { formError } = (await searchParams) ?? {};
  // ADVISOR included per KEY DECISION #5 (advisor prices + SENDS the
  // estimate) — it was missing here, so the editor's "Preview Estimate"
  // button bounced advisors back to their dashboard.
  const session = await requireAnyRole(["ADVISOR","CASHIER","OWNER","MASTER"]);
  const t = await getT();
  const locale = await getLocale();
  const lineFormErrorMessage: string | null = formError
    ? LINE_FORM_ERROR_CODES.has(formError as LineFormErrorCode)
      ? t(
          `lineFormErr_${(formError as LineFormErrorCode).replace(/-/g, "_")}` as MessageKey,
        )
      : t("lineFormErr_generic")
    : null;

  const est = await prisma.estimate.findFirst({
    where: { id, jobCard: { garageId: session.user.garageId } },
    include: {
      lines: { orderBy: { createdAt:"asc"} },
      jobCard: {
        include: {
          vehicle: { include: { customer: true } },
          garage: { select: { name: true, trn: true, country: true, logoUrl: true } },
        },
      },
    },
  });
  if (!est) notFound();
  const tz = countryToTimeZone(est.jobCard.garage.country);

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
        {/* Standardized document header — shared across every printable
            surface (job card, estimate, invoice, delivery, PO). Estimate
            has no gapless per-garage number so we identify by parent JC
            rather than invent an EST-… slug. */}
        {/* Internal preview of the customer-facing estimate — fall
            back to the GarageOS mark when the shop hasn't uploaded. */}
        <DocumentHeader
          title={t("estimate")}
          jobCard={est.jobCard}
          vehicle={est.jobCard.vehicle}
          garage={garage}
          logoUrl={garage.logoUrl ?? "/brand/garageos-logo.png"}
        />

        <div className="mt-6 flex justify-between text-sm">
          <div>
            <div className="text-zinc-500">{t("billTo")}</div>
            <div className="font-medium">{customer.name}</div>
            <div className="text-zinc-500">{customer.phone}</div>
          </div>
          <div className="text-right text-zinc-500">
            <div>
              {est.sentAt
                ? `${t("issued")}: ${fmtDate(est.sentAt, locale, tz)}`
                : `${t("issued")}: ${fmtDate(est.createdAt, locale, tz)}`}
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
              {lines.map((l) => {
                // Pre-flight chip on any non-declined PART @ 0.00 —
                // AR 2026-08-18. Preview renders the read-only table
                // (not via EstimateLineRow) so the chip inlines here.
                // Off-print so the customer's copy never carries the
                // chip on paper.
                const isUnpricedPart =
                  l.kind === "PART" && !l.declined && Number(l.unitPrice) === 0;
                return (
                  <tr key={l.id} className="border-b border-black/5">
                    <td className="py-1">
                      {translateLineDescription(l.description, locale)}
                      {isUnpricedPart ? (
                        <span
                          className="ms-2 inline-flex items-center rounded-full border border-warning-500/40 bg-warning-50 px-2 py-0.5 text-[10px] font-semibold text-warning-700 print:hidden dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500"
                          title={t("zeroPartsPreflightBody")}
                        >
                          {t("zeroPartsChip")}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1 text-right">{Number(l.qty)}</td>
                    <td className="py-1 text-right">
                      {Number(l.unitPrice).toFixed(2)}
                    </td>
                    <td className="py-1 text-right">
                      {Number(l.lineTotal).toFixed(2)}
                    </td>
                  </tr>
                );
              })}
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

      {/* Pre-flight warning (AR 2026-08-18) — same condition as the
          post-click gate, rendered before the advisor clicks Send so
          they see the offending lines while they can still fix them.
          Warning-yellow (informational), distinct from the danger-red
          post-click banner below. Off-print — the customer's copy of
          the estimate never carries this banner if the preview is
          accidentally printed mid-refusal. */}
      {(() => {
        const preflightZero = findZeroPricedPartLines(est.lines);
        if (preflightZero.length === 0) return null;
        return (
          <div
            role="status"
            className="rounded-xl border border-warning-500/40 bg-warning-50 px-4 py-2.5 text-sm text-warning-700 print:hidden dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500"
          >
            <div className="font-semibold">{t("zeroPartsPreflightTitle")}</div>
            <div className="mt-0.5">{t("zeroPartsPreflightBody")}</div>
            <ul className="mt-1 list-inside list-disc">
              {preflightZero.map((l) => (
                <li key={l.id}>{l.description}</li>
              ))}
            </ul>
          </div>
        );
      })()}

      {/* Inline validation banner (AR 2026-08-18) — sendEstimate refused
          because non-declined PART lines are at 0.00. Lists offending
          lines + a "Send anyway" form that resubmits with
          confirmZeroParts=1. Off-print so a mid-refusal print of the
          preview doesn't carry the banner onto paper. */}
      {lineFormErrorMessage ? (
        <div
          role="alert"
          className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 print:hidden dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500"
        >
          <div className="font-semibold">{t("lineFormErrorTitle")}</div>
          <div className="mt-0.5">{lineFormErrorMessage}</div>
          {formError === "zero-part-lines-estimate" ? (() => {
            const zeroLines = findZeroPricedPartLines(est.lines);
            if (zeroLines.length === 0) return null;
            return (
              <>
                <div className="mt-2 font-medium">{t("lineFormErr_zeroPartsHeading")}</div>
                <ul className="mt-1 list-inside list-disc">
                  {zeroLines.map((l) => (
                    <li key={l.id}>{l.description}</li>
                  ))}
                </ul>
                <form action={sendEstimateToCustomerAction} className="mt-3">
                  <input type="hidden" name="estimateId" value={est.id} />
                  <input type="hidden" name="confirmZeroParts" value="1" />
                  <button className="inline-flex h-10 items-center justify-center rounded-lg border border-danger-500/60 bg-danger-50 px-4 text-sm font-semibold text-danger-700 hover:bg-danger-100 dark:bg-danger-500/10 dark:text-danger-500 dark:hover:bg-danger-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-500/60">
                    {t("lineFormErr_sendAnyway")}
                  </button>
                </form>
              </>
            );
          })() : null}
        </div>
      ) : null}

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
        {/* AR 2026-08-16 estimate-send fix. Previously the Send form
            called setEstimateStatusAction(SENT), which built no wa.me
            URL and mocked the WhatsApp call away in prod (no Meta
            Cloud API creds) — the button stamped sentAt but WhatsApp
            never opened. sendEstimateToCustomerAction mirrors
            sendInvoiceToCustomerAction: builds the wa.me URL and
            redirects the browser to it, so WhatsApp opens with the
            message drafted. The action is idempotent — same form
            renders on the SENT-state pill below with a Resend label. */}
        <form action={sendEstimateToCustomerAction}>
          <input type="hidden" name="estimateId" value={est.id} />
          {isDraft ? (
            <button
              type="submit"
              className="inline-flex h-12 items-center justify-center rounded-lg bg-accent-500 px-5 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            >
              {t("estimateSendToCustomer")}
            </button>
          ) : (
            // AR 2026-08-15 estimate-honesty pass. Was a green ✓ pill
            // reading "Sent to the customer · <date>" — both the colour
            // and the wording implied delivery had happened. wa.me
            // returns no delivery signal (see src/lib/wa.ts + the
            // JobCard.invoiceSentAt schema comment). Now warning-yellow
            // with an honest label + a full banner below that mirrors
            // the invoice preview at src/app/invoices/[id]/preview/page.tsx
            // exactly, so estimate + invoice read the same. The
            // sentAt timestamp is what we know: when the hand-off fired.
            // AR 2026-08-16 — pill now sits next to a Resend submit
            // button, mirroring the invoice preview's post-send state
            // (invoiceResendViaWhatsApp).
            <div className="flex items-center gap-2">
              <span className="inline-flex h-12 items-center justify-center rounded-lg bg-warning-50 px-5 text-base font-semibold text-warning-700 dark:bg-warning-500/10 dark:text-warning-500">
                📱{" "}
                {est.sentAt
                  ? `${t("estimateSentAt")} ${fmtDate(est.sentAt, locale, tz)}`
                  : t("estimateSentAt")}
              </span>
              <button
                type="submit"
                className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
              >
                {t("estimateResendViaWhatsApp")}
              </button>
            </div>
          )}
        </form>
      </div>

      {isDraft ? (
        <p className="text-xs text-zinc-400 print:hidden">{t("estimatePreviewMockNote")}</p>
      ) : (
        // Footer banner mirrors the invoice preview (see src/app/
        // invoices/[id]/preview/page.tsx line ~316). Renders the
        // full honest text and the hand-off timestamp so the
        // operator can't miss that the customer hasn't received the
        // estimate yet.
        <p className="rounded-xl border border-warning-500/40 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500 print:hidden">
          📱 {t("estimateHandedOffBanner")}
          {est.sentAt
            ? ` · ${t("estimateSentAt")} ${fmtDate(est.sentAt, locale, tz)}`
            : ""}
        </p>
      )}
    </main>
  );
}

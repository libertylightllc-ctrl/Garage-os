import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { sendEstimateToCustomerAction } from "@/app/actions/billing";
import { PrintButton } from "@/components/print-button";
import { DocumentHeader } from "@/components/document-header";
import { CustomerPhoneNudge } from "@/components/customer-phone-nudge";
import { normalizeToE164 } from "@/lib/wa";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { translateLineDescription } from "@/lib/line-item-translations";
import { groupLinesBySection, type SectionedLine } from "@/lib/estimate-sections";
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
          // Batch C: garage.defaultPaymentTerms as the shop-wide
          // fallback for the Payment Terms block; advisor as the
          // live-name fallback when the snapshot isn't populated
          // (draft / never-sent estimates).
          garage: { select: { name: true, trn: true, address: true, country: true, logoUrl: true, defaultPaymentTerms: true } },
          advisor: { select: { name: true, phone: true } },
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
  // AR 2026-08-23 — soft nudge above the Send button when the
  // customer's phone can't be normalised. The action still lets the
  // send through (contact-picker fallback) — see the DELIBERATE
  // DIVERGENCE note on sendEstimateToCustomerAction. This banner
  // just makes the reason visible so the operator fixes the record
  // for next time.
  const customerPhoneRaw = customer.waId ?? customer.phone ?? null;
  const customerPhoneWillPrefill = normalizeToE164(customerPhoneRaw) !== null;
  // Non-declined lines only — declined items are customer-skipped and
  // shouldn't appear on the preview the customer sees.
  const lines = est.lines.filter((l) => !l.declined);
  const subtotal = Number(est.subtotal);
  const vatAmount = Number(est.vatAmount);
  const total = Number(est.total);

  // AR 2026-08-25 Batch C — group lines by section. The three-section
  // shape (Parts, Sublet/Consumables/Services, Labour) matches how a
  // real UAE-shop's estimate document reads. Discount lines (FEE with
  // negative unitPrice) render separately after the section subtotals.
  const sectioned = groupLinesBySection(
    lines.map<SectionedLine & { id: string }>((l) => ({
      id: l.id,
      kind: l.kind,
      description: l.description,
      qty: Number(l.qty),
      unitPrice: Number(l.unitPrice),
      lineTotal: Number(l.lineTotal),
      declined: l.declined,
    })),
  );

  // Advisor block: prefer the snapshot (captured at send time) over
  // the live advisor row so a staff change doesn't rewrite the
  // customer's copy of the doc. Snapshot is null on drafts +
  // never-sent estimates; falls back to the live advisor row then.
  const advisorName = est.advisorNameSnapshot ?? est.jobCard.advisor?.name ?? null;
  const advisorPhone = est.advisorPhoneSnapshot ?? est.jobCard.advisor?.phone ?? null;

  // Payment terms: per-estimate override falls through to garage
  // default. Both null → block doesn't render.
  const paymentTerms = est.paymentTerms ?? est.jobCard.garage.defaultPaymentTerms ?? null;

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

        {/* AR 2026-08-25 Batch C — sectioned line-items table matching
            the real UAE-shop estimate format:
              1. Parts
              2. Sublet / Consumables / Services
              3. Labour
            Each section has its own subtotal. Discount lines (FEE
            with negative unitPrice) render separately after the
            three section subtotals. Empty sections are omitted. */}
        <div className="mt-6 flex flex-col gap-6">
          {lines.length === 0 ? (
            <p className="py-3 text-center text-zinc-500">{t("noLineItems")}</p>
          ) : (
            <>
              {sectioned.parts.lines.length > 0 ? (
                <SectionTable
                  title={t("estimateSectionParts")}
                  lines={sectioned.parts.lines}
                  subtotal={sectioned.parts.subtotal}
                  locale={locale}
                  t={t}
                />
              ) : null}
              {sectioned.sublet.lines.length > 0 ? (
                <SectionTable
                  title={t("estimateSectionSublet")}
                  lines={sectioned.sublet.lines}
                  subtotal={sectioned.sublet.subtotal}
                  locale={locale}
                  t={t}
                />
              ) : null}
              {sectioned.labour.lines.length > 0 ? (
                <SectionTable
                  title={t("estimateSectionLabour")}
                  lines={sectioned.labour.lines}
                  subtotal={sectioned.labour.subtotal}
                  locale={locale}
                  t={t}
                />
              ) : null}
            </>
          )}
        </div>

        {/* Remarks block — per-estimate scope-limitation text. Only
            renders when the advisor has set one. Prints as a real
            content block on the customer's copy. */}
        {est.remarks ? (
          <div className="mt-6 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
              {t("estimateRemarksHeading")}
            </div>
            <p className="mt-1 whitespace-pre-line">{est.remarks}</p>
          </div>
        ) : null}

        {/* Totals — subtotal (sum of sections), discounts (if any),
            then VAT + total. AR 2026-08-25 Batch C — the sum-of-
            sections line uses sectioned.sumOfSections which matches
            the DB-stored est.subtotal for the non-discount case. */}
        <div className="mt-6 ml-auto text-right text-base tabular-nums">
          {sectioned.discounts.lines.length > 0 ? (
            <>
              <div className="text-zinc-600">
                {t("estimateTotalsSumOfSections")}: {money(sectioned.sumOfSections)}
              </div>
              {sectioned.discounts.lines.map((d) => (
                <div key={(d as { id?: string }).id ?? d.description} className="text-zinc-600">
                  {translateLineDescription(d.description, locale)}: {money(d.lineTotal)}
                </div>
              ))}
              <div className="text-zinc-600">
                {t("subtotal")}: {money(subtotal)}
              </div>
            </>
          ) : (
            <div className="text-zinc-600">
              {t("subtotal")}: {money(subtotal)}
            </div>
          )}
          <div className="text-zinc-600">
            {t("vat5")}: {money(vatAmount)}
          </div>
          <div className="mt-1 text-lg font-semibold">
            {t("total")}: {money(total)}
          </div>
        </div>

        {/* Payment terms + service advisor block — bottom of the doc,
            matching the real UAE-shop format. Both are optional and
            omit cleanly. AR 2026-08-25 Batch C. */}
        {paymentTerms || advisorName ? (
          <div className="mt-8 grid grid-cols-1 gap-4 border-t border-zinc-200 pt-4 text-sm sm:grid-cols-2">
            {paymentTerms ? (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
                  {t("estimatePaymentTermsHeading")}
                </div>
                <p className="mt-1 whitespace-pre-line">{paymentTerms}</p>
              </div>
            ) : <div />}
            {advisorName ? (
              <div className="sm:text-end">
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
                  {t("estimateAdvisorHeading")}
                </div>
                <div className="mt-1 font-medium">{advisorName}</div>
                {advisorPhone ? (
                  <div className="text-xs text-zinc-600 tabular-nums">{advisorPhone}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
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
        {!customerPhoneWillPrefill && (isDraft || est.status === "SENT") ? (
          <div className="w-full sm:w-auto">
            <CustomerPhoneNudge
              rawPhone={customerPhoneRaw}
              labels={{
                heading: t("phoneNudgeHeading"),
                rawLabel: t("phoneNudgeRawLabel"),
                rawNone: t("phoneNudgeRawNone"),
              }}
            />
          </div>
        ) : null}
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
            //
            // AR 2026-08-23 — Resend button ONLY renders while the
            // customer hasn't decided yet (status SENT). Was
            // unconditional on any non-DRAFT, which meant an APPROVED
            // or REJECTED estimate also showed the button — clicking
            // it fired sendEstimateToCustomerAction, which then (via
            // the OLD `isFirstSend = status !== "SENT"` bug at
            // billing.ts:747) silently reverted APPROVED → SENT and
            // wiped approvedAt. The server-side gate now refuses those
            // cases outright (see the action); this UI change removes
            // the affordance so a well-meaning advisor never sees the
            // click that would fire that gate.
            <div className="flex items-center gap-2">
              <span className="inline-flex h-12 items-center justify-center rounded-lg bg-warning-50 px-5 text-base font-semibold text-warning-700 dark:bg-warning-500/10 dark:text-warning-500">
                📱{" "}
                {est.sentAt
                  ? `${t("estimateSentAt")} ${fmtDate(est.sentAt, locale, tz)}`
                  : t("estimateSentAt")}
              </span>
              {est.status === "SENT" ? (
                <button
                  type="submit"
                  className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                >
                  {t("estimateResendViaWhatsApp")}
                </button>
              ) : null}
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

// AR 2026-08-25 Batch C — one section of the three-section estimate
// table. Rendered inline so declining a section becomes trivial (empty
// section → the caller doesn't render this at all). Cost/margin never
// on this doc — cashier-facing preview mirrors the customer's view.
function SectionTable({
    title,
    lines,
    subtotal,
    locale,
    t,
}: {
    title: string;
    lines: Array<{ id?: string; description: string; qty: number; unitPrice: number; lineTotal: number; kind: string; declined?: boolean }>;
    subtotal: number;
    locale: string;
    t: (k: MessageKey) => string;
}) {
    return (
        <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-600">{title}</h3>
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
                    {lines.map((l, i) => {
                        const isUnpricedCostAware =
                            (l.kind === "PART" || l.kind === "SUBLET") && !l.declined && Number(l.unitPrice) === 0;
                        return (
                            <tr key={l.id ?? i} className="border-b border-black/5">
                                <td className="py-1">
                                    {(l.description)}
                                    {isUnpricedCostAware ? (
                                        <span
                                            className="ms-2 inline-flex items-center rounded-full border border-warning-500/40 bg-warning-50 px-2 py-0.5 text-[10px] font-semibold text-warning-700 print:hidden dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500"
                                            title={t("zeroPartsPreflightBody")}
                                        >
                                            {t("zeroPartsChip")}
                                        </span>
                                    ) : null}
                                </td>
                                <td className="py-1 text-right">{l.qty.toLocaleString(locale)}</td>
                                <td className="py-1 text-right tabular-nums">{l.unitPrice.toFixed(2)}</td>
                                <td className="py-1 text-right tabular-nums">{l.lineTotal.toFixed(2)}</td>
                            </tr>
                        );
                    })}
                    <tr>
                        <td colSpan={3} className="py-1 text-right text-xs font-semibold text-zinc-600">
                            {t("estimateSectionSubtotal")}
                        </td>
                        <td className="py-1 text-right font-semibold tabular-nums">
                            {subtotal.toFixed(2)}
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

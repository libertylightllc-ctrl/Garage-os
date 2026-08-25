import { prisma } from "@/lib/prisma";
import { formatInvoiceNo } from "@/lib/billing";
import { resolveDocumentToken } from "@/lib/document-tokens";
import { getT, getLocale } from "@/i18n/server";
import { DocumentHeader } from "@/components/document-header";
import { InvoiceLineSection } from "@/components/invoice-line-section";
import { groupLinesBySection } from "@/lib/estimate-sections";
import { UAE_VAT_RATE } from "@/lib/vat";
import Link from "next/link";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

// Friendly "link isn't working" page — replaces the bare Next.js 404
// so a customer tapping a stale or preview-signed link sees actionable
// wording instead of a system error page. AR (2026-08-11): "A customer
// tapping an invoice link should never see a bare 404. Show a page
// saying the link is invalid or has expired… a 'not found' screen on a
// payment link loses money."
//
// The token shape is `<invoiceId>~<sig>`. Even when the signature
// mismatches (Preview vs Prod AUTH_SECRET, secret rotation, etc.), the
// id half is a real cuid — cheap to look up the invoice's garage from
// it so we can name the shop the customer was dealing with. If the
// signature IS valid but the row is missing (rare — nothing deletes
// invoices today) we treat it the same way.
// Server-log categorisation for invalid-link hits. AR (2026-08-11):
// "log those hits with the token that failed, so we can tell a
// mistyped link from a signature mismatch. A spike in signature
// failures would mean the secret changed, and right now we'd never
// know." Categories:
//   sig_mismatch — id half maps to a real invoice, sig didn't verify.
//                  Any sustained rate here means AUTH_SECRET rotated
//                  or a Preview link is being tapped from Prod.
//   row_missing  — id half looks like a cuid, no invoice with that id.
//                  Deleted invoice (shouldn't happen) or hand-typed id.
//   malformed    — token has no `~` at all, or the id half doesn't
//                  even look like a cuid. Truncation, screenshot copy,
//                  hand-editing.
//   sig_ok_row_missing — sig verified but invoice row was gone by
//                  read time. Race with a delete (currently impossible).
// Tagged prefix lets grep / Vercel log filters count spikes without a
// schema change; add a proper table when we have more than console.
type InvalidLinkKind =
  | "sig_mismatch"
  | "row_missing"
  | "malformed"
  | "sig_ok_row_missing";
function logInvalidLink(kind: InvalidLinkKind, token: string) {
  // Truncate the token so logs stay one-line even with a full cuid.
  const short = token.length > 40 ? `${token.slice(0, 32)}…(${token.length}ch)` : token;
  console.warn(`[c/invoice/invalid-link] kind=${kind} token=${short}`);
}

async function InvalidLinkPage({ rawId, token, kindHint }: {
  rawId: string;
  token: string;
  // Caller already knows whether the signature verified — the page
  // itself only needs to know whether to attempt the garage-name
  // lookup. Passed in so we can categorise before the DB hit.
  kindHint: "bad_sig" | "sig_ok_row_missing";
}) {
  const t = await getT();
  // Best-effort garage lookup — reveals only the garage NAME, never
  // invoice contents. Fails silently to a generic message if the id
  // half doesn't map to anything. Cuid v1 starts with `c` + 24 base32
  // chars — anything shorter is malformed, skip the DB round-trip.
  const looksLikeCuid = /^c[a-z0-9]{20,}$/.test(rawId);
  const fallback = looksLikeCuid
    ? await prisma.invoice.findUnique({
        where: { id: rawId },
        select: { garage: { select: { name: true } } },
      })
    : null;
  const garageName = fallback?.garage.name ?? null;

  // Category is derived here so it reflects what the DB actually
  // said, not just the caller's guess.
  const kind: InvalidLinkKind =
    kindHint === "sig_ok_row_missing"
      ? "sig_ok_row_missing"
      : !looksLikeCuid
        ? "malformed"
        : fallback
          ? "sig_mismatch"
          : "row_missing";
  logInvalidLink(kind, token);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6 text-center">
      <div className="text-4xl">🔗</div>
      <h1 className="text-xl font-semibold">{t("invoiceLinkInvalidTitle")}</h1>
      <p className="text-sm text-text-mute">
        {garageName
          ? t("invoiceLinkInvalidBodyNamed").replace("{garage}", garageName)
          : t("invoiceLinkInvalidBody")}
      </p>
    </main>
  );
}

export default async function CustomerInvoice({ params }: { params: Promise<{ id: string }> }) {
  const { id: tokenParam } = await params;
  // Keep the raw URL segment for the Download PDF link below — the
  // PDF route accepts the same dual-shape token (Phase-2 raw
  // publicToken OR Phase-1 HMAC), so passing whatever segment the
  // customer arrived with works for both.
  const token = tokenParam;
  // Phase 2 (2026-08-10): accepts both raw publicToken and Phase-1
  // HMAC-signed `<id>~<sig>`. Dispatch is inside resolveDocumentToken.
  const id = await resolveDocumentToken("invoice", token);
  // For the friendly fallback page, we want to still surface a garage
  // name when we can. HMAC tokens carry the id in the segment before
  // "~" (safe cheap lookup); raw publicTokens can only be resolved
  // via the same DB path that just failed, so the fallback is generic
  // for that shape. `rawId` is used ONLY for that name lookup, never
  // for authorization — resolveDocumentToken above is the gate.
  const rawId = token.includes("~") ? token.slice(0, token.lastIndexOf("~")) : "";
  if (!id) return <InvalidLinkPage rawId={rawId} token={token} kindHint="bad_sig" />;
  // AR 2026-08-12 (Step 5) — belt-and-braces hardening. Every field
  // is spelled out explicitly. The internal-only cost/margin columns
  // (EstimateLine.unitCost, EstimateLine.markupPct, InvoiceLine.unitCost)
  // introduced in the cost-based-pricing feature are DELIBERATELY NOT
  // listed here, so they never enter the RSC payload even if a future
  // dev adds a client component that echoes props (e.g. a `Totals`
  // panel receiving the invoice) to the browser.
  // Adding a new customer-visible field means adding it to
  // this list — a pinned test in
  // src/lib/__tests__/customer-invoice-line-fields.test.ts asserts
  // this select doesn't leak "unitCost" or "markupPct". A future
  // dev who reverts to `include: { lines: true }` fires that test.
  const inv = await prisma.invoice.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      issuedAt: true,
      dueDate: true,
      subtotal: true,
      vatAmount: true,
      total: true,
      status: true,
      clearanceStatus: true,
      qrPayload: true,
      voidedAt: true,
      customerTrn: true,
      // AR 2026-08-25 — parity blocks. Same fields the customer
      // estimate reads; snapshotted onto Invoice at generation time
      // so the two documents match.
      remarks: true,
      paymentTerms: true,
      advisorNameSnapshot: true,
      advisorPhoneSnapshot: true,
      lines: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          kind: true,
          description: true,
          qty: true,
          unitPrice: true,
          lineTotal: true,
          vatRate: true,
          // NB: unitCost is INTENTIONALLY OMITTED.
        },
      },
      payments: { select: { id: true, amount: true, method: true, paidAt: true } },
      garage: {
        select: {
          id: true,
          name: true,
          country: true,
          trn: true,
          address: true,
          logoUrl: true,
          // Batch D + split (2026-08-25): invoice-side terms only.
          // Estimate has its own column (estimateTerms) never read
          // by the customer invoice.
          invoiceTerms: true,
          // AR 2026-08-25 — fallback for the invoice's Payment
          // Terms block when the per-invoice override is null.
          defaultPaymentTerms: true,
          // Batch F1: fallback for advisor phone when the
          // individual advisor has no personal number set.
          phone: true,
        },
      },
      // Pull customer for Bill-to block + FTA-required customer TRN when
      // set. Customer.trn was added to Customer for B2B invoices; the
      // customer is VAT-registered → we must print their TRN on the tax
      // invoice so they can reclaim the VAT.
      jobCard: {
        select: {
          number: true,
          createdAt: true,
          vehicle: {
            select: {
              make: true,
              model: true,
              year: true,
              plate: true,
              vin: true,
              engineSize: true,
              fuelType: true,
              customer: {
                select: { name: true, phone: true, trn: true, lang: true },
              },
            },
          },
        },
      },
      // Void + reissue cross-references (2026-08-10). We only need
      // number + issuedAt for the small pill under the header — the
      // customer's copy doesn't link (they can't reach staff routes),
      // it just names the other document for their records.
      previousInvoice: { select: { number: true, issuedAt: true } },
      replacedBy: { select: { number: true, issuedAt: true } },
    },
  });
  if (!inv) return <InvalidLinkPage rawId={id} token={token} kindHint="sig_ok_row_missing" />;
  const t = await getT();
  // Customer-facing locale — when Arabic, swap known service names to
  // their Arabic equivalent via the dictionary (display only; stored
  // descriptions stay as the cashier typed them).
  const locale = await getLocale();

  const customer = inv.jobCard.vehicle.customer;
  const total = Number(inv.total);
  const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = Math.max(0, total - paid);
  const isPaid = inv.status ==="PAID"|| balance <= 0;

  // AR 2026-08-25 Batch D — sectioned line-items on the customer's
  // copy too, so the customer's estimate + invoice pair reads as one
  // document family instead of "sectioned quote / flat invoice". Same
  // helper the estimate + staff invoice preview use.
  const invoiceSections = groupLinesBySection(
    inv.lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      description: l.description,
      qty: Number(l.qty),
      unitPrice: Number(l.unitPrice),
      lineTotal: Number(l.lineTotal),
    })),
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="flex flex-col items-start gap-3">
        {/* Customer-facing tax invoice.
            Title MUST be "Tax Invoice" per UAE FTA — it identifies the
            document type for both the customer and the tax audit.
            Logo: pass raw logoUrl; when null the header falls back to
            text-only garage name (never our brand on a customer's
            invoice). */}
        <DocumentHeader
          title={t("taxInvoice")}
          documentNumber={formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
          jobCard={inv.jobCard}
          vehicle={inv.jobCard.vehicle}
          vinLabel={t("documentVinLabel")}
          garage={inv.garage}
          logoUrl={inv.garage.logoUrl}
        />
        {/* Void / replacement cross-references (2026-08-10). Two
            shapes — this doc is a void that's been replaced, or
            this doc is the replacement itself. Only one applies
            per row. Read-only text (no links) — customers can't
            reach the other document's URL from here anyway. */}
        {inv.status === "VOID" && inv.replacedBy ? (
          <p className="rounded-md border border-danger-500/40 bg-danger-50 px-3 py-1.5 text-xs text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {t("invoiceBadgeVoid")} · {t("invoiceReplacedByLabel")}{" "}
            <span className="font-medium">
              {formatInvoiceNo(inv.replacedBy.number, inv.replacedBy.issuedAt.getFullYear())}
            </span>
          </p>
        ) : null}
        {inv.previousInvoice ? (
          <p className="text-xs text-text-mute">
            {t("invoiceReplacesLabel")}{" "}
            <span className="font-medium">
              {formatInvoiceNo(inv.previousInvoice.number, inv.previousInvoice.issuedAt.getFullYear())}
            </span>
          </p>
        ) : null}
      </div>

      {/* Bill-to block — customer name and TRN (when present, VAT-
          registered). Customer TRN is labelled "Customer TRN" so it
          reads clearly as distinct from ours in the header. Phone is
          omitted from the customer's own invoice (not useful to them
          on a document they already have). */}
      <div className="text-sm">
        <div className="text-text-mute">{t("billTo")}</div>
        <div className="font-medium">{customer.name}</div>
        {/* Prefer the snapshot on the invoice row (frozen at
            generate time) over the live customer.trn — if the shop
            updated the customer's TRN after issuing this invoice,
            the historical document must still show what was issued.
            Falls through to the live value for invoices generated
            before the snapshot writer landed (they have null). */}
        {(inv.customerTrn ?? customer.trn) ? (
          <div className="text-text-mute">
            {t("customerTrnLabel")}: <span className="tabular-nums">{inv.customerTrn ?? customer.trn}</span>
          </div>
        ) : null}
      </div>

      {/* Line-item table — per-line VAT column added for FTA audit
          clarity. On a single-rate document the aggregate at the
          bottom is technically enough, but per-line matches FTA best
          practice and future-proofs for multi-rate lines. */}
      {/* AR 2026-08-25 Batch D — three-section render matching the
          estimate. Empty sections are omitted. The theming defaults
          on InvoiceLineSection use zinc/black; override to the
          themed palette so this reads correctly under dark mode
          (customer may be viewing on their phone at any time). */}
      <div className="flex flex-col gap-6 overflow-x-auto">
        {inv.lines.length === 0 ? (
          <p className="py-3 text-center text-text-mute">{t("noLineItems")}</p>
        ) : (
          <>
            <InvoiceLineSection
              title={t("estimateSectionParts")}
              lines={invoiceSections.parts.lines}
              subtotal={invoiceSections.parts.subtotal}
              locale={locale}
              t={t}
              vatRate={UAE_VAT_RATE}
              borderClass="border-b border-border"
              subtleTextClass="text-text-mute"
              subtotalRowClass="border-t border-border"
              headingClass="text-text-mute"
            />
            <InvoiceLineSection
              title={t("estimateSectionSublet")}
              lines={invoiceSections.sublet.lines}
              subtotal={invoiceSections.sublet.subtotal}
              locale={locale}
              t={t}
              vatRate={UAE_VAT_RATE}
              borderClass="border-b border-border"
              subtleTextClass="text-text-mute"
              subtotalRowClass="border-t border-border"
              headingClass="text-text-mute"
            />
            <InvoiceLineSection
              title={t("estimateSectionLabour")}
              lines={invoiceSections.labour.lines}
              subtotal={invoiceSections.labour.subtotal}
              locale={locale}
              t={t}
              vatRate={UAE_VAT_RATE}
              borderClass="border-b border-border"
              subtleTextClass="text-text-mute"
              subtotalRowClass="border-t border-border"
              headingClass="text-text-mute"
            />
          </>
        )}
      </div>
      <div className="border-t border-border pt-2 text-right text-sm">
        <div>{t("totalGrossLabel")}: {money(Number(inv.subtotal))}</div>
        <div>{t("totalVatLabel")}: {money(Number(inv.vatAmount))}</div>
        <div className="text-lg font-semibold">{t("totalNetLabel")}: {money(total)}</div>
      </div>

      {inv.remarks?.trim() ? (
        // AR 2026-08-25 Batch F2.7 — yellow fill (print-safe).
        <div className="rounded-lg border border-yellow-400 bg-yellow-100 px-3 py-2 text-sm text-zinc-900 [-webkit-print-color-adjust:exact] [print-color-adjust:exact]">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-700">
            {t("estimateRemarksHeading")}
          </div>
          <p className="mt-1 whitespace-pre-line">{inv.remarks}</p>
        </div>
      ) : null}

      {(() => {
        const paymentTerms =
          (inv.paymentTerms?.trim() || inv.garage.defaultPaymentTerms?.trim()) || null;
        const advisorName = inv.advisorNameSnapshot?.trim() || null;
        const advisorPhone =
          inv.advisorPhoneSnapshot?.trim() ||
          inv.garage.phone?.trim() ||
          null;
        if (!paymentTerms && !advisorName) return null;
        return (
          <div className="grid grid-cols-1 gap-4 border-t border-border pt-3 text-sm sm:grid-cols-2">
            {paymentTerms ? (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-text-mute">
                  {t("estimatePaymentTermsHeading")}
                </div>
                <p className="mt-1 whitespace-pre-line">{paymentTerms}</p>
              </div>
            ) : <div />}
            {advisorName ? (
              <div className="sm:text-end">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-mute">
                  {t("estimateAdvisorHeading")}
                </div>
                <div className="mt-1 font-medium">{advisorName}</div>
                {advisorPhone ? (
                  <div className="text-sm text-text-mute tabular-nums">
                    {advisorPhone}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })()}

      {/* AR 2026-08-25 Batch D — shop-wide Terms & Conditions,
          bottom of the customer-facing invoice. Renders only when
          set; blank = no block. */}
      {inv.garage.invoiceTerms ? (
        <div className="border-t border-border pt-3 text-xs">
          <div className="font-semibold uppercase tracking-wide text-text-mute">
            {t("documentTermsHeading")}
          </div>
          <p className="mt-1 whitespace-pre-line leading-relaxed">
            {inv.garage.invoiceTerms}
          </p>
        </div>
      ) : null}

      {isPaid ? (
        <p className="rounded-xl border border-success-500/40 bg-success-50 p-4 text-center text-sm font-semibold text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          {t("paidThanks")}
        </p>
      ) : (
        <p className="rounded-xl border border-border bg-surface-2 p-4 text-center text-sm">
          {t("payAtGarage")} · {money(balance)}
        </p>
      )}

      {/* Download PDF — public route, same signed token as this page.
          The customer can save the tax invoice to their phone /
          forward it to an accountant / attach it to their expense
          claim without depending on the browser's Print → Save-as-PDF
          dance (which many mobile WhatsApp in-app browsers don't
          expose reliably). */}
      <Link
        href={`/c/invoice/${token}/pdf`}
        className="inline-flex h-11 items-center justify-center rounded-lg border border-border bg-surface px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors print:hidden"
      >
        📄 {t("invoiceDownloadPdf")}
      </Link>
    </main>
  );
}

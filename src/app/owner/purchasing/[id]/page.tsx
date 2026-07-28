import Link from "next/link";
import { notFound } from "next/navigation";
import { Printer, MessageCircle } from "lucide-react";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { DocumentHeader } from "@/components/document-header";
import { PrintButton } from "@/components/print-button";
import { SendPoViaWhatsAppButton } from "@/components/SendPoViaWhatsAppButton";
import { PoSentHistory } from "@/components/PoSentHistory";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { Button } from "@/components/ui/button";
import { stockOptionSuffix } from "@/lib/stock-label";
import { normalizeToE164 } from "@/lib/wa";
import { resolvePoVehicles, formatVehicleShort } from "@/lib/po-vehicle";
import { poDocKind, isLineUnpriced } from "@/lib/po-doc-kind";
import {
  addPoLineAction,
  editPoLineAction,
  removePoLineAction,
  setPoStatusAction,
  receivePurchaseOrderAction,
  returnPurchaseOrderAction,
  sendPurchaseOrderWhatsAppAction,
} from "@/app/actions/purchasing";

export const dynamic = "force-dynamic";

// Inventory 2a — purchase order detail. Build lines while DRAFT, then send
// (→ ORDERED) or cancel. Receiving (→ RECEIVED, moves stock) arrives in 2b.
// OWNER-only, garage-scoped.
export default async function PurchaseOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    emailOk?: string;
    emailError?: string;
  }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const t = await getT();
  const locale = await getLocale();
  const { id } = await params;
  const { error, emailOk, emailError } = await searchParams;
  const garage = await prisma.garage.findUnique({
    where: { id: session.user.garageId },
    select: { name: true, trn: true, country: true, logoUrl: true },
  });
  const tz = countryToTimeZone(garage?.country ?? "UAE");

  const po = await prisma.purchaseOrder.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      // Widened select — phone/email/contactPerson feed the print
      // header block + the WhatsApp send button. All optional on
      // Supplier, all handled gracefully when absent.
      supplier: {
        select: {
          name: true,
          phone: true,
          email: true,
          contactPerson: true,
        },
      },
      lines: {
        orderBy: { createdAt: "asc" },
        include: {
          part: {
            select: {
              name: true,
              sku: true,
              // Vehicle chain — resolves to a vehicle when the
              // Part was spun up via the from-estimate flow; null
              // otherwise. See resolvePoVehicles for the rendering
              // logic that turns this into per-line / per-doc
              // context. Nested include is intentional — one query
              // instead of N+1.
              autoCreatedFromLine: {
                include: {
                  estimate: {
                    include: {
                      jobCard: {
                        select: {
                          number: true,
                          vehicle: {
                            select: {
                              id: true,
                              make: true,
                              model: true,
                              year: true,
                              plate: true,
                              vin: true,
                              engineSize: true,
                              fuelType: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!po) notFound();

  const isDraft = po.status === "DRAFT";
  // Receiving surfaces once the PO has been sent. `showReceiving` reveals the
  // received/outstanding columns; `canReceive` shows the receive form (still
  // has outstanding qty to take in).
  const showReceiving =
    po.status === "ORDERED" || po.status === "PARTIALLY_RECEIVED" || po.status === "RECEIVED";
  const canReceive = po.status === "ORDERED" || po.status === "PARTIALLY_RECEIVED";
  // Returns (2c) apply once stock has been received. `showReturned` reveals
  // the Returned column; `canReturn` shows the return form (a line still has
  // received stock that hasn't been returned).
  const showReturned = po.status === "PARTIALLY_RECEIVED" || po.status === "RECEIVED";
  const canReturn = showReturned && po.lines.some((l) => l.receivedQty - l.returnedQty > 0);

  // Parts available to add (active, garage-scoped) for the line dropdown.
  const parts = isDraft
    ? await prisma.part.findMany({
        where: { garageId: session.user.garageId, active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, sku: true, cost: true, qtyOnHand: true, reorderLevel: true },
      })
    : [];
  // 3a — read-only stock hint in the line picker (helps decide order qty).
  const stockHint = (p: { qtyOnHand: number; reorderLevel: number }) =>
    stockOptionSuffix(p.qtyOnHand, p.reorderLevel, {
      inStock: t("inStockShort"),
      low: t("lowStockTag"),
      out: t("outOfStock"),
    });

  const money = (v: number) =>
    new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(v);
  const total = po.lines.reduce((s, l) => s + l.qty * Number(l.unitCost), 0);

  // ── Print / send derivations ─────────────────────────────────
  // RFQ/PO classifier — shared with the 4 other document surfaces
  // via `poDocKind`. AR's rule: ANY unpriced line means the shop
  // isn't committing to a price on that line, so the whole document
  // is an RFQ. Only a fully-priced document is a Purchase Order.
  const isRfq = poDocKind(po.lines) === "RFQ";
  const docTitle = isRfq ? t("documentRfq") : t("documentPurchaseOrder");
  // The visible identifier for print / WhatsApp — supplier's own
  // quote reference if they gave us one (helps them match against
  // THEIR record), otherwise the last 6 chars of our PO id as a
  // fallback so we always show something.
  const docNumber = po.reference?.trim() ? po.reference : `#${po.id.slice(-6).toUpperCase()}`;

  // The public /c/po/[token] link used to be built here and appended
  // to the wa.me body. Both send channels now compose that URL inside
  // their own actions — the page no longer needs to build or render
  // it.

  // Vehicle context — resolved from the auto-created chain.
  // Feeds the Vehicle column in the table below AND the header
  // shape in the WhatsApp/email body. See resolvePoVehicles for
  // the null semantics (unresolved lines render "—" on the surface
  // and "(no vehicle linked)" in the message body).
  const vehicles = resolvePoVehicles(po.lines);

  // The shared message body used to be built here for the wa.me href.
  // It now lives inside sendPurchaseOrderWhatsAppAction (and C's email
  // action) — the same purchaseOrderMessage() shape, called from ONE
  // place per channel so the copy still can't drift. This page only
  // needs to know whether the supplier phone is usable enough to
  // enable the button, not what would go through it.

  // WhatsApp — the button is now a form POST that hits
  // sendPurchaseOrderWhatsAppAction. That action writes a HANDED_OFF
  // audit row before redirecting to wa.me, so we no longer build the
  // wa.me URL here. Client-side normalizeToE164 still runs to gate
  // the disabled state: no valid phone → show the button disabled
  // rather than round-trip through the action just to fail.
  const phoneE164 = normalizeToE164(po.supplier.phone);
  const waDisabled = !phoneE164;

  const printedOnLabel = fmtDate(new Date(), locale, tz);

  return (
    <div>
      {/* Nav is hidden on print — a printed PO/RFQ shouldn't carry app
          chrome to the supplier. */}
      <div className="print:hidden">
        <AppNav role="OWNER" active="purchasing" />
      </div>
      <main className="mx-auto max-w-3xl space-y-6 p-6 print:max-w-none print:p-0">
        {/* Back link — off-print. */}
        <div className="print:hidden">
          <Link
            href="/owner/purchasing"
            className="text-xs uppercase tracking-widest text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("backToPurchasing")}
          </Link>
        </div>

        {/* Action bar — Print + Send via WhatsApp. Hidden on print.
            Email dispatch is a separate channel held on MAIL_FROM
            domain verification and rides in the next commit. */}
        <div className="flex flex-wrap items-center gap-3 print:hidden">
          <PrintButton className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-semibold hover:bg-surface-2">
            <Printer aria-hidden="true" className="h-4 w-4" />
            {t("printPo")}
          </PrintButton>
          <SendPoViaWhatsAppButton
            action={sendPurchaseOrderWhatsAppAction}
            poId={po.id}
            label={t("sendViaWhatsApp")}
            disabled={waDisabled}
            disabledReason={waDisabled ? t("supplierNoPhoneReason") : undefined}
          />
        </div>

        {/* Email send outcome banners. The failure code comes from
            the action as a small enum — never as the provider's own
            error text — so nothing untrusted / user-hostile / secret
            (API messages sometimes carry keys or account details)
            reaches the URL or the DOM. Unknown / legacy codes fall
            back to the generic message. Real error text is logged
            server-side only. */}
        {emailOk ? (
          <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500 print:hidden">
            {t("emailSentOk")}
          </p>
        ) : null}
        {emailError ? (
          <div className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500 print:hidden">
            <div className="font-semibold">{t("emailSentError")}</div>
            <div className="mt-0.5">
              {(() => {
                // Whitelist. Anything else → generic. Do NOT extend
                // this by writing `t(\`emailErr_${code}\`)` blindly —
                // that would send arbitrary URL-supplied strings
                // straight into the i18n lookup (and, on miss, back
                // into the DOM).
                const KNOWN = new Set([
                  "no_recipient",
                  "unverified_domain",
                  "not_configured",
                  "provider_error",
                ] as const);
                type KnownCode = typeof KNOWN extends Set<infer T> ? T : never;
                if (KNOWN.has(emailError as KnownCode)) {
                  return t(`emailErr_${emailError as KnownCode}` as const);
                }
                return t("emailErr_generic");
              })()}
            </div>
          </div>
        ) : null}

        {/* Sent history — one row per send attempt (WhatsApp click or
            email dispatch), newest first. Every attempt visible; no
            dedupe. Off-print — the log is for the shop, not the
            supplier. See PoSentHistory for the honesty-about-WhatsApp
            wording. */}
        <PoSentHistory
          purchaseOrderId={po.id}
          garageId={session.user.garageId}
          timeZone={tz}
        />

        <div>
          {/* Standardized document header. Title switches between
              "Purchase Order" and "Request for Quotation" based on
              whether the lines have prices — an unpriced doc going
              to a supplier is an RFQ, and calling it a PO would be
              dishonest labelling. PO has no vehicle and no gapless
              per-garage number — supplier name plays the role of
              the identifying line, and the supplier's own quote
              number (if present) renders as "Supplier ref: …" so a
              reader never assumes it's OUR document number. */}
          <div className="mt-1">
            <DocumentHeader
              title={docTitle}
              supplier={{
                name: po.supplier.name,
                reference: po.reference,
                refLabel: t("supplierRef"),
              }}
              garage={{
                name: garage?.name ?? "",
                trn: garage?.trn ?? null,
                country: garage?.country ?? "UAE",
              }}
              logoUrl={garage?.logoUrl ?? "/brand/garageos-logo.png"}
            />
          </div>

          {/* Print-only supplemental block. Everything DocumentHeader
              doesn't already carry: the date the printout was made,
              the supplier's contact details (so a phone call to
              follow up can happen off the printed page), and a
              totals row. Renders only on print (`hidden print:block`)
              — screen state stays as it was. */}
          <section className="mt-3 hidden text-xs text-zinc-700 print:block">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              <div>
                <span className="font-medium">{t("printedOn")}:</span> {printedOnLabel}
              </div>
              <div>
                <span className="font-medium">{t("printSupplierContact")}:</span>{" "}
                {[
                  po.supplier.contactPerson,
                  po.supplier.phone,
                  po.supplier.email,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </div>
              <div className="col-span-2 border-t border-zinc-300 pt-1">
                <span className="font-medium">{t("printTotalsLabel")}:</span>{" "}
                {po.lines.length} {t("poLines").toLowerCase()}
                {/* On RFQ, suppressing the money total — a partial sum
                    (priced lines only) reads as "the shop's cost" which
                    it isn't; a full sum including 0.00 lines under-counts.
                    Neither is a number worth showing. */}
                {isRfq ? null : <> · {money(total)}</>}
              </div>
            </div>
          </section>
          {/* Status pill + summary caption below the header. Status
              moved out of the h1 so the standardized stacked shape stays
              consistent with the other document surfaces. */}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
              {t(`poStatus_${po.status}`)}
            </span>
            <span>
              {po.lines.length} {t("poLines").toLowerCase()}
              {isRfq ? null : <> · {money(total)}</>}
            </span>
          </div>
          {po.note ? <p className="mt-1 text-sm text-muted-foreground">{po.note}</p> : null}
        </div>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        {/* Fully received banner */}
        {po.status === "RECEIVED" && po.receivedAt ? (
          <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
            {t("poReceivedBanner")} {fmtDate(po.receivedAt, locale, tz)}
          </p>
        ) : null}

        {/* Lines */}
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t("partName")}</th>
                <th className="px-4 py-3">{t("colVehicle")}</th>
                <th className="px-4 py-3 text-right">{t("poOrdered")}</th>
                {showReceiving ? <th className="px-4 py-3 text-right">{t("poReceived")}</th> : null}
                {showReceiving ? <th className="px-4 py-3 text-right">{t("poOutstanding")}</th> : null}
                {showReturned ? <th className="px-4 py-3 text-right">{t("poReturned")}</th> : null}
                <th className="px-4 py-3 text-right">{t("poUnitCost")}</th>
                <th className="px-4 py-3 text-right">{t("poLineTotal")}</th>
                {isDraft ? <th className="px-4 py-3" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {po.lines.map((l) => {
                const outstanding = l.qty - l.receivedQty;
                // DRAFT lines are editable in place. HTML5 `form=` lets
                // the qty + unitCost inputs live in their normal cells
                // while being form-associated with the edit <form> in
                // the actions cell — otherwise a <form> spanning
                // multiple <td>s wouldn't be valid HTML. Non-DRAFT rows
                // stay read-only; server-side guard also rejects.
                const editFormId = `edit-po-line-${l.id}`;
                const lineVehicle = vehicles.perLine.get(l.id) ?? null;
                return (
                  <tr key={l.id}>
                    <td className="px-4 py-3 font-medium">
                      {l.part.name} <span className="font-mono text-xs text-muted-foreground">{l.part.sku}</span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {lineVehicle ? (
                        <div className="space-y-0.5">
                          <div className="font-medium">
                            {formatVehicleShort(lineVehicle)}
                          </div>
                          {lineVehicle.vin ? (
                            <div className="font-mono text-[10px] text-muted-foreground">
                              VIN {lineVehicle.vin}
                            </div>
                          ) : null}
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            JC-{lineVehicle.jobNumber}
                          </div>
                        </div>
                      ) : (
                        <span
                          className="text-muted-foreground"
                          title={t("noVehicleLinkedReason")}
                        >
                          {t("noVehicleLinkedShort")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {isDraft ? (
                        <input
                          type="number"
                          name="qty"
                          min="1"
                          step="1"
                          required
                          defaultValue={l.qty}
                          form={editFormId}
                          aria-label={t("colQty")}
                          className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-right text-sm tabular-nums"
                        />
                      ) : (
                        l.qty
                      )}
                    </td>
                    {showReceiving ? (
                      <td className="px-4 py-3 text-right tabular-nums">{l.receivedQty}</td>
                    ) : null}
                    {showReceiving ? (
                      <td
                        className={
                          "px-4 py-3 text-right tabular-nums " +
                          (outstanding > 0 ? "font-medium text-warning-600" : "text-muted-foreground")
                        }
                      >
                        {outstanding}
                      </td>
                    ) : null}
                    {showReturned ? (
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{l.returnedQty}</td>
                    ) : null}
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {isDraft ? (
                        <input
                          type="number"
                          name="unitCost"
                          min="0"
                          step="0.01"
                          required
                          defaultValue={Number(l.unitCost).toFixed(2)}
                          form={editFormId}
                          aria-label={t("poUnitCost")}
                          className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-right text-sm tabular-nums"
                        />
                      ) : isLineUnpriced(l) ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span>—</span>
                          {/* "quote please" tag — rendered as its OWN
                              element next to the cost cell, NOT
                              concatenated into any user-visible
                              string. Description passes through to
                              WhatsApp verbatim; we do not want a
                              future refactor sending "Battery 70Ah
                              (quote please)" as the description into
                              a persisted store. */}
                          <span className="rounded-md border border-warning-500/40 bg-warning-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                            {t("lineUnpricedTag")}
                          </span>
                        </span>
                      ) : (
                        money(Number(l.unitCost))
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {isLineUnpriced(l) ? "—" : money(l.qty * Number(l.unitCost))}
                    </td>
                    {isDraft ? (
                      <td className="px-4 py-3 text-right print:hidden">
                        <div className="flex items-center justify-end gap-2">
                          {/* Edit form — inputs live in the cells above,
                              associated by the `form=` attribute.
                              hidden poId+lineId + Save button live here. */}
                          <form id={editFormId} action={editPoLineAction} className="inline-flex">
                            <input type="hidden" name="poId" value={po.id} />
                            <input type="hidden" name="lineId" value={l.id} />
                            <button className="text-xs text-brand-900 hover:underline dark:text-white" type="submit">
                              {t("save")}
                            </button>
                          </form>
                          <span aria-hidden="true" className="text-muted-foreground">·</span>
                          <form action={removePoLineAction} className="inline-flex">
                            <input type="hidden" name="poId" value={po.id} />
                            <input type="hidden" name="lineId" value={l.id} />
                            <button className="text-xs text-danger-700 hover:underline" type="submit">
                              {t("remove")}
                            </button>
                          </form>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {po.lines.length === 0 ? (
                <tr>
                  <td colSpan={isDraft ? 6 : 5} className="px-4 py-8 text-center text-muted-foreground">
                    {t("noPoLines")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {/* Everything below the lines table is interactive editing —
            receive, return, add-line, status transitions. All hidden on
            print. The printable content ends at the lines table above. */}
        <div className="contents print:hidden">

        {/* Receive delivery — PARTIAL receiving (2b). Enter how many of each
            line arrived NOW (≤ outstanding). Defaults to the full outstanding
            for a one-tap "everything arrived", but can be reduced for a
            partial delivery; receive again later for the rest. */}
        {canReceive ? (
          <section className="space-y-3 rounded-xl border border-border p-4">
            <h2 className="text-base font-semibold tracking-tight">{t("poReceiveHeading")}</h2>
            <p className="text-xs text-muted-foreground">{t("poReceiveHint")}</p>
            <form action={receivePurchaseOrderAction} className="space-y-2">
              <input type="hidden" name="poId" value={po.id} />
              {po.lines.map((l) => {
                const outstanding = l.qty - l.receivedQty;
                return (
                  <div key={l.id} className="flex items-center justify-between gap-3 border-b border-border/60 pb-2 last:border-0">
                    <span className="min-w-0 truncate text-sm">
                      {l.part.name}
                      <span className="ms-2 text-xs text-muted-foreground">
                        {l.receivedQty}/{l.qty} {t("poReceivedLower")}
                        {outstanding > 0 ? <> · {outstanding} {t("poOutstandingLower")}</> : null}
                      </span>
                    </span>
                    {outstanding > 0 ? (
                      <input
                        name={`recv_${l.id}`}
                        type="number"
                        min="0"
                        max={outstanding}
                        defaultValue={outstanding}
                        aria-label={t("poReceiveNow")}
                        className="w-20 shrink-0 rounded-md border border-border bg-transparent px-2 py-1.5 text-right text-sm tabular-nums"
                      />
                    ) : (
                      <span className="shrink-0 text-xs font-medium text-success-700 dark:text-success-500">✓</span>
                    )}
                  </div>
                );
              })}
              <div className="pt-1">
                <Button type="submit" variant="hero">{t("poReceiveButton")}</Button>
              </div>
            </form>
          </section>
        ) : null}

        {/* Return to supplier — PARTIAL returns (2c). Enter how many of each
            received line to send back; stock drops by that amount and the
            line's returnedQty rises. Defaults to 0 (returns are the exception,
            not the norm). Capped at what's still returnable (received − already
            returned); the action also refuses to drive stock negative. */}
        {canReturn ? (
          <section className="space-y-3 rounded-xl border border-border p-4">
            <h2 className="text-base font-semibold tracking-tight">{t("poReturnHeading")}</h2>
            <p className="text-xs text-muted-foreground">{t("poReturnHint")}</p>
            <form action={returnPurchaseOrderAction} className="space-y-2">
              <input type="hidden" name="poId" value={po.id} />
              {po.lines.map((l) => {
                const returnable = l.receivedQty - l.returnedQty;
                return (
                  <div key={l.id} className="flex items-center justify-between gap-3 border-b border-border/60 pb-2 last:border-0">
                    <span className="min-w-0 truncate text-sm">
                      {l.part.name}
                      <span className="ms-2 text-xs text-muted-foreground">
                        {l.returnedQty}/{l.receivedQty} {t("poReturnedLower")}
                        {returnable > 0 ? <> · {returnable} {t("poReturnableLower")}</> : null}
                      </span>
                    </span>
                    {returnable > 0 ? (
                      <input
                        name={`ret_${l.id}`}
                        type="number"
                        min="0"
                        max={returnable}
                        defaultValue="0"
                        aria-label={t("poReturnNow")}
                        className="w-20 shrink-0 rounded-md border border-border bg-transparent px-2 py-1.5 text-right text-sm tabular-nums"
                      />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                );
              })}
              <div className="pt-1">
                <Button type="submit" variant="ghost">{t("poReturnButton")}</Button>
              </div>
            </form>
          </section>
        ) : null}

        {/* Add line — draft only */}
        {isDraft ? (
          <section className="space-y-3 rounded-xl border border-border p-4">
            <h2 className="text-base font-semibold tracking-tight">{t("addPoLine")}</h2>
            {parts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("noPartsForPo")}{" "}
                <Link href="/owner/inventory" className="font-medium text-foreground hover:underline">
                  {t("tabInventory")}
                </Link>
                .
              </p>
            ) : (
              <form action={addPoLineAction} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <input type="hidden" name="poId" value={po.id} />
                <label className="col-span-2 flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("partName")}</span>
                  <select name="partId" required defaultValue="" className="rounded-md border border-border bg-transparent px-3 py-2 text-sm">
                    <option value="" disabled>{t("choosePlaceholder")}</option>
                    {parts.map((p) => (
                      <option key={p.id} value={p.id} data-cost={String(p.cost)}>
                        {p.name} ({p.sku}) · {stockHint(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("adjustQty")}</span>
                  <input name="qty" type="number" min="1" required className="rounded-md border border-border bg-transparent px-3 py-2 text-sm" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("poUnitCost")}</span>
                  <input name="unitCost" type="number" step="0.01" min="0" required className="rounded-md border border-border bg-transparent px-3 py-2 text-sm" />
                </label>
                <div className="col-span-2 flex items-end sm:col-span-4">
                  <Button type="submit">{t("addPoLine")}</Button>
                </div>
              </form>
            )}
          </section>
        ) : null}

        {/* Status actions */}
        {po.status === "DRAFT" || po.status === "ORDERED" ? (
          <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4">
            {po.status === "DRAFT" ? (
              <form action={setPoStatusAction}>
                <input type="hidden" name="poId" value={po.id} />
                <input type="hidden" name="status" value="ORDERED" />
                <Button type="submit" variant="hero">{t("markOrdered")}</Button>
              </form>
            ) : null}
            <form action={setPoStatusAction}>
              <input type="hidden" name="poId" value={po.id} />
              <input type="hidden" name="status" value="CANCELLED" />
              <Button type="submit" variant="ghost">{t("cancelPo")}</Button>
            </form>
          </section>
        ) : null}
        </div>
      </main>
    </div>
  );
}

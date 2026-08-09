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
import { fmtDate, fmtDateTime, countryToTimeZone } from "@/lib/format-datetime";
import { Button } from "@/components/ui/button";
import { stockOptionSuffix } from "@/lib/stock-label";
import { normalizeToE164 } from "@/lib/wa";
import { resolvePoVehicles, formatVehicleShort } from "@/lib/po-vehicle";
import { poDocKind, isLinePriced, isLineUnpriced, canMarkOrdered } from "@/lib/po-doc-kind";
import { VehicleMatchFill } from "@/components/vehicle-match-fill";
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
    mode?: string;
  }>;
}) {
  const session = await requireAnyRole(["OWNER", "MASTER"]);
  const t = await getT();
  const locale = await getLocale();
  const { id } = await params;
  const { error, emailOk, emailError, mode: rawMode } = await searchParams;
  // Two-mode passthrough (2026-08-02). The create action redirects here
  // with ?mode=quote|order. On order mode the add-line cost input renders
  // `required` and shows a hint. Whitelist to avoid an arbitrary query
  // string silently changing behavior.
  const orderMode = rawMode === "order";
  const garage = await prisma.garage.findUnique({
    where: { id: session.user.garageId },
    select: { name: true, trn: true, country: true, logoUrl: true },
  });
  const tz = countryToTimeZone(garage?.country ?? "UAE");

  // Stock movements written by receipts / returns on this PO. Pulled
  // in newest-first so the reader sees the most recent activity at
  // the top. The Part join gives us the SKU + name column; the
  // PartMovement.purchaseOrderId FK was added 2026-08-09 with the
  // new writers below (this query returns [] for POs whose only
  // receipts pre-date the migration).
  const poMovements = await prisma.partMovement.findMany({
    where: { purchaseOrderId: id, garageId: session.user.garageId },
    orderBy: { createdAt: "desc" },
    include: { part: { select: { name: true, sku: true } } },
  });

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
              // No `autoCreatedFromLine` — removed 2026-08-02 with the
              // resolver's chain fallback. Vehicle resolution now
              // reads only the line's own snapshot columns
              // (vehicleId, vehicleMake, …), which is what the
              // supplier actually saw when the document was sent.
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
  // Garage vehicles for the Add-line vehicle datalist (per-line
  // override or set-when-no-default). Same query shape as the new-
  // quotation form.
  const vehiclesForPicker = isDraft
    ? await prisma.vehicle.findMany({
        where: { customer: { garageId: session.user.garageId } },
        orderBy: [{ make: "asc" }, { model: "asc" }],
        select: { id: true, plate: true, make: true, model: true, year: true },
        take: 500,
      })
    : [];
  // Compact caption for the doc-level default — "FORD FOCUS 2014 · T35970"
  // — used above the Add-line vehicle widget so the owner can see what
  // new lines will inherit if they don't override.
  const docDefaultVehicleLabel = (() => {
    const bits: string[] = [];
    const nm = [po.defaultVehicleMake, po.defaultVehicleModel]
      .filter(Boolean)
      .join(" ");
    if (nm) bits.push(nm + (po.defaultVehicleYear ? ` ${po.defaultVehicleYear}` : ""));
    if (po.defaultVehiclePlate) bits.push(po.defaultVehiclePlate);
    return bits.length ? bits.join(" · ") : null;
  })();
  // 3a — read-only stock hint in the line picker (helps decide order qty).
  const stockHint = (p: { qtyOnHand: number; reorderLevel: number }) =>
    stockOptionSuffix(p.qtyOnHand, p.reorderLevel, {
      inStock: t("inStockShort"),
      low: t("lowStockTag"),
      out: t("outOfStock"),
    });

  const money = (v: number) =>
    new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(v);
  // Total = sum of qty * unitCost, but ONLY over lines with a
  // priced unitCost. A document with any awaiting-quote line renders
  // total as "—" instead of a number — a quotation must never show a
  // supplier "Total: 0.00" that includes unpriced lines as zero.
  // See the render block for the null branch.
  const anyLineUnpriced = po.lines.some((l) => !isLinePriced(l));
  const total = anyLineUnpriced
    ? null
    : po.lines.reduce((s, l) => s + l.qty * Number(l.unitCost), 0);
  // Mark Ordered gate — mirrors the server-side canMarkOrdered guard in
  // setPoStatusAction so the button is visibly disabled when the guard
  // would refuse. Same rule: empty PO or any unpriced line → false.
  // The action still enforces this authoritatively; disabling here is
  // affordance, not security.
  const canOrder = canMarkOrdered(po.lines);
  const markOrderedReason = canOrder ? undefined : t("markOrderedNeedsPricesReason");

  // ── Print / send derivations ─────────────────────────────────
  // Status + intent classifier (2026-08-02). DRAFT with intent=ORDER
  // reads as "Purchase Order (draft)"; DRAFT with intent=QUOTE (or
  // pre-intent rows, which backfilled to QUOTE) reads as "Request
  // for Quotation". Committed rows (status=ORDERED / PARTIALLY_
  // RECEIVED / RECEIVED / CANCELLED-with-orderedAt) always read as
  // "Purchase order" — Mark Ordered is still the ONLY thing that
  // turns a quotation into a committed purchase order.
  const docKind = poDocKind({
    status: po.status,
    orderedAt: po.orderedAt,
    intent: po.intent,
  });
  const isRfq = docKind === "RFQ";
  const docTitle =
    docKind === "RFQ"
      ? t("documentRfq")
      : docKind === "PO_DRAFT"
      ? t("documentPurchaseOrderDraft")
      : t("documentPurchaseOrder");
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
  // Doc-level default is passed to the resolver so lines with no
  // per-line snapshot (older rows, or any manual add that skipped the
  // write-time copy) fall back to the doc default at render time.
  const vehicles = resolvePoVehicles(po.lines, {
    defaultVehicleId: po.defaultVehicleId,
    defaultVehicleMake: po.defaultVehicleMake,
    defaultVehicleModel: po.defaultVehicleModel,
    defaultVehicleYear: po.defaultVehicleYear,
    defaultVehiclePlate: po.defaultVehiclePlate,
    defaultVehicleVin: po.defaultVehicleVin,
    defaultVehicleEngineSize: po.defaultVehicleEngineSize,
    defaultVehicleFuelType: po.defaultVehicleFuelType,
    defaultVehicleJobNumber: po.defaultVehicleJobNumber,
  });

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
      <main data-print-document="po-edit" className="mx-auto max-w-3xl space-y-6 p-6 print:max-w-none print:p-0">
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
        {/* Visible reason when Send-via-WhatsApp is disabled — the
            component sets the tooltip via `title=`, but a tooltip is
            invisible on touch and non-obvious on desktop. The button
            appeared silently dead until this caption landed. Mirrors
            the Mark Ordered disabled-reason pattern below. */}
        {waDisabled ? (
          <p className="text-xs text-muted-foreground print:hidden">
            {t("supplierNoPhoneReason")}
          </p>
        ) : null}

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
                {/* total is guaranteed non-null on the !isRfq branch
                    (canMarkOrdered enforces all-lines-priced at
                    DRAFT→ORDERED and edit inputs are DRAFT-only), but
                    coalesce so TS doesn't have to prove that. */}
                {isRfq ? null : <> · {money(total ?? 0)}</>}
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
              {isRfq ? null : <> · {money(total ?? 0)}</>}
            </span>
          </div>
          {po.note ? <p className="mt-1 text-sm text-muted-foreground">{po.note}</p> : null}
        </div>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {/* Structured codes from editPoLineAction get their own
                message so the copy can be locale-aware and specific.
                Anything else (legacy string errors) passes through
                verbatim for now. */}
            {error === "stale_line"
              ? t("poLineStaleError")
              : error === "line_not_found"
              ? t("poLineNotFoundError")
              : error}
          </p>
        ) : null}

        {/* Fully received banner */}
        {po.status === "RECEIVED" && po.receivedAt ? (
          <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
            {t("poReceivedBanner")} {fmtDate(po.receivedAt, locale, tz)}
          </p>
        ) : null}

        {/* Lines */}
        <div className="overflow-x-auto rounded-xl border border-border">
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
                      {/* Free-text RFQ lines (Layer 0): l.part is null
                          until the shop links a catalogue Part (Layer 5).
                          Fall back to the row's own description/sku. */}
                      {l.part?.name ?? l.description} <span className="font-mono text-xs text-muted-foreground">{l.part?.sku ?? l.sku ?? ""}</span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {lineVehicle ? (
                        // 2026-08-02 (fix #3 followup): each detail on
                        // its own row so a supplier can identify the
                        // right part. "Toyota Land Cruiser 2021" alone
                        // isn't enough to pick a filter for a specific
                        // trim; the engine + plate + VIN are what
                        // matter. Rows that are null just don't render.
                        <div className="space-y-0.5">
                          {lineVehicle.make || lineVehicle.model ? (
                            <div className="font-medium">
                              {[lineVehicle.make, lineVehicle.model]
                                .filter(Boolean)
                                .join(" ")}
                            </div>
                          ) : null}
                          {lineVehicle.year != null ? (
                            <div className="text-[11px] text-muted-foreground">
                              {lineVehicle.year}
                            </div>
                          ) : null}
                          {lineVehicle.engineSize || lineVehicle.fuelType ? (
                            <div className="text-[11px] text-muted-foreground">
                              {[lineVehicle.engineSize, lineVehicle.fuelType]
                                .filter(Boolean)
                                .join(" ")}
                            </div>
                          ) : null}
                          {lineVehicle.plate ? (
                            <div className="text-[11px] font-medium">
                              {lineVehicle.plate}
                            </div>
                          ) : null}
                          {lineVehicle.vin ? (
                            <div className="font-mono text-[10px] text-muted-foreground">
                              VIN {lineVehicle.vin}
                            </div>
                          ) : null}
                          {lineVehicle.jobNumber != null ? (
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                              JC-{lineVehicle.jobNumber}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        // Empty on print (supplier surface) + a subdued
                        // dash on screen for staff so the column doesn't
                        // read as broken. The internal "(no vehicle
                        // linked)" wording is gone as of 2026-08-02 —
                        // AR's rule: print + supplier surfaces show
                        // nothing, and the screen inherits the cleaner
                        // shape.
                        <span
                          className="text-muted-foreground print:hidden"
                          aria-hidden="true"
                        >
                          —
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
                        // Blank = awaiting quote (Layer 0). If the row's
                        // stored unitCost is null, render an empty input,
                        // NOT `Number(null).toFixed(2)` = "0.00" — a
                        // supplier reading a printed draft would read
                        // 0.00 as a quoted price of zero. `required` is
                        // dropped for the same reason: the server side
                        // accepts null via parseMoney's { ok:true,
                        // value: null } branch, so the browser must not
                        // block re-saving a legitimately-blank row.
                        <input
                          type="number"
                          name="unitCost"
                          min="0"
                          step="0.01"
                          defaultValue={isLineUnpriced(l) ? "" : Number(l.unitCost).toFixed(2)}
                          placeholder="—"
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
                      <td className="px-4 py-3 text-right whitespace-nowrap print:hidden">
                        <div className="flex items-center justify-end gap-2">
                          {/* Edit form — inputs live in the cells above,
                              associated by the `form=` attribute.
                              hidden poId+lineId + Save button live here. */}
                          <form id={editFormId} action={editPoLineAction} className="inline-flex">
                            <input type="hidden" name="poId" value={po.id} />
                            <input type="hidden" name="lineId" value={l.id} />
                            {/* Stale-write guard: the row's `updatedAt`
                                comes back verbatim so the server can
                                refuse a save from a tab that opened
                                before someone else's write landed. See
                                editPoLineAction. */}
                            <input
                              type="hidden"
                              name="expectedUpdatedAt"
                              value={l.updatedAt.toISOString()}
                            />
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
                      {l.part?.name ?? l.description}
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
                      {l.part?.name ?? l.description}
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
            {/* Layer 1 (2026-08-02): datalist combo. The owner can pick
                an existing catalogue Part by name OR type free text for
                a part the shop doesn't stock — both paths add a line.
                Free-text ships as description-only (partId null); an
                exact-name match resolves to a catalogue Part server-
                side. No Part row is ever created here — stock only
                moves at goods receipt (Layer 5). */}
            <form action={addPoLineAction} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <input type="hidden" name="poId" value={po.id} />
              <label className="col-span-2 flex flex-col gap-1">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("partName")}</span>
                <input
                  name="lineText"
                  type="text"
                  required
                  list="po-add-line-parts"
                  autoComplete="off"
                  placeholder={t("addPoLinePlaceholder")}
                  className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                />
                {/* Suggestions from the catalogue — a picked value fills
                    the input with the Part.name verbatim, which the
                    server matches case-insensitively. */}
                <datalist id="po-add-line-parts">
                  {parts.map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.sku} · {stockHint(p)}
                    </option>
                  ))}
                </datalist>
                <span className="text-[11px] text-muted-foreground">
                  {t("addPoLineHint")}
                </span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("adjustQty")}</span>
                <input name="qty" type="number" min="1" required className="rounded-md border border-border bg-transparent px-3 py-2 text-sm" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{t("poUnitCost")}</span>
                {/* Layer 0 rule: blank = awaiting a supplier quote.
                    Two-mode (2026-08-02) sets `required` on order mode
                    only — the browser blocks empty submits so a
                    "purchase order" doesn't accidentally land with a
                    line the shop hasn't priced. Quote mode stays
                    optional. Server accepts either via parseMoney. */}
                <input
                  name="unitCost"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="—"
                  required={orderMode}
                  className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                />
                {orderMode ? (
                  <span className="text-[11px] text-muted-foreground">
                    {t("orderModeCostRequired")}
                  </span>
                ) : null}
              </label>
              {/* Per-line vehicle (2026-08-02). If the PO has a doc-level
                  default, show a "For: FORD FOCUS 2014 · T35970 — Change"
                  caption above the collapsed override — the owner can
                  expand it to type a different car for this specific
                  line. Server rule: if the owner leaves the line-level
                  fields blank AND a doc default exists, that default
                  is copied into the line's own snapshot at write time
                  (never referenced live afterwards). If both are absent
                  the line ships with no vehicle, and public/print
                  surfaces render nothing rather than "(no vehicle
                  linked)" — internal wording only. */}
              <details className="col-span-2 rounded-md border border-border/60 bg-surface-2/40 p-2 sm:col-span-4">
                <summary className="flex cursor-pointer items-center justify-between gap-2 text-xs text-muted-foreground">
                  {docDefaultVehicleLabel ? (
                    <span>
                      <strong className="font-semibold text-foreground">
                        {t("poAddLineVehicleFor")}:
                      </strong>{" "}
                      {docDefaultVehicleLabel}
                    </span>
                  ) : (
                    <span>{t("poAddLineNoDefaultVehicle")}</span>
                  )}
                  <span className="text-[11px] font-medium text-foreground underline-offset-2 hover:underline">
                    {t("poAddLineVehicleChange")}
                  </span>
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">
                      {t("vehiclePlateLabel")}
                    </span>
                    <input
                      name="vehicle_plate"
                      type="text"
                      list="po-add-line-vehicle-plates"
                      autoComplete="off"
                      placeholder={t("vehiclePlatePlaceholder")}
                      className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                    />
                    <datalist id="po-add-line-vehicle-plates">
                      {vehiclesForPicker.map((v) => (
                        <option key={v.id} value={v.plate}>
                          {v.make} {v.model}
                          {v.year ? ` (${v.year})` : ""}
                        </option>
                      ))}
                    </datalist>
                  </label>
                  {/* Job # — alternate identifier that resolves the
                      same vehicle. Advisor typically has the JC in
                      front of them. Client matcher cross-fills the
                      plate when this hits. */}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">
                      {t("vehicleJobNumberLabel")}
                    </span>
                    <input
                      name="vehicle_jobNumber"
                      type="number"
                      inputMode="numeric"
                      min="1"
                      autoComplete="off"
                      placeholder={t("vehicleJobNumberPlaceholder")}
                      className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm tabular-nums"
                    />
                  </label>
                  <VehicleMatchFill
                    plateName="vehicle_plate"
                    jobNumberName="vehicle_jobNumber"
                    makeName="vehicle_make"
                    modelName="vehicle_model"
                    yearName="vehicle_year"
                    engineName="vehicle_engineSize"
                    vinName="vehicle_vin"
                    labels={{
                      matchedLabel: t("vehicleMatchLabel"),
                      dismissLabel: t("vehicleMatchDismiss"),
                      vinLabel: t("vehicleVinLabel"),
                    }}
                  />
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <input
                      name="vehicle_make"
                      type="text"
                      placeholder={t("vehicleMakeLabel")}
                      className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                    />
                    <input
                      name="vehicle_model"
                      type="text"
                      placeholder={t("vehicleModelLabel")}
                      className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                    />
                    <input
                      name="vehicle_year"
                      type="number"
                      inputMode="numeric"
                      min="1900"
                      max="2100"
                      placeholder={t("vehicleYearLabel")}
                      className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                    />
                    <input
                      name="vehicle_engineSize"
                      type="text"
                      placeholder={t("vehicleEngineLabel")}
                      className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                    />
                  </div>
                  <input
                    name="vehicle_vin"
                    type="text"
                    maxLength={17}
                    placeholder={t("vehicleVinLabel")}
                    className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm font-mono"
                  />
                </div>
              </details>
              <div className="col-span-2 flex items-end sm:col-span-4">
                <Button type="submit">{t("addPoLine")}</Button>
              </div>
            </form>
          </section>
        ) : null}

        {/* Stock movements from this order (2026-08-09). Rendered
            when the PO has produced any receipts / returns. Each row
            links back to the affected Part's detail page, closing
            the loop with the "From PO" column on that page. */}
        {poMovements.length > 0 ? (
          <section className="space-y-3 rounded-xl border border-border p-4 print:hidden">
            <h2 className="text-base font-semibold tracking-tight">
              {t("poMovementsTitle")}
            </h2>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">{t("movementWhen")}</th>
                    <th className="px-3 py-2">{t("colDescription")}</th>
                    <th className="px-3 py-2">{t("poMovementsKind")}</th>
                    <th className="px-3 py-2 text-right">{t("movementChange")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {poMovements.map((m) => (
                    <tr key={m.id}>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {fmtDateTime(m.createdAt, locale, tz)}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/owner/inventory/${m.partId}`}
                          className="font-medium hover:underline"
                        >
                          {m.part.name}
                        </Link>
                        {m.part.sku ? (
                          <span className="ms-2 font-mono text-xs text-muted-foreground">
                            {m.part.sku}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
                        {m.kind === "PO_RECEIPT"
                          ? t("poMovementsReceipt")
                          : m.kind === "PO_RETURN"
                            ? t("poMovementsReturn")
                            : m.kind}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium ${
                          m.delta >= 0 ? "text-success-700" : "text-danger-700"
                        }`}
                      >
                        {m.delta >= 0 ? "+" : ""}
                        {m.delta}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {/* Status actions */}
        {po.status === "DRAFT" || po.status === "ORDERED" ? (
          <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4">
            {po.status === "DRAFT" ? (
              <form action={setPoStatusAction}>
                <input type="hidden" name="poId" value={po.id} />
                <input type="hidden" name="status" value="ORDERED" />
                <Button
                  type="submit"
                  variant="hero"
                  disabled={!canOrder}
                  title={markOrderedReason}
                  aria-disabled={!canOrder}
                >
                  {t("markOrdered")}
                </Button>
                {markOrderedReason ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {markOrderedReason}
                  </p>
                ) : null}
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

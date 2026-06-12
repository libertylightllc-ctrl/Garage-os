import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  addInvoiceLineAction,
  updateInvoiceLineAction,
  removeInvoiceLineAction,
  setInvoiceDiscountAction,
  emailInvoiceAction,
  // sendInvoiceToCustomerAction → /invoices/[id]/preview only.
  // recordPaymentAction → /cashier Receivables row only.
  // Both moved out so the edit page can only edit; mutations that
  // affect the customer (WhatsApp send) or the books (payment) live
  // on their own contextual surfaces.
} from "@/app/actions/billing";
import { PrintButton } from "@/components/print-button";
// DISCOUNT_DESCRIPTION_MARKER moved out of billing.ts because that file
// is "use server" and can only export async functions — exporting a
// regexp from there broke the whole module under Turbopack on Vercel
// (every action came back as 'export not found'). Now imported from a
// plain module that both this page and billing.ts can share without
// triggering the server-action export check.
import { DISCOUNT_DESCRIPTION_MARKER } from "@/lib/invoice-discount";
import { arState, AR_EMOJI, formatInvoiceNo } from "@/lib/billing";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function InvoiceView({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // ?emailed=1 lights up the green 'Invoice emailed to customer'
  // confirmation banner after emailInvoiceAction redirects back.
  searchParams: Promise<{ emailed?: string }>;
}) {
  const { id } = await params;
  const { emailed } = await searchParams;
  const justEmailed = emailed === "1";
  const session = await auth();
  if (!session?.user) redirect("/login");

  const inv = await prisma.invoice.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      lines: { orderBy: { createdAt: "asc" } },
      payments: true,
      garage: true,
      jobCard: { include: { vehicle: { include: { customer: true } } } },
    },
  });
  if (!inv) notFound();
  const t = await getT();

  const total = Number(inv.total);
  const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = Math.max(0, total - paid);
  const state = arState(total, paid, inv.dueDate, new Date());
  const customer = inv.jobCard.vehicle.customer;
  // Line edits are unlocked for cashier/owner only while the invoice
  // is still 'pre-send'. Once sendInvoiceToCustomerAction stamps
  // jobCard.invoiceSentAt the inputs disappear and the table falls
  // back to the existing read-only render (matches what the server-
  // side ownedEditableInvoice helper enforces).
  const canEditLines =
    ["CASHIER", "OWNER"].includes(session.user.role) && !inv.jobCard.invoiceSentAt;

  // Pull the discount line out of the main line array so the table
  // shows only real work + the totals area shows the discount as a
  // distinct row. There's at most one discount line — setInvoice
  // DiscountAction guarantees this by wiping any old discount line
  // before adding the new one. Marker pattern: 'Discount (...)' on
  // the description, stored as a FEE line with a negative amount.
  const discountLine = inv.lines.find((l) =>
    DISCOUNT_DESCRIPTION_MARKER.test(l.description),
  );
  const workLines = inv.lines.filter(
    (l) => !DISCOUNT_DESCRIPTION_MARKER.test(l.description),
  );
  // 'gross' = subtotal BEFORE discount (parts + labour only). Stored
  // invoice.subtotal already has the discount baked in — recompute
  // gross from the work-only lines so the totals area can show the
  // breakdown the user asked for.
  const grossSubtotal = workLines.reduce((s, l) => s + Number(l.lineTotal), 0);
  const discountAmount = discountLine ? Math.abs(Number(discountLine.lineTotal)) : 0;
  // Parse 'Discount (2%)' / 'Discount (fixed)' to render a small badge
  // showing which path the cashier used.
  const discountLabelKey = (() => {
    if (!discountLine) return null;
    const m = discountLine.description.match(/^Discount \((\d+(?:\.\d+)?)%\)/);
    if (m) return { mode: "PERCENT" as const, value: Number(m[1]) };
    return { mode: "AMOUNT" as const, value: discountAmount };
  })();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 print:max-w-full print:bg-white print:p-0 print:text-zinc-900">
      {/* Role-aware Back link — mirrors the /estimates/[id] pattern.
          Cashier (and owner) goes back to the Invoices tab of the
          dashboard; advisor goes back to the parent job. Tech doesn't
          normally land here. print:hidden so the customer's PDF
          doesn't carry a stray nav element. */}
      <Link
        href={
          session.user.role === "ADVISOR"
            ? `/advisor/jobs/${inv.jobCardId}`
            : "/cashier?tab=invoices"
        }
        className="inline-block py-2 text-sm text-zinc-500 hover:underline print:hidden dark:text-zinc-400"
      >
        {session.user.role === "ADVISOR"
          ? t("backJob")
          : t("invoiceBackToCashier")}
      </Link>

      {/* '?emailed=1' confirmation banner — green strip across the
          top, click-through to dismiss (just navigate without the
          searchParam). Hidden on print so it doesn't end up on the
          customer's PDF. */}
      {justEmailed ? (
        <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 print:hidden dark:bg-green-950 dark:text-green-200">
          📧 {t("invoiceEmailedConfirmation")}
        </div>
      ) : null}

      {/* Action bar — Print Invoice / Print Receipt (when paid) /
          Email Invoice. All three hidden from the print output so
          the document the customer sees is just the invoice itself.
          The WhatsApp send button on /invoices/[id]/preview stays
          where it was — per spec, this slice doesn't touch it. */}
      <div className="flex flex-wrap gap-2 print:hidden">
        <PrintButton className="rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
          🖨️ {t("invoicePrintInvoice")}
        </PrintButton>
        {state === "PAID" ? (
          <Link
            href={`/invoices/${inv.id}/receipt`}
            target="_blank"
            rel="noopener"
            className="rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            🧾 {t("invoicePrintReceipt")}
          </Link>
        ) : null}
        {["CASHIER", "OWNER"].includes(session.user.role) ? (
          customer.email ? (
            <form action={emailInvoiceAction} className="contents">
              <input type="hidden" name="invoiceId" value={inv.id} />
              <button
                type="submit"
                className="rounded-md border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
              >
                📧 {t("invoiceEmailInvoice")}
              </button>
            </form>
          ) : (
            <span
              aria-disabled="true"
              title={t("invoiceEmailNoEmailOnFile")}
              className="cursor-not-allowed rounded-md border border-black/10 px-3 py-1.5 text-sm font-medium text-zinc-400 dark:border-white/10 dark:text-zinc-600"
            >
              📧 {t("invoiceEmailNoEmailOnFile")}
            </span>
          )
        ) : null}
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("taxInvoice")}</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="font-medium">{inv.garage.name}</div>
          <div className="text-zinc-500 dark:text-zinc-400">TRN: {inv.garage.trn ?? "—"}</div>
          <div className="text-zinc-500 dark:text-zinc-400">{inv.garage.country}</div>
        </div>
      </div>

      <div className="flex justify-between text-sm">
        <div>
          <div className="text-zinc-500 dark:text-zinc-400">{t("billTo")}</div>
          <div className="font-medium">{customer.name}</div>
          <div className="text-zinc-500 dark:text-zinc-400">{customer.phone}</div>
          <div className="text-zinc-500 dark:text-zinc-400">
            {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model} · {inv.jobCard.vehicle.plate}
          </div>
        </div>
        <div className="text-right text-zinc-500 dark:text-zinc-400">
          <div>{t("issued")}: {inv.issuedAt.toISOString().slice(0, 10)}</div>
          <div>{t("due")}: {inv.dueDate.toISOString().slice(0, 10)}</div>
          <div>{t("clearance")}: {inv.clearanceStatus}</div>
        </div>
      </div>

      <div className="overflow-x-auto">
      <table className="w-full min-w-[20rem] text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/15">
            <th className="py-1">{t("colDescription")}</th>
            <th className="py-1 text-right">{t("colQty")}</th>
            <th className="py-1 text-right">{t("colUnit")}</th>
            <th className="py-1 text-right">{t("colAmount")}</th>
            {canEditLines ? <th className="py-1" /> : null}
          </tr>
        </thead>
        <tbody>
          {workLines.map((l) =>
            canEditLines ? (
              // Inline edit: one form per row. qty + unit price + description
              // all editable. Recompute happens server-side via
              // updateInvoiceLineAction → recomputeInvoice; totals refresh
              // on revalidatePath.
              <tr key={l.id} className="border-b border-black/5 align-top dark:border-white/10">
                <td className="py-1 pr-2" colSpan={4}>
                  <form
                    action={updateInvoiceLineAction}
                    className="grid grid-cols-[1fr_5rem_6rem_6rem_auto_auto] items-center gap-2"
                  >
                    <input type="hidden" name="invoiceId" value={inv.id} />
                    <input type="hidden" name="lineId" value={l.id} />
                    <input type="hidden" name="kind" value={l.kind} />
                    <input
                      name="description"
                      defaultValue={l.description}
                      className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
                    />
                    <input
                      name="qty"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={Number(l.qty)}
                      aria-label={t("colQty")}
                      className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-end text-sm tabular-nums dark:border-white/20"
                    />
                    <input
                      name="unitPrice"
                      type="number"
                      step="0.01"
                      defaultValue={Number(l.unitPrice).toFixed(2)}
                      aria-label={t("colUnit")}
                      className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-end text-sm tabular-nums dark:border-white/20"
                    />
                    <span className="tabular-nums text-end text-sm">
                      {Number(l.lineTotal).toFixed(2)}
                    </span>
                    <button
                      type="submit"
                      className="rounded-md border border-black/15 px-2 py-1 text-xs font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
                    >
                      {t("saveDraft")}
                    </button>
                  </form>
                  <form action={removeInvoiceLineAction} className="mt-1 flex justify-end">
                    <input type="hidden" name="invoiceId" value={inv.id} />
                    <input type="hidden" name="lineId" value={l.id} />
                    <button
                      type="submit"
                      className="text-xs text-red-600 hover:underline"
                      aria-label={t("removeLine")}
                    >
                      ✕ {t("removeLine")}
                    </button>
                  </form>
                </td>
              </tr>
            ) : (
              <tr key={l.id} className="border-b border-black/5 dark:border-white/10">
                <td className="py-1">{l.description}</td>
                <td className="py-1 text-right">{Number(l.qty)}</td>
                <td className="py-1 text-right">{Number(l.unitPrice).toFixed(2)}</td>
                <td className="py-1 text-right">{Number(l.lineTotal).toFixed(2)}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      </div>

      {canEditLines ? (
        // Add a new line — labor / part / fee selectable. Mirrors the
        // estimate-line add form so the cashier sees the same controls
        // they used while pricing the estimate. DISCOUNT short-circuits
        // to a negative FEE per the existing convention.
        <form
          action={addInvoiceLineAction}
          className="rounded-lg border border-black/10 p-3 print:hidden dark:border-white/15"
        >
          <input type="hidden" name="invoiceId" value={inv.id} />
          <div className="mb-2 text-sm font-medium">{t("addLineTitle")}</div>
          <div className="grid grid-cols-[6rem_1fr_4.5rem_6rem_auto] items-center gap-2">
            <select
              name="kind"
              defaultValue="LABOR"
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
              aria-label={t("colKind")}
            >
              <option value="LABOR">{t("kindLabor")}</option>
              <option value="PART">{t("kindPart")}</option>
              <option value="FEE">{t("kindFee")}</option>
              <option value="DISCOUNT">{t("kindDiscount")}</option>
            </select>
            <input
              name="description"
              placeholder={t("colDescription")}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
            <input
              name="qty"
              type="number"
              step="0.01"
              min="0"
              defaultValue="1"
              aria-label={t("colQty")}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-end text-sm tabular-nums dark:border-white/20"
            />
            <input
              name="unitPrice"
              type="number"
              step="0.01"
              defaultValue="0"
              aria-label={t("colUnit")}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-end text-sm tabular-nums dark:border-white/20"
            />
            <button
              type="submit"
              className="rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-black"
            >
              {t("addLineButton")}
            </button>
          </div>
        </form>
      ) : null}

      {/* Discount section — two side-by-side forms, one for % and one
          for a fixed AED amount. Whichever the cashier submits replaces
          the existing discount (setInvoiceDiscountAction wipes the prior
          discount line before writing the new one, so there's never
          stacking). A third 'Remove' form shows when a discount is
          already applied. Discount applies BEFORE VAT — handled in
          recomputeInvoice via the negative FEE line. */}
      {canEditLines ? (
        <div className="rounded-lg border border-black/10 p-3 print:hidden dark:border-white/15">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t("discountSectionTitle")}</span>
            {discountLabelKey ? (
              <span className="text-xs text-rose-700 dark:text-rose-400">
                {discountLabelKey.mode === "PERCENT"
                  ? t("discountCurrentPercent").replace(
                      "{pct}",
                      String(discountLabelKey.value),
                    )
                  : t("discountCurrentFixed").replace(
                      "{amount}",
                      money(discountLabelKey.value),
                    )}{" "}
                · −{money(discountAmount)}
              </span>
            ) : (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {t("discountNone")}
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <form
              action={setInvoiceDiscountAction}
              className="flex items-center gap-2 rounded-md border border-black/10 p-2 dark:border-white/15"
            >
              <input type="hidden" name="invoiceId" value={inv.id} />
              <input type="hidden" name="mode" value="PERCENT" />
              <label className="text-xs text-zinc-600 dark:text-zinc-300">
                {t("discountPercentLabel")}
              </label>
              <input
                name="value"
                type="number"
                step="0.01"
                min="0"
                max="100"
                placeholder="2"
                aria-label={t("discountPercentLabel")}
                className="w-20 rounded-md border border-black/15 bg-transparent px-2 py-1 text-end text-sm tabular-nums dark:border-white/20"
              />
              <span className="text-xs text-zinc-500 dark:text-zinc-400">%</span>
              <button
                type="submit"
                className="ms-auto rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-black"
              >
                {t("discountApply")}
              </button>
            </form>
            <form
              action={setInvoiceDiscountAction}
              className="flex items-center gap-2 rounded-md border border-black/10 p-2 dark:border-white/15"
            >
              <input type="hidden" name="invoiceId" value={inv.id} />
              <input type="hidden" name="mode" value="AMOUNT" />
              <label className="text-xs text-zinc-600 dark:text-zinc-300">
                {t("discountAmountLabel")}
              </label>
              <input
                name="value"
                type="number"
                step="0.01"
                min="0"
                placeholder="200"
                aria-label={t("discountAmountLabel")}
                className="w-24 rounded-md border border-black/15 bg-transparent px-2 py-1 text-end text-sm tabular-nums dark:border-white/20"
              />
              <span className="text-xs text-zinc-500 dark:text-zinc-400">AED</span>
              <button
                type="submit"
                className="ms-auto rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-black"
              >
                {t("discountApply")}
              </button>
            </form>
          </div>
          {discountLine ? (
            <form action={setInvoiceDiscountAction} className="mt-2 flex justify-end">
              <input type="hidden" name="invoiceId" value={inv.id} />
              <input type="hidden" name="mode" value="NONE" />
              <input type="hidden" name="value" value="0" />
              <button
                type="submit"
                className="text-xs text-red-600 hover:underline"
              >
                ✕ {t("discountRemove")}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-end justify-between">
        {/* QR placeholder — KSA Phase 2 replaces with a signed ZATCA QR */}
        <div className="flex flex-col items-center">
          <div className="grid h-24 w-24 place-items-center rounded-md border-2 border-dashed border-black/20 text-[10px] text-zinc-400 dark:border-white/20">
            QR
          </div>
          <span className="mt-1 text-[10px] text-zinc-400">{t("qrPlaceholder")}</span>
        </div>
        {/* Totals — per spec the order is strict:
              with discount:
                Subtotal (before discount)
                Discount       (single negative line, no % suffix)
                Subtotal (after discount)
                VAT (5%)       (calculated on subtotal AFTER discount)
                Total
              without discount:
                Subtotal
                VAT (5%)
                Total
            VAT correctness: invoice.vatAmount is computed by
            recomputeInvoice as 5% of invoice.subtotal, which already
            includes the negative discount line — so it matches 'VAT
            on subtotal AFTER discount' automatically. */}
        <div className="text-right text-sm">
          {discountLine ? (
            <>
              <div>{t("subtotalBeforeDiscount")}: {money(grossSubtotal)}</div>
              <div className="text-rose-700 dark:text-rose-400">
                {t("discountRow")}: −{money(discountAmount)}
              </div>
              <div>{t("subtotalAfterDiscount")}: {money(Number(inv.subtotal))}</div>
            </>
          ) : (
            <div>{t("subtotal")}: {money(grossSubtotal)}</div>
          )}
          <div>{t("vat5")}: {money(Number(inv.vatAmount))}</div>
          <div className="text-base font-semibold">{t("total")}: {money(total)}</div>
          <div className="mt-1">{t("paid")}: {money(paid)}</div>
          <div className="font-medium">
            {AR_EMOJI[state]} {state === "PAID" ? t("paid") : `${t("balance")} ${money(balance)}`}
          </div>
        </div>
      </div>

      {/* Preview gate — replaces the direct Send-to-customer button per
          spec. The cashier must review the customer-facing render
          before the WhatsApp send goes out. The actual sendInvoice
          ToCustomerAction now only fires from /invoices/[id]/preview,
          which means typo'd line items can't reach the customer in
          one accidental click. */}
      {["CASHIER", "OWNER"].includes(session.user.role) &&
      !inv.jobCard.invoiceSentAt ? (
        <Link
          href={`/invoices/${inv.id}/preview`}
          className="block rounded-lg border border-fuchsia-500/40 bg-fuchsia-50 p-4 text-center print:hidden dark:bg-fuchsia-950/40"
        >
          <p className="text-sm text-fuchsia-900 dark:text-fuchsia-100">
            {t("invoicePreviewNote")}
          </p>
          <span className="mt-3 inline-block rounded-lg bg-fuchsia-600 px-5 py-3 text-base font-semibold text-white hover:bg-fuchsia-500">
            {t("invoicePreviewButton")}
          </span>
        </Link>
      ) : inv.jobCard.invoiceSentAt ? (
        <p className="rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-700 print:hidden dark:bg-zinc-900 dark:text-zinc-300">
          📨 {t("invoiceAlreadySent")} · {t("invoiceSentAt")}{" "}
          {inv.jobCard.invoiceSentAt.toISOString().slice(0, 16).replace("T", " ")}
        </p>
      ) : null}

      {/* Mark as Paid removed from this page per spec. Recording an
          actual customer payment now happens ONLY from the cashier's
          Receivables row on /cashier, so the cashier can't
          accidentally mark-paid while still editing line items here.
          The Receivables row has the same form (amount + method +
          Mark as Paid button) but lives next to the customer name +
          balance, which is the real context for a payment-record
          decision. */}
    </main>
  );
}

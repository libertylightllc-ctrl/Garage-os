import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { type StaffRole } from "@/lib/roles";
import { getLocale, getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { DictateInput } from "@/components/dictate";
import {
  addEstimateLineAction,
  addLineFromPartAction,
  updateEstimateLinePriceAction,
  removeEstimateLineAction,
  toggleEstimateLineAction,
  setEstimateStatusAction,
  generateInvoiceAction,
} from "@/app/actions/billing";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

// A technician part row with a one-click "Price this part" button (when editable).
function PartRow({
  p,
  estimateId,
  editable,
  t,
}: {
  p: { id: string; partNo: string | null; description: string; qty: number };
  estimateId: string;
  editable: boolean;
  t: (k: MessageKey) => string;
}) {
  return (
    <li className="flex items-center justify-between gap-2 text-zinc-600 dark:text-zinc-300">
      <span>
        • {p.partNo ? `${p.partNo} ` : ""}
        {p.description} ×{p.qty}
      </span>
      {editable ? (
        <form action={addLineFromPartAction}>
          <input type="hidden" name="estimateId" value={estimateId} />
          <input type="hidden" name="jobPartId" value={p.id} />
          <button className="shrink-0 rounded-md border border-black/15 px-2 py-0.5 text-xs font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
            {t("priceThisPart")}
          </button>
        </form>
      ) : null}
    </li>
  );
}

// Shared screen: the Cashier sets prices here; the Advisor can view + send it.
export default async function EstimateEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAnyRole(["ADVISOR", "CASHIER", "OWNER"]);
  const role = session.user.role as StaffRole;
  const canPrice = role === "CASHIER" || role === "OWNER"; // edit lines / invoice

  const est = await prisma.estimate.findFirst({
    where: { id, jobCard: { garageId: session.user.garageId } },
    include: {
      lines: { orderBy: { createdAt: "asc" } },
      jobCard: {
        include: {
          vehicle: true,
          finding: true,
          jobParts: { orderBy: { createdAt: "asc" } },
        },
      },
      invoice: { select: { id: true } },
    },
  });
  if (!est) notFound();
  const t = await getT();
  const locale = await getLocale();
  const dictLabels = {
    start: t("dictateStart"),
    stop: t("dictateStop"),
    listening: t("dictateListening"),
    error: t("dictateError"),
  };
  const finding = est.jobCard.finding;
  const requiredParts = est.jobCard.jobParts.filter((p) => p.kind === "REQUIRED");
  const usedParts = est.jobCard.jobParts.filter((p) => p.kind === "USED");
  const workNotes = est.jobCard.workNotes;

  const editable = canPrice && est.status === "DRAFT";
  const canDecline = canPrice && !est.invoice; // skip lines until the invoice is cut
  const backHref = role === "ADVISOR" ? `/advisor/jobs/${est.jobCardId}` : "/cashier";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role={role} active={role === "ADVISOR" ? "jobs" : "accounts"} />
      <div>
        <Link href={backHref} className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          {role === "ADVISOR" ? t("backJob") : t("accounts")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("estimate")}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {est.jobCard.vehicle.make} {est.jobCard.vehicle.model} · {est.jobCard.vehicle.plate} ·{" "}
          <span className="font-medium">{est.status}</span>
        </p>
        {!canPrice ? (
          <p className="text-xs text-zinc-400">{t("pricingByCashier")}</p>
        ) : null}
        {est.approvedAt ? (
          <p className="text-xs text-green-700 dark:text-green-400">
            ✅ {t("approvedOn")} AED {Number(est.approvedAmount ?? est.total).toFixed(2)} ·{" "}
            {est.approvedAt.toISOString().slice(0, 10)}
          </p>
        ) : null}
      </div>

      {/* Technician findings & parts required — what the cashier prices from */}
      {finding?.submittedAt || requiredParts.length > 0 ? (
        <div className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
          <h2 className="mb-1 text-sm font-medium">{t("techFindingsPanel")}</h2>
          {finding?.findings ? <p>{finding.findings}</p> : null}
          {finding?.diagnosis ? (
            <p className="text-zinc-600 dark:text-zinc-300">{finding.diagnosis}</p>
          ) : null}
          {requiredParts.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {requiredParts.map((p) => (
                <PartRow key={p.id} p={p} estimateId={est.id} editable={editable} t={t} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Parts used & work notes (Repair stage) — reconcile Final Billing */}
      {usedParts.length > 0 || workNotes ? (
        <div className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
          <h2 className="mb-1 text-sm font-medium">{t("partsUsedPanel")}</h2>
          {workNotes ? <p className="text-zinc-600 dark:text-zinc-300">{workNotes}</p> : null}
          {usedParts.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {usedParts.map((p) => (
                <PartRow key={p.id} p={p} estimateId={est.id} editable={editable} t={t} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-x-auto">
      <table className="w-full min-w-[20rem] text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-zinc-500 dark:border-white/15">
            <th className="py-1">{t("colItem")}</th>
            <th className="py-1 text-right">{t("colQty")}</th>
            <th className="py-1 text-right">{t("colUnit")}</th>
            <th className="py-1 text-right">{t("colTotal")}</th>
            {editable || canDecline ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {est.lines.map((l) => (
            <tr
              key={l.id}
              className={
                "border-b border-black/5 dark:border-white/10 " +
                (l.declined ? "text-zinc-400 line-through" : "")
              }
            >
              <td className="py-1">
                <span className="text-zinc-400">{l.kind}</span> {l.description}
              </td>
              <td className="py-1 text-right">{Number(l.qty)}</td>
              <td className="py-1 text-right">
                {editable ? (
                  <form action={updateEstimateLinePriceAction} className="flex items-center justify-end gap-1">
                    <input type="hidden" name="estimateId" value={est.id} />
                    <input type="hidden" name="lineId" value={l.id} />
                    <input
                      name="unitPrice"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={Math.abs(Number(l.unitPrice)).toFixed(2)}
                      className="w-16 rounded-md border border-black/15 bg-transparent px-1 py-0.5 text-right text-sm dark:border-white/20"
                    />
                    <button className="text-xs text-zinc-500 hover:underline">✓</button>
                  </form>
                ) : (
                  Number(l.unitPrice).toFixed(2)
                )}
              </td>
              <td className="py-1 text-right">{Number(l.lineTotal).toFixed(2)}</td>
              {editable || canDecline ? (
                <td className="py-1 pl-2 text-right no-underline">
                  <div className="flex justify-end gap-2">
                    {canDecline ? (
                      <form action={toggleEstimateLineAction}>
                        <input type="hidden" name="estimateId" value={est.id} />
                        <input type="hidden" name="lineId" value={l.id} />
                        <button className="text-xs text-zinc-500 hover:underline">
                          {l.declined ? t("restore") : t("skip")}
                        </button>
                      </form>
                    ) : null}
                    {editable ? (
                      <form action={removeEstimateLineAction}>
                        <input type="hidden" name="estimateId" value={est.id} />
                        <input type="hidden" name="lineId" value={l.id} />
                        <button className="text-red-600">✕</button>
                      </form>
                    ) : null}
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
          {est.lines.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-3 text-center text-zinc-500">
                {t("noLineItems")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      </div>

      <div className="ml-auto text-right text-sm">
        <div>{t("subtotal")}: {money(Number(est.subtotal))}</div>
        <div>{t("vat5")}: {money(Number(est.vatAmount))}</div>
        <div className="text-base font-semibold">{t("total")}: {money(Number(est.total))}</div>
      </div>

      {editable ? (
        <form action={addEstimateLineAction} className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
          <input type="hidden" name="estimateId" value={est.id} />
          <div className="flex gap-2">
            <select name="kind" className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20">
              <option value="LABOR">{t("labor")}</option>
              <option value="PART">{t("part")}</option>
              <option value="FEE">{t("fee")}</option>
              <option value="DISCOUNT">{t("discount")}</option>
            </select>
            <DictateInput locale={locale} labels={dictLabels} name="description" placeholder={t("description")} required className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20" />
          </div>
          <div className="flex gap-2">
            <input name="qty" type="number" step="0.5" min="0" defaultValue="1" className="w-20 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20" />
            <input name="unitPrice" type="number" step="0.01" min="0" placeholder="Unit price" required className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20" />
            <button className="rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-black">
              {t("addLine")}
            </button>
          </div>
        </form>
      ) : null}

      {/* Lifecycle actions */}
      <div className="flex flex-wrap gap-2">
        {est.status === "DRAFT" && est.lines.length > 0 ? (
          <StatusButton estimateId={est.id} status="SENT" label={t("sendToCustomer")} primary />
        ) : null}
        {est.status === "SENT" ? (
          <>
            <StatusButton estimateId={est.id} status="APPROVED" label={t("markApproved")} primary />
            <StatusButton estimateId={est.id} status="REJECTED" label={t("markRejected")} />
          </>
        ) : null}
        {canPrice && est.status === "APPROVED" && !est.invoice ? (
          <form action={generateInvoiceAction}>
            <input type="hidden" name="estimateId" value={est.id} />
            <button className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500">
              {t("generateInvoice")}
            </button>
          </form>
        ) : null}
        {est.invoice ? (
          <Link href={`/invoices/${est.invoice.id}`} className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20">
            {t("viewInvoice")}
          </Link>
        ) : null}
      </div>
      <p className="text-xs text-zinc-400">
        (Send/approve here simulates the customer; the real WhatsApp approval link is also sent on Send.)
      </p>
    </main>
  );
}

function StatusButton({
  estimateId,
  status,
  label,
  primary,
}: {
  estimateId: string;
  status: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <form action={setEstimateStatusAction}>
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="status" value={status} />
      <button
        className={
          primary
            ? "rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-white dark:text-black"
            : "rounded-lg border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20"
        }
      >
        {label}
      </button>
    </form>
  );
}

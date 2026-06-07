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
  setEstimateStatusAction,
  generateInvoiceAction,
} from "@/app/actions/billing";
import { EstimateLineRow } from "@/components/estimate-line-row";

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
    <li className="flex flex-wrap items-center justify-between gap-2 text-base text-zinc-600 dark:text-zinc-300">
      <span>
        • {p.partNo ? `${p.partNo} ` : ""}
        {p.description} ×{p.qty}
      </span>
      {editable ? (
        <form action={addLineFromPartAction}>
          <input type="hidden" name="estimateId" value={estimateId} />
          <input type="hidden" name="jobPartId" value={p.id} />
          <button className="shrink-0 rounded-md border border-black/15 px-3 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
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
        <Link href={backHref} className="inline-block py-2 text-base text-zinc-500 hover:underline dark:text-zinc-400">
          {role === "ADVISOR" ? t("backJob") : t("accounts")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("estimate")}</h1>
        <p className="text-base text-zinc-600 dark:text-zinc-300">
          {est.jobCard.vehicle.make} {est.jobCard.vehicle.model} · {est.jobCard.vehicle.plate} ·{" "}
          <span className="font-medium">{est.status}</span>
        </p>
        {!canPrice ? (
          <p className="text-sm text-zinc-400">{t("pricingByCashier")}</p>
        ) : null}
        {est.approvedAt ? (
          <p className="text-sm text-green-700 dark:text-green-400">
            ✅ {t("approvedOn")} AED {Number(est.approvedAmount ?? est.total).toFixed(2)} ·{" "}
            {est.approvedAt.toISOString().slice(0, 10)}
          </p>
        ) : null}
      </div>

      {/* Technician findings & parts required — what the cashier prices from */}
      {finding?.submittedAt || requiredParts.length > 0 ? (
        <div className="rounded-lg border border-black/10 p-4 text-base dark:border-white/15">
          <h2 className="mb-2 text-base font-semibold">{t("techFindingsPanel")}</h2>
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
        <div className="rounded-lg border border-black/10 p-4 text-base dark:border-white/15">
          <h2 className="mb-2 text-base font-semibold">{t("partsUsedPanel")}</h2>
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
      <table className="w-full min-w-[20rem] text-base">
        <thead>
          <tr className="border-b border-black/10 text-left text-sm font-medium text-zinc-500 dark:border-white/15">
            <th className="py-2">{t("colItem")}</th>
            <th className="py-2 text-right">{t("colQty")}</th>
            <th className="py-2 text-right">{t("colUnit")}</th>
            <th className="py-2 text-right">{t("colTotal")}</th>
            {editable || canDecline ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {est.lines.map((l) => (
            <EstimateLineRow
              key={l.id}
              estimateId={est.id}
              editable={editable}
              canDecline={canDecline}
              line={{
                id: l.id,
                kind: l.kind,
                description: l.description,
                qty: Number(l.qty),
                unitPrice: Number(l.unitPrice),
                lineTotal: Number(l.lineTotal),
                declined: l.declined,
              }}
              labels={{
                edit: t("editLine"),
                delete: t("deleteLine"),
                save: t("saveLine"),
                cancel: t("cancelLine"),
                skip: t("skip"),
                restore: t("restore"),
                confirmDelete: t("confirmDeleteLine"),
                kindLabor: t("labor"),
                kindPart: t("part"),
                kindFee: t("fee"),
                kindDiscount: t("discount"),
              }}
            />
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

      <div className="ml-auto text-right text-base tabular-nums">
        <div className="text-zinc-600 dark:text-zinc-300">{t("subtotal")}: {money(Number(est.subtotal))}</div>
        <div className="text-zinc-600 dark:text-zinc-300">{t("vat5")}: {money(Number(est.vatAmount))}</div>
        <div className="mt-1 text-lg font-semibold">{t("total")}: {money(Number(est.total))}</div>
      </div>

      {editable ? (
        <form action={addEstimateLineAction} className="flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
          <input type="hidden" name="estimateId" value={est.id} />
          <div className="flex flex-wrap gap-2">
            <select name="kind" className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-base dark:border-white/20">
              <option value="LABOR">{t("labor")}</option>
              <option value="PART">{t("part")}</option>
              <option value="FEE">{t("fee")}</option>
              <option value="DISCOUNT">{t("discount")}</option>
            </select>
            <DictateInput locale={locale} labels={dictLabels} name="description" placeholder={t("description")} required className="min-w-40 flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-base dark:border-white/20" />
          </div>
          <div className="flex flex-wrap gap-2">
            <input name="qty" type="number" step="0.5" min="0" defaultValue="1" className="w-20 rounded-md border border-black/15 bg-transparent px-3 py-2 text-base text-right dark:border-white/20" />
            <input name="unitPrice" type="number" step="0.01" min="0" placeholder="Unit price" required className="min-w-32 flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-base text-right dark:border-white/20" />
            <button className="rounded-md bg-zinc-900 px-4 py-2 text-base font-semibold text-white dark:bg-white dark:text-black">
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
            <button className="rounded-lg bg-green-600 px-5 py-3 text-base font-semibold text-white hover:bg-green-500">
              {t("generateInvoice")}
            </button>
          </form>
        ) : null}
        {est.invoice ? (
          <Link href={`/invoices/${est.invoice.id}`} className="rounded-lg border border-black/15 px-5 py-3 text-base font-medium dark:border-white/20">
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
            ? "rounded-lg bg-zinc-900 px-5 py-3 text-base font-semibold text-white dark:bg-white dark:text-black"
            : "rounded-lg border border-black/15 px-5 py-3 text-base font-medium dark:border-white/20"
        }
      >
        {label}
      </button>
    </form>
  );
}

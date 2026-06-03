import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import {
  addEstimateLineAction,
  removeEstimateLineAction,
  toggleEstimateLineAction,
  setEstimateStatusAction,
  generateInvoiceAction,
} from "@/app/actions/billing";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function EstimateEditor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireRole("ADVISOR");

  const est = await prisma.estimate.findFirst({
    where: { id, jobCard: { garageId: session.user.garageId } },
    include: {
      lines: { orderBy: { createdAt: "asc" } },
      jobCard: { include: { vehicle: true } },
      invoice: { select: { id: true } },
    },
  });
  if (!est) notFound();
  const t = await getT();

  const editable = est.status === "DRAFT";
  const canDecline = !est.invoice; // advisor can skip lines until the invoice is cut

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs" />
      <div>
        <Link href={`/advisor/jobs/${est.jobCardId}`} className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          {t("backJob")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("estimate")}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {est.jobCard.vehicle.make} {est.jobCard.vehicle.model} · {est.jobCard.vehicle.plate} ·{" "}
          <span className="font-medium">{est.status}</span>
        </p>
      </div>

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
              <td className="py-1 text-right">{Number(l.unitPrice).toFixed(2)}</td>
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
            <input name="description" placeholder={t("description")} required className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20" />
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
        {est.status === "APPROVED" && !est.invoice ? (
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
        (Send/approve here simulates the customer; Step 6 wires the real WhatsApp approval.)
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

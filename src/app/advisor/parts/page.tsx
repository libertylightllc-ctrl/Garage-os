import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { partStatusKey } from "@/i18n/config";
import { inStock } from "@/lib/partrequest";
import {
  fulfillPartRequestAction,
  orderPartRequestAction,
  arrivePartRequestAction,
  cancelPartRequestAction,
} from "@/app/actions/parts";

export const dynamic ="force-dynamic";

export default async function PartsQueue() {
  const session = await requireRole("ADVISOR");
  const t = await getT();

  const requests = await prisma.partRequest.findMany({
    where: { garageId: session.user.garageId, status: { in: ["REQUESTED","ORDERED","ARRIVED"] } },
    include: {
      part: true,
      requestedBy: { select: { name: true } },
      jobCard: { include: { vehicle: true } },
    },
    orderBy: { createdAt:"asc"},
  });

  const btn =
  "inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors transition-colors";
  const btnPrimary =
  "inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="parts"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("partsQueue")}</h1>

      {requests.length === 0 ? (
        <p className="text-sm text-text-mute">{t("noOpenParts")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {requests.map((r) => {
            const available = r.part ? inStock(r.part.qtyOnHand, r.qty) : false;
            return (
              <li key={r.id} className="rounded-xl border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      📦 {r.qty}× {r.description}
                    </div>
                    <div className="text-xs text-text-mute">
                      <Link href={`/advisor/jobs/${r.jobCardId}`} className="hover:underline">
                        {r.jobCard.vehicle.make} {r.jobCard.vehicle.model} · {r.jobCard.vehicle.plate}
                      </Link>
                      {r.requestedBy?.name ? ` · ${t("requestedByLabel")} ${r.requestedBy.name}` :""}
                    </div>
                    {r.note ? (
                      <div className="text-xs text-text-mute">— {r.note}</div>
                    ) : null}
                  </div>
                  <span className="whitespace-nowrap text-xs">
                    <span className="rounded-full bg-black/5 px-2 py-0.5 dark:bg-white/10">
                      {t(partStatusKey(r.status))}
                    </span>
                    {r.part ? (
                      <span
                        className={
                        "ms-1"+
                          (available ?"text-green-600 dark:text-green-400":"text-amber-600 dark:text-amber-400")
                        }
                      >
                        {available ? t("inStockTag") : t("outOfStock")}
                      </span>
                    ) : null}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {r.status ==="REQUESTED"&& available ? (
                    <form action={fulfillPartRequestAction}>
                      <input type="hidden" name="requestId" value={r.id} />
                      <button className={btnPrimary}>{t("actFulfill")}</button>
                    </form>
                  ) : null}
                  {r.status ==="REQUESTED"? (
                    <form action={orderPartRequestAction} className="flex items-center gap-2">
                      <input type="hidden" name="requestId" value={r.id} />
                      <input
                        name="note"
                        placeholder={t("supplierNote")}
                        className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                      />
                      <button className={btn}>{t("actOrder")}</button>
                    </form>
                  ) : null}
                  {r.status ==="ORDERED"? (
                    <form action={arrivePartRequestAction}>
                      <input type="hidden" name="requestId" value={r.id} />
                      <button className={btnPrimary}>{t("actArrived")}</button>
                    </form>
                  ) : null}
                  {r.status ==="ARRIVED"? (
                    <>
                      <form action={fulfillPartRequestAction}>
                        <input type="hidden" name="requestId" value={r.id} />
                        <button className={btnPrimary}>{t("actFulfill")}</button>
                      </form>
                      <form action={orderPartRequestAction}>
                        <input type="hidden" name="requestId" value={r.id} />
                        <button className={btn}>{t("actReorder")}</button>
                      </form>
                    </>
                  ) : null}
                  <form action={cancelPartRequestAction}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <button className={btn}>{t("actCancelReq")}</button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { partStatusKey } from "@/i18n/config";
import { inStock } from "@/lib/partrequest";
import { formatVehicleSpec } from "@/lib/jobcard-fields";
import {
  fulfillPartRequestAction,
  orderPartRequestAction,
  arrivePartRequestAction,
  cancelPartRequestAction,
} from "@/app/actions/parts";
import { Button } from "@/components/ui/button";
import { PART_REQUEST_OPEN_STATUSES } from "@/lib/part-request-open";
import { Paginator } from "@/components/paginator";
import { PER_PAGE_OPTIONS, computeWindow } from "@/lib/pagination";

export const dynamic ="force-dynamic";

export default async function PartsQueue({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; per?: string }>;
}) {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const t = await getT();
  const { page: rawPage, per: rawPer } = await searchParams;
  const garageId = session.user.garageId;

  // The "OPEN" definition is shared with the AppShell nav badge via
  // PART_REQUEST_OPEN_STATUSES so the two cannot drift when the enum
  // grows. Count first so the paginator can clamp ?page / ?per to a valid
  // window before we fetch a slice — a stale ?page=99 after rows were
  // fulfilled lands on the last real page instead of an empty one.
  const openWhere = {
    garageId,
    status: { in: [...PART_REQUEST_OPEN_STATUSES] },
  };
  const totalCount = await prisma.partRequest.count({ where: openWhere });
  const pageWindow = computeWindow({ rawPage, rawPer, totalCount });

  const requests = await prisma.partRequest.findMany({
    where: openWhere,
    include: {
      part: true,
      requestedBy: { select: { name: true } },
      jobCard: { include: { vehicle: true } },
    },
    orderBy: { createdAt:"asc"},
    skip: pageWindow.skip,
    take: pageWindow.take,
  });

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
                    {/* Full vehicle spec — shown inline so the parts orderer
                        can read make/model/year/engine/fuel on a phone call
                        with a supplier without opening the job card. */}
                    {formatVehicleSpec(r.jobCard.vehicle).length > 0 ? (
                      <div className="mt-0.5 text-xs text-text-mute">
                        🔧 {formatVehicleSpec(r.jobCard.vehicle)}
                      </div>
                    ) : null}
                    {r.note ? (
                      <div className="text-xs text-text-mute">— {r.note}</div>
                    ) : null}
                  </div>
                  <span className="whitespace-nowrap text-xs">
                    <span className="rounded-full bg-surface-2 px-2 py-0.5">
                      {t(partStatusKey(r.status))}
                    </span>
                    {r.part ? (
                      <span
                        className={
                        "ms-1"+
                          (available ?"text-success-700 dark:text-success-500":"text-warning-600 dark:text-warning-500")
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
                      <Button>{t("actFulfill")}</Button>
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
                      <Button variant="ghost">{t("actOrder")}</Button>
                    </form>
                  ) : null}
                  {r.status ==="ORDERED"? (
                    <form action={arrivePartRequestAction}>
                      <input type="hidden" name="requestId" value={r.id} />
                      <Button>{t("actArrived")}</Button>
                    </form>
                  ) : null}
                  {r.status ==="ARRIVED"? (
                    <>
                      <form action={fulfillPartRequestAction}>
                        <input type="hidden" name="requestId" value={r.id} />
                        <Button>{t("actFulfill")}</Button>
                      </form>
                      <form action={orderPartRequestAction}>
                        <input type="hidden" name="requestId" value={r.id} />
                        <Button variant="ghost">{t("actReorder")}</Button>
                      </form>
                    </>
                  ) : null}
                  <form action={cancelPartRequestAction}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <Button variant="ghost">{t("actCancelReq")}</Button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {totalCount > 0 ? (
        <Paginator
          currentPath="/advisor/parts"
          currentSearchParams=""
          page={pageWindow.page}
          perPage={pageWindow.perPage}
          pageCount={pageWindow.pageCount}
          from={pageWindow.from}
          to={pageWindow.to}
          total={pageWindow.totalCount}
          perPageOptions={PER_PAGE_OPTIONS}
          labels={{
            showing: t("paginationShowing"),
            rowsPerPage: t("paginationRowsPerPage"),
            prev: t("paginationPrev"),
            next: t("paginationNext"),
          }}
        />
      ) : null}
    </main>
  );
}

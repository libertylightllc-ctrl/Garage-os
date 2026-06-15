import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { approveEstimatePublic, rejectEstimatePublic, toggleLinePublic } from "@/app/actions/public";
import { verifyToken } from "@/lib/tokens";
import { getT, getLocale } from "@/i18n/server";
import { translateLineDescription } from "@/lib/line-item-translations";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function CustomerEstimate({ params }: { params: Promise<{ id: string }> }) {
 const { id: token } = await params;
 const id = verifyToken("estimate", token);
 if (!id) notFound();
 const est = await prisma.estimate.findUnique({
  where: { id },
  include: {
   lines: { orderBy: { createdAt:"asc"} },
   jobCard: { include: { vehicle: { include: { customer: true } }, garage: true } },
  },
 });
 if (!est) notFound();
 const t = await getT();
 const locale = await getLocale();

 const decided = est.status ==="APPROVED"|| est.status ==="REJECTED";

 return (
  <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
   <div>
    <p className="text-sm text-text-mute">{est.jobCard.garage.name}</p>
    <h1 className="text-2xl font-semibold tracking-tight">{t("yourEstimate")}</h1>
    <p className="text-sm text-text-mute">
     {est.jobCard.vehicle.make} {est.jobCard.vehicle.model} · {est.jobCard.vehicle.plate}
    </p>
   </div>

   <ul className="flex flex-col gap-1 text-sm">
    {est.lines.map((l) => (
     <li key={l.id} className="flex items-center justify-between gap-2">
      <span className={l.declined ?"text-text-mute line-through":""}>
       {translateLineDescription(l.description, locale)}
      </span>
      <span className="flex items-center gap-2">
       <span className={l.declined ?"text-text-mute line-through":""}>
        {Number(l.lineTotal).toFixed(2)}
       </span>
       {est.status ==="SENT"? (
        <form action={toggleLinePublic}>
         <input type=" hidden" name="token" value={token} />
         <input type=" hidden" name="lineId" value={l.id} />
         <button className="text-xs text-text-mute hover:underline">
          {l.declined ? t("restore") : t("skip")}
         </button>
        </form>
       ) : null}
      </span>
     </li>
    ))}
   </ul>
   <div className="border-t border-border pt-2 text-right text-sm">
    <div>{t("subtotal")}: {money(Number(est.subtotal))}</div>
    <div>{t("vat5")}: {money(Number(est.vatAmount))}</div>
    <div className="text-lg font-semibold">{t("total")}: {money(Number(est.total))}</div>
   </div>

   {decided ? (
    <p className="rounded-xl border border-border bg-surface-2 p-4 text-center text-sm font-semibold">
     {est.status ==="APPROVED"? t("estimateApprovedMsg") : t("estimateDeclinedMsg")}
    </p>
   ) : est.status ==="SENT"? (
    <div className="flex gap-2">
     <form action={approveEstimatePublic} className="flex-1">
      <input type=" hidden" name="token" value={token} />
      <button className="inline-flex w-full h-12 items-center justify-center rounded-lg bg-accent-500 px-4 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
       {t("approve")}
      </button>
     </form>
     <form action={rejectEstimatePublic} className="flex-1">
      <input type=" hidden" name="token" value={token} />
      <button className="inline-flex w-full h-12 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
       {t("decline")}
      </button>
     </form>
    </div>
   ) : (
    <p className="text-center text-sm text-text-mute">
     {t("estimateNotReady")}
    </p>
   )}
  </main>
 );
}

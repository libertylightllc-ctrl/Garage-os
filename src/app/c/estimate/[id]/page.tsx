import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { approveEstimatePublic, rejectEstimatePublic, toggleLinePublic } from "@/app/actions/public";
import { verifyToken } from "@/lib/tokens";
import { getT, getLocale } from "@/i18n/server";
import { translateLineDescription } from "@/lib/line-item-translations";
import { stripVehicleLabel } from "@/lib/jobcard-fields";
import { Button } from "@/components/ui/button";
import { DocumentHeader } from "@/components/document-header";

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

  // Vehicle data — same for every line, surfaced as table columns so
  // the customer can read "this is for my Ford Focus" at a glance.
  const v = est.jobCard.vehicle;
  // Description column reads clean even on legacy lines that still
  // carry the "(Make Model)" suffix from a prior code path.
  const cleanDesc = (line: { description: string }) =>
    stripVehicleLabel(
      translateLineDescription(line.description, locale),
      v.make,
      v.model,
    );

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-5 p-6">
      <div className="flex flex-col items-start gap-3">
        {/* Customer-facing document — pass raw logoUrl. When null, the
            header falls back to text-only garage name; we deliberately
            do NOT show the GarageOS mark on a customer's document
            because that's our brand, not theirs. */}
        <DocumentHeader
          title={t("yourEstimate")}
          jobCard={est.jobCard}
          vehicle={v}
          garage={est.jobCard.garage}
          logoUrl={est.jobCard.garage.logoUrl}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-surface-2 text-xs uppercase tracking-wide text-text-mute">
            <tr>
              <th className="px-2 py-2 text-left">{t("colMake")}</th>
              <th className="px-2 py-2 text-left">{t("colModel")}</th>
              <th className="px-2 py-2 text-left">{t("colYear")}</th>
              <th className="px-2 py-2 text-left">{t("colPart")}</th>
              <th className="px-2 py-2 text-right">{t("colQty")}</th>
              <th className="px-2 py-2 text-right">{t("colTotal")}</th>
              {est.status === "SENT" ? <th className="px-2 py-2"></th> : null}
            </tr>
          </thead>
          <tbody>
            {est.lines.map((l) => {
              const isPart = l.kind === "PART";
              const strike = l.declined ? "text-text-mute line-through" : "";
              return (
                <tr key={l.id} className="border-t border-border align-top">
                  <td className={`px-2 py-2 ${strike}`}>{isPart ? (v.make ?? "—") : "—"}</td>
                  <td className={`px-2 py-2 ${strike}`}>{isPart ? (v.model ?? "—") : "—"}</td>
                  <td className={`px-2 py-2 ${strike}`}>{isPart ? (v.year ?? "—") : "—"}</td>
                  <td className={`px-2 py-2 font-medium ${strike}`}>{cleanDesc(l)}</td>
                  <td className={`px-2 py-2 text-right tabular-nums ${strike}`}>
                    {Number(l.qty)}
                  </td>
                  <td className={`px-2 py-2 text-right tabular-nums ${strike}`}>
                    {Number(l.lineTotal).toFixed(2)}
                  </td>
                  {est.status === "SENT" ? (
                    <td className="px-2 py-2 text-right">
                      <form action={toggleLinePublic}>
                        <input type="hidden" name="token" value={token} />
                        <input type="hidden" name="lineId" value={l.id} />
                        <button className="text-xs text-text-mute hover:underline">
                          {l.declined ? t("restore") : t("skip")}
                        </button>
                      </form>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
            <input type="hidden" name="token" value={token} />
            <Button variant="hero" size="lg" fullWidth>
              {t("approve")}
            </Button>
          </form>
          <form action={rejectEstimatePublic} className="flex-1">
            <input type="hidden" name="token" value={token} />
            <Button variant="ghost" size="lg" fullWidth>
              {t("decline")}
            </Button>
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

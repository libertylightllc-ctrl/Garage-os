import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { approveEstimatePublic, rejectEstimatePublic, toggleLinePublic } from "@/app/actions/public";
import { resolveDocumentToken } from "@/lib/document-tokens";
import { getT, getLocale } from "@/i18n/server";
import { translateLineDescription } from "@/lib/line-item-translations";
import { stripVehicleLabel } from "@/lib/jobcard-fields";
import { Button } from "@/components/ui/button";
import { DocumentHeader } from "@/components/document-header";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function CustomerEstimate({ params }: { params: Promise<{ id: string }> }) {
  const { id: token } = await params;
  const id = await resolveDocumentToken("estimate", token);
  if (!id) notFound();
  // AR 2026-08-12 (Step 5) — explicit customer allowlist. The advisor-
  // internal fields (unitCost, markupPct) added for cost-based pricing
  // are DELIBERATELY OMITTED so they never enter the RSC payload. Pinned
  // by src/lib/__tests__/customer-invoice-line-fields.test.ts.
  const est = await prisma.estimate.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      subtotal: true,
      vatAmount: true,
      total: true,
      sentAt: true,
      approvedAt: true,
      // AR 2026-08-25 Batch C — customer-facing surface renders the
      // per-estimate remarks + payment terms + advisor snapshot.
      // Snapshot fields (name/phone) are populated at send time;
      // fallback to garage default for paymentTerms below.
      remarks: true,
      paymentTerms: true,
      advisorNameSnapshot: true,
      advisorPhoneSnapshot: true,
      lines: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          kind: true,
          description: true,
          qty: true,
          unitPrice: true,
          lineTotal: true,
          vatRate: true,
          declined: true,
          // NB: unitCost + markupPct INTENTIONALLY OMITTED.
        },
      },
      jobCard: {
        select: {
          number: true,
          createdAt: true,
          vehicle: {
            select: {
              make: true,
              model: true,
              year: true,
              plate: true,
              vin: true,
              engineSize: true,
              fuelType: true,
              customer: {
                select: { name: true, phone: true, lang: true, trn: true },
              },
            },
          },
          garage: {
            select: {
              id: true,
              name: true,
              country: true,
              trn: true,
              logoUrl: true,
              // Batch C: shop-wide Payment Terms fallback when the
              // per-estimate override isn't set.
              defaultPaymentTerms: true,
              // Batch D + split (2026-08-25): estimate-side terms only.
              estimateTerms: true,
            },
          },
        },
      },
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
      {est.remarks ? (
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-mute">
            {t("estimateRemarksHeading")}
          </div>
          <p className="mt-1 whitespace-pre-line">{est.remarks}</p>
        </div>
      ) : null}
      <div className="border-t border-border pt-2 text-right text-sm">
        <div>{t("subtotal")}: {money(Number(est.subtotal))}</div>
        <div>{t("vat5")}: {money(Number(est.vatAmount))}</div>
        <div className="text-lg font-semibold">{t("total")}: {money(Number(est.total))}</div>
      </div>

      {/* AR 2026-08-25 Batch C — payment terms + service advisor.
          Payment terms fall through to garage.defaultPaymentTerms
          when the per-estimate override is null. Advisor block
          reads the snapshot captured at send time; skipped entirely
          when both are absent. */}
      {(est.paymentTerms || est.jobCard.garage.defaultPaymentTerms || est.advisorNameSnapshot) ? (
        <div className="grid grid-cols-1 gap-4 border-t border-border pt-3 text-sm sm:grid-cols-2">
          {(est.paymentTerms || est.jobCard.garage.defaultPaymentTerms) ? (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-text-mute">
                {t("estimatePaymentTermsHeading")}
              </div>
              <p className="mt-1 whitespace-pre-line">
                {est.paymentTerms ?? est.jobCard.garage.defaultPaymentTerms}
              </p>
            </div>
          ) : <div />}
          {est.advisorNameSnapshot ? (
            <div className="sm:text-end">
              <div className="text-xs font-semibold uppercase tracking-wide text-text-mute">
                {t("estimateAdvisorHeading")}
              </div>
              <div className="mt-1 font-medium">{est.advisorNameSnapshot}</div>
              {est.advisorPhoneSnapshot ? (
                <div className="text-xs text-text-mute tabular-nums">
                  {est.advisorPhoneSnapshot}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* AR 2026-08-25 Batch D — shop-wide Terms & Conditions,
          bottom of the document. Renders only when set. */}
      {est.jobCard.garage.estimateTerms ? (
        <div className="border-t border-border pt-3 text-xs">
          <div className="font-semibold uppercase tracking-wide text-text-mute">
            {t("documentTermsHeading")}
          </div>
          <p className="mt-1 whitespace-pre-line leading-relaxed">
            {est.jobCard.garage.estimateTerms}
          </p>
        </div>
      ) : null}

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

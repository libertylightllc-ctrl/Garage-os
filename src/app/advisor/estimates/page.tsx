import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
 * Advisor's estimates list — five sections mirroring the cashier's
 * estimate-tab structure (Phase 4 of the workflow flip, rev. 2026-06-23).
 *
 * The cashier dashboard already computes these same buckets from the
 * jobs query; we use the same predicates here so the two views can
 * never drift out of sync (a job in "Drafts" on the advisor side is
 * the SAME row that would show in the cashier's "Pending" filter).
 *
 * Multi-tenant: the jobCard.findMany is scoped on garageId from the
 * session, and Estimate is reached only via the jobCard relation —
 * same indirect-scoping pattern that the tenant-isolation tests
 * already cover for the existing cashier queries.
 */
export default async function AdvisorEstimates() {
  const session = await requireRole("ADVISOR");
  const t = await getT();
  const garageId = session.user.garageId;

  // Same query shape as the cashier dashboard's `jobs` query
  // (src/app/cashier/page.tsx). Keep them aligned — the bucket
  // predicates assume estimates ordered DESC.
  const jobs = await prisma.jobCard.findMany({
    where: { garageId, status: { notIn: ["DELIVERED", "CANCELLED"] } },
    include: {
      vehicle: { include: { customer: true } },
      estimates: {
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, sentAt: true, total: true },
      },
      invoices: {
        orderBy: { issuedAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  // Bucket predicates — identical to the cashier dashboard so counts
  // and rows stay in lock-step (DRAFT/SENT/APPROVED/REJECTED on a
  // shared estimate row will appear on both views, just labelled by
  // each role's responsibility).
  const jobsToPrice = jobs.filter((j) => {
    if (j.status !== "ESTIMATE") return false;
    const e = j.estimates[0];
    return !e;
  });
  const drafts = jobs.filter(
    (j) => j.status === "ESTIMATE" && j.estimates[0]?.status === "DRAFT",
  );
  const sent = jobs.filter((j) => j.estimates[0]?.status === "SENT");
  // Approved-not-yet-invoiced — uses .some so a stray DRAFT alongside
  // an APPROVED row doesn't hide the job (same logic the cashier uses).
  const approved = jobs.filter(
    (j) => j.estimates.some((e) => e.status === "APPROVED") && j.invoices.length === 0,
  );
  const rejected = jobs.filter((j) => j.estimates[0]?.status === "REJECTED");

  // Declarative section definitions — render in one loop below to keep
  // the JSX flat. Each section has a primary destination per row:
  //   - jobs to price → /advisor/jobs/[id] (Create estimate button is there)
  //   - drafts/sent/approved/rejected → /estimates/[id] (the editor/view)
  // The badge text per section is the job count.
  type Section = {
    key: string;
    titleKey: MessageKey;
    hintKey: MessageKey;
    items: typeof jobs;
    rowHref: (j: typeof jobs[number]) => string;
    showMoney: boolean;
    tone: "neutral" | "info" | "warning" | "success" | "danger";
  };
  const sections: Section[] = [
    {
      key: "to_price",
      titleKey: "advisorEstSecJobsToPrice",
      hintKey: "advisorEstSecJobsToPriceHint",
      items: jobsToPrice,
      rowHref: (j) => `/advisor/jobs/${j.id}`,
      showMoney: false,
      tone: "info",
    },
    {
      key: "drafts",
      titleKey: "advisorEstSecDrafts",
      hintKey: "advisorEstSecDraftsHint",
      items: drafts,
      rowHref: (j) => `/estimates/${j.estimates[0]!.id}`,
      showMoney: true,
      tone: "neutral",
    },
    {
      key: "sent",
      titleKey: "advisorEstSecSent",
      hintKey: "advisorEstSecSentHint",
      items: sent,
      rowHref: (j) => `/estimates/${j.estimates[0]!.id}`,
      showMoney: true,
      tone: "warning",
    },
    {
      key: "approved",
      titleKey: "advisorEstSecApproved",
      hintKey: "advisorEstSecApprovedHint",
      items: approved,
      // Land on the APPROVED estimate id specifically (not [0] which may
      // be a newer DRAFT created during a re-estimate cycle).
      rowHref: (j) =>
        `/estimates/${j.estimates.find((e) => e.status === "APPROVED")?.id ?? j.estimates[0]!.id}`,
      showMoney: true,
      tone: "success",
    },
    {
      key: "rejected",
      titleKey: "advisorEstSecRejected",
      hintKey: "advisorEstSecRejectedHint",
      items: rejected,
      rowHref: (j) => `/advisor/jobs/${j.id}`,
      showMoney: true,
      tone: "danger",
    },
  ];

  const toneBorder: Record<Section["tone"], string> = {
    neutral: "border-border",
    info: "border-info-500/40",
    warning: "border-warning-500/40",
    success: "border-success-500/40",
    danger: "border-danger-500/40",
  };
  const toneBg: Record<Section["tone"], string> = {
    neutral: "bg-surface",
    info: "bg-info-50 dark:bg-info-500/10",
    warning: "bg-warning-50 dark:bg-warning-500/10",
    success: "bg-success-50 dark:bg-success-500/10",
    danger: "bg-danger-50 dark:bg-danger-500/10",
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-5 p-6 lg:max-w-5xl">
      <AppNav role="ADVISOR" active="estimates" />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("advisorEstimatesTitle")}</h1>
        <p className="mt-1 text-sm text-text-mute">{t("advisorEstimatesIntro")}</p>
      </div>

      {sections.map((sec) => (
        <section key={sec.key} className="rounded-xl border border-border p-4">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">
              {t(sec.titleKey)}
              <span className="ms-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums text-text-mute">
                {sec.items.length}
              </span>
            </h2>
            <p className="text-xs text-text-mute">{t(sec.hintKey)}</p>
          </div>
          {sec.items.length === 0 ? (
            <p className="text-sm text-text-mute">{t("advisorEstEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sec.items.map((j) => {
                const e = j.estimates[0];
                return (
                  <li key={j.id}>
                    <Link
                      href={sec.rowHref(j)}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border ${toneBorder[sec.tone]} ${toneBg[sec.tone]} p-3 text-sm transition-colors hover:bg-surface-2`}
                    >
                      <span className="flex flex-col">
                        <span className="font-medium">
                          {j.vehicle.make} {j.vehicle.model}
                          <span className="ms-2 text-text-mute">{j.vehicle.plate}</span>
                        </span>
                        <span className="text-xs text-text-mute">{j.vehicle.customer.name}</span>
                      </span>
                      {sec.showMoney && e ? (
                        <span className="text-right tabular-nums font-semibold">
                          {money(Number(e.total))}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </main>
  );
}

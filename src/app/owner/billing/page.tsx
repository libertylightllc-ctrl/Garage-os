import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { listBranches } from "@/lib/branches";
import { ensureSubscription } from "@/app/actions/subscription";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const session = await requireRole("OWNER");
  const t = await getT();
  await ensureSubscription(session.user.garageId);

  const [garage, sub, plans] = await Promise.all([
    prisma.garage.findUnique({ where: { id: session.user.garageId }, select: { isPilot: true } }),
    prisma.subscription.findUnique({
      where: { garageId: session.user.garageId },
      include: { plan: true },
    }),
    prisma.plan.findMany({ where: { active: true }, orderBy: { priceMonthly: "asc" } }),
  ]);
  const isPilot = garage?.isPilot ?? true;
  const branches = await listBranches(session.user.garageId);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="billing" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("billing")}</h1>

      <div className="rounded-lg border border-border p-4 text-sm ">
        {t("statusLabel")}: <span className="font-medium">{sub?.status ?? "PILOT"}</span>
        {sub?.plan ? ` · ${sub.plan.name}` : ""}
      </div>

      {isPilot ? (
        <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          🟢 {t("onPilotNotBilled")}
        </p>
      ) : null}

      <p className="text-sm text-text-mute">{t("billingManual")}</p>

      {/* Per-branch seats — billing is per branch. */}
      {branches.length > 1 ? (
        <div>
          <p className="mb-2 text-xs text-text-mute">{t("perBranchBilling")}</p>
          <ul className="flex flex-col gap-1">
            {branches.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between rounded-lg border border-border p-3 text-sm "
              >
                <span className="font-medium">
                  {b.name}
                  {b.isRoot ? (
                    <span className="ms-2 text-xs text-text-mute">{t("branchMainTag")}</span>
                  ) : null}
                </span>
                <span className="text-xs">{b.isPilot ? `🟢 ${t("statusLabel")}: PILOT` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        {plans.map((p) => (
          <div key={p.id} className="rounded-xl border border-border p-4">
            <div className="text-sm font-medium">{p.name}</div>
            <div className="mt-1 text-lg font-semibold">
              {p.currency} {Number(p.priceMonthly).toFixed(0)}
              <span className="text-xs font-normal text-text-mute">
                {" "}
                /{t("perMonth")}
              </span>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

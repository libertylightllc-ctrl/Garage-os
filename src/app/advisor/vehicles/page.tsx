import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * Advisor vehicle search — slice 'service history'.
 *
 * Looks up any vehicle in this garage by:
 *   - Plate number (case-insensitive partial match)
 *   - Owner name (case-insensitive partial match)
 *   - Owner phone (digits-only normalized; partial)
 *
 * One `?q=` query param drives the search; same shape as the cashier
 * estimate filter. URL-driven so back/forward works.
 *
 * Tapping a result row navigates to /advisor/vehicles/[id] — the
 * full history view (past jobs, parts, mileage, total spend, last
 * oil change summary).
 */
export default async function AdvisorVehicleSearch({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireRole("ADVISOR");
  const t = await getT();
  const { q: rawQ } = await searchParams;
  const q = (rawQ ?? "").trim();

  // Empty search → don't dump every vehicle in the garage. Show a
  // hint and wait for input. Once the advisor types something, fire
  // a single Prisma `OR` query across plate / customer name / phone.
  // Digits-only on the phone branch so "050-963-3330" matches a
  // stored "0509633330".
  const phoneDigits = q.replace(/\D/g, "");
  const results = !q
    ? []
    : await prisma.vehicle.findMany({
        where: {
          customer: { garageId: session.user.garageId },
          OR: [
            { plate: { contains: q, mode: "insensitive" } },
            { customer: { name: { contains: q, mode: "insensitive" } } },
            ...(phoneDigits.length >= 3
              ? [{ customer: { phone: { contains: phoneDigits } } }]
              : []),
          ],
        },
        include: {
          customer: { select: { name: true, phone: true } },
          // jobCards: pull the COUNT only — full history lives on the
          // detail page. We just need to show 'N visits' next to each
          // result so the advisor can pick the right one quickly.
          jobCards: { select: { id: true } },
        },
        orderBy: [{ updatedAt: "desc" }],
        take: 50, // safety cap; the search query was specific enough
      });

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="vehicles" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("vehiclesTitle")}
        </h1>
        <p className="text-sm text-text-mute">{t("vehiclesSubtitle")}</p>
      </div>

      {/* Search bar — GET form so the URL becomes the bookmark. The
          'Clear' link only appears once a search is active, which
          keeps the empty state visually quiet. */}
      <form method="get" className="flex flex-wrap gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={t("vehiclesSearchPlaceholder")}
          autoFocus
          className="h-10 min-w-40 flex-1 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        />
        <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
          {t("vehiclesSearchBtn")}
        </button>
        {q ? (
          <Link
            href="/advisor/vehicles"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors"
          >
            {t("vehiclesSearchClear")}
          </Link>
        ) : null}
      </form>

      {!q ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-mute">
          {t("vehiclesEmptyHint")}
        </p>
      ) : results.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-mute">
          {t("vehiclesNoMatch")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {results.map((v) => (
            <li key={v.id}>
              <Link
                href={`/advisor/vehicles/${v.id}`}
                className="flex items-center justify-between rounded-xl border border-border p-4 hover:bg-surface-2 transition-colors"
              >
                <span>
                  <span className="block font-medium">
                    {v.make} {v.model}
                    {v.year ? ` · ${v.year}` : ""}
                    <span className="ms-2 text-sm text-text-mute">
                      {v.plate}
                    </span>
                  </span>
                  <span className="block text-sm text-text-mute">
                    {v.customer.name} · {v.customer.phone}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1 text-xs text-text-mute">
                  <span>
                    <span className="font-semibold tabular-nums text-text">
                      {v.jobCards.length}
                    </span>{" "}
                    {v.jobCards.length === 1
                      ? t("vehiclesVisitSingular")
                      : t("vehiclesVisitPlural")}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { companyGarageIds } from "@/lib/branches";
import { ACCOUNTS } from "@/lib/billing";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
  * Owner-only account ledger report — slice #5.
  *
  * Two halves:
  *  1. Per-account rollup (Sales / VAT / Cash / AR / Deposits) with
  *   total Debit, total Credit, net balance. Lets the owner see the
  *   books at a glance.
  *  2. Individual payments (Payment + AdvancePayment rows) with date,
  *   customer, method, amount. Per-payment detail per AR's spec.
  *
  * Filter: optional ?from= and ?to= query params (YYYY-MM-DD). When
  * absent we show 'this month so far' as a sane default. URL-driven so
  * back/forward works.
  *
  * Read-only, ALWAYS garage-scoped (companyGarageIds includes the
  * owner's branches), no raw SQL — matches the CLAUDE.md rule.
  */
// Natural balance side per account, used by the 'By account' table to
// present each row's Net as a positive number + DR/CR label instead
// of a signed value. AR's spec rule:
//   Asset accounts (debit-normal) → DR
//   Revenue + liability accounts (credit-normal) → CR
// The underlying ledger math (debit, credit, signed net) is unchanged
// — only the Net column's DISPLAY is reformatted, so a non-accountant
// owner doesn't read 'Sales Revenue −16,382.10' as a loss.
const NATURAL_SIDE: Record<string, "DR" | "CR"> = {
  [ACCOUNTS.CASH]: "DR",
  [ACCOUNTS.AR]: "DR",
  [ACCOUNTS.DEPOSITS]: "CR",
  [ACCOUNTS.VAT_PAYABLE]: "CR",
  [ACCOUNTS.SALES]: "CR",
};

function startOfMonth(d: Date) {
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function parseDay(raw: string | undefined): Date | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Per-account row from the ledger groupBy + computed net.
interface AccountRow {
  account: string;
  debit: number;
  credit: number;
  net: number; // debit − credit (Cash/AR debit-normal positive; Sales/VAT/Deposits credit-normal negative)
}

export default async function OwnerLedger({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const gids = await companyGarageIds(session.user.garageId);
  const now = new Date();
  const { from: rawFrom, to: rawTo } = await searchParams;

  // Date window: explicit ?from / ?to override the defaults. Defaults
  // are start-of-month → now so the page opens with 'this month' data.
  const fromD = parseDay(rawFrom) ?? startOfMonth(now);
  // Inclusive end: bump end-of-day so a 2026-06-14 to-date includes
  // entries timestamped at 23:59.
  const toD = (() => {
    const p = parseDay(rawTo);
    if (!p) return now;
    return new Date(p.getTime() + 24 * 60 * 60 * 1000 - 1);
  })();

  // Pull the data set ONCE for the window. Aggregate in JS so the
  // filter UI can drive any date range without per-account queries.
  const [ledger, payments, advances] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { garageId: { in: gids }, createdAt: { gte: fromD, lte: toD } },
      select: { account: true, debit: true, credit: true },
    }),
    prisma.payment.findMany({
      where: {
        invoice: { garageId: { in: gids } },
        paidAt: { gte: fromD, lte: toD },
      },
      orderBy: { paidAt:"desc"},
      select: {
        id: true,
        amount: true,
        method: true,
        paidAt: true,
        invoice: {
          select: {
            number: true,
            jobCard: { select: { vehicle: { select: { customer: { select: { name: true } } } } } },
          },
        },
      },
    }),
    prisma.advancePayment.findMany({
      where: {
        garageId: { in: gids },
        receivedAt: { gte: fromD, lte: toD },
      },
      orderBy: { receivedAt:"desc"},
      select: {
        id: true,
        amount: true,
        method: true,
        receivedAt: true,
        migratedAt: true,
        jobCard: { select: { vehicle: { select: { customer: { select: { name: true } } } } } },
      },
    }),
  ]);

  // Per-account rollup. Order matters for readability — list assets
  // (Cash, AR) before liabilities (Deposits, VAT) before revenue
  // (Sales). Unknown accounts fall to the bottom.
  const ACCOUNT_ORDER = [
    ACCOUNTS.CASH,
    ACCOUNTS.AR,
    ACCOUNTS.DEPOSITS,
    ACCOUNTS.VAT_PAYABLE,
    ACCOUNTS.SALES,
  ];
  const rollup = new Map<string, AccountRow>();
  for (const e of ledger) {
    const r = rollup.get(e.account) ?? {
      account: e.account,
      debit: 0,
      credit: 0,
      net: 0,
    };
    r.debit += Number(e.debit);
    r.credit += Number(e.credit);
    rollup.set(e.account, r);
  }
  for (const r of rollup.values()) r.net = r.debit - r.credit;
  const accountRows: AccountRow[] = [
    ...ACCOUNT_ORDER.map(
      (a) =>
        rollup.get(a) ?? {
          account: a,
          debit: 0,
          credit: 0,
          net: 0,
        },
    ),
    ...[...rollup.values()].filter(
      (r) => !ACCOUNT_ORDER.includes(r.account as typeof ACCOUNT_ORDER[number]),
    ),
  ];

  // Trial-balance check — DEBIT total must equal CREDIT total. If it
  // doesn't, something writes to the ledger without the matching
  // counter-entry. Show a red banner so the owner sees this
  // immediately (we should never ship a state where this breaks).
  const totalDebit = accountRows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = accountRows.reduce((s, r) => s + r.credit, 0);
  const balanced = Math.round((totalDebit - totalCredit) * 100) === 0;

  // Merge Payment + AdvancePayment into a single time-sorted feed so
  // the owner reads cash movement as one stream. Advance rows display
  // a small 'advance' chip; Payment rows show the invoice number.
  const feed: Array<
    | {
        kind:"PAYMENT";
        id: string;
        at: Date;
        amount: number;
        method: string;
        customer: string;
        invoiceNumber: number;
      }
    | {
        kind:"ADVANCE";
        id: string;
        at: Date;
        amount: number;
        method: string;
        customer: string;
        migrated: boolean;
      }
  > = [
    ...payments.map((p) => ({
      kind:"PAYMENT"as const,
      id: p.id,
      at: p.paidAt,
      amount: Number(p.amount),
      method: p.method,
      customer: p.invoice.jobCard.vehicle.customer.name,
      invoiceNumber: p.invoice.number,
    })),
    ...advances.map((a) => ({
      kind:"ADVANCE"as const,
      id: a.id,
      at: a.receivedAt,
      amount: Number(a.amount),
      method: a.method,
      customer: a.jobCard.vehicle.customer.name,
      migrated: a.migratedAt !== null,
    })),
  ].sort((x, y) => y.at.getTime() - x.at.getTime());

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="ledger"/>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("ledgerTitle")}</h1>
        <p className="text-sm text-text-mute">{t("ledgerSubtitle")}</p>
      </div>

      {/* Date-range filter — GET form so URL stays bookmarkable.
          Default range (this month → today) shows when params absent. */}
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-text-mute">
          {t("ledgerFrom")}
          <input
            type="date"
            name="from "
            defaultValue={ymd(fromD)}
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          />
        </label>
        <label className="flex flex-col text-xs text-text-mute">
          {t("ledgerTo")}
          <input
            type="date"
            name="to"
            defaultValue={ymd(now)}
            className="h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          />
        </label>
        <button className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors">
          {t("ledgerApply")}
        </button>
        {rawFrom || rawTo ? (
          <Link
            href="/owner/ledger"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors"
          >
            {t("ledgerReset")}
          </Link>
        ) : null}
      </form>

      {/* Trial-balance banner — success-toned card when the books are
          balanced (debit total == credit total) and danger-toned when
          there's drift. Includes a leading status icon + the totals so
          the owner can see both 'are we balanced?' and 'what's the
          gross volume?' at a glance. */}
      <div
        className={
          "flex flex-wrap items-center gap-2 rounded-xl border p-4 text-sm " +
          (balanced
            ? "border-success-500/40 bg-success-50 text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500"
            : "border-danger-500/40 bg-danger-50 text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500")
        }
      >
        <span className="text-lg" aria-hidden="true">{balanced ? "✓" : "⚠"}</span>
        <span className="font-semibold">{t("ledgerTrialBalance")}</span>
        <span className="text-text-mute">·</span>
        <span className="tabular-nums">
          {t("ledgerDebit")} <span className="font-semibold">{money(totalDebit)}</span>
        </span>
        <span className="text-text-mute">·</span>
        <span className="tabular-nums">
          {t("ledgerCredit")} <span className="font-semibold">{money(totalCredit)}</span>
        </span>
      </div>

      {/* Per-account rollup — same table treatment as the tech /
          advisor tables on /owner: uppercase tracking on headers,
          border-b row separation, zebra-stripe surface-2 on even rows.
          All money values right-aligned with tabular-nums so decimals
          stack cleanly. */}
      <div className="rounded-xl border border-border p-4">
        <h2 className="mb-3 text-base font-semibold">{t("ledgerByAccount")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-text-mute">
                <th className="py-2 pe-3 text-start font-semibold">{t("ledgerAccount")}</th>
                <th className="py-2 px-2 text-end font-semibold">{t("ledgerDebit")}</th>
                <th className="py-2 px-2 text-end font-semibold">{t("ledgerCredit")}</th>
                <th className="py-2 ps-2 text-end font-semibold">{t("ledgerNet")}</th>
              </tr>
            </thead>
            <tbody>
              {accountRows.map((r, i) => (
                <tr
                  key={r.account}
                  className={
                    "border-b border-border/60 " +
                    (i % 2 === 1 ? "bg-surface-2/40" : "")
                  }
                >
                  <td className="py-2 pe-3 font-medium">{r.account}</td>
                  <td className="py-2 px-2 text-end tabular-nums">
                    {money(r.debit)}
                  </td>
                  <td className="py-2 px-2 text-end tabular-nums">
                    {money(r.credit)}
                  </td>
                  {/* Net column — AR's spec: show abs value + a small
                      muted DR/CR tag based on the account's NATURAL
                      side. Cash/Bank and AR are debit-normal (DR);
                      Sales / VAT Payable / Customer Deposits are
                      credit-normal (CR). The signed net is preserved
                      in r.net (used elsewhere); only the display
                      changes. Unknown account → fall back to the
                      signed value so a future-added account doesn't
                      silently lose its sign. */}
                  <td className="py-2 ps-2 text-end tabular-nums font-semibold">
                    {NATURAL_SIDE[r.account] ? (
                      <>
                        {money(Math.abs(r.net))}
                        <span className="ms-1.5 text-xs font-medium tracking-wide text-text-mute">
                          {NATURAL_SIDE[r.account]}
                        </span>
                      </>
                    ) : (
                      money(r.net)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Individual payments feed — Payment + AdvancePayment merged
          time-sorted. 'advance' chip distinguishes pre-invoice money
          received. Migrated advances get a faded 'migrated' chip so
          the owner can tell which advances have already been applied
          to a final invoice. */}
      <div className="rounded-xl border border-border p-4">
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          {t("ledgerPayments")}
          <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold tabular-nums text-text-mute">
            {feed.length}
          </span>
        </h2>
        {feed.length === 0 ? (
          <p className="text-sm text-text-mute">
            {t("ledgerPaymentsEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {feed.map((row) => (
              <li
                key={`${row.kind}:${row.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="tabular-nums text-xs text-text-mute">
                    {row.at.toISOString().slice(0, 16).replace("T","")}
                  </span>
                  <span className="font-medium">{row.customer}</span>
                  {row.kind ==="PAYMENT"? (
                    <span className="inline-flex items-center rounded-full bg-success-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success-700 dark:bg-success-500/10 dark:text-success-500">
                      INV-{String(row.invoiceNumber).padStart(4,"0")}
                    </span>
                  ) : (
                    <>
                      <span className="inline-flex items-center rounded-full bg-warning-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning-600 dark:bg-warning-500/10 dark:text-warning-500">
                        advance
                      </span>
                      {row.migrated ? (
                        <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-mute">
                          migrated
                        </span>
                      ) : null}
                    </>
                  )}
                  <span className="text-xs text-text-mute">
                    {row.method ==="CASH"
                      ? t("methodCash")
                      : row.method ==="CARD_POS"
                        ? t("methodCardPos")
                        : row.method}
                  </span>
                </span>
                <span className="tabular-nums font-semibold">{money(row.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

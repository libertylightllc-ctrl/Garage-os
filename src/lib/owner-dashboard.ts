// Owner dashboard — five money-at-a-glance tiles.
//
// AR 2026-08-30 build. Every value is LEDGER-DERIVED per AR's Q2
// rule ("if it diverges from the invoice tables that divergence
// is a bug I want visible rather than papered over by picking
// the friendlier number"). So cash, revenue, and unpaid
// outstanding are all computed from LedgerEntry — never from
// Invoice.total minus Payment.amount, even when that would be
// cheaper. Cost is the one exception: the ledger doesn't carry
// per-line cost, so cost comes from InvoiceLine.unitCost frozen
// at invoice generation time — same source as JobProfitCard.
//
// Coverage discipline (AR's Q3 rule): profit-tile coverage is
// counted BY INVOICE, not by job or line. "N of M invoices this
// month have complete cost data." One big uncosted invoice
// among twenty small ones would read as 95 % coverage by line
// count while the profit figure is meaningless — invoice-count
// is the honest denominator.
//
// Month range is calendar Asia/Dubai — the shop's day starts at
// local midnight, not UTC midnight. Handled via
// startOfMonthInTz below.
//
// Additive only. No writes, no schema changes, no new routes.
// Every query is a SELECT / groupBy / aggregate scoped by
// garageId.

import { prisma } from "@/lib/prisma";
import { ACCOUNTS } from "@/lib/billing";

const TZ_DUBAI = "Asia/Dubai";

/**
 * Start of the month containing `now`, in the shop's local
 * timezone (Asia/Dubai). Returns a UTC Date whose instant is
 * `YYYY-MM-01T00:00:00` in that TZ.
 *
 * We use Intl.DateTimeFormat to extract the y/m/d parts in TZ,
 * then reconstruct a UTC timestamp for the first-of-month
 * midnight in that TZ. Node's Date arithmetic is UTC-based, so
 * we compute the offset manually.
 */
function startOfMonthInTz(now: Date, tz: string = TZ_DUBAI): Date {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const y = get("year");
    const m = get("month");
    // Midnight on the 1st of month `m/y` in the shop's TZ, as a
    // UTC instant. Trick: format `Date.UTC(y, m-1, 1, 0, 0, 0)` in
    // the TZ and see how far it drifts from midnight; the drift is
    // the TZ offset for that instant. Correct by that offset.
    const naiveUtc = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
    const projected = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(naiveUtc);
    const py = Number(projected.find((p) => p.type === "year")!.value);
    const pm = Number(projected.find((p) => p.type === "month")!.value);
    const pd = Number(projected.find((p) => p.type === "day")!.value);
    const ph = Number(projected.find((p) => p.type === "hour")!.value);
    // If projecting UTC-midnight-1st into Dubai TZ yields "Aug 1
    // 04:00 Dubai" (UTC+4), the offset is +4h. Subtract to get
    // the real UTC instant of Dubai midnight.
    const drift =
        Date.UTC(py, pm - 1, pd, ph, 0, 0, 0) -
        Date.UTC(y, m - 1, 1, 0, 0, 0);
    return new Date(naiveUtc.getTime() - drift);
}

/**
 * Start of the previous month in the shop's TZ. Handles year
 * rollover (Jan 1 → Dec 1 of previous year).
 */
function startOfPrevMonthInTz(now: Date, tz: string = TZ_DUBAI): Date {
    const monthStart = startOfMonthInTz(now, tz);
    // Step back one calendar month by subtracting a day from
    // monthStart and re-normalising to the 1st of THAT month.
    const backOne = new Date(monthStart.getTime() - 1);
    return startOfMonthInTz(backOne, tz);
}

/**
 * Same instant this-many-days-into-the-month, in the shop's TZ.
 * Used to compare "so far this month" against the same window
 * last month — so on Sept 3 we compare Sept 1-3 against Aug 1-3,
 * not partial-September against full-August. Avoids the
 * "we're worse!" panic on the 3rd of the month.
 */
function sameWindowStartLastMonth(now: Date, tz: string = TZ_DUBAI): Date {
    return startOfPrevMonthInTz(now, tz);
}
function sameWindowEndLastMonth(now: Date, tz: string = TZ_DUBAI): Date {
    // Last month's window ends at THIS month's start + elapsed
    // ms into current month. i.e. last month's [start, prevStart +
    // (now - thisStart)).
    const thisStart = startOfMonthInTz(now, tz);
    const elapsed = now.getTime() - thisStart.getTime();
    return new Date(startOfPrevMonthInTz(now, tz).getTime() + elapsed);
}

async function ledgerSum(
    garageId: string,
    account: string,
    field: "credit" | "debit",
    from: Date,
    to: Date,
): Promise<number> {
    const agg = await prisma.ledgerEntry.aggregate({
        where: { garageId, account, createdAt: { gte: from, lt: to } },
        _sum: { [field]: true } as { credit?: true; debit?: true },
    });
    return Number(agg._sum[field] ?? 0);
}

// ─────────────────────────────────────────────────────────────────

export type MonthPair = {
    thisMonth: number;
    lastMonthSameWindow: number;
};

/**
 * Cash received this month + last-month-same-window.
 * DEBIT-normal account (cash comes IN as a debit).
 */
export async function cashReceived(
    garageId: string,
    now: Date = new Date(),
): Promise<MonthPair> {
    const thisStart = startOfMonthInTz(now);
    const lastStart = startOfPrevMonthInTz(now);
    const lastEnd = sameWindowEndLastMonth(now);
    return {
        thisMonth: await ledgerSum(garageId, ACCOUNTS.CASH, "debit", thisStart, now),
        lastMonthSameWindow: await ledgerSum(garageId, ACCOUNTS.CASH, "debit", lastStart, lastEnd),
    };
}

/**
 * Revenue this month + last-month-same-window.
 * CREDIT-normal account (sales booked as credit).
 */
export async function revenueMonth(
    garageId: string,
    now: Date = new Date(),
): Promise<MonthPair> {
    const thisStart = startOfMonthInTz(now);
    const lastStart = startOfPrevMonthInTz(now);
    const lastEnd = sameWindowEndLastMonth(now);
    return {
        thisMonth: await ledgerSum(garageId, ACCOUNTS.SALES, "credit", thisStart, now),
        lastMonthSameWindow: await ledgerSum(garageId, ACCOUNTS.SALES, "credit", lastStart, lastEnd),
    };
}

// ─────────────────────────────────────────────────────────────────

export type AgingBuckets = {
    current: number;
    days30: number;
    days60: number;
    days90plus: number;
    total: number;
};

/**
 * Unpaid invoices by aging bucket, LEDGER-DERIVED.
 *
 * For each invoice-sourced AR ledger entry, sum the DR/CR balance
 * per invoice (invoice id = LedgerEntry.sourceId when
 * sourceType='INVOICE'). Any positive residual is unpaid AR.
 * Age each residual against its invoice's dueDate — accountant
 * convention.
 *
 * Why ledger and not `Invoice.total - SUM(Payment)`:
 *   - Voids: an INVOICE_VOID reversal already zeros the AR
 *     ledger entries, so the ledger reflects reality without
 *     needing a separate "is this invoice voided" branch.
 *   - Advance migration: an ADVANCE_MIGRATION LedgerEntry moves
 *     the AR down by the migrated advance amount; the ledger
 *     shows this cleanly. A "total minus payments" query would
 *     miss the advance migration and over-count outstanding.
 *   - Truth: the ledger is what the accountant checks against.
 *     If the invoice-side sum disagrees, THAT is the bug — not
 *     the number to display.
 */
export async function unpaidInvoicesAging(
    garageId: string,
    now: Date = new Date(),
): Promise<AgingBuckets> {
    // Every AR-touching ledger row for this garage. Grouped by
    // invoice sourceId. We include INVOICE + INVOICE_VOID +
    // PAYMENT + ADVANCE_MIGRATION rows so the balance reflects
    // every write path.
    //
    // INVOICE   → DR AR (sourceId = invoice.id)
    // INVOICE_VOID → CR AR (sourceId = invoice.id)
    // PAYMENT   → CR AR (sourceId = payment.id) — need to resolve to invoice
    // ADVANCE_MIGRATION → CR AR (sourceId = advancePayment.id) — need to resolve
    //
    // We simplify: aggregate by (sourceType, sourceId) then look
    // up the invoice ID for PAYMENT and ADVANCE_MIGRATION rows
    // via their FKs.
    const rows = await prisma.ledgerEntry.findMany({
        where: {
            garageId,
            account: ACCOUNTS.AR,
        },
        select: {
            sourceType: true,
            sourceId: true,
            debit: true,
            credit: true,
        },
    });

    // Balance per invoice.id
    const perInvoice = new Map<string, number>();
    const paymentIds: string[] = [];
    const advanceIds: string[] = [];
    for (const r of rows) {
        const bal = Number(r.debit) - Number(r.credit);
        if (r.sourceType === "INVOICE" || r.sourceType === "INVOICE_VOID") {
            perInvoice.set(r.sourceId, (perInvoice.get(r.sourceId) ?? 0) + bal);
        } else if (r.sourceType === "PAYMENT") {
            // Resolve to invoice via Payment.invoiceId in one batched
            // findMany below. Stash the row for the second pass.
            paymentIds.push(r.sourceId);
        } else if (r.sourceType === "ADVANCE_MIGRATION") {
            advanceIds.push(r.sourceId);
        }
    }

    // Batch-resolve payments to their invoice ids.
    if (paymentIds.length > 0) {
        const payments = await prisma.payment.findMany({
            where: { id: { in: paymentIds } },
            select: { id: true, invoiceId: true },
        });
        const invByPay = new Map(payments.map((p) => [p.id, p.invoiceId]));
        for (const r of rows) {
            if (r.sourceType !== "PAYMENT") continue;
            const invId = invByPay.get(r.sourceId);
            if (!invId) continue;
            perInvoice.set(invId, (perInvoice.get(invId) ?? 0) + Number(r.debit) - Number(r.credit));
        }
    }

    // Batch-resolve advance migrations. AdvancePayment.paymentId
    // points at the Payment created at migration time; that
    // Payment has invoiceId.
    if (advanceIds.length > 0) {
        const advances = await prisma.advancePayment.findMany({
            where: { id: { in: advanceIds } },
            select: { id: true, paymentId: true },
        });
        const advPayIds = advances.map((a) => a.paymentId).filter((x): x is string => !!x);
        const advPayments = advPayIds.length
            ? await prisma.payment.findMany({
                  where: { id: { in: advPayIds } },
                  select: { id: true, invoiceId: true },
              })
            : [];
        const invByPay = new Map(advPayments.map((p) => [p.id, p.invoiceId]));
        const invByAdv = new Map(
            advances
                .filter((a) => a.paymentId && invByPay.has(a.paymentId))
                .map((a) => [a.id, invByPay.get(a.paymentId!)!] as const),
        );
        for (const r of rows) {
            if (r.sourceType !== "ADVANCE_MIGRATION") continue;
            const invId = invByAdv.get(r.sourceId);
            if (!invId) continue;
            perInvoice.set(invId, (perInvoice.get(invId) ?? 0) + Number(r.debit) - Number(r.credit));
        }
    }

    // Filter to unpaid (positive residual, tiny epsilon for float
    // dust) and age against dueDate.
    const invoiceIds = Array.from(perInvoice.entries())
        .filter(([, bal]) => bal > 0.005)
        .map(([id]) => id);
    if (invoiceIds.length === 0) {
        return { current: 0, days30: 0, days60: 0, days90plus: 0, total: 0 };
    }
    const invoices = await prisma.invoice.findMany({
        where: { id: { in: invoiceIds } },
        select: { id: true, dueDate: true },
    });
    const dueById = new Map(invoices.map((i) => [i.id, i.dueDate]));

    const buckets: AgingBuckets = {
        current: 0,
        days30: 0,
        days60: 0,
        days90plus: 0,
        total: 0,
    };
    const nowMs = now.getTime();
    const DAY = 24 * 60 * 60 * 1000;
    for (const [invId, bal] of perInvoice.entries()) {
        if (bal <= 0.005) continue;
        const due = dueById.get(invId);
        if (!due) continue;
        const daysOverdue = Math.floor((nowMs - due.getTime()) / DAY);
        if (daysOverdue < 1) buckets.current += bal;
        else if (daysOverdue < 31) buckets.days30 += bal;
        else if (daysOverdue < 61) buckets.days60 += bal;
        else buckets.days90plus += bal;
        buckets.total += bal;
    }
    return round2Buckets(buckets);
}

function round2Buckets(b: AgingBuckets): AgingBuckets {
    const r = (n: number) => Math.round(n * 100) / 100;
    return {
        current: r(b.current),
        days30: r(b.days30),
        days60: r(b.days60),
        days90plus: r(b.days90plus),
        total: r(b.total),
    };
}

// ─────────────────────────────────────────────────────────────────

export type GrossProfit =
    | {
          state: "complete";
          revenue: number;
          cost: number;
          profit: number;
          marginPct: number;
          invoicesTotal: number;
          invoicesCosted: number;
      }
    | {
          state: "incomplete";
          revenue: number;
          invoicesTotal: number;
          invoicesCosted: number;
          invoicesMissingCost: number;
      };

/**
 * Gross profit this month, with the coverage discipline AR named
 * in Q3: count INVOICES with complete cost data against total
 * invoices, not lines or jobs.
 *
 * An invoice is "cost-complete" iff every PART line on it has
 * unitCost set. LABOR / SUBLET / FEE lines have no cost concept
 * per the schema comment (unitCost is nullable specifically for
 * those kinds); they don't count against coverage.
 *
 * If ANY invoice this month is missing cost on any PART line,
 * the tile renders "cost data incomplete" with the count. No
 * partially-computed number is shown — same discipline as
 * JobProfitCard.
 */
export async function grossProfitMonth(
    garageId: string,
    now: Date = new Date(),
): Promise<GrossProfit> {
    const thisStart = startOfMonthInTz(now);
    const revenue = await ledgerSum(garageId, ACCOUNTS.SALES, "credit", thisStart, now);

    // Every invoice issued this month + its PART lines' unitCost.
    // qty * unitCost = per-line cost; sum across all PART lines
    // on all invoices for the month total.
    const invoices = await prisma.invoice.findMany({
        where: {
            garageId,
            issuedAt: { gte: thisStart, lt: now },
        },
        select: {
            id: true,
            lines: {
                where: { kind: "PART" },
                select: { qty: true, unitCost: true },
            },
        },
    });

    const invoicesTotal = invoices.length;
    let invoicesCosted = 0;
    let totalCost = 0;
    for (const inv of invoices) {
        if (inv.lines.length === 0) {
            // No PART lines → no cost to account for; treat as
            // cost-complete. Labour-only invoices are perfectly
            // profit-visible.
            invoicesCosted += 1;
            continue;
        }
        const missingAny = inv.lines.some((l) => l.unitCost === null);
        if (missingAny) continue;
        invoicesCosted += 1;
        for (const l of inv.lines) {
            totalCost += Number(l.qty) * Number(l.unitCost);
        }
    }

    if (invoicesCosted < invoicesTotal) {
        return {
            state: "incomplete",
            revenue: Math.round(revenue * 100) / 100,
            invoicesTotal,
            invoicesCosted,
            invoicesMissingCost: invoicesTotal - invoicesCosted,
        };
    }

    const profit = revenue - totalCost;
    const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;
    return {
        state: "complete",
        revenue: Math.round(revenue * 100) / 100,
        cost: Math.round(totalCost * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        marginPct: Math.round(marginPct * 10) / 10,
        invoicesTotal,
        invoicesCosted,
    };
}

// ─────────────────────────────────────────────────────────────────

/**
 * Jobs delivered this month. Uses `deliveredAt` (the actual
 * customer-collected timestamp) rather than status=DELIVERED —
 * both indicate the same event, but the timestamp gives us the
 * exact month cutoff without a JS-side status filter.
 */
export async function jobsCompletedMonth(
    garageId: string,
    now: Date = new Date(),
): Promise<MonthPair> {
    const thisStart = startOfMonthInTz(now);
    const lastStart = startOfPrevMonthInTz(now);
    const lastEnd = sameWindowEndLastMonth(now);
    const [thisMonth, lastMonth] = await Promise.all([
        prisma.jobCard.count({
            where: { garageId, deliveredAt: { gte: thisStart, lt: now } },
        }),
        prisma.jobCard.count({
            where: { garageId, deliveredAt: { gte: lastStart, lt: lastEnd } },
        }),
    ]);
    return { thisMonth, lastMonthSameWindow: lastMonth };
}

// Exports for testing.
export const _testonly = {
    startOfMonthInTz,
    startOfPrevMonthInTz,
    sameWindowEndLastMonth,
};

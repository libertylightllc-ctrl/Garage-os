// Payables C6 — aging buckets for supplier bills.
//
// AR 2026-08-30 hard requirement: age from `billDate` (the supplier's
// tax invoice date, captured in C4.5), NOT from createdAt. Net 30 in
// the region clocks from invoice date — a supplier that shipped last
// Tuesday ages against last Tuesday even if the parts arrived today
// or the row was written to our DB seconds ago.
//
// Only OPEN + PARTIALLY_PAID bills contribute to aging. PAID has
// nothing outstanding; VOID has been reversed at ledger level and
// carries no live liability.
//
// Buckets match the customer-side unpaidInvoicesAging shape so
// owners read both surfaces the same way:
//   Current   0-30 days old
//   Days30    31-60
//   Days60    61-90
//   Days90+   91+
//
// Outstanding per bill = total - paidAmount. Total across buckets
// is the sum of every open bill's outstanding.

export interface AgingInputBill {
    billDate: Date;
    total: number;
    paidAmount: number;
    status: string;
}

export interface AgingBuckets {
    current: number;
    days30: number;
    days60: number;
    days90plus: number;
    total: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function agingBuckets(
    bills: AgingInputBill[],
    now: Date = new Date(),
): AgingBuckets {
    const b: AgingBuckets = {
        current: 0,
        days30: 0,
        days60: 0,
        days90plus: 0,
        total: 0,
    };
    const nowMs = now.getTime();
    for (const bill of bills) {
        if (bill.status !== "OPEN" && bill.status !== "PARTIALLY_PAID") continue;
        const outstanding = bill.total - bill.paidAmount;
        if (outstanding <= 0.005) continue;
        const ageDays = Math.floor((nowMs - bill.billDate.getTime()) / DAY_MS);
        if (ageDays < 31) b.current += outstanding;
        else if (ageDays < 61) b.days30 += outstanding;
        else if (ageDays < 91) b.days60 += outstanding;
        else b.days90plus += outstanding;
        b.total += outstanding;
    }
    return {
        current: round2(b.current),
        days30: round2(b.days30),
        days60: round2(b.days60),
        days90plus: round2(b.days90plus),
        total: round2(b.total),
    };
}

/** Outstanding across a list of bills, for the supplier-list view. */
export function supplierOutstanding(bills: AgingInputBill[]): number {
    let sum = 0;
    for (const bill of bills) {
        if (bill.status !== "OPEN" && bill.status !== "PARTIALLY_PAID") continue;
        const out = bill.total - bill.paidAmount;
        if (out > 0.005) sum += out;
    }
    return round2(sum);
}

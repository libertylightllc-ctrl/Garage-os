import { Prisma } from "@/generated/prisma/client";

/**
 * Labour cost snapshot at WorkSession close (AR 2026-08-12, profit
 * reporting Step 4).
 *
 * The garage's `defaultLaborHourlyCost` may drift over time — a raise,
 * a new payroll tier, an accounting cleanup. Historical margin reports
 * must NOT rewrite themselves every time the rate moves; the labour
 * cost that landed on a job in June should read the same in September.
 *
 * Rule:
 *   • hourlyCost is null (garage never set a rate, or set it then
 *     cleared it) → return null. The profit card counts these sessions
 *     into its Unknown bucket, never as "zero labour cost".
 *   • endedAt <= startedAt → return 0 as the DEFENSIVE case; a
 *     zero-duration session has no accrued cost regardless of rate.
 *     This shouldn't happen in the flow (SWITCHED/COMPLETED both
 *     stamp endedAt = now() and startedAt is always earlier) but the
 *     helper stays total.
 *   • Otherwise → hours × hourlyCost, rounded to 2 dp half-up.
 *     Hours are the millisecond delta divided by 3_600_000, held on
 *     Decimal to preserve full precision through the multiply.
 */

export function computeLaborCostSnapshot(
    startedAt: Date,
    endedAt: Date,
    hourlyCost: Prisma.Decimal | string | number | null,
): Prisma.Decimal | null {
    if (hourlyCost === null || hourlyCost === undefined) return null;
    const rate = new Prisma.Decimal(hourlyCost);

    const ms = endedAt.getTime() - startedAt.getTime();
    if (!Number.isFinite(ms) || ms <= 0) {
        return new Prisma.Decimal(0).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    }

    // ms → hours, kept on Decimal all the way through the multiply.
    // A JS number here would drift on long sessions (~ppb-scale but
    // enough to show up as a 0.01 diff on 8-hour shifts around
    // certain rates); the app runs Decimal everywhere else, we
    // stay consistent.
    const hours = new Prisma.Decimal(ms).dividedBy(3_600_000);

    return hours
        .times(rate)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

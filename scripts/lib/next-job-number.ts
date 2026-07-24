import type { PrismaClient } from "../../src/generated/prisma/client";

/**
 * Allocate the next per-garage JobCard.number for a fixture script,
 * using the SAME mechanism the real intake action uses:
 *
 *   UPDATE "Garage" SET "jobSeq" = "jobSeq" + 1 RETURNING "jobSeq"
 *
 * — via `prisma.garage.update({ data: { jobSeq: { increment: 1 } } })`,
 * which compiles to that row-locked update. Whatever value is returned
 * is guaranteed unique per garage.
 *
 * ── DO NOT use `MAX(JobCard.number) + 1` in fixture scripts. ────────
 * Every hand-rolled MAX+1 allocator has broken the intake action in
 * production-shaped local testing (60514bf, 2026-07-24 repeat). The
 * failure mode is silent: seed inserts JC-YYYY-NNNN, jobSeq stays behind
 * the max, the next real intake POST hits `@@unique([garageId, number])`
 * and dies with `PrismaClientKnownRequestError: Unique constraint
 * failed on the fields: ("garageId", number)`.
 *
 * If you're writing a new fixture script that creates JobCards: import
 * this. See real-shape reference at
 * src/app/actions/intake-moulkia.ts:342-346.
 *
 * Pinned by `AGENTS.md` under `## Rules`.
 */
export async function nextJobNumber(
  prisma: PrismaClient,
  garageId: string,
): Promise<number> {
  const g = await prisma.garage.update({
    where: { id: garageId },
    data: { jobSeq: { increment: 1 } },
    select: { jobSeq: true },
  });
  return g.jobSeq;
}

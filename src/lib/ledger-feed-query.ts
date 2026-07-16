// Server-side paginated read for the owner-ledger "Individual payments"
// feed. Combines Payment + AdvancePayment via SQL UNION ALL so the count
// and slice are honest — the old JS merge fetched every row in the window
// then sliced in memory, which does not scale.
//
// Ordering matches the JS merge in src/lib/ledger-feed.ts exactly. That
// parity is asserted by src/lib/__tests__/ledger-feed-union-parity.test.ts;
// if it breaks, the owner ledger silently reorders money on the page.
//
//   ORDER BY at DESC          — newest first, same as JS y.at - x.at
//   ORDER BY kind_ord ASC     — tie-break: PAYMENT (0) beats ADVANCE (1),
//                               same as V8's stable Array.sort against
//                               [...payments, ...advances]
//   ORDER BY id DESC          — final deterministic fallback; never trips
//                               in the JS path because id ties never occur
//                               (cuid), but present so no run is
//                               under-specified

import { prisma } from "@/lib/prisma";

export type FeedKind = "PAYMENT" | "ADVANCE";

export interface FeedRow {
  kind: FeedKind;
  id: string;
  at: Date;
  amount: number;
  method: string;
  customer: string;
  invoiceNumber: number | null;
  migrated: boolean | null;
}

interface RawUnionRow {
  kind: FeedKind;
  id: string;
  at: Date;
  amount: string; // Decimal returned as string by raw SQL
  method: string;
  customer: string;
  invoice_number: number | null;
  migrated_at: Date | null;
}

export async function runLedgerFeedUnion({
  garageIds,
  from,
  to,
  skip,
  take,
}: {
  garageIds: string[];
  from: Date;
  to: Date;
  skip: number;
  take: number;
}): Promise<{ rows: FeedRow[]; totalCount: number }> {
  if (garageIds.length === 0) return { rows: [], totalCount: 0 };

  // Prisma's $queryRaw tagged template only interpolates scalars — for
  // an array of garageIds we need Prisma.join. Use $queryRawUnsafe with
  // a parameterized placeholder list to keep it injection-safe.
  const placeholders = garageIds.map((_, i) => `$${i + 1}`).join(",");
  const fromIdx = garageIds.length + 1;
  const toIdx = garageIds.length + 2;
  const takeIdx = garageIds.length + 3;
  const skipIdx = garageIds.length + 4;

  const sql = `
    WITH combined AS (
      SELECT
        'PAYMENT'::text  AS kind,
        p.id             AS id,
        p."paidAt"       AS at,
        p.amount         AS amount,
        p.method         AS method,
        cu.name          AS customer,
        i.number         AS invoice_number,
        NULL::timestamp  AS migrated_at,
        0                AS kind_ord
      FROM "Payment" p
      JOIN "Invoice" i  ON i.id = p."invoiceId"
      JOIN "JobCard" j  ON j.id = i."jobCardId"
      JOIN "Vehicle" v  ON v.id = j."vehicleId"
      JOIN "Customer" cu ON cu.id = v."customerId"
      WHERE i."garageId" IN (${placeholders})
        AND p."paidAt" >= $${fromIdx}
        AND p."paidAt" <= $${toIdx}
      UNION ALL
      SELECT
        'ADVANCE'::text  AS kind,
        a.id             AS id,
        a."receivedAt"   AS at,
        a.amount         AS amount,
        a.method         AS method,
        cu.name          AS customer,
        NULL::int        AS invoice_number,
        a."migratedAt"   AS migrated_at,
        1                AS kind_ord
      FROM "AdvancePayment" a
      JOIN "JobCard" j   ON j.id = a."jobCardId"
      JOIN "Vehicle" v   ON v.id = j."vehicleId"
      JOIN "Customer" cu ON cu.id = v."customerId"
      WHERE a."garageId" IN (${placeholders})
        AND a."receivedAt" >= $${fromIdx}
        AND a."receivedAt" <= $${toIdx}
    )
    SELECT kind, id, at, amount, method, customer, invoice_number, migrated_at
    FROM combined
    ORDER BY at DESC, kind_ord ASC, id DESC
    LIMIT $${takeIdx} OFFSET $${skipIdx}
  `;

  // Postgres allows the same $N to be referenced multiple times, so both
  // UNION arms reuse $1..$N (garageIds) and $fromIdx/$toIdx (dates). We
  // pass exactly N+4 params: garageIds ×N, from, to, take, skip.
  const raw = await prisma.$queryRawUnsafe<RawUnionRow[]>(
    sql,
    ...garageIds,
    from,
    to,
    take,
    skip,
  );

  const countSql = `
    SELECT COUNT(*)::bigint AS n FROM (
      SELECT p.id
      FROM "Payment" p
      JOIN "Invoice" i ON i.id = p."invoiceId"
      WHERE i."garageId" IN (${placeholders})
        AND p."paidAt" >= $${fromIdx}
        AND p."paidAt" <= $${toIdx}
      UNION ALL
      SELECT a.id
      FROM "AdvancePayment" a
      WHERE a."garageId" IN (${placeholders})
        AND a."receivedAt" >= $${fromIdx}
        AND a."receivedAt" <= $${toIdx}
    ) t
  `;
  const countRes = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    countSql,
    ...garageIds,
    from,
    to,
  );
  const totalCount = Number(countRes[0]?.n ?? 0);

  const rows: FeedRow[] = raw.map((r) => ({
    kind: r.kind,
    id: r.id,
    at: r.at,
    amount: Number(r.amount),
    method: r.method,
    customer: r.customer,
    invoiceNumber: r.invoice_number,
    migrated: r.migrated_at !== null,
  }));

  return { rows, totalCount };
}

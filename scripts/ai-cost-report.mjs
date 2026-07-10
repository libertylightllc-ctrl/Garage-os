// READ-ONLY report: real AiEvent usage from PROD (.env DATABASE_URL).
// SELECT queries only — no writes anywhere.
import "dotenv/config";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
const host = new URL(url).hostname;
if (!host.includes("supabase")) {
  console.error("Expected the prod Supabase host, got:", host);
  process.exit(1);
}
console.log("target (read-only):", host);

const c = new Client({ connectionString: url });
await c.connect();
const q = (sql, params) => c.query(sql, params).then((r) => r.rows);

const SINCE = "now() - interval '30 days'";

console.log("\n== 1. calls last 30 days, by kind + sourceType + model ==");
console.table(
  await q(`
    SELECT "kind", coalesce(split_part("sourceType", ':', 1), '—') AS source,
           "model",
           count(*)::int AS calls,
           sum("tokensIn")::int  AS tokens_in,
           sum("tokensOut")::int AS tokens_out,
           round(sum("costEstimate")::numeric, 4) AS cost_usd,
           count(*) FILTER (WHERE "sourceType" LIKE '%:%')::int AS error_attempts
    FROM "AiEvent"
    WHERE "createdAt" > ${SINCE}
    GROUP BY 1, 2, 3
    ORDER BY cost_usd DESC NULLS LAST`),
);

console.log("\n== 2. totals last 30 days ==");
console.table(
  await q(`
    SELECT count(*)::int AS calls,
           sum("tokensIn")::int AS tokens_in,
           sum("tokensOut")::int AS tokens_out,
           round(sum("costEstimate")::numeric, 4) AS cost_usd,
           round(avg("costEstimate")::numeric, 6) AS avg_usd_per_call,
           round(max("costEstimate")::numeric, 4) AS max_usd_call
    FROM "AiEvent" WHERE "createdAt" > ${SINCE}`),
);

console.log("\n== 3. by garage (who drives usage) ==");
console.table(
  await q(`
    SELECT g."name", count(*)::int AS calls, round(sum(e."costEstimate")::numeric, 4) AS cost_usd
    FROM "AiEvent" e JOIN "Garage" g ON g.id = e."garageId"
    WHERE e."createdAt" > ${SINCE}
    GROUP BY 1 ORDER BY 3 DESC`),
);

console.log("\n== 4. retry signal: bursts of same kind+garage within 10 minutes ==");
console.table(
  await q(`
    WITH x AS (
      SELECT "garageId", "kind", "createdAt",
             lag("createdAt") OVER (PARTITION BY "garageId", "kind" ORDER BY "createdAt") AS prev
      FROM "AiEvent" WHERE "createdAt" > ${SINCE}
    )
    SELECT "kind", count(*) FILTER (WHERE "createdAt" - prev < interval '10 minutes')::int AS calls_within_10min_of_previous,
           count(*)::int AS total
    FROM x GROUP BY 1`),
);

console.log("\n== 5. invoice-OCR docs vs attempts (PartsImport rows vs OCR events) ==");
console.table(
  await q(`
    SELECT
      (SELECT count(*)::int FROM "PartsImport" WHERE "createdAt" > ${SINCE}) AS imports_created,
      (SELECT count(*)::int FROM "AiEvent" WHERE "createdAt" > ${SINCE} AND "sourceType" LIKE 'PARTS_INVOICE%') AS invoice_ocr_events`),
);

console.log("\n== 6. all-time totals for context ==");
console.table(
  await q(`
    SELECT count(*)::int AS calls, round(sum("costEstimate")::numeric, 4) AS cost_usd,
           min("createdAt")::date AS first_event
    FROM "AiEvent"`),
);

await c.end();

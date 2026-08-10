// One-shot backfill for Phase 1 of per-document tokens (2026-08-10).
// Populates publicToken on every existing row of Invoice, Estimate,
// PurchaseOrder, JobCard that currently has publicToken=NULL.
//
// Idempotent: on rerun, skips rows that already have a token. Safe to
// invoke against Prod after the 20260810180000_add_public_tokens
// migration deploys.
//
// Usage:
//   npx tsx scripts/backfill-public-tokens.ts        # target auto-set by target-prod
//
// Token shape: 32 URL-safe base64 characters = 192 bits of entropy
// from crypto.randomBytes(24). Distinguishable from a cuid (which
// always starts with 'c' followed by 24 alphanumeric chars) — cuids
// look like `cmskqh9pd000b04jskvkbmyqv`; tokens look like
// `RyU7d-3zK9pQlNv1MjO4TpB2eXqIf-Sa`. Any future URL-based token
// verifier can dispatch on the presence of `~` (HMAC signature
// separator, phase 1/2 co-existence) or `-`/`_` (base64url-only
// chars — never appear in cuid v1).

import "./lib/target-prod.mjs";
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/prisma";

function newToken(): string {
  // 24 raw bytes → 32 base64url chars. Node's base64url encoding is
  // already URL-safe (no +/=) so the string is copy-pastable into a URL
  // without further encoding.
  return randomBytes(24).toString("base64url");
}

interface ModelStats {
  name: string;
  total: number;
  before: number;
  filled: number;
  after: number;
}

async function backfillModel<T extends { id: string; publicToken: string | null }>(
  name: string,
  findWithoutToken: () => Promise<T[]>,
  countAll: () => Promise<number>,
  countMissing: () => Promise<number>,
  updateOne: (id: string, token: string) => Promise<unknown>,
): Promise<ModelStats> {
  const before = await countMissing();
  const total = await countAll();
  let filled = 0;
  if (before === 0) {
    return { name, total, before, filled, after: 0 };
  }
  // Fetch ids only; loop and write one-by-one. Batch upserts don't
  // help here — the token must be unique per row so we can't share a
  // value across the batch anyway, and per-row round-trips are fine
  // at the ~200-row scale (Demo Garage's entire history) we're
  // operating against.
  const rows = await findWithoutToken();
  for (const r of rows) {
    // Retry on the vanishingly unlikely event of a token collision
    // (192-bit entropy makes this ~zero, but @unique enforces it).
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await updateOne(r.id, newToken());
        filled++;
        break;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("Unique constraint") || attempt === 3) throw e;
      }
    }
  }
  const after = await countMissing();
  return { name, total, before, filled, after };
}

async function main() {
  const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "(none)";
  console.log(`Backfilling public tokens against: ${host}\n`);

  const results: ModelStats[] = [];

  results.push(await backfillModel(
    "Invoice",
    () => prisma.invoice.findMany({ where: { publicToken: null }, select: { id: true, publicToken: true } }),
    () => prisma.invoice.count(),
    () => prisma.invoice.count({ where: { publicToken: null } }),
    (id, token) => prisma.invoice.update({ where: { id }, data: { publicToken: token } }),
  ));
  results.push(await backfillModel(
    "Estimate",
    () => prisma.estimate.findMany({ where: { publicToken: null }, select: { id: true, publicToken: true } }),
    () => prisma.estimate.count(),
    () => prisma.estimate.count({ where: { publicToken: null } }),
    (id, token) => prisma.estimate.update({ where: { id }, data: { publicToken: token } }),
  ));
  results.push(await backfillModel(
    "PurchaseOrder",
    () => prisma.purchaseOrder.findMany({ where: { publicToken: null }, select: { id: true, publicToken: true } }),
    () => prisma.purchaseOrder.count(),
    () => prisma.purchaseOrder.count({ where: { publicToken: null } }),
    (id, token) => prisma.purchaseOrder.update({ where: { id }, data: { publicToken: token } }),
  ));
  results.push(await backfillModel(
    "JobCard",
    () => prisma.jobCard.findMany({ where: { publicToken: null }, select: { id: true, publicToken: true } }),
    () => prisma.jobCard.count(),
    () => prisma.jobCard.count({ where: { publicToken: null } }),
    (id, token) => prisma.jobCard.update({ where: { id }, data: { publicToken: token } }),
  ));

  console.log("Model            total   missing→filled   remaining");
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(15)}${String(r.total).padStart(4)}   ${String(r.before).padStart(6)}→${String(r.filled).padStart(6)}   ${String(r.after).padStart(6)}`,
    );
  }
  const remainingTotal = results.reduce((s, r) => s + r.after, 0);
  if (remainingTotal > 0) {
    console.error(`\nSome rows remain unfilled (${remainingTotal}). Rerun the script.`);
    process.exit(2);
  }
  console.log("\nAll rows have publicToken. Phase 1 backfill complete.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

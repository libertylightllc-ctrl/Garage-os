// READ-ONLY. Counts customer links (invoice + estimate) that would fail
// on tap because AUTH_SECRET was rotated on Prod at 2026-08-01 13:21:52 UTC.
// Zero writes.
//
// Method:
//   - InvoiceSend rows have the true send timestamp. Anything with
//     createdAt < rotation was signed with the old secret. Anything >=
//     rotation was signed with the current secret. HMAC output isn't
//     stored, so this timestamp comparison is the only way to bucket.
//   - Estimates don't have a dedicated send-audit table; the closest
//     proxy is Estimate.sentAt (the timestamp the cashier flipped to
//     SENT). Same timestamp rule applies for that shape.
//
// A dead link CAN'T be resurrected — the pre-rotation secret is gone.
// Recovery for a specific customer today: void + reissue the invoice,
// or re-send the estimate (new signature under the current secret).
import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";

const ROTATION = new Date("2026-08-01T13:21:52.454Z");

async function main() {
  const host = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "(none)";
  if (!host.includes("supabase")) {
    console.error(`Refusing to run — DATABASE_URL host is ${host}, no 'supabase'.`);
    process.exit(1);
  }
  console.log(`Target: PROD (${host})`);
  console.log(`Rotation cutoff: ${ROTATION.toISOString()}\n`);

  // ── Invoice sends ─────────────────────────────────────────────────
  const invSends = await prisma.invoiceSend.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true, invoiceId: true, channel: true, createdAt: true,
      recipient: true, sentByName: true, status: true,
      garage: { select: { name: true } },
      invoice: { select: { number: true, issuedAt: true, status: true } },
    },
  });
  const invDead = invSends.filter((s) => s.createdAt < ROTATION);
  const invLive = invSends.filter((s) => s.createdAt >= ROTATION);

  console.log(`── Invoice sends ──`);
  console.log(`Total send rows           : ${invSends.length}`);
  console.log(`  Signed BEFORE rotation  : ${invDead.length}   ← dead links`);
  console.log(`  Signed AFTER rotation   : ${invLive.length}   ← still valid`);

  if (invSends.length > 0) {
    console.log(`\nDead invoice sends (invoiceId · garage · sentBy · when · channel):`);
    for (const s of invDead) {
      console.log(`  ${s.invoiceId} · ${s.garage.name} · ${s.sentByName} · ${s.createdAt.toISOString()} · ${s.channel}`);
    }
    console.log(`\nLive invoice sends:`);
    for (const s of invLive) {
      console.log(`  ${s.invoiceId} · ${s.garage.name} · ${s.sentByName} · ${s.createdAt.toISOString()} · ${s.channel}`);
    }
  }

  // ── Estimate sends (via Estimate.sentAt proxy) ───────────────────
  const estSent = await prisma.estimate.findMany({
    where: { sentAt: { not: null } },
    orderBy: { sentAt: "asc" },
    select: {
      id: true, sentAt: true, status: true, approvedAt: true,
      jobCard: { select: { garage: { select: { name: true } } } },
    },
  });
  const estDead = estSent.filter((e) => e.sentAt! < ROTATION);
  const estLive = estSent.filter((e) => e.sentAt! >= ROTATION);

  console.log(`\n── Estimate sends (via Estimate.sentAt) ──`);
  console.log(`Total sent estimates      : ${estSent.length}`);
  console.log(`  sentAt BEFORE rotation  : ${estDead.length}   ← dead links`);
  console.log(`  sentAt AFTER  rotation  : ${estLive.length}   ← still valid`);

  if (estSent.length > 0) {
    console.log(`\nDead estimate sends (estimateId · garage · status · approved? · sentAt):`);
    for (const e of estDead) {
      const approved = e.approvedAt ? `APPROVED ${e.approvedAt.toISOString()}` : "not approved";
      console.log(`  ${e.id} · ${e.jobCard.garage.name} · ${e.status} · ${approved} · ${e.sentAt!.toISOString()}`);
    }
    console.log(`\nLive estimate sends:`);
    for (const e of estLive) {
      const approved = e.approvedAt ? `APPROVED ${e.approvedAt.toISOString()}` : "not approved";
      console.log(`  ${e.id} · ${e.jobCard.garage.name} · ${e.status} · ${approved} · ${e.sentAt!.toISOString()}`);
    }
  }

  // ── Per-tenant summary ────────────────────────────────────────────
  console.log(`\n── Per-garage dead-link summary ──`);
  const byGarage = new Map<string, { deadInv: number; liveInv: number; deadEst: number; liveEst: number }>();
  for (const s of invSends) {
    const g = byGarage.get(s.garage.name) ?? { deadInv: 0, liveInv: 0, deadEst: 0, liveEst: 0 };
    if (s.createdAt < ROTATION) g.deadInv++; else g.liveInv++;
    byGarage.set(s.garage.name, g);
  }
  for (const e of estSent) {
    const gname = e.jobCard.garage.name;
    const g = byGarage.get(gname) ?? { deadInv: 0, liveInv: 0, deadEst: 0, liveEst: 0 };
    if (e.sentAt! < ROTATION) g.deadEst++; else g.liveEst++;
    byGarage.set(gname, g);
  }
  for (const [g, s] of byGarage.entries()) {
    console.log(`  ${g.padEnd(30)} · inv ${s.deadInv} dead / ${s.liveInv} live · est ${s.deadEst} dead / ${s.liveEst} live`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

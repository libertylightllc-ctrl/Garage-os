// AR 2026-08-19. Delete every orphan LedgerEntry row — a ledger row
// is "orphan" when its (sourceType, sourceId) doesn't match a
// surviving row in the source table:
//
//   sourceType='INVOICE'              → Invoice
//   sourceType='INVOICE_VOID'         → Invoice  (voidReversalLedger's source is the original invoice)
//   sourceType='PAYMENT'              → Payment
//   sourceType='ADVANCE'              → AdvancePayment
//   sourceType='ADVANCE_MIGRATION'    → AdvancePayment
//
// Cause: manual DELETE against prod removed 5 Invoice rows and 78
// Payment rows, leaving their ledger entries behind. AR 2026-08-19
// confirmed all rows in scope are Demo Garage test data — no real
// money moved. Ledger-source delete trigger (in the sibling
// migration) prevents this class of drift going forward.
//
// Dry-run by default (no writes). Pass --commit to actually delete.
// The dry-run:
//   1. lists every orphan row it would remove, per class;
//   2. prints per-account nets (Cash / AR / Sales / VAT / Deposits)
//      for the orphans;
//   3. prints the ledger account nets BEFORE and PROJECTED-AFTER
//      cleanup, so the effect on the Reports tiles is explicit and
//      you can eyeball the tie-out before running --commit.

import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";

const COMMIT = process.argv.includes("--commit");

type OrphanClass = {
  sourceType: "INVOICE" | "INVOICE_VOID" | "PAYMENT" | "ADVANCE" | "ADVANCE_MIGRATION";
  targetTable: "Invoice" | "Payment" | "AdvancePayment";
};

// Every class where sourceType points at a table we can join back to.
// A class not listed here would be silently skipped — add it if a new
// zero-entry writer is introduced.
const CLASSES: OrphanClass[] = [
  { sourceType: "INVOICE", targetTable: "Invoice" },
  { sourceType: "INVOICE_VOID", targetTable: "Invoice" },
  { sourceType: "PAYMENT", targetTable: "Payment" },
  { sourceType: "ADVANCE", targetTable: "AdvancePayment" },
  { sourceType: "ADVANCE_MIGRATION", targetTable: "AdvancePayment" },
];

// Accounts we care about for Reports tiles. Anything else is
// tracked in `other` so a surprise account name is visible.
const TRACKED = new Set([
  "Cash/Bank",
  "Accounts Receivable",
  "Sales Revenue",
  "VAT Payable",
  "Customer Deposits",
]);

type Nets = {
  "Cash/Bank": number;
  "Accounts Receivable": number;
  "Sales Revenue": number;
  "VAT Payable": number;
  "Customer Deposits": number;
  other: number;
};

function emptyNets(): Nets {
  return {
    "Cash/Bank": 0,
    "Accounts Receivable": 0,
    "Sales Revenue": 0,
    "VAT Payable": 0,
    "Customer Deposits": 0,
    other: 0,
  };
}

async function main() {
  const num = (d: unknown) => Number(d ?? 0);
  const fmt = (n: number) => n.toFixed(2).padStart(12);
  const bar = "─".repeat(78);

  console.log(bar);
  console.log(`  cleanup-orphan-ledger — mode: ${COMMIT ? "COMMIT" : "DRY-RUN"}`);
  console.log(bar);
  if (!COMMIT) {
    console.log("  (no writes will happen; re-run with --commit to actually delete)");
  }

  // ── Baseline nets across ALL ledger rows (for the before/after
  // comparison at the end).
  const allLedger = await prisma.ledgerEntry.findMany({
    select: { account: true, debit: true, credit: true },
  });
  const beforeNets = emptyNets();
  for (const r of allLedger) {
    const signed = num(r.debit) - num(r.credit);
    if (TRACKED.has(r.account)) beforeNets[r.account as keyof Nets] += signed;
    else beforeNets.other += signed;
  }

  // ── Collect orphans per class, print detail, sum per-account.
  const allOrphanIds: string[] = [];
  const orphanNets = emptyNets();
  const perClassSummary: Array<{ srcType: string; rowCount: number; sourceCount: number; nets: Nets }> = [];

  for (const cls of CLASSES) {
    const rows = await prisma.ledgerEntry.findMany({
      where: { sourceType: cls.sourceType },
      select: {
        id: true, sourceId: true, account: true, debit: true, credit: true, createdAt: true, garageId: true,
      },
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) {
      perClassSummary.push({ srcType: cls.sourceType, rowCount: 0, sourceCount: 0, nets: emptyNets() });
      continue;
    }
    const distinct = Array.from(new Set(rows.map((r) => r.sourceId)));
    let known: Set<string>;
    if (cls.targetTable === "Invoice") {
      known = new Set((await prisma.invoice.findMany({
        where: { id: { in: distinct } }, select: { id: true },
      })).map((r) => r.id));
    } else if (cls.targetTable === "Payment") {
      known = new Set((await prisma.payment.findMany({
        where: { id: { in: distinct } }, select: { id: true },
      })).map((r) => r.id));
    } else {
      known = new Set((await prisma.advancePayment.findMany({
        where: { id: { in: distinct } }, select: { id: true },
      })).map((r) => r.id));
    }
    const orph = rows.filter((r) => !known.has(r.sourceId));
    const orphSources = new Set(orph.map((r) => r.sourceId));
    const nets = emptyNets();
    for (const r of orph) {
      const signed = num(r.debit) - num(r.credit);
      if (TRACKED.has(r.account)) nets[r.account as keyof Nets] += signed;
      else nets.other += signed;
      allOrphanIds.push(r.id);
      // Also accumulate into total orphan nets
      if (TRACKED.has(r.account)) orphanNets[r.account as keyof Nets] += signed;
      else orphanNets.other += signed;
    }
    perClassSummary.push({
      srcType: cls.sourceType,
      rowCount: orph.length,
      sourceCount: orphSources.size,
      nets,
    });

    console.log(`\n== ${cls.sourceType} orphans ==`);
    console.log(`   distinct orphan source ids: ${orphSources.size}`);
    console.log(`   ledger rows to delete:      ${orph.length}`);
    if (orph.length > 0) {
      console.log(`   Rows the script ${COMMIT ? "WILL delete" : "WOULD delete"}:`);
      console.log(`     createdAt              sourceId (last 12)   account                     debit        credit`);
      for (const r of orph) {
        console.log(
          `     ${r.createdAt.toISOString()}  ${r.sourceId.slice(-12).padEnd(20)} ${r.account.padEnd(24)} ${fmt(num(r.debit))} ${fmt(num(r.credit))}`,
        );
      }
      console.log(`   per-account nets (signed, DR positive):`);
      for (const acct of Object.keys(nets) as Array<keyof Nets>) {
        if (nets[acct] !== 0) console.log(`     ${String(acct).padEnd(24)} ${fmt(nets[acct])}`);
      }
    }
  }

  // ── Per-class summary table
  console.log(`\n== summary by class ==`);
  console.log(`   class                rows sources    Cash        AR         Sales       VAT       Deposits`);
  for (const s of perClassSummary) {
    console.log(
      `   ${s.srcType.padEnd(20)} ${String(s.rowCount).padStart(4)} ${String(s.sourceCount).padStart(7)}  ${fmt(s.nets["Cash/Bank"])} ${fmt(s.nets["Accounts Receivable"])} ${fmt(s.nets["Sales Revenue"])} ${fmt(s.nets["VAT Payable"])} ${fmt(s.nets["Customer Deposits"])}`,
    );
  }

  // ── Before / projected-after
  console.log(`\n== ledger account nets — before vs projected-after cleanup ==`);
  console.log(`   account               before          orphan effect   projected after`);
  for (const acct of Object.keys(beforeNets) as Array<keyof Nets>) {
    const before = beforeNets[acct];
    const orph = orphanNets[acct];
    const after = before - orph;
    console.log(
      `   ${String(acct).padEnd(20)} ${fmt(before)}   ${fmt(-orph)}    ${fmt(after)}`,
    );
  }
  console.log(`   (orphan effect column shows what the cleanup REMOVES — i.e. negation of the orphan net)`);
  console.log(`   (projected-after should match Reports tiles after --commit reruns)`);

  console.log(`\n${bar}`);
  if (!COMMIT) {
    console.log(`  DRY-RUN complete. No rows deleted.`);
    console.log(`  Total rows the --commit run would delete: ${allOrphanIds.length}`);
    console.log(`  Re-run with --commit to delete every orphan row across all classes.`);
    console.log(bar);
    await prisma.$disconnect();
    return;
  }

  // ── COMMIT path ────────────────────────────────────────────────
  if (allOrphanIds.length === 0) {
    console.log(`  No orphans to delete. Ledger is clean.`);
    console.log(bar);
    await prisma.$disconnect();
    return;
  }
  console.log(`  COMMIT mode — deleting ${allOrphanIds.length} rows across all classes...`);
  // Batch delete in chunks — id list is small (<200 rows expected)
  // but keep the query bounded either way.
  const CHUNK = 500;
  let removed = 0;
  for (let i = 0; i < allOrphanIds.length; i += CHUNK) {
    const slice = allOrphanIds.slice(i, i + CHUNK);
    const result = await prisma.ledgerEntry.deleteMany({ where: { id: { in: slice } } });
    removed += result.count;
  }
  console.log(`  DELETE completed. Removed: ${removed} rows.`);
  console.log(`  Reports tiles reflect the change on next page load.`);
  console.log(bar);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

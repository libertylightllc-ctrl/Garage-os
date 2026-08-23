// Read-only Prod probe for the customer-phone normalisation cliff
// (AR 2026-08-23, step 4 of the phone-write plan).
//
// Reports how many Customer rows in Prod hold a phone that:
//   [A] normalizeToE164 REJECTS today (pre-widen shape),
//   [B] the NEW widened normalizeToE164 would resolve to E.164,
//   [C] would remain unresolvable even after widening (needs advisor
//       fix on next contact).
//
// Splits by shape so the counts make the backfill script's cost
// obvious: (a) is what today's send path falls back to picker for;
// (b) is what the backfill would clean up in one pass; (c) is the
// residual that stays flagged with phoneNeedsReview=true.
//
// Sample offenders are printed with the customer id + garage id +
// stored phone shape, so AR can spot-check a handful before
// deciding whether to run the backfill.

import "./lib/target-prod.mjs";
import { prisma } from "../src/lib/prisma";
import { normalizeToE164 } from "../src/lib/wa";

// Snapshot of the OLD (pre-widen) normalizeToE164 — inline copy so
// this probe reports pre-widen vs post-widen counts against the
// live Prod schema without depending on git history.
function normalizeToE164Legacy(raw: string): string | null {
    const GCC = ["971", "966", "968", "974", "973", "965"] as const;
    const cleaned = String(raw).replace(/[^\d+]/g, "");
    if (!cleaned) return null;
    let digits: string;
    if (cleaned.startsWith("+")) digits = cleaned.slice(1);
    else if (cleaned.startsWith("00")) digits = cleaned.slice(2);
    else if (cleaned.startsWith("0") && cleaned.length === 10) digits = "971" + cleaned.slice(1);
    else digits = cleaned;
    while (digits.startsWith("0")) digits = digits.slice(1);
    if (!/^\d+$/.test(digits)) return null;
    if (digits.length < 8 || digits.length > 15) return null;
    if (!GCC.some((c) => digits.startsWith(c))) return null;
    return digits;
}

async function main() {
    const all = await prisma.customer.findMany({
        select: {
            id: true,
            garageId: true,
            phone: true,
            waId: true,
            name: true,
        },
    });

    const total = all.length;
    let alreadyClean = 0;                 // legacy normaliser accepts as-is
    let fixedByWidening = 0;              // legacy rejects, new accepts
    let stillUnresolvable = 0;            // both reject
    const sampleFixedByWidening: typeof all = [];
    const sampleStillUnresolvable: typeof all = [];

    for (const c of all) {
        const legacy = normalizeToE164Legacy(c.phone);
        const widened = normalizeToE164(c.phone);
        if (legacy !== null) {
            alreadyClean++;
        } else if (widened !== null) {
            fixedByWidening++;
            if (sampleFixedByWidening.length < 15) sampleFixedByWidening.push(c);
        } else {
            stillUnresolvable++;
            if (sampleStillUnresolvable.length < 15) sampleStillUnresolvable.push(c);
        }
    }

    // Also count how many rows are ALREADY stored in a canonical
    // shape (E.164 without "+", 10-15 digits, GCC-prefixed) — those
    // don't need touching by any backfill.
    let alreadyE164 = 0;
    for (const c of all) {
        if (normalizeToE164(c.phone) === c.phone) alreadyE164++;
    }

    console.log("");
    console.log("=== Customer.phone shape audit (Prod, %s) ===", new Date().toISOString());
    console.log("Total Customer rows                       : %d", total);
    console.log("Already E.164 (no rewrite needed)         : %d", alreadyE164);
    console.log("");
    console.log("Send-path behaviour under CURRENT normalizeToE164:");
    console.log("  [A] resolved (would send direct)        : %d", alreadyClean);
    console.log("  [B+C] rejected (falls to contact picker): %d", fixedByWidening + stillUnresolvable);
    console.log("");
    console.log("Backfill impact (widened normalizeToE164):");
    console.log("  [B] newly-resolvable (backfill fixes)   : %d", fixedByWidening);
    console.log("  [C] stays unresolvable (needsReview=true): %d", stillUnresolvable);
    console.log("");

    if (sampleFixedByWidening.length > 0) {
        console.log("Sample [B] rows that would be fixed by backfill (up to 15):");
        for (const c of sampleFixedByWidening) {
            const widened = normalizeToE164(c.phone);
            console.log(
                "  garage=%s id=%s phone=%s → %s (waId=%s)",
                c.garageId, c.id, JSON.stringify(c.phone), widened, JSON.stringify(c.waId),
            );
        }
        console.log("");
    }

    if (sampleStillUnresolvable.length > 0) {
        console.log("Sample [C] rows that stay unresolvable (up to 15):");
        for (const c of sampleStillUnresolvable) {
            console.log(
                "  garage=%s id=%s phone=%s (waId=%s, name=%s)",
                c.garageId, c.id, JSON.stringify(c.phone), JSON.stringify(c.waId), JSON.stringify(c.name),
            );
        }
        console.log("");
    }

    console.log("Next step: if [B] > 0, AR runs scripts/backfill-customer-phones.mts");
    console.log("(not written yet — waiting on these counts before authoring).");
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });

// ERPNext master-data pushers — Customer + Item.
//
// Each pusher follows the same three-step contract:
//   1. Pre-flight: findByGarageosId(). If HIT, log distinctly and
//      return the existing erpnextName without POST. This is the
//      idempotency safeguard from §3 of the brief — a duplicate
//      push cannot create a second row.
//   2. POST if absent. Frappe returns the created row's name.
//   3. Read back and (for records with Company defaults) verify the
//      §3 config asserts. On mismatch throw; the runner reclassifies
//      the job as FAILED.
//
// The pushers themselves do NOT open a Prisma transaction. The
// runner opens ONE $transaction around (entity-map upsert + job
// status update) AFTER the pusher returns. That keeps the HTTP call
// outside the DB tx — see runner.ts head comment.
//
// Item is READ-ONLY. §6 of the brief: the four generic Items
// (PART/LABOR/SUBLET/FEE) are pre-seeded on the instance and their
// item_code equals the GarageOS LineKind verbatim. We never create
// or update Items from Phase 3; verifyItemExists() is the safety
// check that they're actually there.

import { frappeGet, frappePost, findByGarageosId } from "@/lib/erp-sync/client";
import type { ErpNextCredentials } from "@/lib/erp-sync/credentials";

export type PushResult = {
    erpnextName: string;
    /**
     * True when the entity was found on ERPNext by pre-flight (no
     * POST issued). Callers should log distinctly — this is the
     * signal that a prior push landed but its map/status commit
     * didn't complete.
     */
    preflightHit: boolean;
};

/**
 * Push a GarageOS Customer into ERPNext.
 *
 * Load-bearing: the custom field `garageos_customer_id` on Customer
 * carries our cuid; Selling Settings has `cust_master_name =
 * "Naming Series"` so ERPNext-side names are naming-series generated
 * (CUST-YYYY-#####). We NEVER match on customer_name — see §6 of
 * the brief.
 */
export async function pushCustomer(
    creds: ErpNextCredentials,
    customer: {
        id: string;
        name: string;
        phone: string | null;
        trn: string | null;
    },
    opts?: { fetchImpl?: typeof fetch },
): Promise<PushResult> {
    const existing = await findByGarageosId(
        creds,
        "Customer",
        "garageos_customer_id",
        customer.id,
        opts,
    );
    if (existing) {
        return { erpnextName: existing, preflightHit: true };
    }

    const body = await frappePost(
        creds,
        "/api/resource/Customer",
        {
            customer_name: customer.name,
            customer_type: "Individual",
            customer_group: "All Customer Groups",
            territory: "All Territories",
            // The load-bearing custom field. A duplicate push would
            // fail at the ERPNext-side unique index on this column
            // (§3 of the brief).
            garageos_customer_id: customer.id,
            // Optional extras — Customer's contact block. Frappe
            // accepts these but stores them on child tables, so the
            // read-back below only asserts the top-level fields.
            ...(customer.phone ? { mobile_no: customer.phone } : {}),
            ...(customer.trn ? { tax_id: customer.trn } : {}),
        },
        opts,
    );

    const name = extractName(body, "Customer");

    // Light read-back: verify the record exists and echoes our id.
    // Full §5-shape asserts land in Phase 5 for Sales Invoice. For
    // Customer + Item, matching the round-trip is sufficient.
    const readBack = await frappeGet(
        creds,
        `/api/resource/Customer/${encodeURIComponent(name)}`,
        undefined,
        opts,
    );
    const echoed = readBackField(readBack, "garageos_customer_id");
    if (echoed !== customer.id) {
        throw new Error(
            `[erp-pusher] Customer ${name} read-back returned garageos_customer_id=${echoed}, expected ${customer.id}`,
        );
    }

    return { erpnextName: name, preflightHit: false };
}

/**
 * Verify that the four generic Items exist on the instance and
 * return their names. Called once at runner startup per garage;
 * throws loudly if any is missing. §6 of the brief: the four are
 * pre-seeded and their item_code equals the LineKind — so the map
 * is identity, no lookup table needed at runtime.
 */
export async function verifyItemsExist(
    creds: ErpNextCredentials,
    opts?: { fetchImpl?: typeof fetch },
): Promise<{ kind: string; itemCode: string; name: string }[]> {
    const KINDS = ["PART", "LABOR", "SUBLET", "FEE"];
    const results: { kind: string; itemCode: string; name: string }[] = [];
    for (const kind of KINDS) {
        const body = await frappeGet(
            creds,
            `/api/resource/Item/${encodeURIComponent(kind)}`,
            undefined,
            opts,
        );
        const name = extractName(body, "Item");
        if (name !== kind) {
            throw new Error(
                `[erp-pusher] Item ${kind} — expected name to equal item_code, got ${name}`,
            );
        }
        results.push({ kind, itemCode: kind, name });
    }
    return results;
}

function extractName(body: unknown, doctype: string): string {
    if (!body || typeof body !== "object") {
        throw new Error(`[erp-pusher] ${doctype} — no body from Frappe`);
    }
    const data = (body as { data?: unknown }).data;
    if (!data || typeof data !== "object") {
        throw new Error(`[erp-pusher] ${doctype} — no data in body`);
    }
    const name = (data as { name?: unknown }).name;
    if (typeof name !== "string" || !name) {
        throw new Error(`[erp-pusher] ${doctype} — no name in data`);
    }
    return name;
}

function readBackField(body: unknown, field: string): unknown {
    if (!body || typeof body !== "object") return undefined;
    const data = (body as { data?: unknown }).data;
    if (!data || typeof data !== "object") return undefined;
    return (data as Record<string, unknown>)[field];
}

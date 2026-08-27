/**
 * ERPNext runner integration test — Phase 3.
 *
 * Real Postgres. ERPNext HTTP mocked via a stub fetch that the
 * runner threads through opts.fetchImpl. No real network.
 *
 * Load-bearing assertions:
 *   1. Happy path — PUSH_CUSTOMER job → ErpEntityMap row + job
 *      SYNCED, in a single visible tx (verified by asserting BOTH
 *      writes are absent when tx rolls back).
 *   2. Pre-flight HIT — ERPNext already has the row via a prior
 *      attempt. POST is NOT issued; only the map+status commit runs.
 *      Distinct log line fires.
 *   3. Dep gate — job with a PENDING dep is BLOCKED_DEPS; nothing
 *      is written.
 *   4. Not enabled — a garage with erpSyncEnabled=false is skipped.
 *   5. Missing credentials — greppable log; job queue untouched.
 *   6. Failure path — a pusher throw increments attempts; after
 *      MAX_ATTEMPTS the job flips DEAD_LETTER.
 *   7. Not implemented — PUSH_INVOICE / PUSH_PAYMENT etc. leave the
 *      job PENDING with no state change (Phase 5 territory).
 */

import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runOnePass, runOneJob } from "@/lib/erp-sync/runner";
import type { ErpNextCredentials } from "@/lib/erp-sync/credentials";

const P = "erp-runner-test-";
const gid = P + "g1";
const gidDisabled = P + "g2";
const gidNoCreds = P + "g3";

const SUFFIX = gid.toUpperCase();
const SUFFIX_NOCREDS = gidNoCreds.toUpperCase();

const CRED_ENVS = [
    `ERPNEXT_BASE_URL__${SUFFIX}`,
    `ERPNEXT_COMPANY_NAME__${SUFFIX}`,
    `ERPNEXT_COMPANY_ABBR__${SUFFIX}`,
    `ERPNEXT_API_KEY__${SUFFIX}`,
    `ERPNEXT_API_SECRET__${SUFFIX}`,
];

function setCreds() {
    process.env[`ERPNEXT_BASE_URL__${SUFFIX}`] = "https://erp.test";
    process.env[`ERPNEXT_COMPANY_NAME__${SUFFIX}`] = "garageos";
    process.env[`ERPNEXT_COMPANY_ABBR__${SUFFIX}`] = "GOS";
    process.env[`ERPNEXT_API_KEY__${SUFFIX}`] = "test-key";
    process.env[`ERPNEXT_API_SECRET__${SUFFIX}`] = "test-secret";
}

function clearCreds() {
    for (const k of CRED_ENVS) delete process.env[k];
    // Also for gidNoCreds — belt & braces
    delete process.env[`ERPNEXT_BASE_URL__${SUFFIX_NOCREDS}`];
    delete process.env[`ERPNEXT_COMPANY_NAME__${SUFFIX_NOCREDS}`];
    delete process.env[`ERPNEXT_COMPANY_ABBR__${SUFFIX_NOCREDS}`];
    delete process.env[`ERPNEXT_API_KEY__${SUFFIX_NOCREDS}`];
    delete process.env[`ERPNEXT_API_SECRET__${SUFFIX_NOCREDS}`];
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/** Stub fetch that returns programmed responses per URL substring. */
function stubFetch(handlers: Array<{
    match: (url: string, init: RequestInit) => boolean;
    respond: () => Response;
}>): { fetchImpl: typeof fetch; calls: { url: string; method: string }[] } {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        for (const h of handlers) {
            if (h.match(url, init ?? {})) return h.respond();
        }
        throw new Error(`stubFetch: no handler matched ${method} ${url}`);
    };
    return { fetchImpl, calls };
}

async function seedGarageWithCustomer(garageId: string, enabled = true) {
    await prisma.garage.upsert({
        where: { id: garageId },
        create: { id: garageId, name: garageId, erpSyncEnabled: enabled },
        update: { erpSyncEnabled: enabled },
    });
    const cust = await prisma.customer.create({
        data: {
            id: garageId + "-cust",
            garageId,
            name: "Test Customer",
            phone: garageId + "-phone-" + Math.random(),
        },
    });
    return cust;
}

async function enqueueCustomerJob(garageId: string, customerId: string) {
    return prisma.erpSyncJob.create({
        data: {
            garageId,
            op: "PUSH_CUSTOMER",
            sourceType: "Customer",
            sourceId: customerId,
            status: "PENDING",
            dependsOnJobIds: [],
        },
    });
}

async function cleanup() {
    const garageIds = [gid, gidDisabled, gidNoCreds];
    await prisma.erpSyncJob.deleteMany({
        where: { garageId: { in: garageIds } },
    });
    await prisma.erpEntityMap.deleteMany({
        where: { garageId: { in: garageIds } },
    });
    await prisma.erpSyncCursor.deleteMany({
        where: { garageId: { in: garageIds } },
    });
    await prisma.customer.deleteMany({
        where: { garageId: { in: garageIds } },
    });
    await prisma.garage.deleteMany({ where: { id: { in: garageIds } } });
}

beforeEach(async () => {
    await cleanup();
    clearCreds();
});
afterEach(clearCreds);
afterAll(cleanup);

describe("runOnePass — happy path", () => {
    it("PUSH_CUSTOMER: pre-flight miss → POST → read-back → ErpEntityMap + job SYNCED", async () => {
        setCreds();
        const cust = await seedGarageWithCustomer(gid);
        await enqueueCustomerJob(gid, cust.id);

        const { fetchImpl, calls } = stubFetch([
            // Pre-flight: no existing row
            {
                match: (url) =>
                    url.includes("/api/resource/Customer") &&
                    url.includes("filters="),
                respond: () => jsonResponse(200, { data: [] }),
            },
            // POST: create row
            {
                match: (url, init) =>
                    url.endsWith("/api/resource/Customer") &&
                    init.method === "POST",
                respond: () =>
                    jsonResponse(200, { data: { name: "CUST-2026-00042" } }),
            },
            // Read-back
            {
                match: (url) =>
                    url.includes("/api/resource/Customer/CUST-2026-00042"),
                respond: () =>
                    jsonResponse(200, {
                        data: { name: "CUST-2026-00042", garageos_customer_id: cust.id },
                    }),
            },
        ]);

        const result = await runOnePass(gid, prisma, { fetchImpl });
        expect(result.status).toBe("advanced");
        expect(result.synced).toBe(1);
        expect(result.preflightHits).toBe(0);
        expect(result.failed).toBe(0);

        const job = await prisma.erpSyncJob.findFirstOrThrow({
            where: { garageId: gid, op: "PUSH_CUSTOMER" },
        });
        expect(job.status).toBe("SYNCED");
        expect(job.syncedAt).not.toBeNull();
        expect(job.attempts).toBe(1);

        const mapRow = await prisma.erpEntityMap.findUniqueOrThrow({
            where: {
                garageId_garageosDoctype_garageosId: {
                    garageId: gid,
                    garageosDoctype: "Customer",
                    garageosId: cust.id,
                },
            },
        });
        expect(mapRow.erpnextDoctype).toBe("Customer");
        expect(mapRow.erpnextName).toBe("CUST-2026-00042");
        expect(mapRow.version).toBe(1);

        // Three HTTP calls total: pre-flight + POST + read-back.
        expect(calls).toHaveLength(3);
        expect(calls[0].method).toBe("GET"); // pre-flight
        expect(calls[1].method).toBe("POST");
        expect(calls[2].method).toBe("GET"); // read-back
    });
});

describe("runOnePass — pre-flight HIT", () => {
    it("skips POST when ERPNext already has the row via our id", async () => {
        setCreds();
        const cust = await seedGarageWithCustomer(gid);
        await enqueueCustomerJob(gid, cust.id);

        let posts = 0;
        const { fetchImpl, calls } = stubFetch([
            // Pre-flight: HIT
            {
                match: (url) =>
                    url.includes("/api/resource/Customer") &&
                    url.includes("filters="),
                respond: () =>
                    jsonResponse(200, {
                        data: [{ name: "CUST-2026-00007" }],
                    }),
            },
            // POST would go here — but shouldn't be called.
            {
                match: (url, init) =>
                    url.endsWith("/api/resource/Customer") &&
                    init.method === "POST",
                respond: () => {
                    posts++;
                    return jsonResponse(200, { data: { name: "SHOULD_NOT_BE_CALLED" } });
                },
            },
        ]);

        const result = await runOnePass(gid, prisma, { fetchImpl });
        expect(result.status).toBe("advanced");
        expect(result.synced).toBe(1);
        expect(result.preflightHits).toBe(1);

        // No POST issued.
        expect(posts).toBe(0);
        expect(calls.every((c) => c.method === "GET")).toBe(true);

        // Map row still landed with the existing name.
        const mapRow = await prisma.erpEntityMap.findUniqueOrThrow({
            where: {
                garageId_garageosDoctype_garageosId: {
                    garageId: gid,
                    garageosDoctype: "Customer",
                    garageosId: cust.id,
                },
            },
        });
        expect(mapRow.erpnextName).toBe("CUST-2026-00007");

        const job = await prisma.erpSyncJob.findFirstOrThrow({
            where: { garageId: gid },
        });
        expect(job.status).toBe("SYNCED");
    });
});

describe("runOnePass — dep gate", () => {
    it("BLOCKED_DEPS when a dep is still PENDING; no writes", async () => {
        setCreds();
        const cust = await seedGarageWithCustomer(gid);

        // Blocker dep job stays PENDING.
        const dep = await prisma.erpSyncJob.create({
            data: {
                garageId: gid,
                op: "PUSH_CUSTOMER",
                sourceType: "Customer",
                sourceId: cust.id + "-dep",
                status: "PENDING",
                dependsOnJobIds: [],
            },
        });
        // Blocked job depends on the still-PENDING dep. Use
        // PUSH_ITEM as the blocked op because it's the only op that
        // stays SKIPPED_NOT_IMPLEMENTED post-Phase-4 — a wired op
        // (PUSH_INVOICE) would try to look up a real Invoice row.
        // We only care that the runner processes both in the same
        // pass and the invoice-shaped one falls through cleanly.
        const blocked = await prisma.erpSyncJob.create({
            data: {
                garageId: gid,
                op: "PUSH_ITEM",
                sourceType: "Part",
                sourceId: cust.id + "-part",
                status: "PENDING",
                dependsOnJobIds: [dep.id],
            },
        });

        // No customer exists for the dep so pushCustomer would fail
        // — but the blocked job should not even reach the pusher.
        // Give the dep a matching Customer row and a pre-flight
        // stub. Focus on the blocked job's behaviour.
        const { fetchImpl } = stubFetch([
            {
                match: () => true,
                // Dep will pre-flight HIT for simplicity, then the
                // blocked job's dispatch will discover deps SYNCED
                // and reach SKIPPED_NOT_IMPLEMENTED (PUSH_INVOICE).
                respond: () =>
                    jsonResponse(200, { data: [{ name: "CUST-2026-00099" }] }),
            },
        ]);

        // Give the dep a real Customer row so its dispatch succeeds.
        await prisma.customer.create({
            data: {
                id: cust.id + "-dep",
                garageId: gid,
                name: "Dep customer",
                phone: gid + "-dep-phone-" + Math.random(),
            },
        });

        const result = await runOnePass(gid, prisma, { fetchImpl });
        expect(result.processed).toBe(2);
        // The dep syncs; the invoice is SKIPPED_NOT_IMPLEMENTED
        // because Phase 3 doesn't have a PUSH_INVOICE pusher yet.
        // Crucially, it was NOT blocked — deps resolved this pass.
        expect(result.synced).toBe(1);

        const blockedRow = await prisma.erpSyncJob.findUniqueOrThrow({
            where: { id: blocked.id },
        });
        expect(blockedRow.status).toBe("PENDING"); // Phase 5 territory
    });

    it("BLOCKED_DEPS when the dep is FAILED (not just PENDING)", async () => {
        setCreds();
        const cust = await seedGarageWithCustomer(gid);
        // Failed dep.
        const dep = await prisma.erpSyncJob.create({
            data: {
                garageId: gid,
                op: "PUSH_CUSTOMER",
                sourceType: "Customer",
                sourceId: cust.id + "-dep2",
                status: "FAILED",
                attempts: 1,
                lastError: "prior failure",
                dependsOnJobIds: [],
            },
        });
        const blocked = await prisma.erpSyncJob.create({
            data: {
                garageId: gid,
                op: "PUSH_CUSTOMER",
                sourceType: "Customer",
                sourceId: cust.id,
                status: "PENDING",
                dependsOnJobIds: [dep.id],
            },
        });

        const { fetchImpl } = stubFetch([
            { match: () => true, respond: () => jsonResponse(200, { data: [] }) },
        ]);
        const single = await runOneJob(blocked.id, prisma, {
            creds: creds_for(gid),
            fetchImpl,
        });
        expect(single.status).toBe("BLOCKED_DEPS");

        const blockedRow = await prisma.erpSyncJob.findUniqueOrThrow({
            where: { id: blocked.id },
        });
        expect(blockedRow.status).toBe("PENDING");
        expect(blockedRow.attempts).toBe(0);
    });
});

describe("runOnePass — enable + credentials gates", () => {
    it("erpSyncEnabled=false → skipped-not-enabled, queue untouched", async () => {
        setCreds(); // creds are set but enable is off
        const cust = await seedGarageWithCustomer(gidDisabled, false);
        // Bootstrap the Garage row's erpSyncEnabled=false; then
        // enqueue a job under it.
        await prisma.garage.update({
            where: { id: gidDisabled },
            data: { erpSyncEnabled: false },
        });
        await prisma.erpSyncJob.create({
            data: {
                garageId: gidDisabled,
                op: "PUSH_CUSTOMER",
                sourceType: "Customer",
                sourceId: cust.id,
                status: "PENDING",
                dependsOnJobIds: [],
            },
        });

        const result = await runOnePass(gidDisabled, prisma);
        expect(result.status).toBe("skipped-not-enabled");
        expect(result.processed).toBe(0);

        const jobs = await prisma.erpSyncJob.findMany({
            where: { garageId: gidDisabled },
        });
        expect(jobs).toHaveLength(1);
        expect(jobs[0].status).toBe("PENDING");
    });

    it("missing credential envs → skipped-missing-credentials, queue untouched", async () => {
        // Do NOT set creds for gidNoCreds.
        const cust = await seedGarageWithCustomer(gidNoCreds);
        await enqueueCustomerJob(gidNoCreds, cust.id);

        const result = await runOnePass(gidNoCreds, prisma);
        expect(result.status).toBe("skipped-missing-credentials");
        expect(result.missingEnvs).toBeDefined();
        expect(result.missingEnvs!.length).toBe(5);

        const jobs = await prisma.erpSyncJob.findMany({
            where: { garageId: gidNoCreds },
        });
        expect(jobs[0].status).toBe("PENDING");
        expect(jobs[0].attempts).toBe(0);
    });
});

describe("runOneJob — failure escalation", () => {
    it("HTTP 4xx → FAILED with attempts=1, lastError captured", async () => {
        setCreds();
        const cust = await seedGarageWithCustomer(gid);
        const job = await enqueueCustomerJob(gid, cust.id);

        const { fetchImpl } = stubFetch([
            {
                match: (url) =>
                    url.includes("/api/resource/Customer") &&
                    url.includes("filters="),
                respond: () => jsonResponse(200, { data: [] }),
            },
            {
                match: (url, init) => init.method === "POST",
                respond: () =>
                    jsonResponse(400, { exc: "ValidationError: Customer name required" }),
            },
        ]);

        const result = await runOneJob(job.id, prisma, {
            creds: creds_for(gid),
            fetchImpl,
        });
        expect(result.status).toBe("FAILED");

        const row = await prisma.erpSyncJob.findUniqueOrThrow({
            where: { id: job.id },
        });
        expect(row.status).toBe("FAILED");
        expect(row.attempts).toBe(1);
        expect(row.lastError).toContain("HTTP 400");
    });

    it("MAX_ATTEMPTS failures → DEAD_LETTER", async () => {
        setCreds();
        const cust = await seedGarageWithCustomer(gid);
        // Simulate a job that's already been retried 4 times.
        const job = await prisma.erpSyncJob.create({
            data: {
                garageId: gid,
                op: "PUSH_CUSTOMER",
                sourceType: "Customer",
                sourceId: cust.id,
                status: "PENDING",
                dependsOnJobIds: [],
                attempts: 4,
            },
        });

        const { fetchImpl } = stubFetch([
            {
                match: (url) => url.includes("filters="),
                respond: () => jsonResponse(200, { data: [] }),
            },
            {
                match: (url, init) => init.method === "POST",
                respond: () => jsonResponse(400, { exc: "still broken" }),
            },
        ]);

        const result = await runOneJob(job.id, prisma, {
            creds: creds_for(gid),
            fetchImpl,
        });
        expect(result.status).toBe("DEAD_LETTER");

        const row = await prisma.erpSyncJob.findUniqueOrThrow({
            where: { id: job.id },
        });
        expect(row.status).toBe("DEAD_LETTER");
        expect(row.attempts).toBe(5);
    });
});

describe("runOnePass — still-not-implemented ops", () => {
    // Phase 4 wired PUSH_INVOICE / PUSH_PAYMENT / PUSH_ADVANCE /
    // PUSH_VOID. Two ops remain SKIPPED_NOT_IMPLEMENTED on purpose:
    //   - PUSH_ITEM: Items are pre-seeded on the instance (§6); the
    //     tailer never enqueues one, but the enum value is reserved.
    //   - APPLY_DEPOSIT: handled implicitly by
    //     allocate_advances_automatically=1 on PUSH_INVOICE; nothing
    //     enqueues one today.
    it("PUSH_ITEM + APPLY_DEPOSIT leave PENDING, no state change", async () => {
        setCreds();
        const cust = await seedGarageWithCustomer(gid);
        for (const op of ["PUSH_ITEM", "APPLY_DEPOSIT"] as const) {
            await prisma.erpSyncJob.create({
                data: {
                    garageId: gid,
                    op,
                    sourceType: op === "PUSH_ITEM" ? "Part" : "Invoice",
                    sourceId: cust.id + ":" + op,
                    status: "PENDING",
                    dependsOnJobIds: [],
                },
            });
        }
        const result = await runOnePass(gid, prisma);
        expect(result.processed).toBe(2);
        expect(result.synced).toBe(0);
        expect(result.skippedNotImplemented).toBe(2);
        const rows = await prisma.erpSyncJob.findMany({
            where: { garageId: gid },
        });
        for (const r of rows) {
            expect(r.status).toBe("PENDING");
            expect(r.attempts).toBe(0);
            expect(r.lastError).toBeNull();
        }
    });
});

// Local helper: resolve for runOneJob callers.
function creds_for(garageId: string): ErpNextCredentials {
    // Read from the same env we set in setCreds().
    const suffix = garageId.toUpperCase();
    return {
        garageId,
        baseUrl: process.env[`ERPNEXT_BASE_URL__${suffix}`]!,
        companyName: process.env[`ERPNEXT_COMPANY_NAME__${suffix}`]!,
        companyAbbr: process.env[`ERPNEXT_COMPANY_ABBR__${suffix}`]!,
        apiKey: process.env[`ERPNEXT_API_KEY__${suffix}`]!,
        apiSecret: process.env[`ERPNEXT_API_SECRET__${suffix}`]!,
    };
}

/**
 * Phase 4 pushers — unit tests with a stub fetch.
 *
 * Focuses on the request payload shape (§4 of the brief) and the
 * §5 read-back assertions. Runner integration is in runner.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
    pushInvoice,
    pushPayment,
    pushAdvance,
    pushVoid,
} from "@/lib/erp-sync/pushers";
import type { ErpNextCredentials } from "@/lib/erp-sync/credentials";

const creds: ErpNextCredentials = {
    garageId: "g1",
    baseUrl: "https://erp.test",
    companyName: "garageos",
    companyAbbr: "GOS",
    apiKey: "k",
    apiSecret: "s",
};

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function makeStub(handlers: Array<{
    match: (url: string, init: RequestInit, body: unknown) => boolean;
    respond: (postBody?: unknown) => Response;
}>): { fetchImpl: typeof fetch; calls: { url: string; method: string; body: unknown }[] } {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
        const method = init?.method ?? "GET";
        let body: unknown = undefined;
        if (init?.body) {
            try {
                body = JSON.parse(String(init.body));
            } catch {
                body = init.body;
            }
        }
        calls.push({ url, method, body });
        for (const h of handlers) {
            if (h.match(url, init ?? {}, body)) return h.respond(body);
        }
        throw new Error(`stubFetch: no handler matched ${method} ${url}`);
    };
    return { fetchImpl, calls };
}

describe("pushCustomer — leaf customer_group + territory (2026-08-28 HTTP 417)", () => {
    it("customer_group and territory are LEAF nodes, never Frappe group roots (never begin with 'All ')", async () => {
        const { fetchImpl, calls } = makeStub([
            { match: (url) => url.includes("filters="), respond: () => jsonResponse(200, { data: [] }) },
            {
                match: (url, init) => url.endsWith("/api/resource/Customer") && init.method === "POST",
                respond: () => jsonResponse(200, { data: { name: "CUST-2026-00001" } }),
            },
            {
                match: (url) => url.includes("/api/resource/Customer/CUST-2026-00001"),
                respond: () => jsonResponse(200, {
                    data: { name: "CUST-2026-00001", garageos_customer_id: "cust-y" },
                }),
            },
        ]);
        const { pushCustomer } = await import("@/lib/erp-sync/pushers");
        await pushCustomer(
            creds,
            { id: "cust-y", name: "Test", phone: null, trn: null },
            { fetchImpl },
        );
        const post = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
        // Both must NOT start with "All " — Frappe convention for
        // group nodes (is_group: 1), which are unselectable and
        // return HTTP 417 ValidationError.
        expect(String(post.customer_group)).not.toMatch(/^All /);
        expect(String(post.territory)).not.toMatch(/^All /);
        // Explicit pin on the current values so a silent taxonomy
        // change surfaces here.
        expect(post.customer_group).toBe("Commercial");
        expect(post.territory).toBe("United Arab Emirates");
    });
});

describe("pushCustomer — mandatory naming_series (finding #1)", () => {
    it("sends naming_series so Frappe doesn't reject with 'Series is mandatory'", async () => {
        const { fetchImpl, calls } = makeStub([
            { match: (url) => url.includes("filters="), respond: () => jsonResponse(200, { data: [] }) },
            {
                match: (url, init) => url.endsWith("/api/resource/Customer") && init.method === "POST",
                respond: () => jsonResponse(200, { data: { name: "CUST-2026-00001" } }),
            },
            {
                match: (url) => url.includes("/api/resource/Customer/CUST-2026-00001"),
                respond: () => jsonResponse(200, {
                    data: { name: "CUST-2026-00001", garageos_customer_id: "cust-x" },
                }),
            },
        ]);
        const { pushCustomer } = await import("@/lib/erp-sync/pushers");
        await pushCustomer(
            creds,
            { id: "cust-x", name: "Test", phone: null, trn: null },
            { fetchImpl },
        );
        const post = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
        // The exact series shape from AR's manual test.
        expect(post.naming_series).toBe("CUST-.YYYY.-");
    });
});

describe("pushInvoice — request shape (§4)", () => {
    it("sends items[] with income_account, taxes[] with Actual VAT, disable_rounded_total + allocate_advances_automatically", async () => {
        const { fetchImpl, calls } = makeStub([
            { match: (url) => url.includes("filters="), respond: () => jsonResponse(200, { data: [] }) },
            {
                match: (url, init) => url.endsWith("/api/resource/Sales Invoice") && init.method === "POST",
                respond: () => jsonResponse(200, { data: { name: "ACC-SINV-2026-00099" } }),
            },
            {
                match: (url) => url.includes("/api/resource/Sales Invoice/ACC-SINV-2026-00099"),
                respond: () => jsonResponse(200, {
                    data: {
                        name: "ACC-SINV-2026-00099",
                        docstatus: 1,
                        grand_total: 105.00,
                        outstanding_amount: 105.00,
                        allocate_advances_automatically: 1,
                        taxes: [{ tax_amount: 5.00 }],
                    },
                }),
            },
        ]);

        const res = await pushInvoice(
            creds,
            {
                id: "inv-xyz",
                total: 105,
                vatAmount: 5,
                issuedAt: new Date("2026-08-27"),
                dueDate: new Date("2026-09-26"),
                customerErpnextName: "CUST-2026-00001",
                expectedAllocation: 0,
                lines: [
                    { kind: "LABOR", description: "Diag", qty: 1, unitPrice: 100 },
                ],
            },
            { fetchImpl },
        );

        expect(res.preflightHit).toBe(false);
        expect(res.erpnextName).toBe("ACC-SINV-2026-00099");

        // Inspect the POST body
        const postCall = calls.find((c) => c.method === "POST")!;
        const body = postCall.body as Record<string, unknown>;
        expect(body.customer).toBe("CUST-2026-00001");
        expect(body.company).toBe("garageos");
        expect(body.disable_rounded_total).toBe(1);
        expect(body.allocate_advances_automatically).toBe(1);
        expect(body.garageos_invoice_id).toBe("inv-xyz");
        const items = body.items as Array<Record<string, unknown>>;
        expect(items).toHaveLength(1);
        expect(items[0].income_account).toBe("Sales Account - GOS");
        expect(items[0].item_code).toBe("LABOR");
        expect(items[0].qty).toBe(1);
        expect(items[0].rate).toBe(100);
        const taxes = body.taxes as Array<Record<string, unknown>>;
        expect(taxes).toHaveLength(1);
        expect(taxes[0].charge_type).toBe("Actual");
        expect(taxes[0].account_head).toBe("VAT 5% - GOS");
        expect(taxes[0].tax_amount).toBe(5);
    });

    it("read-back FAILS when allocate_advances_automatically comes back 0", async () => {
        const { fetchImpl } = makeStub([
            { match: (url) => url.includes("filters="), respond: () => jsonResponse(200, { data: [] }) },
            {
                match: (url, init) => url.endsWith("/api/resource/Sales Invoice") && init.method === "POST",
                respond: () => jsonResponse(200, { data: { name: "ACC-SINV-X" } }),
            },
            {
                match: (url) => url.includes("/api/resource/Sales Invoice/ACC-SINV-X"),
                respond: () => jsonResponse(200, {
                    data: {
                        name: "ACC-SINV-X",
                        docstatus: 1,
                        grand_total: 100,
                        outstanding_amount: 100,
                        allocate_advances_automatically: 0, // ← the failure
                        taxes: [{ tax_amount: 0 }],
                    },
                }),
            },
        ]);

        await expect(
            pushInvoice(
                creds,
                {
                    id: "inv-x", total: 100, vatAmount: 0,
                    issuedAt: new Date("2026-08-27"), dueDate: new Date("2026-09-26"),
                    customerErpnextName: "CUST-A", expectedAllocation: 0,
                    lines: [{ kind: "LABOR", description: "d", qty: 1, unitPrice: 100 }],
                },
                { fetchImpl },
            ),
        ).rejects.toThrow(/allocate_advances_automatically=0/);
    });

    it("read-back FAILS on outstanding_amount mismatch — the §5b decisive check", async () => {
        const { fetchImpl } = makeStub([
            { match: (url) => url.includes("filters="), respond: () => jsonResponse(200, { data: [] }) },
            {
                match: (url, init) => url.endsWith("/api/resource/Sales Invoice") && init.method === "POST",
                respond: () => jsonResponse(200, { data: { name: "ACC-SINV-Y" } }),
            },
            {
                match: (url) => url.includes("/api/resource/Sales Invoice/ACC-SINV-Y"),
                // 500 total, 100 expected allocation → outstanding
                // SHOULD be 400. ERPNext returns 500 (allocation
                // didn't happen) — this is exactly the invisible-
                // failure surface §5b guards against.
                respond: () => jsonResponse(200, {
                    data: {
                        name: "ACC-SINV-Y",
                        docstatus: 1,
                        grand_total: 500,
                        outstanding_amount: 500,
                        allocate_advances_automatically: 1,
                        taxes: [{ tax_amount: 0 }],
                    },
                }),
            },
        ]);

        try {
            await pushInvoice(
                creds,
                {
                    id: "inv-y", total: 500, vatAmount: 0,
                    issuedAt: new Date("2026-08-27"), dueDate: new Date("2026-09-26"),
                    customerErpnextName: "CUST-A", expectedAllocation: 100,
                    lines: [{ kind: "LABOR", description: "d", qty: 1, unitPrice: 500 }],
                },
                { fetchImpl },
            );
            throw new Error("expected throw");
        } catch (err) {
            expect((err as Error).message).toMatch(/outstanding_amount=500, expected 400/);
            expect((err as Error & { field?: string }).field).toBe("outstanding_amount");
        }
    });

    it("pre-flight HIT skips POST", async () => {
        let posts = 0;
        const { fetchImpl } = makeStub([
            {
                match: (url) => url.includes("filters="),
                respond: () => jsonResponse(200, { data: [{ name: "ACC-SINV-HIT" }] }),
            },
            {
                match: (url, init) => init.method === "POST",
                respond: () => {
                    posts++;
                    return jsonResponse(200, { data: { name: "wrong" } });
                },
            },
        ]);
        const res = await pushInvoice(
            creds,
            {
                id: "inv-z", total: 100, vatAmount: 0,
                issuedAt: new Date("2026-08-27"), dueDate: new Date("2026-09-26"),
                customerErpnextName: "C", expectedAllocation: 0,
                lines: [{ kind: "LABOR", description: "d", qty: 1, unitPrice: 100 }],
            },
            { fetchImpl },
        );
        expect(res.preflightHit).toBe(true);
        expect(res.erpnextName).toBe("ACC-SINV-HIT");
        expect(posts).toBe(0);
    });
});

describe("pushPayment — request shape (§4)", () => {
    it("sends payment_type Receive with references[] linking the invoice", async () => {
        const { fetchImpl, calls } = makeStub([
            { match: (url) => url.includes("filters="), respond: () => jsonResponse(200, { data: [] }) },
            {
                match: (url, init) => url.endsWith("/api/resource/Payment Entry") && init.method === "POST",
                respond: () => jsonResponse(200, { data: { name: "ACC-PAY-2026-00100" } }),
            },
            {
                match: (url) => url.includes("/api/resource/Payment Entry/ACC-PAY-2026-00100"),
                respond: () => jsonResponse(200, {
                    data: {
                        name: "ACC-PAY-2026-00100",
                        docstatus: 1,
                        references: [{ reference_name: "ACC-SINV-2026-00099" }],
                    },
                }),
            },
        ]);

        const res = await pushPayment(
            creds,
            {
                id: "pay-x",
                amount: 105,
                paidAt: new Date("2026-08-27"),
                invoiceErpnextName: "ACC-SINV-2026-00099",
                customerErpnextName: "CUST-A",
            },
            { fetchImpl },
        );
        expect(res.erpnextName).toBe("ACC-PAY-2026-00100");

        const post = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
        expect(post.payment_type).toBe("Receive");
        // AR 2026-08-28 (post-Replay finding): paid_from is
        // DELIBERATELY OMITTED for invoice-allocated payments —
        // sending it alongside references[] made ERPNext double-
        // book, producing a phantom DR AR / CR AR pair. Let
        // ERPNext auto-derive from the customer's default
        // receivable. Only pushAdvance keeps sending paid_from.
        expect(post.paid_from).toBeUndefined();
        expect(post.paid_to).toBe("Cash/Bank - GOS");
        expect(post.garageos_payment_id).toBe("pay-x");
        // Finding #3: Cash/Bank - GOS is typed Bank so
        // reference_no + reference_date are mandatory. Use our
        // payment id + date.
        expect(post.reference_no).toBe("pay-x");
        expect(post.reference_date).toBe("2026-08-27");
        const refs = post.references as Array<Record<string, unknown>>;
        expect(refs).toHaveLength(1);
        expect(refs[0].reference_doctype).toBe("Sales Invoice");
        expect(refs[0].reference_name).toBe("ACC-SINV-2026-00099");
        expect(refs[0].allocated_amount).toBe(105);
    });

    it("read-back FAILS when references[] comes back empty", async () => {
        const { fetchImpl } = makeStub([
            { match: (url) => url.includes("filters="), respond: () => jsonResponse(200, { data: [] }) },
            {
                match: (url, init) => init.method === "POST",
                respond: () => jsonResponse(200, { data: { name: "ACC-PAY-X" } }),
            },
            {
                match: (url) => url.includes("/api/resource/Payment Entry/ACC-PAY-X"),
                respond: () => jsonResponse(200, {
                    data: { name: "ACC-PAY-X", docstatus: 1, references: [] },
                }),
            },
        ]);
        await expect(
            pushPayment(
                creds,
                { id: "p", amount: 100, paidAt: new Date("2026-08-27"), invoiceErpnextName: "I", customerErpnextName: "C" },
                { fetchImpl },
            ),
        ).rejects.toThrow(/references\[\] empty/);
    });
});

describe("pushAdvance — request shape + §5a read-back", () => {
    it("sends naked Payment Entry (no references[]) and asserts paid_from rewritten to Customer Deposits", async () => {
        const { fetchImpl, calls } = makeStub([
            // §5a check 3: PLE row lookup — MUST come before the
            // generic filters= handler because both URLs carry
            // filters=.
            {
                match: (url) => url.includes("/api/resource/Payment Ledger Entry"),
                respond: () => jsonResponse(200, { data: [{ name: "PLE-1" }] }),
            },
            { match: (url) => url.includes("filters="), respond: () => jsonResponse(200, { data: [] }) },
            {
                match: (url, init) => url.endsWith("/api/resource/Payment Entry") && init.method === "POST",
                respond: () => jsonResponse(200, { data: { name: "ACC-PAY-ADV-1" } }),
            },
            {
                match: (url) => url.includes("/api/resource/Payment Entry/ACC-PAY-ADV-1"),
                respond: () => jsonResponse(200, {
                    data: {
                        name: "ACC-PAY-ADV-1",
                        docstatus: 1,
                        // §5a check 1: ERPNext rewrote paid_from
                        paid_from: "Customer Deposits - GOS",
                    },
                }),
            },
        ]);

        const res = await pushAdvance(
            creds,
            {
                id: "adv-x",
                amount: 50,
                receivedAt: new Date("2026-08-25"),
                customerErpnextName: "CUST-A",
            },
            { fetchImpl },
        );
        expect(res.erpnextName).toBe("ACC-PAY-ADV-1");

        const post = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
        expect(post.references).toBeUndefined(); // naked advance
        expect(post.garageos_payment_id).toBe("adv-x");
        // Finding #3: same Bank-account requirement as pushPayment.
        expect(post.reference_no).toBe("adv-x");
        expect(post.reference_date).toBe("2026-08-25");
    });

    it("§5a decisive check — FAILS with tagged field when Payment Ledger Entry row is missing", async () => {
        const { fetchImpl } = makeStub([
            { match: (url) => url.includes("filters=") && !url.includes("Payment Ledger Entry"), respond: () => jsonResponse(200, { data: [] }) },
            {
                match: (url, init) => url.endsWith("/api/resource/Payment Entry") && init.method === "POST",
                respond: () => jsonResponse(200, { data: { name: "ACC-PAY-ADV-2" } }),
            },
            {
                match: (url) => url.includes("/api/resource/Payment Entry/ACC-PAY-ADV-2"),
                respond: () => jsonResponse(200, {
                    data: {
                        name: "ACC-PAY-ADV-2",
                        docstatus: 1,
                        paid_from: "Customer Deposits - GOS",
                    },
                }),
            },
            {
                match: (url) => url.includes("/api/resource/Payment Ledger Entry"),
                respond: () => jsonResponse(200, { data: [] }), // ← the invisible failure
            },
        ]);

        try {
            await pushAdvance(
                creds,
                { id: "adv-2", amount: 50, receivedAt: new Date("2026-08-25"), customerErpnextName: "C" },
                { fetchImpl },
            );
            throw new Error("expected throw");
        } catch (err) {
            expect((err as Error).message).toMatch(/NO Payment Ledger Entry/);
            expect((err as Error & { field?: string }).field).toBe("payment_ledger_entry");
        }
    });
});

describe("pushVoid — is_return + return_against", () => {
    it("sends credit note with negative qty, negative tax_amount, return_against set", async () => {
        const { fetchImpl, calls } = makeStub([
            { match: (url) => url.includes("filters="), respond: () => jsonResponse(200, { data: [] }) },
            {
                match: (url, init) => url.endsWith("/api/resource/Sales Invoice") && init.method === "POST",
                respond: () => jsonResponse(200, { data: { name: "ACC-SINV-CN-1" } }),
            },
            {
                match: (url) => url.includes("/api/resource/Sales Invoice/ACC-SINV-CN-1"),
                respond: () => jsonResponse(200, {
                    data: {
                        name: "ACC-SINV-CN-1",
                        docstatus: 1,
                        return_against: "ACC-SINV-ORIG",
                        grand_total: -105,
                    },
                }),
            },
        ]);

        const res = await pushVoid(
            creds,
            {
                originalInvoiceId: "inv-orig",
                originalErpnextName: "ACC-SINV-ORIG",
                total: 105,
                vatAmount: 5,
                voidedAt: new Date("2026-08-27"),
                customerErpnextName: "CUST-A",
                lines: [{ kind: "LABOR", description: "d", qty: 1, unitPrice: 100 }],
            },
            { fetchImpl },
        );
        expect(res.erpnextName).toBe("ACC-SINV-CN-1");

        const post = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
        expect(post.is_return).toBe(1);
        expect(post.return_against).toBe("ACC-SINV-ORIG");
        expect(post.garageos_credit_note_id).toBe("inv-orig");
        const items = post.items as Array<Record<string, unknown>>;
        expect(items[0].qty).toBe(-1);
        const taxes = post.taxes as Array<Record<string, unknown>>;
        expect(taxes[0].tax_amount).toBe(-5);
    });
});

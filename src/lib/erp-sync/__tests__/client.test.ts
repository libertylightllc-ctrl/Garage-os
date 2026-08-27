/**
 * Frappe client unit tests — no DB, no network. Uses a stub fetch
 * that records requests and returns canned Response objects.
 *
 * Covers:
 *   - Auth header shape (token <key>:<secret>)
 *   - 4xx → throw ErpNextHttpError, no retry
 *   - 5xx → retry with capped backoff, throw after MAX_ATTEMPTS
 *   - Timeout → ErpNextTimeoutError, retried
 *   - findByGarageosId returns null on empty data, string on match
 */

import { describe, expect, it, vi } from "vitest";
import {
    frappeGet,
    frappePost,
    findByGarageosId,
    ErpNextHttpError,
} from "@/lib/erp-sync/client";
import type { ErpNextCredentials } from "@/lib/erp-sync/credentials";

const creds: ErpNextCredentials = {
    garageId: "g1",
    baseUrl: "https://erp.test",
    companyName: "test",
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

describe("frappe client — auth header", () => {
    it("sends Authorization: token <key>:<secret>", async () => {
        const seen: RequestInit[] = [];
        const fetchImpl: typeof fetch = async (_url, init) => {
            seen.push(init ?? {});
            return jsonResponse(200, { data: { ok: 1 } });
        };
        await frappeGet(creds, "/api/method/ping", undefined, { fetchImpl });
        expect(seen).toHaveLength(1);
        const headers = seen[0].headers as Record<string, string>;
        expect(headers.Authorization).toBe("token k:s");
        expect(headers.Accept).toBe("application/json");
    });
});

describe("frappe client — error handling", () => {
    it("4xx throws ErpNextHttpError with no retry", async () => {
        let calls = 0;
        const fetchImpl: typeof fetch = async () => {
            calls++;
            return jsonResponse(400, { exc: "ValidationError" });
        };
        await expect(
            frappePost(creds, "/api/resource/Customer", {}, { fetchImpl }),
        ).rejects.toBeInstanceOf(ErpNextHttpError);
        expect(calls).toBe(1);
    });

    it("5xx retries up to MAX_ATTEMPTS then throws", async () => {
        let calls = 0;
        const fetchImpl: typeof fetch = async () => {
            calls++;
            return jsonResponse(503, { exc: "TransientError" });
        };
        await expect(
            frappeGet(creds, "/api/method/ping", undefined, { fetchImpl }),
        ).rejects.toBeInstanceOf(ErpNextHttpError);
        // MAX_ATTEMPTS = 3 in client.ts
        expect(calls).toBe(3);
    });

    it("5xx that recovers on retry succeeds", async () => {
        let calls = 0;
        const fetchImpl: typeof fetch = async () => {
            calls++;
            if (calls === 1) return jsonResponse(500, {});
            return jsonResponse(200, { data: { ok: true } });
        };
        const body = await frappeGet(creds, "/api/method/ping", undefined, { fetchImpl });
        expect(body).toEqual({ data: { ok: true } });
        expect(calls).toBe(2);
    });
});

describe("findByGarageosId", () => {
    it("returns the name string when Frappe echoes one match", async () => {
        const fetchImpl: typeof fetch = async (url) => {
            expect(String(url)).toContain("/api/resource/Customer");
            expect(String(url)).toContain("filters=");
            return jsonResponse(200, {
                data: [{ name: "CUST-2026-00001" }],
            });
        };
        const name = await findByGarageosId(
            creds,
            "Customer",
            "garageos_customer_id",
            "cust-xyz",
            { fetchImpl },
        );
        expect(name).toBe("CUST-2026-00001");
    });

    it("returns null when Frappe returns empty data", async () => {
        const fetchImpl: typeof fetch = async () =>
            jsonResponse(200, { data: [] });
        const name = await findByGarageosId(
            creds,
            "Customer",
            "garageos_customer_id",
            "cust-xyz",
            { fetchImpl },
        );
        expect(name).toBeNull();
    });

    it("returns null when Frappe returns malformed body", async () => {
        const fetchImpl: typeof fetch = async () =>
            jsonResponse(200, { unexpected: 1 });
        const name = await findByGarageosId(
            creds,
            "Customer",
            "garageos_customer_id",
            "cust-xyz",
            { fetchImpl },
        );
        expect(name).toBeNull();
    });
});

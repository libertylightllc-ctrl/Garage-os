/**
 * Per-garage env-var resolver tests. Pure unit — no DB.
 *
 * Load-bearing:
 *   - suffix is UPPERCASED garageId
 *   - all five envs required; missing any → throw
 *   - NO fallback to unsuffixed variants (AR 2026-08-27)
 *   - trailing slash on base URL is stripped
 */

import { afterEach, describe, expect, it } from "vitest";
import {
    resolveCredentials,
    tryResolveCredentials,
    envSuffixFor,
    MissingErpCredentialsError,
} from "@/lib/erp-sync/credentials";

const GID = "gid_abcxyz";
const SUFFIX = GID.toUpperCase();

const ORIG: Record<string, string | undefined> = {};

function setEnv(key: string, val: string | undefined) {
    if (!(key in ORIG)) ORIG[key] = process.env[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
}

afterEach(() => {
    for (const [k, v] of Object.entries(ORIG)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

describe("resolveCredentials", () => {
    it("returns all five fields when all envs are set", () => {
        setEnv(`ERPNEXT_BASE_URL__${SUFFIX}`, "https://erp.test/");
        setEnv(`ERPNEXT_COMPANY_NAME__${SUFFIX}`, "co");
        setEnv(`ERPNEXT_COMPANY_ABBR__${SUFFIX}`, "GOS");
        setEnv(`ERPNEXT_API_KEY__${SUFFIX}`, "k");
        setEnv(`ERPNEXT_API_SECRET__${SUFFIX}`, "s");

        const c = resolveCredentials(GID);
        // Trailing slash stripped so `${baseUrl}/api/...` doesn't
        // produce a "//".
        expect(c.baseUrl).toBe("https://erp.test");
        expect(c.companyName).toBe("co");
        expect(c.companyAbbr).toBe("GOS");
        expect(c.apiKey).toBe("k");
        expect(c.apiSecret).toBe("s");
    });

    it("throws MissingErpCredentialsError listing every missing env", () => {
        setEnv(`ERPNEXT_BASE_URL__${SUFFIX}`, "https://erp.test");
        // Rest deliberately absent.
        setEnv(`ERPNEXT_COMPANY_NAME__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_COMPANY_ABBR__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_API_KEY__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_API_SECRET__${SUFFIX}`, undefined);

        try {
            resolveCredentials(GID);
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(MissingErpCredentialsError);
            const missing = (err as MissingErpCredentialsError).missing;
            expect(missing).toEqual([
                `ERPNEXT_COMPANY_NAME__${SUFFIX}`,
                `ERPNEXT_COMPANY_ABBR__${SUFFIX}`,
                `ERPNEXT_API_KEY__${SUFFIX}`,
                `ERPNEXT_API_SECRET__${SUFFIX}`,
            ]);
        }
    });

    it("does NOT fall back to unsuffixed variants", () => {
        // Set unsuffixed values only — must NOT be picked up.
        setEnv(`ERPNEXT_BASE_URL`, "https://erp.test");
        setEnv(`ERPNEXT_COMPANY_NAME`, "co");
        setEnv(`ERPNEXT_COMPANY_ABBR`, "GOS");
        setEnv(`ERPNEXT_API_KEY`, "k");
        setEnv(`ERPNEXT_API_SECRET`, "s");
        // Suffixed absent.
        setEnv(`ERPNEXT_BASE_URL__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_COMPANY_NAME__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_COMPANY_ABBR__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_API_KEY__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_API_SECRET__${SUFFIX}`, undefined);

        expect(() => resolveCredentials(GID)).toThrow(
            MissingErpCredentialsError,
        );
    });

    it("uppercase-normalises the garageId suffix", () => {
        setEnv(`ERPNEXT_BASE_URL__${SUFFIX}`, "https://erp.test");
        setEnv(`ERPNEXT_COMPANY_NAME__${SUFFIX}`, "co");
        setEnv(`ERPNEXT_COMPANY_ABBR__${SUFFIX}`, "GOS");
        setEnv(`ERPNEXT_API_KEY__${SUFFIX}`, "k");
        setEnv(`ERPNEXT_API_SECRET__${SUFFIX}`, "s");

        // Callers pass the raw (lowercase) garageId; resolver
        // internally uppercases before matching.
        const c = resolveCredentials(GID.toLowerCase());
        expect(c.apiKey).toBe("k");
    });
});

describe("envSuffixFor — the two real-world shapes", () => {
    it("cuid → uppercased verbatim (no hyphens to convert)", () => {
        expect(envSuffixFor("cmqwg2ekw00003guwz34j9o56")).toBe(
            "CMQWG2EKW00003GUWZ34J9O56",
        );
    });
    it("legacy hyphenated id → hyphen becomes underscore", () => {
        // Vercel env var names must match /^[A-Za-z_][A-Za-z0-9_]*$/
        // — the hyphen in "demo-garage" would be rejected as-is.
        expect(envSuffixFor("demo-garage")).toBe("DEMO_GARAGE");
    });
    it("any non-alphanumeric collapses to underscore (fuzz)", () => {
        expect(envSuffixFor("a.b-c/d e")).toBe("A_B_C_D_E");
    });
});

describe("resolveCredentials — hyphenated garageId reads DEMO_GARAGE-suffixed envs", () => {
    it("looks up ERPNEXT_*__DEMO_GARAGE for garageId 'demo-garage'", () => {
        setEnv("ERPNEXT_BASE_URL__DEMO_GARAGE", "https://erp.test");
        setEnv("ERPNEXT_COMPANY_NAME__DEMO_GARAGE", "garageos");
        setEnv("ERPNEXT_COMPANY_ABBR__DEMO_GARAGE", "GOS");
        setEnv("ERPNEXT_API_KEY__DEMO_GARAGE", "k");
        setEnv("ERPNEXT_API_SECRET__DEMO_GARAGE", "s");

        const c = resolveCredentials("demo-garage");
        expect(c.baseUrl).toBe("https://erp.test");
        expect(c.apiKey).toBe("k");
    });
});

describe("tryResolveCredentials", () => {
    it("returns ok=false + missing[] instead of throwing", () => {
        setEnv(`ERPNEXT_BASE_URL__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_COMPANY_NAME__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_COMPANY_ABBR__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_API_KEY__${SUFFIX}`, undefined);
        setEnv(`ERPNEXT_API_SECRET__${SUFFIX}`, undefined);

        const res = tryResolveCredentials(GID);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.missing).toHaveLength(5);
        }
    });
});

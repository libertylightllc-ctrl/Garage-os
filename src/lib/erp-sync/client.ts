// Frappe / ERPNext HTTP client.
//
// Small wrapper over fetch that handles:
//   - Token auth (`Authorization: token <key>:<secret>`)
//   - Timeout (default 20s; ERPNext under load can take a while)
//   - Retry on transient 5xx with capped exponential backoff
//   - Error-shape normalisation so callers get an Error with a
//     stable `.status`, `.body` and greppable message
//
// NOT retried: 4xx. A 400 / 401 / 403 / 404 is a caller-side problem
// (bad payload, bad auth, missing resource). Retrying won't help and
// masks the underlying bug.

import type { ErpNextCredentials } from "@/lib/erp-sync/credentials";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

export class ErpNextHttpError extends Error {
    constructor(
        public readonly status: number,
        public readonly body: string,
        public readonly method: string,
        public readonly path: string,
    ) {
        super(`[erp-client] ${method} ${path} → HTTP ${status}: ${trim(body, 300)}`);
        this.name = "ErpNextHttpError";
    }
}

export class ErpNextTimeoutError extends Error {
    constructor(public readonly method: string, public readonly path: string) {
        super(`[erp-client] ${method} ${path} → timeout`);
        this.name = "ErpNextTimeoutError";
    }
}

type RequestOpts = {
    method: "GET" | "POST" | "PUT";
    path: string; // e.g. "/api/resource/Customer"
    query?: Record<string, string | number>;
    body?: unknown;
    timeoutMs?: number;
    /**
     * Fetch impl override — used only by tests. Production code
     * leaves this unset and uses globalThis.fetch.
     */
    fetchImpl?: typeof fetch;
};

async function request(
    creds: ErpNextCredentials,
    opts: RequestOpts,
): Promise<{ status: number; body: unknown }> {
    const query = opts.query
        ? "?" + new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)])).toString()
        : "";
    const url = `${creds.baseUrl}${opts.path}${query}`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchFn = opts.fetchImpl ?? fetch;

    const headers: Record<string, string> = {
        Authorization: `token ${creds.apiKey}:${creds.apiSecret}`,
        Accept: "application/json",
    };
    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
        bodyStr = JSON.stringify(opts.body);
        headers["Content-Type"] = "application/json";
    }

    // AR 2026-08-30 — diagnostic logging. AR's second live payment
    // push produced a 4-row GL matching the "unreferenced-then-
    // reconciled" pattern despite our POST body containing both
    // references[] and docstatus:1. Frappe on ERPNext 16 may be
    // ignoring docstatus in the POST body (create as DRAFT
    // regardless), producing that shape when something later
    // submits the draft. Log request + response so we can read
    // the wire, not the code. Temporary — remove once diagnosed.
    // Auth header stripped; secrets never logged.
    const DEBUG = true;
    if (DEBUG && opts.method !== "GET") {
        console.log(
            `[erp-client] REQ ${opts.method} ${opts.path}${query} body=${bodyStr ?? "(none)"}`,
        );
    }

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetchFn(url, {
                method: opts.method,
                headers,
                body: bodyStr,
                signal: ctrl.signal,
            });
            const txt = await res.text();
            let parsed: unknown = txt;
            try {
                parsed = JSON.parse(txt);
            } catch {
                // Non-JSON body — keep as string; will surface in error msg
            }
            if (DEBUG && opts.method !== "GET") {
                console.log(
                    `[erp-client] RESP ${opts.method} ${opts.path} status=${res.status} body=${txt.slice(0, 4000)}`,
                );
            }
            if (res.status >= 500) {
                // Retryable server error. Log so ops can see the
                // retry cycle; distinct prefix for grep.
                console.warn(
                    `[erp-client] RETRY ${opts.method} ${opts.path} attempt=${attempt} status=${res.status}`,
                );
                lastErr = new ErpNextHttpError(res.status, txt, opts.method, opts.path);
                if (attempt < MAX_ATTEMPTS) {
                    await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
                    continue;
                }
                throw lastErr;
            }
            if (res.status >= 400) {
                // Client error — do NOT retry. Bubble up so the
                // runner can decide (fail-loud vs. reclassify).
                throw new ErpNextHttpError(res.status, txt, opts.method, opts.path);
            }
            return { status: res.status, body: parsed };
        } catch (err) {
            if (err instanceof ErpNextHttpError && err.status < 500) throw err;
            const isAbort = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
            if (isAbort) {
                console.warn(
                    `[erp-client] TIMEOUT ${opts.method} ${opts.path} attempt=${attempt}`,
                );
                lastErr = new ErpNextTimeoutError(opts.method, opts.path);
                if (attempt < MAX_ATTEMPTS) {
                    await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
                    continue;
                }
                throw lastErr;
            }
            // Network-level error — retry.
            console.warn(
                `[erp-client] NET_ERR ${opts.method} ${opts.path} attempt=${attempt} err=${(err as Error).message}`,
            );
            lastErr = err;
            if (attempt < MAX_ATTEMPTS) {
                await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
                continue;
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr ?? new Error("[erp-client] unreachable");
}

export async function frappeGet(
    creds: ErpNextCredentials,
    path: string,
    query?: Record<string, string | number>,
    opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<unknown> {
    const { body } = await request(creds, {
        method: "GET",
        path,
        query,
        timeoutMs: opts?.timeoutMs,
        fetchImpl: opts?.fetchImpl,
    });
    return body;
}

export async function frappePost(
    creds: ErpNextCredentials,
    path: string,
    body: unknown,
    opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<unknown> {
    const { body: res } = await request(creds, {
        method: "POST",
        path,
        body,
        timeoutMs: opts?.timeoutMs,
        fetchImpl: opts?.fetchImpl,
    });
    return res;
}

/**
 * Pre-flight lookup — the load-bearing idempotency safeguard from
 * the brief §3. Query ERPNext for a doctype by a custom field key
 * matching our GarageOS-side id. Returns the ERPNext name if the
 * row exists, null otherwise.
 *
 * A pre-flight HIT means either (a) the row was pushed on a prior
 * attempt whose map+status commit didn't complete, or (b) an
 * operator manually created it in ERPNext with the matching custom
 * field. Either way, the runner should log distinctly (see
 * `runner.ts`) and NOT re-POST.
 */
export async function findByGarageosId(
    creds: ErpNextCredentials,
    doctype: string,
    idField: string,
    idValue: string,
    opts?: { fetchImpl?: typeof fetch },
): Promise<string | null> {
    const filters = JSON.stringify([[idField, "=", idValue]]);
    const body = await frappeGet(
        creds,
        `/api/resource/${encodeURIComponent(doctype)}`,
        { filters, limit_page_length: 1 },
        opts,
    );
    // Frappe returns { data: [{ name: "..." }] } (with fields=name by
    // default). Empty array → no match.
    if (!body || typeof body !== "object") return null;
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0];
    if (!first || typeof first !== "object" || !("name" in first)) return null;
    return String((first as { name: unknown }).name);
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function trim(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max) + "…";
}

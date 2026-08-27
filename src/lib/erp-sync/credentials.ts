// Per-garage ERPNext credentials, read from environment variables.
//
// Design decision (AR 2026-08-27): credentials are NOT stored in the
// database, encrypted or otherwise. They live in Vercel environment
// variables, five per garage:
//
//   ERPNEXT_BASE_URL__<GARAGE_ID>
//   ERPNEXT_COMPANY_NAME__<GARAGE_ID>
//   ERPNEXT_COMPANY_ABBR__<GARAGE_ID>
//   ERPNEXT_API_KEY__<GARAGE_ID>
//   ERPNEXT_API_SECRET__<GARAGE_ID>
//
// GARAGE_ID is the garage's cuid, UPPERCASED. Vercel env vars are
// case-sensitive; we normalize the suffix here so operators set them
// in the conventional uppercase form and the code always finds them.
//
// NO FALLBACK to unsuffixed variants. A shared credential that later
// needs splitting is a migration nobody wants; a fallback path makes
// it easy to never do the split properly. Missing suffix → throw.
//
// Adding a second garage means adding five more Vercel envs. No code
// change, no DB migration, no bootstrap script.

export type ErpNextCredentials = {
    garageId: string;
    baseUrl: string;
    companyName: string;
    companyAbbr: string;
    apiKey: string;
    apiSecret: string;
};

const KEYS = [
    "ERPNEXT_BASE_URL",
    "ERPNEXT_COMPANY_NAME",
    "ERPNEXT_COMPANY_ABBR",
    "ERPNEXT_API_KEY",
    "ERPNEXT_API_SECRET",
] as const;

export class MissingErpCredentialsError extends Error {
    constructor(
        public readonly garageId: string,
        public readonly missing: string[],
    ) {
        super(
            `[erp-credentials] garage=${garageId} missing envs: ${missing.join(", ")}`,
        );
        this.name = "MissingErpCredentialsError";
    }
}

export function resolveCredentials(garageId: string): ErpNextCredentials {
    const suffix = garageId.toUpperCase();
    const values: Record<string, string | undefined> = {};
    const missing: string[] = [];
    for (const key of KEYS) {
        const envName = `${key}__${suffix}`;
        const v = process.env[envName];
        if (!v || v.trim() === "") {
            missing.push(envName);
        } else {
            values[key] = v.trim();
        }
    }
    if (missing.length > 0) {
        throw new MissingErpCredentialsError(garageId, missing);
    }
    // Strip trailing slash so callers can concat "/api/resource/..."
    // without worrying about "//".
    const baseUrl = values.ERPNEXT_BASE_URL!.replace(/\/+$/, "");
    return {
        garageId,
        baseUrl,
        companyName: values.ERPNEXT_COMPANY_NAME!,
        companyAbbr: values.ERPNEXT_COMPANY_ABBR!,
        apiKey: values.ERPNEXT_API_KEY!,
        apiSecret: values.ERPNEXT_API_SECRET!,
    };
}

/**
 * Non-throwing variant for the runner's outer loop: check if a
 * garage has credentials configured before we start walking its job
 * queue. Returns null if any env is missing, along with the list of
 * missing names for the greppable log line.
 */
export function tryResolveCredentials(
    garageId: string,
): { ok: true; creds: ErpNextCredentials } | { ok: false; missing: string[] } {
    try {
        return { ok: true, creds: resolveCredentials(garageId) };
    } catch (err) {
        if (err instanceof MissingErpCredentialsError) {
            return { ok: false, missing: err.missing };
        }
        throw err;
    }
}

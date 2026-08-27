// Pins that the advisor-side setEstimateStatusAction pings the
// central revalidation set — not just its own page.
//
// AR 2026-08-27 caught the gap by clicking "Mark approved" on a
// SENT estimate and watching the /advisor/estimates bucket keep
// showing it as SENT through two attempts. The DB row flipped
// APPROVED both times; the list page just kept serving cached
// RSC because the action only pinged /estimates/[id] +
// /advisor/jobs/[id].
//
// Same discipline as the customer-side pin (public.ts:19-33)
// which calls the full set. This test source-inspects the
// billing action so a silent revert to a partial revalidation
// list fires here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const BILLING_SRC = readFileSync(
    join(process.cwd(), "src", "app", "actions", "billing.ts"),
    "utf8",
);
const PUBLIC_SRC = readFileSync(
    join(process.cwd(), "src", "app", "actions", "public.ts"),
    "utf8",
);
const HELPER_SRC = readFileSync(
    join(process.cwd(), "src", "lib", "revalidate-estimate-surfaces.ts"),
    "utf8",
);

function bodyOf(src: string, name: string): string {
    const start = src.indexOf(`export async function ${name}`);
    if (start === -1) throw new Error(`action ${name} not found`);
    const rest = src.slice(start + 1);
    const nextExport = rest.indexOf("\nexport ");
    return nextExport === -1
        ? src.slice(start)
        : src.slice(start, start + 1 + nextExport);
}

describe("estimate-status writers use the central revalidation helper", () => {
    it("advisor-side setEstimateStatusAction imports + calls revalidateEstimateStaffSurfaces", () => {
        expect(BILLING_SRC).toMatch(
            /from ["']@\/lib\/revalidate-estimate-surfaces["']/,
        );
        const body = bodyOf(BILLING_SRC, "setEstimateStatusAction");
        expect(body).toMatch(/revalidateEstimateStaffSurfaces\(/);
    });

    it("customer-side approveEstimatePublic also uses the helper (unchanged; parity check)", () => {
        expect(PUBLIC_SRC).toMatch(
            /from ["']@\/lib\/revalidate-estimate-surfaces["']/,
        );
        const body = bodyOf(PUBLIC_SRC, "approveEstimatePublic");
        expect(body).toMatch(/revalidateEstimateStaffSurfaces\(/);
    });

    it("helper pings every staff surface that reads Estimate status", () => {
        // Load-bearing set — if you narrow this list, add a
        // reason next to the removed line AND update this pin.
        // The 2026-08-27 incident was 'MISSING /advisor/estimates
        // + /cashier from the advisor-side path'; both must stay
        // in the central helper forever.
        // Each path must appear inside a revalidatePath(...) call,
        // in EITHER a template literal (backtick) OR a plain string
        // (double / single quote). Regex allows both.
        const cases: Array<{ label: string; re: RegExp }> = [
            { label: "/advisor/jobs/${…}", re: /revalidatePath\(\s*[`"']\/advisor\/jobs\// },
            { label: "/estimates/${…}", re: /revalidatePath\(\s*[`"']\/estimates\// },
            { label: "/advisor (exact)", re: /revalidatePath\(\s*[`"']\/advisor[`"']\s*\)/ },
            { label: "/advisor/estimates", re: /revalidatePath\(\s*[`"']\/advisor\/estimates[`"']\s*\)/ },
            { label: "/cashier", re: /revalidatePath\(\s*[`"']\/cashier[`"']\s*\)/ },
        ];
        for (const c of cases) {
            expect(HELPER_SRC, `missing revalidatePath for ${c.label}`).toMatch(c.re);
        }
    });
});

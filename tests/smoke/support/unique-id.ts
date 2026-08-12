/**
 * Unique-per-run identifiers for smoke-test data hygiene.
 *
 * Every row a flow spec creates on staging carries a prefix keyed to
 * the GitHub Actions run id, so:
 *   - Concurrent runs on different SHAs never collide.
 *   - `scripts/smoke-cleanup.mjs` can find and delete exactly this
 *     run's debris, and no one else's.
 *
 * Local iteration: STAGING_SMOKE_RUN_ID unset → falls back to "local".
 * Local debris is harmless (staging weekly reseed clears it) but you
 * can also delete it by hand via a plate prefix search.
 */

const RUN_ID = process.env.STAGING_SMOKE_RUN_ID ?? "local";

/** Distinctive plate — e.g. "SMK-12345-A". Letter distinguishes flows. */
export function smokePlate(letter: "A" | "B" | "C" | "D"): string {
    return `SMK-${RUN_ID}-${letter}`;
}

/** Customer name used across every flow this run. Cleanup keys on this. */
export function smokeCustomerName(): string {
    return `Smoke Test ${RUN_ID}`;
}

/** UAE-shape phone. Deterministic per (run, letter) so retries reuse it. */
export function smokePhone(letter: "A" | "B" | "C" | "D"): string {
    // +971 55 7 XXXXX — 55 is a valid Etisalat prefix, 7 in position 4
    // keeps this out of any real-looking number range. Last 5 digits
    // derived from the run id + letter for stability across retries.
    const idHash = String(RUN_ID)
        .split("")
        .reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
    const letterOffset = { A: 0, B: 1, C: 2, D: 3 }[letter];
    const suffix = String((idHash + letterOffset) % 100000).padStart(5, "0");
    return `+9715570${suffix}`;
}

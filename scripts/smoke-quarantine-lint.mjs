#!/usr/bin/env node
/**
 * Quarantine lint — the discipline half of the flake strategy.
 *
 * Two rules, enforced on the smoke suite files under tests/smoke/**:
 *
 *   1. Every `test.fixme(` (or `test.skip(` — same semantics for us)
 *      must have a linked GitHub issue on the line before it, in the
 *      form `// QUARANTINE: gh#<number>` or `// QUARANTINE: <url>`.
 *      Putting a test into quarantine costs you a filed issue — no
 *      shortcut.
 *
 *   2. A quarantined test can live at most 7 days. The blame line
 *      (`git blame` on the fixme's line) tells us when the fixme
 *      LAST changed; older than 7 days without a re-touch means
 *      either fix it, delete it, or actively re-quarantine (which
 *      resets the clock and forces a fresh decision).
 *
 * Exit codes:
 *   0 — no fixmes, or every fixme is annotated + young.
 *   1 — at least one fixme fails a rule. Prints `::error::` lines
 *       so GitHub Actions annotates the offending file:line.
 *
 * Runs in the smoke workflow BEFORE the Playwright step, so a
 * violation blocks the whole gate — not just the current run.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const SMOKE_DIR = join(ROOT, "tests", "smoke");
const TTL_DAYS = 7;
const FIXME_REGEX = /\btest\.(fixme|skip)\s*\(/;
const ANNOTATION_REGEX = /\/\/\s*QUARANTINE:\s*(gh#\d+|https?:\/\/\S+)/i;

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) out.push(...walk(full));
        else if (/\.(spec|test)\.ts$/.test(entry)) out.push(full);
    }
    return out;
}

/** git blame for `file` line `line` — returns the author timestamp in ms, or null. */
function blameTimestampMs(file, line) {
    try {
        const rel = relative(ROOT, file).replace(/\\/g, "/");
        const out = execSync(
            `git blame -L ${line},${line} --line-porcelain -- "${rel}"`,
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        const m = out.match(/^author-time (\d+)/m);
        if (!m) return null;
        return Number(m[1]) * 1000;
    } catch {
        return null;
    }
}

const files = walk(SMOKE_DIR);
const violations = [];
const nowMs = Date.now();
const ttlMs = TTL_DAYS * 24 * 60 * 60 * 1000;

for (const file of files) {
    const src = readFileSync(file, "utf8");
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (!FIXME_REGEX.test(lines[i])) continue;
        const rel = relative(ROOT, file).replace(/\\/g, "/");
        const lineNo = i + 1;

        // Rule 1: preceding line must carry the QUARANTINE annotation.
        const prev = lines[i - 1] ?? "";
        if (!ANNOTATION_REGEX.test(prev)) {
            violations.push({
                file: rel,
                line: lineNo,
                msg: "quarantined test has no `// QUARANTINE: gh#<n>` annotation on the preceding line",
            });
            continue;
        }

        // Rule 2: TTL. Blame on the fixme's own line.
        const ts = blameTimestampMs(file, lineNo);
        if (ts !== null && nowMs - ts > ttlMs) {
            const daysOld = Math.floor((nowMs - ts) / (24 * 60 * 60 * 1000));
            violations.push({
                file: rel,
                line: lineNo,
                msg: `quarantine older than ${TTL_DAYS} days (${daysOld} days) — fix it, delete it, or re-touch to reset the clock`,
            });
        }
    }
}

if (violations.length === 0) {
    console.log("✓ smoke-quarantine-lint: no violations.");
    process.exit(0);
}

for (const v of violations) {
    console.log(`::error file=${v.file},line=${v.line}::${v.msg}`);
}
console.log(`\n✗ smoke-quarantine-lint: ${violations.length} violation(s).`);
process.exit(1);

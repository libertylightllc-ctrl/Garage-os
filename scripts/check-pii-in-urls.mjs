#!/usr/bin/env node
/**
 * CI guardrail against PII in URL query params on advisor + action
 * surfaces. Fails with exit 1 when any file constructs a URL that
 * carries one of the watched PII keys (ownerName / phone / email /
 * vin / chassis / mobile).
 *
 * Written after the class of bug was reintroduced twice — slice 5
 * fixed one variant, slice 3 rebuilt it via a different redirect
 * pattern, and slice 3's fix commit (6663146) closed five sites but
 * left three (the Moulkia OCR pipeline) still leaking. Detector
 * lands RED to prove it detects the class before the fix turns it
 * green — a rule written after the code is clean has never been
 * observed catching anything.
 *
 * Scope: `src/app/advisor/**` (the destination surfaces AR named)
 * PLUS `src/app/actions/**` (redirect origins that TARGET advisor
 * pages — sites 6–7 live in intake-moulkia.ts, which is under
 * /actions, not /advisor). Widening the scope beyond AR's literal
 * text so the rule catches every source of an advisor-page PII URL.
 *
 * Docs: docs/intake-duplicate-handling-spec.md § "PII in URL —
 * pattern and remaining follow-up".
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = process.cwd();
const SCAN_ROOTS = [
  join(REPO_ROOT, "src", "app", "advisor"),
  join(REPO_ROOT, "src", "app", "actions"),
];

const PII_KEYS = ["ownerName", "phone", "email", "vin", "chassis", "mobile"];
const PII_ALT = PII_KEYS.join("|");

/**
 * URL-construction signals. Each pattern is intentionally narrow —
 * it must match BOTH a URL-shaped context AND a PII key — so the
 * false-positive rate stays low without a heavy whitelist.
 *
 * The object-literal triggers use `[^}]*?` (not `[\s\S]*?`) so the
 * match CAN'T span past the closing `}` of the object literal into
 * an unrelated PII reference further down the file. Our URL-builder
 * object literals are always shallow, so `[^}]` is a correct bracket
 * boundary.
 */
const TRIGGERS = [
  {
    label: "new URLSearchParams({...}) with PII key",
    re: new RegExp(
      String.raw`new\s+URLSearchParams\s*\(\s*\{[^}]*?\b(${PII_ALT})\b[^}]*?\}`,
      "g",
    ),
  },
  {
    label: "URL builder call (confirmUrl / backUrl / buildQuery) with PII key",
    re: new RegExp(
      String.raw`(?:confirmUrl|backUrl|buildQuery)\s*\(\s*\{[^}]*?\b(${PII_ALT})\b[^}]*?\}`,
      "g",
    ),
  },
  {
    label: '.set("piiKey", …) / .append("piiKey", …) on URL search params',
    re: new RegExp(
      String.raw`\.(?:set|append)\s*\(\s*["'](${PII_ALT})["']`,
      "g",
    ),
  },
  {
    label: "template-literal URL with ?piiKey= or &piiKey=",
    re: new RegExp(String.raw`[?&](${PII_ALT})=`, "g"),
  },
];

/**
 * Exclusions applied to full matched substrings AFTER a trigger fires.
 * Every excluded match is printed with its reason so the reviewer can
 * eyeball the whitelist once. If the exclusions list keeps growing,
 * that's a signal the triggers are too broad.
 */
const EXCLUSIONS = [
  {
    re: new RegExp(String.raw`name\s*=\s*["'](${PII_ALT})["']`),
    reason: "React form input name attribute (POST body field, not URL)",
  },
  {
    re: /^\s*(\/\/|\*|\/\*)/,
    reason: "comment line",
  },
];

/** Recursively list .ts/.tsx files under `dir`, skipping tests + node_modules. */
function listFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out = out.concat(listFiles(p));
    } else if (/\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const files = SCAN_ROOTS.flatMap(listFiles);
const findings = [];
const exclusions = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const rel = relative(REPO_ROOT, file).split(sep).join("/");

  for (const trigger of TRIGGERS) {
    trigger.re.lastIndex = 0;
    let m;
    while ((m = trigger.re.exec(text)) !== null) {
      const match = m[0];
      const line = text.slice(0, m.index).split("\n").length;
      const excerpt =
        match.length <= 200
          ? match.replace(/\s+/g, " ").trim()
          : `${match.slice(0, 90).replace(/\s+/g, " ")} … ${match.slice(-90).replace(/\s+/g, " ")}`.trim();

      const excl = EXCLUSIONS.find((e) => e.re.test(match));
      if (excl) {
        exclusions.push({ file: rel, line, reason: excl.reason, excerpt });
      } else {
        findings.push({ file: rel, line, trigger: trigger.label, excerpt });
      }
    }
  }
}

const RED = "[31m";
const GREEN = "[32m";
const YELLOW = "[33m";
const RESET = "[0m";

console.log(`Scanned ${files.length} files under ${SCAN_ROOTS.map((r) => relative(REPO_ROOT, r).split(sep).join("/")).join(", ")}`);
console.log(`PII keys watched: ${PII_KEYS.join(", ")}`);
console.log("");

if (exclusions.length > 0) {
  console.log(`${YELLOW}Whitelisted matches (${exclusions.length}) — audit these once:${RESET}`);
  for (const e of exclusions) {
    console.log(`  ${e.file}:${e.line}  [${e.reason}]`);
    console.log(`    ${e.excerpt}`);
  }
  console.log("");
} else {
  console.log("Whitelist: no excluded matches this run.");
  console.log("");
}

if (findings.length > 0) {
  console.error(`${RED}✗ PII-in-URL violations: ${findings.length}${RESET}`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.trigger}]`);
    console.error(`    ${f.excerpt}`);
  }
  console.error("");
  console.error("Fix: pass an opaque record id (vehicleId, draftId) in the URL");
  console.error("and do a garage-scoped DB findFirst on the destination page.");
  console.error('See docs/intake-duplicate-handling-spec.md § "PII in URL" for the pattern.');
  process.exit(1);
} else {
  console.log(`${GREEN}✓ No PII-in-URL violations found.${RESET}`);
  process.exit(0);
}

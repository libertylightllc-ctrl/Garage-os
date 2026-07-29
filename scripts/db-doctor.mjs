#!/usr/bin/env node
// npm run db:doctor
//
// Local-only. Read-only. Verifies the machine's dev DB state matches
// what the repo says it should be. Exits non-zero on ANY drift so this
// can be wired into a git-hook / pre-commit / session-start check.
//
// Checks, in order:
//   1. Prisma dev server "garageos" exists (via its state file).
//   2. NO other `prisma dev` server exists (phantom detection —
//      accidentally-created servers were the root cause of the port
//      confusion that cost two sessions).
//   3. server.json's ports match the pinned canonical triple.
//   4. .env.local's DATABASE_URL + SHADOW_DATABASE_URL point at those
//      same ports (loud fail on drift, not a warn).
//   5. Something is actually listening on the DB port. The state file
//      persists across a killed prisma-dev process — state → ✓ but
//      no live Postgres → app crashes with ECONNREFUSED. Caught here.
//
// Read-only by design. Silent self-healing would hide the same class
// of drift this script exists to catch. Prints the exact recovery
// command on any failure — usually a `prisma dev rm <name>` followed
// by `npm run db:init`.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

// ────────────────────────────────────────────────────────────
// The canonical triple. THESE THREE NUMBERS must also appear
// identically in: .env.local, .env.example,
// docs/dev-db-proxy-spec.md, AGENTS.md. If you change one,
// change all five.
//
// Why these specific numbers: `prisma dev` (v0.16.26) SILENTLY
// IGNORES the --port / --db-port / --shadow-db-port flags and
// allocates from a fixed base range. The first server on a
// clean machine ALWAYS gets 51213/51214/51215. Since the
// phantom-server check below enforces "exactly one server named
// garageos", these three ports are effectively pinned by
// construction — Prisma has nothing else to pick from.
//
// If a future Prisma version starts respecting the flags, or
// changes the base range, this constant is the one place to
// update. Everything else reads from here.
// ────────────────────────────────────────────────────────────
const CANONICAL = Object.freeze({
    port: 51213,             // Prisma dev proxy (JWT-authenticated URL)
    databasePort: 51214,     // raw Postgres TCP (what .env.local's DATABASE_URL uses)
    shadowDatabasePort: 51215,
});

const SERVER_NAME = "garageos";

// prisma-dev-nodejs state directory. Cross-platform: Windows +
// macOS + Linux all fall under ~/.local/share, but Windows puts
// it under %LOCALAPPDATA%. `env-paths` would do this cleanly if
// it were installed; keeping it plain to stay tooling-lean.
function stateRoot() {
    if (process.platform === "win32") {
        return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "prisma-dev-nodejs", "Data");
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "prisma-dev-nodejs", "Data");
    }
    return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "prisma-dev-nodejs", "Data");
}

const findings = [];
function fail(code, message, remedy) {
    findings.push({ level: "fail", code, message, remedy });
}
function ok(code, message) {
    findings.push({ level: "ok", code, message });
}

function listServers() {
    const root = stateRoot();
    if (!fs.existsSync(root)) return [];
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => fs.existsSync(path.join(root, n, "server.json")));
}

function readServerJson(name) {
    const p = path.join(stateRoot(), name, "server.json");
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}

// ── Check 1 + 2: exactly one server, named `garageos` ───────
const servers = listServers();
const phantoms = servers.filter((s) => s !== SERVER_NAME);
if (phantoms.length > 0) {
    // Loud, not warn. The whole point of this script.
    fail(
        "PHANTOM_SERVER",
        `Found ${phantoms.length} phantom prisma-dev server${phantoms.length > 1 ? "s" : ""}: ${phantoms.join(", ")}. Any server other than "${SERVER_NAME}" is a mistake — it caused the port confusion this script exists to catch.`,
        phantoms.map((n) => `npx prisma dev rm ${n} --force`).join("\n  "),
    );
} else {
    ok("NO_PHANTOM", "no phantom prisma-dev servers");
}

if (!servers.includes(SERVER_NAME)) {
    fail(
        "MISSING_SERVER",
        `prisma-dev server "${SERVER_NAME}" does not exist yet`,
        "npm run db:init",
    );
}

// ── Check 3: server.json ports match the canonical triple ───
const srv = readServerJson(SERVER_NAME);
if (srv) {
    const mismatches = [];
    if (srv.port !== CANONICAL.port) mismatches.push(`port=${srv.port} (expected ${CANONICAL.port})`);
    if (srv.databasePort !== CANONICAL.databasePort) mismatches.push(`databasePort=${srv.databasePort} (expected ${CANONICAL.databasePort})`);
    if (srv.shadowDatabasePort !== CANONICAL.shadowDatabasePort) mismatches.push(`shadowDatabasePort=${srv.shadowDatabasePort} (expected ${CANONICAL.shadowDatabasePort})`);
    if (mismatches.length > 0) {
        fail(
            "SERVER_PORT_DRIFT",
            `${SERVER_NAME}/server.json holds non-canonical ports: ${mismatches.join(", ")}`,
            `npx prisma dev rm ${SERVER_NAME} --force && npm run db:init`,
        );
    } else {
        ok("SERVER_PORTS", `server.json matches canonical triple (${CANONICAL.port}/${CANONICAL.databasePort}/${CANONICAL.shadowDatabasePort})`);
    }
}

// ── Check 4: .env.local matches the canonical triple ────────
const envLocalPath = path.resolve(".env.local");
if (!fs.existsSync(envLocalPath)) {
    fail(
        "MISSING_ENV_LOCAL",
        ".env.local not found — dev will fall through to production credentials",
        `Create .env.local with DATABASE_URL="postgres://postgres:postgres@localhost:${CANONICAL.databasePort}/template1?sslmode=disable" and SHADOW_DATABASE_URL for port ${CANONICAL.shadowDatabasePort}`,
    );
} else {
    const envText = fs.readFileSync(envLocalPath, "utf8");
    // Extract the port from each URL. Loose regex — enough to detect drift.
    const dbMatch = envText.match(/^\s*DATABASE_URL\s*=\s*"?[^"\n]*:(\d+)\//m);
    const shadowMatch = envText.match(/^\s*SHADOW_DATABASE_URL\s*=\s*"?[^"\n]*:(\d+)\//m);
    if (!dbMatch) {
        fail(
            "ENV_LOCAL_DATABASE_URL_MISSING",
            ".env.local has no parseable DATABASE_URL",
            "Rewrite the DATABASE_URL line — see docs/dev-db-proxy-spec.md",
        );
    } else {
        const dbPort = Number(dbMatch[1]);
        if (dbPort !== CANONICAL.databasePort) {
            fail(
                "ENV_LOCAL_DATABASE_URL_DRIFT",
                `.env.local DATABASE_URL points at port ${dbPort}, canonical is ${CANONICAL.databasePort}`,
                `Edit .env.local: change ":${dbPort}/" to ":${CANONICAL.databasePort}/" in DATABASE_URL`,
            );
        } else {
            ok("ENV_LOCAL_DATABASE_URL", `.env.local DATABASE_URL → port ${dbPort}`);
        }
    }
    if (!shadowMatch) {
        fail(
            "ENV_LOCAL_SHADOW_DATABASE_URL_MISSING",
            ".env.local has no parseable SHADOW_DATABASE_URL",
            "Rewrite the SHADOW_DATABASE_URL line — see docs/dev-db-proxy-spec.md",
        );
    } else {
        const shadowPort = Number(shadowMatch[1]);
        if (shadowPort !== CANONICAL.shadowDatabasePort) {
            fail(
                "ENV_LOCAL_SHADOW_DATABASE_URL_DRIFT",
                `.env.local SHADOW_DATABASE_URL points at port ${shadowPort}, canonical is ${CANONICAL.shadowDatabasePort}`,
                `Edit .env.local: change ":${shadowPort}/" to ":${CANONICAL.shadowDatabasePort}/" in SHADOW_DATABASE_URL`,
            );
        } else {
            ok("ENV_LOCAL_SHADOW_DATABASE_URL", `.env.local SHADOW_DATABASE_URL → port ${shadowPort}`);
        }
    }
}

// ── Check 5: something is actually listening on the DB port ─
// state file → ✓ + no live Postgres → app 500s with ECONNREFUSED.
// A cheap TCP-connect probe distinguishes "state configured" from
// "process actually running." Kept synchronous-ish (small await) so
// this check remains under a second.
async function portListening(host, port, timeoutMs = 500) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        const done = (result) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.once("error", () => done(false));
        socket.connect(port, host);
    });
}

const liveDb = await portListening("127.0.0.1", CANONICAL.databasePort);
if (!liveDb) {
    fail(
        "DB_NOT_LISTENING",
        `nothing is listening on 127.0.0.1:${CANONICAL.databasePort}. Server state file exists but the prisma-dev process is dead — a Next dev server will crash with ECONNREFUSED on every query.`,
        "npm run db:dev",
    );
} else {
    ok("DB_LISTENING", `127.0.0.1:${CANONICAL.databasePort} is accepting connections`);
}

// ── Report ──────────────────────────────────────────────────
const fails = findings.filter((f) => f.level === "fail");
const passes = findings.filter((f) => f.level === "ok");

for (const p of passes) console.log(`  ✓ ${p.code}: ${p.message}`);
if (fails.length === 0) {
    console.log(`\n✓ db:doctor — all ${passes.length} checks passed. Canonical triple: ${CANONICAL.port}/${CANONICAL.databasePort}/${CANONICAL.shadowDatabasePort}.`);
    process.exit(0);
}


console.error("");
for (const f of fails) {
    console.error(`  ✗ ${f.code}: ${f.message}`);
    console.error(`    fix: ${f.remedy}`);
}
console.error(`\n✗ db:doctor — ${fails.length} failure${fails.length > 1 ? "s" : ""}. See docs/dev-db-proxy-spec.md for background.`);
process.exit(1);

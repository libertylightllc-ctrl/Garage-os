#!/usr/bin/env node
// npm run db:dev
//
// One command to bring the local dev DB up on the canonical pinned
// ports (see scripts/db-doctor.mjs for the source of truth).
//
//   • If the "garageos" server doesn't exist yet → runs `db:init`
//     (pinned-port create), then start.
//   • If it exists → runs `prisma dev start garageos --detach`.
//
// Explicitly does NOT auto-recover a wrong-port existing server —
// that would silently re-create dev data and hide the exact drift
// this whole scheme exists to catch. If server.json holds
// non-canonical ports, db:doctor reports SERVER_PORT_DRIFT with
// the recovery command; run it by hand.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SERVER_NAME = "garageos";

function stateRoot() {
    if (process.platform === "win32") {
        return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "prisma-dev-nodejs", "Data");
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "prisma-dev-nodejs", "Data");
    }
    return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "prisma-dev-nodejs", "Data");
}

const exists = fs.existsSync(path.join(stateRoot(), SERVER_NAME, "server.json"));

const cmd = exists
    ? ["npx", "prisma", "dev", "start", SERVER_NAME, "--detach"]
    : ["npm", "run", "db:init"];

console.log(exists ? "→ starting existing garageos server" : "→ garageos not found — running db:init");
const res = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", shell: true });
process.exit(res.status ?? 1);

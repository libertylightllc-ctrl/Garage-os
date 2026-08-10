// Operator-only: create a new tenant garage + its owner.
//
// Public self-signup is closed. The operator runs this from the command
// line — it's the ONLY way to create a new Garage row. The actual
// creation logic lives in src/lib/create-garage.ts; this file is just
// the CLI wrapper around it.
//
// Usage:
//   npx tsx scripts/create-garage.ts \
//     --garage "Ahmed Auto Service" \
//     --name "Ahmed Owner" \
//     --email "ahmed@ahmedautos.ae" \
//     --password "secret123"
//
// Optional:
//   --trn "100123456700003"
//
// Opts into Prod via scripts/lib/target-prod.mjs — reads PROD_DATABASE_URL
// from .env and sets DATABASE_URL. Renamed from `dotenv/config` on
// 2026-08-10 so no ambient .env fallback can carry a Prod URL into
// unrelated processes.

import "./lib/target-prod.mjs";
import {
  createGarageWithOwner,
  CreateGarageError,
} from "../src/lib/create-garage";
import { prisma } from "../src/lib/prisma";

interface Args {
  garage?: string;
  name?: string;
  email?: string;
  password?: string;
  trn?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (!a.startsWith("--")) continue;
    const key = a.slice(2) as keyof Args;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      // flag without value — skip
      continue;
    }
    (out as Record<string, string>)[key] = next;
    i++;
  }
  return out;
}

function printUsage(): void {
  console.log(`
Create a new garage tenant + its owner user.

Usage:
  npx tsx scripts/create-garage.ts \\
    --garage "Garage Name" \\
    --name "Owner Full Name" \\
    --email "owner@email.com" \\
    --password "min-6-chars"

Optional:
  --trn "100123456700003"   UAE VAT TRN

The owner can immediately sign in at /login with the email + password
you set. The garage starts EMPTY (no customers, jobs, invoices,
reminders, etc.) and is fully isolated from every other garage in the
DB by the multi-tenancy scoping proven in
src/lib/__tests__/tenant-isolation.test.ts.
`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  const missing = (
    ["garage", "name", "email", "password"] as const
  ).filter((k) => !args[k]);
  if (missing.length) {
    console.error(`Missing required flag(s): ${missing.map((k) => "--" + k).join(", ")}`);
    printUsage();
    return 2;
  }

  try {
    const r = await createGarageWithOwner({
      garageName: args.garage!,
      ownerName: args.name!,
      ownerEmail: args.email!,
      ownerPassword: args.password!,
      trn: args.trn ?? null,
    });
    console.log("");
    console.log("Garage created successfully.");
    console.log("");
    console.log("  Garage name:  " + r.garageName);
    console.log("  Garage id:    " + r.garageId);
    console.log("  Owner:        " + r.ownerName + " <" + r.email + ">");
    console.log("  Owner role:   OWNER");
    console.log("");
    console.log("  Starts empty: no customers, jobs, invoices, parts, reminders.");
    console.log("  Isolation:    enforced by Garage.id scoping on every query.");
    console.log("");
    console.log("  Sign in at /login with " + r.email + " and the password you set.");
    return 0;
  } catch (e) {
    if (e instanceof CreateGarageError) {
      console.error("Error [" + e.code + "]: " + e.message);
      return e.code === "EMAIL_EXISTS" ? 3 : 2;
    }
    console.error("Unexpected error:", e);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));

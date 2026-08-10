// Operator-only: create an AdminUser for the cross-garage admin panel.
//
// The /admin/* surface is gated by an entirely separate table from staff
// (User vs AdminUser), an entirely separate NextAuth provider, and a
// requireAdmin() helper that re-checks the DB row on every request. The
// ONLY way an AdminUser row enters the database is this script — there
// is no UI for creating admins, by design.
//
// Usage:
//   npx tsx scripts/create-admin.ts \
//     --email "ops@garageos.shop" \
//     --name "AR" \
//     --password "min-12-chars-please"
//
// Explicit target — 2026-08-10 rewrite. Silent .env fallback was
// removed after INV-2026-0039 (a local dev session hit Prod DB and
// signed a wa.me link with a non-Prod secret). Every invocation must
// declare its target with --target=local or --target=prod:
//   npx tsx scripts/create-admin.ts --target=local ...
//   npx tsx scripts/create-admin.ts --target=prod  ...
// Neither → refuse to run.
//
// Wrapped in an async main() because tsx transpiles this file to CJS
// where top-level await is forbidden. The dynamic import of the
// target wrapper AND the lazy Prisma import both live inside main()
// so ordering is deterministic: target sets DATABASE_URL first, then
// Prisma instantiates.

async function selectTarget(): Promise<"local" | "prod"> {
  const flag = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
  if (flag !== "local" && flag !== "prod") {
    console.error(
      "[create-admin] missing --target=local or --target=prod flag.\n" +
      "  A silent .env fallback was removed on 2026-08-10; every invocation\n" +
      "  must state its target so a prod-vs-local mistake is a compile-time\n" +
      "  requirement, not a filesystem accident.\n",
    );
    process.exit(1);
  }
  if (flag === "prod") await import("./lib/target-prod.mjs");
  else await import("./lib/target-local.mjs");
  return flag;
}

// Prisma singleton + bcrypt are imported lazily inside main() — tsx
// transpiles this file to CJS where top-level await is forbidden, and
// we also need the dotenv config above to run BEFORE prisma reads
// DATABASE_URL at its own import time.

interface Args {
  email?: string;
  name?: string;
  password?: string;
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
    if (next === undefined || next.startsWith("--")) continue;
    (out as Record<string, string>)[key] = next;
    i++;
  }
  return out;
}

function printUsage(): void {
  console.log(`
Create an operator AdminUser for the cross-garage admin panel.

Usage:
  npx tsx scripts/create-admin.ts \\
    --email "ops@garageos.shop" \\
    --name "Your Name" \\
    --password "minimum-12-chars"

The AdminUser table is entirely separate from the User table — admins
cannot be created via any UI flow, only via this script.

Env precedence: .env.local (LOCAL) → .env (PRODUCTION). The target DB
host prints before any write.
`);
}

function describeTarget(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return "<DATABASE_URL not set>";
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<DATABASE_URL unparseable>";
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  // Select target BEFORE the lazy Prisma import — sets DATABASE_URL
  // from PROD_DATABASE_URL (target-prod) or from .env.local (target-local).
  // Exits with code 1 if the flag is missing.
  await selectTarget();

  const missing = (["email", "name", "password"] as const).filter(
    (k) => !args[k]
  );
  if (missing.length) {
    console.error(
      `Missing required flag(s): ${missing.map((k) => "--" + k).join(", ")}`
    );
    printUsage();
    return 2;
  }

  const email = args.email!.toLowerCase().trim();
  const name = args.name!.trim();
  const password = args.password!;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error(`Invalid email format: ${email}`);
    return 2;
  }
  if (password.length < 12) {
    console.error(
      `Password too short (${password.length} chars). Operator admins must use ≥12 chars.`
    );
    return 2;
  }

  const target = describeTarget();
  console.log("");
  console.log("Target database: " + target);
  console.log("Creating admin:  " + email + " (" + name + ")");
  console.log("");

  // Lazy import so dotenv config above runs first AND so tsx's CJS
  // transpile doesn't choke on top-level await.
  const { prisma } = await import("../src/lib/prisma");
  const bcryptModule = await import("bcryptjs");
  const bcrypt = bcryptModule.default;

  try {
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) {
      console.error(`AdminUser with email ${email} already exists.`);
      return 3;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await prisma.adminUser.create({
      data: { email, name, passwordHash },
      select: { id: true, email: true, name: true, createdAt: true },
    });

    console.log("Admin created successfully.");
    console.log("");
    console.log("  Id:        " + admin.id);
    console.log("  Email:     " + admin.email);
    console.log("  Name:      " + admin.name);
    console.log("  Created:   " + admin.createdAt.toISOString());
    console.log("");
    console.log("  Sign in at /admin/login with " + admin.email + ".");
    console.log("  Session expires 4 hours after sign-in.");
    return 0;
  } catch (e) {
    console.error("Unexpected error:", e);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));

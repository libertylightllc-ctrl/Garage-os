import { NextResponse } from "next/server";
import { signIn } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * Dev-only "sign in as <role>" endpoint. Used in local development to
 * let an AI agent (or a human dev) jump between TECH / ADVISOR /
 * CASHIER / OWNER without bcrypt-ing a real password.
 *
 *   GET /dev/login?role=CASHIER
 *
 * DOUBLE-GATED — both gates must pass or the route 404s:
 *   1. NODE_ENV === "development" (Vercel sets "production")
 *   2. DEV_AUTH_BYPASS === "1" (only present in local .env)
 *
 * If you accidentally deploy this file to production, the deployment
 * is still safe: the gates fail, the dev-bypass provider isn't
 * registered, and this route returns 404. The corresponding auth
 * provider in src/auth.ts is gated identically.
 *
 * The route picks the FIRST user with the requested role in any garage,
 * sorted by createdAt. Predictable + idempotent — same role always lands
 * on the same dev account.
 */

const ENABLED =
  process.env.NODE_ENV === "development" &&
  process.env.DEV_AUTH_BYPASS === "1";

const ROLES = ["OWNER", "ADVISOR", "TECH", "CASHIER"] as const;
type Role = (typeof ROLES)[number];
const HOMES: Record<Role, string> = {
  OWNER: "/owner",
  ADVISOR: "/advisor",
  TECH: "/technician",
  CASHIER: "/cashier",
};

export async function GET(req: Request) {
  if (!ENABLED) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const role = url.searchParams.get("role")?.toUpperCase() as Role | undefined;
  if (!role || !ROLES.includes(role)) {
    return NextResponse.json(
      { error: `role param required — one of ${ROLES.join(", ")}` },
      { status: 400 },
    );
  }
  const user = await prisma.user.findFirst({
    where: { role },
    orderBy: { createdAt: "asc" },
    select: { email: true },
  });
  if (!user) {
    return NextResponse.json(
      { error: `No ${role} user found in the database` },
      { status: 404 },
    );
  }

  // signIn throws NEXT_REDIRECT which Next.js's route handler catches
  // and converts into a 30x response with Set-Cookie for the JWT.
  await signIn("dev-bypass", { email: user.email, redirectTo: HOMES[role] });
  // unreachable; signIn always redirects on success
  return NextResponse.json({ ok: true });
}

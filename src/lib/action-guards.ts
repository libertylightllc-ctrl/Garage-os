import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { sessionUserExists } from "@/lib/session-user";

/**
 * THE single permission-guard module for server ACTIONS.
 *
 * Born from a prod incident (ref 3426515655): the solo-owner change widened
 * "advisor" permissions, but the check lived as 17 private copies across 15
 * action files under two different names — two copies got missed and owners
 * hit "Not authorized" on the reception form. Widening a permission must be
 * ONE change in ONE file. This is that file.
 *
 * NOT the same as src/lib/guard.ts: that module guards PAGES and REDIRECTS
 * (to /login or the user's role home). This module guards ACTIONS and
 * THROWS — the action layer's last line of defense, identical behavior to
 * every private copy it replaced.
 */

type SessionUser = {
  id: string;
  role: string;
  garageId: string;
  email?: string | null;
  name?: string | null;
};

/**
 * Core: session user whose role is in `roles`, else throw "Not authorized".
 *
 * Also verifies the JWT's user id still resolves to a real User row —
 * a stale JWT (dev reseed, admin hard-delete) used to sail past auth
 * and only fail deep in downstream FK writes (`JobCard.advisorId`,
 * `AiEvent.userId`, …), turning intake into "Something went wrong."
 * See [[sessionUserExists]] and
 * `docs/telemetry-must-not-crash-operation-spec.md` for the sibling
 * telemetry rule.
 */
export async function requireAnyRole(roles: string[]): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user || !roles.includes(session.user.role)) {
    throw new Error("Not authorized");
  }
  if (!(await sessionUserExists(session.user.id))) {
    // Stale JWT — user gone. Redirect to /login so the user can
    // re-authenticate; a fresh POST /login overwrites the cookie
    // with a JWT whose sub references a live User row.
    redirect("/login");
  }
  return session.user as SessionUser;
}

/**
 * Advisor-side work: create jobs, intake, bookings, chats. OWNER is included
 * everywhere the advisor is (solo-owner shops run the whole flow on one
 * login; staff stay optional). MASTER is the owner-created do-everything
 * operational role (advisor + tech + cashier under one login) — it belongs
 * in every operational guard, never in requireOwner.
 */
export function requireAdvisor(): Promise<SessionUser> {
  return requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
}

/**
 * Technician work: claim, findings, steps, part requests. Deliberately
 * NOT widened to OWNER — the claim-lock and technician stats stay
 * meaningful. MASTER is included: it covers the tech seat in shops that
 * run the whole floor on one operational login.
 */
export function requireTech(): Promise<SessionUser> {
  return requireAnyRole(["TECH", "MASTER"]);
}

/**
 * Owner-only work: onboarding, WhatsApp connect, anything that touches
 * billing / finance / cross-branch ownership. MASTER is deliberately
 * excluded — the owner dashboard and financials stay owner-only.
 *
 * DO NOT use this for the operational shop surfaces (inventory,
 * purchasing, suppliers). Those are open to MASTER — use
 * requireOperational() instead. Guarding an operational action with
 * requireOwner() turns the MASTER-opened page into a trap: the page
 * loads, the form renders, and every submit throws "Not authorized".
 */
export function requireOwner(): Promise<SessionUser> {
  return requireAnyRole(["OWNER"]);
}

/**
 * Operational shop work: inventory, purchasing, suppliers, parts imports.
 * OWNER + MASTER. Pair this with the matching page guard
 * (`requireAnyRole(["OWNER", "MASTER"])` in src/lib/guard.ts) — opening a
 * page to MASTER without also swapping its action guards silently breaks
 * every submit. See AGENTS.md "Opening pages to MASTER" and the boundary
 * test at src/lib/__tests__/master-owner-boundary.test.ts.
 */
export function requireOperational(): Promise<SessionUser> {
  return requireAnyRole(["OWNER", "MASTER"]);
}

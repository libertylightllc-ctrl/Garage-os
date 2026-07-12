import { auth } from "@/auth";

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

/** Core: session user whose role is in `roles`, else throw "Not authorized". */
export async function requireAnyRole(roles: string[]): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user || !roles.includes(session.user.role)) {
    throw new Error("Not authorized");
  }
  return session.user as SessionUser;
}

/**
 * Advisor-side work: create jobs, intake, bookings, chats. OWNER is included
 * everywhere the advisor is (solo-owner shops run the whole flow on one
 * login; staff stay optional).
 */
export function requireAdvisor(): Promise<SessionUser> {
  return requireAnyRole(["ADVISOR", "OWNER"]);
}

/**
 * Technician-only work: claim, findings, steps, part requests. Deliberately
 * NOT widened to OWNER — the claim-lock and technician stats stay meaningful.
 */
export function requireTech(): Promise<SessionUser> {
  return requireAnyRole(["TECH"]);
}

/** Owner-only work: inventory, purchasing, suppliers, onboarding, WhatsApp. */
export function requireOwner(): Promise<SessionUser> {
  return requireAnyRole(["OWNER"]);
}

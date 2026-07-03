import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAdminAccess } from "@/lib/admin-audit";

export type AdminContext = {
  id: string;
  email: string;
  name: string;
};

export interface RequireAdminOptions {
  /** What surface the admin is viewing — e.g. "/admin/garages". Recorded
   *  on the AdminAuditLog row so we know what they saw. */
  pageView?: string;
  /** Optional target denormalisation, used by the Phase 3 per-shop view
   *  so a per-garage audit query can filter on targetGarageId. */
  targetGarageId?: string;
  targetType?: string;
  targetId?: string;
}

// The single gate for every /admin/* server-side surface.
//
// Three checks, all must pass; any miss → notFound() (404, never a
// redirect). Reason for 404 vs 401/redirect: non-admins shouldn't even
// learn that /admin exists — a redirect to /login would advertise it.
//
//   1. JWT session present AND has isAdmin === true.
//      (set ONLY by adminProvider in src/auth.ts)
//
//   2. The id in the JWT resolves to a row in AdminUser.
//      Catches "attacker forged a JWT with isAdmin:true": they may have
//      bypassed (1) but cannot fake a DB row. Also catches the case
//      where an admin was revoked DB-side after their token was issued.
//
//   3. The AdminUser row is not currently locked.
//      lockedUntil is set by Phase 2 lockout logic. Honoured today even
//      though Phase 1 doesn't populate it, so the gate is correct from
//      day one.
//
// Phase 2: every PASS and every DENY writes one row to AdminAuditLog.
// Both branches happen BEFORE the page renders, so the audit row is
// guaranteed to be in DB before any data the admin would see (or any
// 404 they'd get). Failures of the audit insert itself are swallowed —
// see admin-audit.ts.
//
// Returns the resolved admin context so call sites don't re-query.
// Throws via notFound() on failure — does not return null.
export async function requireAdmin(
  options: RequireAdminOptions = {}
): Promise<AdminContext> {
  const session = await auth();
  const sessionId =
    typeof session?.user?.id === "string" ? session.user.id : null;

  // helper to write a DENY row with whatever context we have, then
  // hand off to notFound(). Centralised so reason+target stay in sync.
  //
  // Note: actorAdminId stays null on every DENY. It's an FK to
  // AdminUser; writing a forged/staff user id there would either
  // crash the audit insert (no matching row) or — worse — pin a
  // failed attempt onto a real admin record. The id we DID see in
  // the JWT lands in meta.attemptedActorId so a forensic query can
  // still find "all probes claiming admin id X".
  const denyAndExit = async (reason: string): Promise<never> => {
    await logAdminAccess({
      actorAdminId: null,
      action: "access_denied",
      targetType: options.targetType,
      targetId: options.targetId,
      targetGarageId: options.targetGarageId,
      meta: {
        reason,
        ...(sessionId ? { attemptedActorId: sessionId } : {}),
        ...(options.pageView ? { path: options.pageView } : {}),
      },
    });
    notFound();
  };

  if (!session?.user?.isAdmin) await denyAndExit("not_admin_session");
  if (!sessionId) await denyAndExit("missing_session_id");

  const admin = await prisma.adminUser.findUnique({
    where: { id: sessionId! },
    select: { id: true, email: true, name: true, lockedUntil: true },
  });
  if (!admin) await denyAndExit("no_admin_row");
  if (admin!.lockedUntil && admin!.lockedUntil > new Date()) {
    await denyAndExit("locked");
  }

  // PASS — log the page view (or generic admit if no pageView named).
  await logAdminAccess({
    actorAdminId: admin!.id,
    action: "page_view",
    targetType: options.targetType,
    targetId: options.targetId,
    targetGarageId: options.targetGarageId,
    meta: options.pageView ? { path: options.pageView } : undefined,
  });

  return { id: admin!.id, email: admin!.email, name: admin!.name };
}

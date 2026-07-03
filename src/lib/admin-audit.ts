import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

// Every interaction with the /admin/* surface lands a row in
// AdminAuditLog. Phase 2 of the operator panel — admin actions have to
// be unrecorded NOWHERE, because admins read across all tenants.
//
// What gets logged:
//   page_view       — requireAdmin admitted, page rendered for an admin
//   access_denied   — requireAdmin rejected (regular user, forged JWT,
//                     locked admin), OR middleware deflected an
//                     anonymous probe of /admin/*
//   login_success   — adminProvider authorized
//   login_failed    — adminProvider rejected (wrong password, no row,
//                     locked admin attempt)
//
// IP + User-Agent are pulled from request headers; in dev they're often
// "127.0.0.1" / "Mozilla/5.0…" Locally that's fine. In prod, Vercel
// puts the real client IP in x-forwarded-for; we read both.

export type AdminAuditAction =
  | "page_view"
  | "access_denied"
  | "login_success"
  | "login_failed"
  | "garage_created"      // Phase 4: admin minted a new tenant
  | "garage_create_failed"; // Phase 4: validation/duplicate/bcrypt error

export interface LogAdminAccessInput {
  /** AdminUser id when known. null for anonymous denials + failed logins. */
  actorAdminId: string | null;
  action: AdminAuditAction;
  /** "Garage" | "User" | "AdminUser" | ... for per-target audit queries. */
  targetType?: string;
  targetId?: string;
  /** Denormalised garageId for the Phase 3 per-shop audit view. */
  targetGarageId?: string;
  /** Free-form context (e.g. {path, reason, email}). Don't put PII here. */
  meta?: Record<string, unknown>;
}

/**
 * Read IP + UA from incoming request headers. Returns ("unknown","unknown")
 * if called outside a request context (tests, scripts).
 */
async function requestContext(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const h = await headers();
    const fwd = h.get("x-forwarded-for");
    const ip = fwd ? fwd.split(",")[0].trim() : h.get("x-real-ip") ?? null;
    const userAgent = h.get("user-agent");
    return { ip, userAgent };
  } catch {
    // headers() throws when called outside a request scope (e.g. unit
    // tests). Audit logging shouldn't crash — fall back to nulls.
    return { ip: null, userAgent: null };
  }
}

/**
 * Append-only write. NEVER throws — audit failures must not break the
 * caller's flow (a failed insert here is worse than a missed log row,
 * given the caller might be requireAdmin gating a sensitive page).
 */
export async function logAdminAccess(input: LogAdminAccessInput): Promise<void> {
  const { ip, userAgent } = await requestContext();
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorAdminId: input.actorAdminId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        targetGarageId: input.targetGarageId,
        ip,
        userAgent,
        // Prisma's JSON input type is more restrictive than
        // Record<string, unknown> — cast through the safe shape.
        meta: input.meta as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[admin-audit] write failed:", e);
  }
}

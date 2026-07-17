// Routing helpers for the advisor /advisor/parts queue. Every function
// here is EXHAUSTIVE over the Prisma PartRequestStatus enum via a `never`
// default arm — TypeScript fails the build the moment a new status ships
// in the schema without being routed. That closes the same class of latent
// bug we fixed in Purchasing: a literal status array in two files silently
// dropping any newly-added enum value.
//
// The literal array `["REQUESTED", "ORDERED", "ARRIVED"]` used to live in
// TWO places — src/app/advisor/parts/page.tsx and the AppShell badge
// counter. Both now derive PART_REQUEST_OPEN_STATUSES from the helper
// below, so a new status (say `BACKORDERED`) forces the maintainer to
// decide OPEN vs TERMINAL in one place and both surfaces stay aligned.

import { PartRequestStatus } from "@/generated/prisma/client";

export type PartRequestSection = "OPEN" | "TERMINAL";

/**
 * Which section a part request belongs to.
 *   OPEN     — still on the advisor's plate: needs to be ordered,
 *              received, or fulfilled onto the job.
 *   TERMINAL — done and no longer shown on /advisor/parts. FULFILLED
 *              means the part landed on the job, CANCELLED means the
 *              request was withdrawn. Both are deliberately excluded
 *              from the queue — they are NOT falling through a default.
 *
 * TERMINAL is a NAMED case, not the default arm. If someone adds
 * `BACKORDERED` (or anything else) tomorrow, TypeScript will refuse to
 * build until they explicitly place it in OPEN or TERMINAL — inheriting
 * whatever the previous default was is not an option.
 */
export function partRequestSection(
  status: PartRequestStatus,
): PartRequestSection {
  switch (status) {
    case "REQUESTED":
    case "ORDERED":
    case "ARRIVED":
      return "OPEN";
    // TERMINAL, not shown on /advisor/parts. Explicit — do NOT collapse
    // into a `default` arm; that would silently absorb any future enum
    // value and reintroduce the vanishing-row bug this helper exists
    // to prevent.
    case "FULFILLED":
    case "CANCELLED":
      return "TERMINAL";
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled PartRequestStatus: ${_exhaustive}`);
    }
  }
}

/**
 * The statuses shown on /advisor/parts, derived from the enum via the
 * exhaustive router above. Both the page's Prisma query and the AppShell
 * nav-badge counter read this SAME constant, so they cannot drift.
 *
 * Ordering is Prisma's enum declaration order (Object.values), which for
 * PartRequestStatus is REQUESTED → ORDERED → ARRIVED — the natural
 * lifecycle order the advisor reads top-to-bottom.
 */
export const PART_REQUEST_OPEN_STATUSES: readonly PartRequestStatus[] =
  (Object.values(PartRequestStatus) as PartRequestStatus[]).filter(
    (s) => partRequestSection(s) === "OPEN",
  );

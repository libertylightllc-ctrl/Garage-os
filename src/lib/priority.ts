// Queue priority (Workflow-Spec Tier 2 #6). Pure so the mapping is testable.
// 0 = normal, 1 = urgent, 2 = emergency. Queues sort by priority desc, then time.

import type { MessageKey } from "@/i18n/config";

export const PRIORITY_LEVELS = [0, 1, 2] as const;

export interface PriorityMeta {
  key: MessageKey; // i18n label key
  badge: string; // emoji shown in queues (empty for normal)
}

export function priorityMeta(p: number | null | undefined): PriorityMeta {
  if ((p ?? 0) >= 2) return { key: "prEmergency", badge: "🔴" };
  if (p === 1) return { key: "prUrgent", badge: "⭐" };
  return { key: "prNormal", badge: "" };
}

/** Clamp arbitrary input to a valid priority level. */
export function clampPriority(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(2, Math.trunc(p)));
}

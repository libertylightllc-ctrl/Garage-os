import type { MessageKey } from "@/i18n/config";
import { FRIENDLY_STATUS_TONE, type FriendlyStatus } from "@/lib/jobcard-status";

interface Props {
  status: FriendlyStatus;
  /** i18n getter — passed in because this is a server component used from
   *  pages that already have one. Keeps the badge dependency-free. */
  t: (k: MessageKey) => string;
  /** Optional size variant for compact lists vs. job-detail headers. */
  size?: "sm" | "md";
}

/**
 * Colour-coded pill for the friendly job status. The colour mapping lives
 * in jobcard-status.ts so badges everywhere stay consistent. Used on
 * advisor / technician / cashier / owner dashboards and on every job
 * detail page so anyone looking at a job sees the same stage.
 */
export function FriendlyStatusBadge({ status, t, size = "md" }: Props) {
  const tone = FRIENDLY_STATUS_TONE[status];
  // Workshop sizing: sm = pill (inline next to a header), md = chip
  // (slightly taller, used in row-level cards). Both font-semibold to
  // match Badge primitive; previous was font-medium (lighter).
  const pad =
    size === "sm" ? "px-2 py-0.5 text-xs" : "h-7 px-3 text-xs";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full ${pad} font-semibold ${tone}`}
    >
      {t(`fs_${status}` as MessageKey)}
    </span>
  );
}

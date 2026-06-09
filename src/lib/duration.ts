// Duration formatting for the workflow timeline. Pure / dependency-free
// so the formatting rules can be exhaustively tested.
//
// Used to display:
//   diagnosis      = sentForEstimateAt - claimedAt
//   pricing        = estimate.sentAt   - sentForEstimateAt
//   approval-wait  = (when relevant)   - estimate.sentAt
// On every dashboard (advisor / technician / cashier) and on each job
// detail page.

/**
 * Format a millisecond duration as a human-readable phrase.
 *
 *  0 .. 60 sec  → 'just now'
 *  < 60 min     → 'Xm'
 *  < 24 hr      → 'Xh Ym'   ('Xh' when minutes round to 0)
 *  >= 24 hr     → 'Xd Yh'   ('Xd' when hours round to 0)
 *
 * Negative durations are clamped to 0. NaN / non-finite returns ''
 * so the caller can hide the badge gracefully.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const t = Math.max(0, Math.floor(ms / 1000)); // seconds
  if (t < 60) return "just now";
  const totalMin = Math.floor(t / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const minRem = totalMin - totalHr * 60;
  if (totalHr < 24) return minRem > 0 ? `${totalHr}h ${minRem}m` : `${totalHr}h`;
  const totalDays = Math.floor(totalHr / 24);
  const hrRem = totalHr - totalDays * 24;
  return hrRem > 0 ? `${totalDays}d ${hrRem}h` : `${totalDays}d`;
}

/**
 * Format the duration between two timestamps. If either is null /
 * undefined, returns ''. If `end` is null but `start` is set, the
 * caller should pass `new Date()` themselves — this helper makes no
 * implicit "now" assumption (server vs. client clock skew, SSR, etc.).
 */
export function durationBetween(start: Date | null | undefined, end: Date | null | undefined): string {
  if (!start || !end) return "";
  return formatDuration(end.getTime() - start.getTime());
}

/**
 * Convenience for "in progress" durations: pass the start timestamp,
 * we compute `(now - start)`. Returns '' when start is null. The caller
 * is responsible for picking which `now` (typically `new Date()` in a
 * server component, since this runs on each page render).
 */
export function elapsedSince(start: Date | null | undefined, now: Date): string {
  if (!start) return "";
  return formatDuration(now.getTime() - start.getTime());
}

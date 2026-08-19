/**
 * Chat draft utilities. AR 2026-08-19.
 *
 * Pure functions used by approveDraftAction to refuse sending a draft
 * whose placeholders were never filled in. Split into its own module
 * so the placeholder-detection rule is testable in isolation +
 * shared by any future draft-render surface (bulk approve, mobile
 * approve modal, etc.) without dragging in Prisma / server-action
 * imports.
 *
 * The placeholder sentinels are set by draftFor() in
 * src/lib/receptionist.ts — three or more literal underscores as
 * the value stand-in ("___") and a leading language-specific
 * "draft" marker ([draft], [مسودة], [ड्राफ्ट], [ڈرافٹ]). An advisor
 * who hits Approve on an unedited draft used to ship that verbatim
 * to a real customer over WhatsApp (INC 2026-08-18: customer
 * received "[مسودة] إجمالي السعر التقديري هو ___ درهم شامل الضريبة.
 * هل تريد المتابعة؟" — literal "draft" + blank underscores where
 * the price belongs).
 *
 * Also relevant: business-rules.md rule 4 (WhatsApp hand-off is not
 * delivery — a wrong message on the customer's phone can't be
 * retracted through wa.me).
 */

/**
 * Every literal marker we recognize as "this draft was not
 * finished". Add here + append en+ar unit tests when a new draft
 * template lands in receptionist.ts. Kept as a plain array (not a
 * regex) so a reader can eyeball every sentinel at once + so
 * variants in Arabic / Hindi / Urdu don't need regex escaping.
 */
export const DRAFT_MARKERS: readonly string[] = [
  "[draft]",
  "[مسودة]",
  "[ड्राफ्ट]",
  "[ڈرافٹ]",
];

/** Placeholder pattern — three or more consecutive underscores.
 *  draftFor uses exactly `___`; the tolerant match covers a
 *  future draft that uses `______` for a wider blank without
 *  needing to add a variant here. */
const PLACEHOLDER_RE = /_{3,}/;

/**
 * True when the body still contains a draft marker or an unfilled
 * `___` placeholder. Case-insensitive on the English marker; the
 * Arabic / Hindi / Urdu markers are already unambiguous.
 *
 * Trims leading/trailing whitespace on the body first so a body
 * like "  [draft] ..." still trips the check. Doesn't collapse
 * internal whitespace — the marker is meaningful anywhere in the
 * message, but almost always leads.
 */
export function hasUnfilledPlaceholders(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) return true; // empty draft is not sendable
  const lower = trimmed.toLowerCase();
  for (const marker of DRAFT_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return true;
  }
  return PLACEHOLDER_RE.test(trimmed);
}

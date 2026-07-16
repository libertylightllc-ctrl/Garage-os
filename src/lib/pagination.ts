// URL-driven table pagination. Pure so the parse + clamp math is testable
// without any request/DB context. All three of `parsePerPage`, `parsePage`,
// and `clampPage` accept the raw string / URLSearchParams values that
// arrive from a page's searchParams — no upstream sanitisation required.

export const PER_PAGE_OPTIONS = [10, 20, 30, 40] as const;
export const DEFAULT_PER_PAGE = 10;

export type PerPage = (typeof PER_PAGE_OPTIONS)[number];

/** Parse rows-per-page. Anything outside {10,20,30,40} falls back to 10. */
export function parsePerPage(raw: unknown): PerPage {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return (PER_PAGE_OPTIONS as readonly number[]).includes(n)
    ? (n as PerPage)
    : DEFAULT_PER_PAGE;
}

/** Parse a page number, defaulting to 1 for anything junky / negative / <1. */
export function parsePage(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

/** Compute the total page count given a row total + per-page. Never < 1
 *  (an empty result still has "page 1 of 1" so we never render "of 0"). */
export function pageCountOf(total: number, perPage: number): number {
  if (perPage <= 0) return 1;
  return Math.max(1, Math.ceil(total / perPage));
}

/** Clamp a requested page into [1, pageCount]. A stale URL like ?page=99
 *  after rows were deleted lands on the last page rather than an error. */
export function clampPage(requested: number, pageCount: number): number {
  if (requested < 1) return 1;
  if (requested > pageCount) return pageCount;
  return requested;
}

export interface PageWindow {
  perPage: PerPage;
  page: number; // clamped
  skip: number;
  take: number;
  totalCount: number;
  pageCount: number;
  /** 1-based row indices for the "Showing X-Y of Z" label. `from` is 0
   *  and `to` is 0 when the result set is empty; the caller can then
   *  hide the label altogether. */
  from: number;
  to: number;
}

/** Compose the four values together into a single window that Prisma
 *  can consume (skip/take) AND the UI can consume ("Showing X-Y of Z"). */
export function computeWindow(input: {
  rawPage: unknown;
  rawPer: unknown;
  totalCount: number;
}): PageWindow {
  const perPage = parsePerPage(input.rawPer);
  const pageCount = pageCountOf(input.totalCount, perPage);
  const page = clampPage(parsePage(input.rawPage), pageCount);
  const skip = (page - 1) * perPage;
  const take = perPage;
  const from = input.totalCount === 0 ? 0 : skip + 1;
  const to = Math.min(skip + take, input.totalCount);
  return {
    perPage,
    page,
    skip,
    take,
    totalCount: input.totalCount,
    pageCount,
    from,
    to,
  };
}

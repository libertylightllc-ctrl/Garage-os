import { formatJobNo } from "@/lib/jobcard-fields";

/**
 * The single source of truth for how a job card number appears anywhere
 * in the app. Renders `JC-YYYY-NNNN` from `formatJobNo(number, year)` and
 * NOTHING at all when the number is null (a job that hasn't been
 * numbered yet — the schema allows `JobCard.number` to be null pre-intake).
 *
 * Rule (pinned by src/components/__tests__/job-number-badge.test.ts):
 * NO page anywhere may render the raw `#{...jobCard.number}` bareword.
 * That's what led to the "same job shows as JC-2026-0042 on one page and
 * #42 on another" bug this component fixes. If a page needs to show the
 * number, it uses this component. No exceptions.
 *
 * Customer-facing surfaces (/c/*) render it too so a customer can quote
 * their job number on the phone.
 */
export interface JobNumberBadgeProps {
    jobCard: { number: number | null; createdAt: Date };
    className?: string;
}

export function JobNumberBadge({ jobCard, className }: JobNumberBadgeProps) {
    const label = formatJobNo(jobCard.number, jobCard.createdAt.getFullYear());
    if (!label) return null;
    return <span className={className}>{label}</span>;
}

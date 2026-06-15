import Link from "next/link";
import * as React from "react";

/**
 * GarageOS Badge primitive — Workshop design system.
 *
 * One color per semantic meaning, no overlap (the audit found amber
 * pulling double-duty for both "Pending Estimates" and "Partially
 * Paid"; we collapse them under one consistent meaning here):
 *
 *   success  — emerald-600  Paid, Approved, Completed
 *   warning  — amber-500    Needs follow-up (Partial, Pending, Action required)
 *   info     — sky-600      In progress, Filter active, Informational
 *   danger   — rose-600     Overdue, Rejected, Destructive
 *   neutral  — zinc-500     Draft, Not started, Generic
 *
 * Sizes:
 *   chip — bigger pill used as a tappable counter/filter (the cashier
 *          dashboard counter row), 28px min tap.
 *   pill — small inline pill next to a header or value (Partially Paid
 *          next to invoice header).
 *
 * As=Link: counter chips on the dashboard navigate to a filtered
 * view. The component renders as a <Link> when href is set, plain
 * <span> otherwise.
 */

type Tone = "success" | "warning" | "info" | "danger" | "neutral";
type Size = "chip" | "pill";

const TONE: Record<Tone, string> = {
  success:
    "border-success-500/40 bg-success-50 text-success-700 hover:bg-success-50/80 dark:border-success-500/40 dark:bg-success-500/10 dark:text-success-500",
  warning:
    "border-warning-500/40 bg-warning-50 text-warning-600 hover:bg-warning-50/80 dark:border-warning-500/40 dark:bg-warning-500/10 dark:text-warning-500",
  info:
    "border-info-500/40 bg-info-50 text-info-600 hover:bg-info-50/80 dark:border-info-500/40 dark:bg-info-500/10 dark:text-info-500",
  danger:
    "border-danger-500/40 bg-danger-50 text-danger-700 hover:bg-danger-50/80 dark:border-danger-500/40 dark:bg-danger-500/10 dark:text-danger-500",
  neutral:
    "border-border bg-surface-2 text-text-mute hover:bg-surface-2/80 dark:border-border dark:bg-surface-2 dark:text-text-mute",
};

const SIZE: Record<Size, string> = {
  chip: "h-7 rounded-full border px-3 text-xs font-semibold",
  pill: "rounded-full border px-2 py-0.5 text-xs font-semibold",
};

interface BadgeBaseProps {
  tone?: Tone;
  size?: Size;
}

const cls = (tone: Tone, size: Size, extra?: string) =>
  [
    "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
    SIZE[size],
    TONE[tone],
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");

export type BadgeProps = BadgeBaseProps & React.HTMLAttributes<HTMLSpanElement>;

export function Badge({
  tone = "neutral",
  size = "pill",
  className,
  ...rest
}: BadgeProps) {
  return <span className={cls(tone, size, className)} {...rest} />;
}

export type BadgeLinkProps = BadgeBaseProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
  };

export function BadgeLink({
  tone = "neutral",
  size = "chip",
  className,
  href,
  ...rest
}: BadgeLinkProps) {
  return <Link className={cls(tone, size, className)} href={href} {...rest} />;
}

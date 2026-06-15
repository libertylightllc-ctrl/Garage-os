import Link from "next/link";
import * as React from "react";

/**
 * GarageOS Button primitive — Workshop design system.
 *
 *   variant
 *     primary  — default-action button (slate-900 bg / white text).
 *                The "save / submit / continue" of any screen.
 *     hero     — the ONE most-important CTA per screen (amber-500 bg /
 *                slate-900 text). Generate Invoice, Send to Customer,
 *                Receive Payment. Use sparingly — two hero buttons on
 *                one screen is a smell.
 *     ghost    — secondary (transparent + border). Cancel, View, Back.
 *     danger   — destructive (rose-600 bg / white text). Delete,
 *                Reject, Disconnect.
 *
 *   size
 *     sm  — 32px tap target — chips and tight inline rows only
 *     md  — 40px tap target — default
 *     lg  — 48px tap target — full-width mobile CTAs, the BIG action
 *
 * The component is render-thin: it forwards every prop to a real
 * <button> (or <a>/<Link> when href is set) so existing form actions,
 * onClick handlers, aria-* etc keep working without surgery.
 *
 * Accessibility / mobile defaults:
 *   - text-base (16px) on size=lg so iOS Safari doesn't auto-zoom
 *     on focus of any input-adjacent button.
 *   - logical-property padding (`px-*` → `ps-*`/`pe-*` are equivalent
 *     in Tailwind v4); the button itself uses symmetric px so RTL
 *     flipping is implicit.
 *   - disabled state: opacity 50 + not-allowed cursor, no separate
 *     visual variant required.
 */

type Variant = "primary" | "hero" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-brand-900 text-white hover:bg-brand-700 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200",
  hero:
    "bg-accent-500 text-brand-900 hover:bg-accent-400 shadow-sm",
  ghost:
    "border border-border bg-transparent text-text hover:bg-surface-2",
  danger:
    "bg-danger-600 text-white hover:bg-danger-700",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold whitespace-nowrap " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";

interface ButtonBaseProps {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
}

export type ButtonProps = ButtonBaseProps &
  React.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({
  variant = "primary",
  size = "md",
  fullWidth,
  className,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button
      // Default to type="submit" inside a <form> elsewhere; explicit
      // type='button' for non-form usage prevents accidental form submit.
      type={type ?? "submit"}
      className={[
        BASE,
        VARIANT[variant],
        SIZE[size],
        fullWidth ? "w-full" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

/**
 * Same visual shape, rendered as a Link / anchor for navigational
 * actions ("Go to invoices →", "View estimate →"). The primary/hero
 * variant choice should mirror the semantic — navigation that's the
 * page's main action is `hero`, regular navigation is `ghost`.
 */
export type ButtonLinkProps = ButtonBaseProps &
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
  };

export function ButtonLink({
  variant = "ghost",
  size = "md",
  fullWidth,
  className,
  href,
  ...rest
}: ButtonLinkProps) {
  const cls = [
    BASE,
    VARIANT[variant],
    SIZE[size],
    fullWidth ? "w-full" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  // Next <Link> doesn't support every anchor attr cleanly; fall back
  // to a plain <a> when external (http(s)://). Internal hrefs use
  // <Link> for client-side nav.
  if (/^https?:\/\//.test(href)) {
    return <a className={cls} href={href} {...rest} />;
  }
  return <Link className={cls} href={href} {...rest} />;
}

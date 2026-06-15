import * as React from "react";

/**
  * GarageOS Card primitive — Workshop design system.
  *
  * One shape, no fuzz:
  *   - radius rounded-xl (12px)
  *   - border 1px border-border
  *   - background bg-surface
  *   - padding p-4
  *
  * Tinted variants for cards that ARE a status signal (Overdue invoice
  * row, Approved estimate row). Untinted otherwise. Tones use the same
  * 50/500 light-bg + colored-border combo as Badge so a tinted card and
  * its inline badge match without manual color juggling.
  */

type Tone = "default" | "success" | "warning" | "info" | "danger" | "neutral";

const TONE: Record<Tone, string> = {
    default: "bg-surface border-border",
    success:
        "border-success-500/40 bg-success-50 dark:border-success-500/30 dark:bg-success-500/10",
    warning:
        "border-warning-500/40 bg-warning-50 dark:border-warning-500/30 dark:bg-warning-500/10",
    info:
        "border-info-500/40 bg-info-50 dark:border-info-500/30 dark:bg-info-500/10",
    danger:
        "border-danger-500/40 bg-danger-50 dark:border-danger-500/30 dark:bg-danger-500/10",
    neutral:
        "border-border bg-surface-2",
};

export type CardProps = React.HTMLAttributes<HTMLDivElement> & {
    tone?: Tone;
    padded?: boolean; // default true; opt out for cards that wrap their own inner padding
};

export function Card({
    tone = "default",
    padded = true,
    className,
    ...rest
}: CardProps) {
    return (
        <div
            className={[
                "rounded-xl border",
                TONE[tone],
                padded ? "p-4" : "",
                className ?? "",
            ]
                .filter(Boolean)
                .join(" ")}
            {...rest}
        />
    );
}

/**
  * Common card sub-parts so a section can be composed declaratively
  * without re-deriving the spacing rhythm each time:
  *
  *   <Card>
  *     <CardHeader>
  *       <CardTitle>Receivables</CardTitle>
  *       <Badge tone="warning">12</Badge>
  *     </CardHeader>
  *     <CardBody>...</CardBody>
  *   </Card>
  */
export function CardHeader({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={[
                "mb-2 flex flex-wrap items-center justify-between gap-2",
                className ?? "",
            ]
                .filter(Boolean)
                .join(" ")}
            {...rest}
        />
    );
}

export function CardTitle({ className, ...rest }: React.HTMLAttributes<HTMLHeadingElement>) {
    return (
        <h2
            className={[
                "text-base font-semibold",
                className ?? "",
            ]
                .filter(Boolean)
                .join(" ")}
            {...rest}
        />
    );
}

export function CardBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={[
                "flex flex-col gap-2",
                className ?? "",
            ]
                .filter(Boolean)
                .join(" ")}
            {...rest}
        />
    );
}

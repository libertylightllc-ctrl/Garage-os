"use client";

// Wrapper for <button type="submit"> inside <form action={serverAction}>.
//
// Closes two related first-click bugs on server-action forms:
//
// (1) "First click swallowed" (AR 2026-08-28). Next.js 16 serves
//     stale RSC on a same-URL redirect after a server action —
//     the router cache treats the redirect as a no-op re-render
//     and paints the cached tree. The user sees no visible
//     change, clicks again, second click paints from a now-
//     invalidated cache. We call `router.refresh()` when the
//     form's pending transition ends, forcing a fresh RSC fetch.
//     Controls that redirect to a DIFFERENT URL (e.g. Take on
//     the technician page, which navigates to /technician?taken=1)
//     don't hit this because they miss the cache naturally.
//
// (2) Double-submit while the action is in flight. The button
//     disables itself during pending and paints a busy label
//     so the user sees they've been heard. `aria-busy` set for
//     screen readers.
//
// Usage:
//   <form action={someServerAction}>
//     <input type="hidden" name="…" value={…} />
//     <SubmitButton className="…">Save</SubmitButton>
//   </form>
//
// Every server-action form should use this instead of a plain
// <button type="submit">. Class-of-bug fix, not per-instance.

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    /**
     * Label to render inside the button while the action is
     * pending. Defaults to children. Pass a distinct string
     * ("Saving…", "Resetting…") for controls where the user
     * benefit of seeing progress outweighs the label churn.
     */
    pendingLabel?: React.ReactNode;
    /**
     * Whether to call router.refresh() when the pending transition
     * ends. Defaults to true. Set false for actions that
     * redirect to a different URL — the refresh would be a
     * wasted extra RSC fetch.
     */
    refreshOnComplete?: boolean;
}

export function SubmitButton({
    children,
    pendingLabel,
    refreshOnComplete = true,
    disabled,
    ...rest
}: Props) {
    const { pending } = useFormStatus();
    const router = useRouter();
    const wasPending = useRef(false);

    // When pending flips true → false, the server action has
    // completed (successfully or with a caught error — the client
    // can't tell). Fire router.refresh() to invalidate the router
    // cache and re-fetch RSC.
    //
    // Extra fetch on actions that DID redirect elsewhere is
    // cheap (one RSC round-trip) but avoidable — callers can
    // pass refreshOnComplete={false} for those.
    useEffect(() => {
        if (wasPending.current && !pending && refreshOnComplete) {
            router.refresh();
        }
        wasPending.current = pending;
    }, [pending, router, refreshOnComplete]);

    return (
        <button
            {...rest}
            type="submit"
            disabled={pending || disabled}
            aria-busy={pending || undefined}
        >
            {pending && pendingLabel ? pendingLabel : children}
        </button>
    );
}

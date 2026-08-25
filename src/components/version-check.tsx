"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Deploy-freshness check for tabs left open across a deploy (AR
 * 2026-08-25 Batch E — the class that produced three stale-bundle
 * false alarms on 2026-08-25 and the "advisor uses last week's form"
 * risk beyond that).
 *
 *   Snapshot at load : NEXT_PUBLIC_BUILD_ID, inlined at Vercel build
 *                      into the JS bundle → whatever version the
 *                      running tab actually IS.
 *   Ground truth     : GET /api/version → the version the ORIGIN is
 *                      serving right now.
 *
 * The check fires on window focus, on tab-visibility change, and on a
 * slow interval (POLL_MS). An all-day-open tab that never returns to
 * foreground still catches a deploy within one interval.
 *
 * Every detected mismatch posts one log row to /api/version/log so
 * the observation window (Vercel Logs, week of 2026-08-25 →) can
 * distinguish real deploys from any other source that could cause a
 * mismatch (edge propagation, scale-up quirks).
 *
 * Banner is gated on NEXT_PUBLIC_VERSION_BANNER_ENABLED so we can
 * ship the mechanism silent, observe for a week, and enable the UI
 * once we know it only fires on genuine deploys — flipping a Vercel
 * env var, no code push.
 *
 * NEVER a forced reload. An advisor mid-estimate must not lose work.
 * The banner is dismissible per-buildId: once dismissed, it stays
 * dismissed until a NEWER buildId is detected.
 */

const POLL_MS = 5 * 60 * 1000; // 5 minutes.

const LOADED_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";
const BANNER_ENABLED = process.env.NEXT_PUBLIC_VERSION_BANNER_ENABLED === "1";

interface VersionCheckProps {
    /** Labels come from the parent so RTL + Arabic render correctly.
     *  The component itself is presentation-agnostic. */
    labels: {
        message: string;
        reload: string;
        dismiss: string;
    };
}

export function VersionCheck({ labels }: VersionCheckProps) {
    // "dev" bundles never fire — a local dev build always reports "dev"
    // both client-side (baked into the bundle) and server-side (env var
    // absent), so the check would be a no-op anyway. Skip cleanly so
    // dev sessions don't spam /api/version.
    if (LOADED_ID === "dev") return null;

    return <VersionCheckActive labels={labels} />;
}

function VersionCheckActive({ labels }: VersionCheckProps) {
    // currentId = the id the origin is serving as of the last successful
    // fetch. null until the first check completes.
    const [currentId, setCurrentId] = useState<string | null>(null);
    // dismissedId = the id the user last clicked "Later" on. If a NEWER
    // buildId appears, the banner re-arms (dismissedId !== currentId).
    const [dismissedId, setDismissedId] = useState<string | null>(null);
    // Ref so `check` can dedupe repeat POSTs for the same mismatch
    // without waiting for React state to settle across ticks.
    const loggedForRef = useRef<string | null>(null);

    const check = useCallback(async () => {
        try {
            const r = await fetch("/api/version", {
                cache: "no-store",
                credentials: "same-origin",
            });
            if (!r.ok) return;
            const data = (await r.json()) as { buildId?: string };
            const fetchedId = data.buildId;
            if (!fetchedId || fetchedId === LOADED_ID) return;
            setCurrentId(fetchedId);
            // One log row per unique mismatched-id per tab lifetime.
            // Prevents a mismatched tab from spamming the log on every
            // interval fire. A NEW mismatched id (rare — would mean
            // multiple deploys during one tab's session) logs again.
            if (loggedForRef.current !== fetchedId) {
                loggedForRef.current = fetchedId;
                void fetch("/api/version/log", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        loadedId: LOADED_ID,
                        currentId: fetchedId,
                        url: typeof window !== "undefined" ? window.location.pathname : "",
                        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
                    }),
                    credentials: "same-origin",
                    keepalive: true,
                }).catch(() => {
                    // Silent — the log endpoint being down is not a
                    // reason to alarm the user. The mismatch itself
                    // still shows in the banner if enabled.
                });
            }
        } catch {
            // Network hiccup — try again on the next tick. Never surface
            // a fetch failure to the user as if it were a version issue.
        }
    }, []);

    useEffect(() => {
        // Initial check on mount so an advisor opening a tab into a
        // stale bundle (e.g. WhatsApp deep-link reopening a cached
        // page) discovers it immediately rather than at the next tick.
        void check();

        const onFocus = () => void check();
        const onVisibility = () => {
            if (document.visibilityState === "visible") void check();
        };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibility);
        const id = window.setInterval(check, POLL_MS);
        return () => {
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisibility);
            window.clearInterval(id);
        };
    }, [check]);

    // Banner ship-hidden gate: mechanism (fetch + log) runs regardless;
    // UI only mounts once the flag is flipped.
    if (!BANNER_ENABLED) return null;
    if (!currentId || currentId === dismissedId) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            className="fixed bottom-4 end-4 z-[60] flex max-w-sm flex-col gap-2 rounded-xl border border-warning-500/50 bg-warning-50 p-3 text-sm text-warning-700 shadow-lg dark:border-warning-500/40 dark:bg-warning-500/10 dark:text-warning-500 print:hidden"
        >
            <p>{labels.message}</p>
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={() => setDismissedId(currentId)}
                    className="inline-flex h-8 items-center justify-center rounded-md border border-warning-500/40 bg-transparent px-3 text-xs font-semibold hover:bg-warning-500/10"
                >
                    {labels.dismiss}
                </button>
                <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="inline-flex h-8 items-center justify-center rounded-md bg-warning-500 px-3 text-xs font-semibold text-white hover:bg-warning-600 dark:text-brand-900"
                >
                    {labels.reload}
                </button>
            </div>
        </div>
    );
}

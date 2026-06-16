"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Log to the browser console so the message + stack appear in
  // devtools when a user encounters this page. Vercel's production
  // build hides the raw message in the HTML response (for security),
  // but the browser console will still get the React-side stack
  // for client-side throws, and the digest is enough to find the
  // server-side stack in Vercel logs.
  useEffect(() => {
    console.error("[error.tsx]", error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
      {/* Themed error fallback (Workshop). Replaces the previous
          'bare Next.js default' look that was flagged in the audit.
          Icon ⚠ + danger-toned card so the cashier instantly knows
          this is a problem (not a normal screen) and the action is
          a single clear retry. */}
      <div className="flex flex-col items-center gap-3 rounded-xl border border-danger-500/40 bg-danger-50 p-6 dark:border-danger-500/30 dark:bg-danger-500/10">
        <span className="text-3xl">⚠️</span>
        <h1 className="text-2xl font-semibold tracking-tight text-danger-700 dark:text-danger-500">
          Something went wrong
        </h1>
        <p className="text-sm text-text-mute">
          That action didn’t complete. Please try again.
        </p>
        <button
          onClick={reset}
          className="inline-flex h-10 items-center justify-center rounded-lg bg-brand-900 px-4 text-sm font-semibold text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        >
          Try again
        </button>
        {error.digest ? (
          <p className="mt-2 select-all text-[10px] font-mono text-text-mute">
            ref: {error.digest}
          </p>
        ) : null}
      </div>
    </main>
  );
}

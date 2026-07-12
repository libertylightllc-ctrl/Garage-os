// Pricing section for the public marketing homepage. Pure server
// component, no client JS — same design tokens as the rest of the page.
//
// Deliberately shows NO numbers (pricing is quoted per shop): one flat
// monthly promise, the no-risk terms, and a Contact us CTA.

export function Pricing({ demoHref }: { demoHref: string }) {
  return (
    <section id="pricing" className="border-t border-border bg-surface-2/40">
      <div className="mx-auto max-w-3xl px-6 py-24 text-center">
        <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
          Simple pricing. Nothing up front.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-balance text-lg text-text-mute">
          One flat monthly price per branch — every role, every feature, every
          update included. No setup fee, no hardware, cancel anytime. Try it in
          your own workshop first, on us.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href={demoHref}
            className="inline-flex h-12 items-center justify-center rounded-full bg-brand-900 px-8 text-base font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
          >
            Start your free pilot
          </a>
          <a
            href={demoHref}
            className="inline-flex h-12 items-center justify-center px-2 text-base font-medium text-text-mute transition-colors hover:text-text"
          >
            or let&rsquo;s talk&nbsp;→
          </a>
        </div>

        <p className="mx-auto mt-10 max-w-xl text-balance text-sm text-text-mute">
          <span className="font-semibold text-text">Your data stays yours.</span>{" "}
          Customers, job history, invoices — export everything, any time.
        </p>
      </div>
    </section>
  );
}

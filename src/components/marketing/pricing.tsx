// Pricing section for the public marketing homepage. Pure server
// component, no client JS — same design tokens as the rest of the page.
//
// The pitch (per positioning): one flat monthly price against the
// incumbent desktop packages sold in the GCC (~AED 8,000 up front plus
// ~AED 1,500/year maintenance, tied to one PC in the office), and an
// explicit data-ownership promise.

export function Pricing({ demoHref }: { demoHref: string }) {
  return (
    <section id="pricing" className="border-t border-border bg-surface-2/40">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
            One price. Nothing up front.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-balance text-lg text-text-mute">
            Every role, every feature, every update — one flat monthly price
            per branch.
          </p>
        </div>

        <div className="mx-auto mt-14 grid max-w-4xl items-stretch gap-6 lg:grid-cols-5">
          {/* ── The plan ────────────────────────────────────── */}
          <div className="flex flex-col rounded-2xl border-2 border-brand-900 bg-surface p-8 shadow-sm lg:col-span-3 dark:border-white/70">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-lg font-semibold tracking-tight">Garage OS</h3>
              <span className="rounded-full bg-accent-500 px-3 py-1 text-xs font-semibold text-brand-900">
                First month free
              </span>
            </div>
            <div className="mt-6 flex items-baseline gap-2">
              <span className="text-5xl font-semibold tracking-tight">AED 149</span>
              <span className="text-text-mute">/ month</span>
            </div>
            <ul className="mt-8 flex flex-col gap-3 text-sm">
              <PlanLine>No upfront cost — start today, pay next month</PlanLine>
              <PlanLine>Cancel anytime, no contract, no penalty</PlanLine>
              <PlanLine>Every role included — owner, advisor, technician, cashier</PlanLine>
              <PlanLine>WhatsApp, Moulkia scan, and 5% VAT invoicing built in</PlanLine>
              <PlanLine>Works on the phones and tablets you already own</PlanLine>
            </ul>
            <div className="mt-8">
              <a
                href={demoHref}
                className="inline-flex h-12 w-full items-center justify-center rounded-full bg-brand-900 px-7 text-base font-semibold text-white transition-colors hover:bg-brand-700 sm:w-auto dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
              >
                Start free
              </a>
            </div>
          </div>

          {/* ── The old way ─────────────────────────────────── */}
          <div className="flex flex-col rounded-2xl border border-border bg-surface/60 p-8 lg:col-span-2">
            <h3 className="text-lg font-semibold tracking-tight text-text-mute">
              The old way
            </h3>
            <div className="mt-6 flex items-baseline gap-2 text-text-mute">
              <span className="text-3xl font-semibold tracking-tight line-through decoration-danger-500/60">
                AED 8,000
              </span>
              <span className="text-sm">up front</span>
            </div>
            <ul className="mt-6 flex flex-col gap-3 text-sm text-text-mute">
              <OldLine>+ AED 1,500 every year for &ldquo;maintenance&rdquo;</OldLine>
              <OldLine>Installed on one PC in the office</OldLine>
              <OldLine>Training days before anyone can use it</OldLine>
              <OldLine>Your records locked inside their software</OldLine>
            </ul>
          </div>
        </div>

        {/* ── Data ownership ──────────────────────────────────── */}
        <p className="mx-auto mt-10 max-w-2xl text-center text-balance text-text-mute">
          <span className="font-semibold text-text">Your data stays yours.</span>{" "}
          Customers, job history, invoices — export everything, any time. Leave
          whenever you want and take it all with you.
        </p>
      </div>
    </section>
  );
}

function PlanLine({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckIcon />
      <span>{children}</span>
    </li>
  );
}

function OldLine({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <DashIcon />
      <span>{children}</span>
    </li>
  );
}

function CheckIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-success-600 dark:text-success-500"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function DashIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-danger-500/70"
    >
      <path d="M6 12h12" />
    </svg>
  );
}

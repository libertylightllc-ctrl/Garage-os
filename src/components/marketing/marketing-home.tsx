import Link from "next/link";
import { GarageBrand } from "@/components/garage-brand";

// Public marketing homepage (additive). Rendered by src/app/page.tsx ONLY
// for anonymous visitors; logged-in staff are still redirected to their
// dashboard, so no existing app entry point changes. Pure server
// component — static content + links, no client JS. Styled with the
// product's own design tokens (brand slate + amber accent + Geist) so it
// matches the app.

const DEMO_MAILTO =
  "mailto:hello@garageos.shop?subject=GarageOS%20demo&body=Hi%20%E2%80%94%20we%27d%20like%20a%20demo%20of%20GarageOS%20for%20our%20workshop.";

export function MarketingHome() {
  return (
    <div className="min-h-screen bg-surface text-text">
      {/* ── Nav ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-surface/80 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2" aria-label="Garage OS">
            <GarageBrand size="mark" />
            <span className="text-sm font-semibold tracking-tight">Garage OS</span>
          </Link>
          {/* pe-16 reserves room for the app-wide language switcher
              (fixed end-3 top-3); dropped on xl where the switcher floats
              in the page margin instead of over the nav. */}
          <div className="flex items-center gap-6 pe-16 text-sm xl:pe-0">
            <a href="#product" className="hidden text-text-mute hover:text-text sm:inline">
              Product
            </a>
            <a href="#pilot" className="hidden text-text-mute hover:text-text sm:inline">
              Pricing
            </a>
            <Link
              href="/login"
              className="rounded-full px-4 py-1.5 font-medium text-text-mute hover:text-text"
            >
              Sign in
            </Link>
          </div>
        </nav>
      </header>

      <main>
        {/* ── Hero ──────────────────────────────────────────── */}
        <section className="mx-auto max-w-4xl px-6 pt-24 pb-16 text-center sm:pt-32">
          <h1 className="text-balance text-5xl font-semibold tracking-tight sm:text-6xl md:text-7xl">
            The workshop, on one screen.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-balance text-lg text-text-mute sm:text-xl">
            Everything from check-in to paid. Nothing you don&rsquo;t need.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <a
              href={DEMO_MAILTO}
              className="inline-flex h-12 items-center justify-center rounded-full bg-brand-900 px-7 text-base font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
            >
              Book a demo
            </a>
            <a
              href="#product"
              className="inline-flex h-12 items-center justify-center px-2 text-base font-medium text-text-mute transition-colors hover:text-text"
            >
              Watch it work&nbsp;→
            </a>
          </div>
        </section>

        {/* ── Product screenshot (placeholder) ──────────────── */}
        <section id="product" className="mx-auto max-w-6xl px-6 pb-24">
          <div className="mx-auto aspect-[16/10] w-full max-w-5xl overflow-hidden rounded-3xl border border-border bg-surface-2 shadow-sm">
            <div className="flex h-full items-center justify-center">
              <span className="text-sm font-medium uppercase tracking-widest text-text-mute">
                Product screenshot
              </span>
            </div>
          </div>
        </section>

        {/* ── Statement ─────────────────────────────────────── */}
        <section className="border-y border-border bg-surface-2/40">
          <div className="mx-auto max-w-4xl px-6 py-24 text-center">
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
              Check in a car. Send an invoice. Get paid.
            </h2>
            <p className="mx-auto mt-6 max-w-2xl text-balance text-lg text-text-mute">
              Job cards, estimates, parts, and 5% VAT — one flow, on any device.
              No training. No clutter. Just the next step.
            </p>
          </div>
        </section>

        {/* ── Three features ────────────────────────────────── */}
        <section className="mx-auto max-w-6xl px-6 py-24">
          <div className="grid gap-12 sm:grid-cols-3 sm:gap-8">
            <Feature
              title="Snap to fill"
              body="Photograph the Moulkia — owner, plate, VIN and model fill themselves in."
              icon={<CameraIcon />}
            />
            <Feature
              title="VAT, done"
              body="5% is added, shown as its own line, and totalled — automatically, every invoice."
              icon={<PercentIcon />}
            />
            <Feature
              title="On the floor"
              body="Runs on the phone in your hand — check-in, parts, and payment, right at the car."
              icon={<PhoneIcon />}
            />
          </div>
        </section>

        {/* ── Closing CTA ───────────────────────────────────── */}
        <section id="pilot" className="border-t border-border">
          <div className="mx-auto max-w-3xl px-6 py-24 text-center">
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Start with a free pilot.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-text-mute">
              See it run in your own workshop before you commit to anything.
            </p>
            <div className="mt-8">
              <a
                href={DEMO_MAILTO}
                className="inline-flex h-12 items-center justify-center rounded-full bg-brand-900 px-7 text-base font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
              >
                Book a demo
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-10 text-sm text-text-mute sm:flex-row">
          <div className="flex items-center gap-2">
            <GarageBrand size="mark" />
            <span className="font-medium">Garage OS</span>
          </div>
          <p>© {2026} Garage OS · Built for GCC workshops</p>
          <Link href="/login" className="hover:text-text">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}

function Feature({ title, body, icon }: { title: string; body: string; icon: React.ReactNode }) {
  return (
    <div className="text-center sm:text-left">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-2 text-text sm:mx-0">
        {icon}
      </div>
      <h3 className="mt-5 text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-text-mute">{body}</p>
    </div>
  );
}

/* Restrained line icons — 1.5px stroke, currentColor, no fill. */
function CameraIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2l1-1.5h4L12.5 7h2A1.5 1.5 0 0 1 16 8.5v8A1.5 1.5 0 0 1 14.5 18h-10A1.5 1.5 0 0 1 3 16.5v-8Z" />
      <circle cx="9.5" cy="12" r="2.75" />
      <path d="M18 9h3v9a1.5 1.5 0 0 1-1.5 1.5H9" opacity="0" />
    </svg>
  );
}
function PercentIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 5 5 19" />
      <circle cx="7.5" cy="7.5" r="2.5" />
      <circle cx="16.5" cy="16.5" r="2.5" />
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M11 18h2" />
    </svg>
  );
}

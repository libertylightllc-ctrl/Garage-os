"use client";

import { useEffect, useRef, useState } from "react";

// Marketing homepage — "How it works" walkthrough. Four numbered steps that
// fade + slide up as they scroll into view (IntersectionObserver, one-shot),
// staggered left-to-right on desktop. prefers-reduced-motion gets everything
// visible immediately: the observer is skipped AND the CSS transition is
// disabled via motion-reduce, so there is no flash of hidden content either
// way. Client component; the rest of the homepage stays a server component.

const STEPS = [
  {
    title: "Snap the car in",
    body: "Photograph the registration, the job card fills itself. No typing.",
    icon: <CameraIcon />,
  },
  {
    title: "Price the estimate",
    body: "Advisor adds parts and labour. Customer approves from their phone.",
    icon: <ClipboardIcon />,
  },
  {
    title: "Parts on hand",
    body: "Snap a supplier invoice, stock updates itself. Low-stock alerts built in.",
    icon: <PackageIcon />,
  },
  {
    title: "Invoice and get paid",
    body: "One tap to invoice, VAT calculated, sent to the customer.",
    icon: <InvoiceIcon />,
  },
];

export function HowItWorks({ demoHref }: { demoHref: string }) {
  const sectionRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState<boolean[]>(() => STEPS.map(() => false));

  useEffect(() => {
    const root = sectionRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(STEPS.map(() => true));
      return;
    }
    const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-step]"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = Number((e.target as HTMLElement).dataset.step);
          setVisible((v) => (v[i] ? v : v.map((x, j) => (j === i ? true : x))));
          io.unobserve(e.target);
        }
      },
      { threshold: 0.25, rootMargin: "0px 0px -10% 0px" },
    );
    cards.forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, []);

  return (
    <section ref={sectionRef} id="how-it-works" className="border-t border-border">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-text-mute">
            How it works
          </p>
          <h2 className="mx-auto mt-3 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
            From car in, to cash — in four steps.
          </h2>
        </div>

        <ol className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              data-step={i}
              style={{ transitionDelay: visible[i] ? `${i * 110}ms` : "0ms" }}
              className={`rounded-2xl border border-border bg-surface p-6 transition-all duration-700 ease-out motion-reduce:transition-none ${
                visible[i]
                  ? "translate-y-0 opacity-100"
                  : "translate-y-6 opacity-0 motion-reduce:translate-y-0 motion-reduce:opacity-100"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-2 text-text">
                  {s.icon}
                </div>
                <span
                  className="text-sm font-semibold tracking-widest text-text-mute/60 tabular-nums"
                  aria-hidden="true"
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="mt-5 text-lg font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-2 text-text-mute">{s.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-14 text-center">
          <a
            href={demoHref}
            className="inline-flex h-12 items-center justify-center rounded-full bg-brand-900 px-7 text-base font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
          >
            Book a demo
          </a>
        </div>
      </div>
    </section>
  );
}

/* Line icons — same voice as the homepage's Feature icons:
   1.5px stroke, currentColor, no fill. */
function CameraIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.1-1.6h6.4L16.3 7h2.2A1.5 1.5 0 0 1 20 8.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-8Z" />
      <circle cx="12" cy="12.5" r="3" />
    </svg>
  );
}
function ClipboardIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4.5" width="14" height="16" rx="2" />
      <path d="M9 4.5V4a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4v.5" />
      <path d="M9 10h6M9 13.5h6M9 17h3.5" />
    </svg>
  );
}
function PackageIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="M4 7l8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  );
}
function InvoiceIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5h9L19 7.5V20.5H6V3.5Z" />
      <path d="M15 3.5v4h4" />
      <path d="M9.5 12h5M9.5 15.5h5" />
    </svg>
  );
}

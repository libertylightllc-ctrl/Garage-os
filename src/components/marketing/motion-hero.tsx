"use client";

import { useEffect, useRef, useState } from "react";

// Marketing homepage — animated motion hero. A looping, code-built product
// "ad": a stylized phone cycles through the four key product moments while
// a synced callout rail highlights each one. All motion is transform/opacity
// (no layout thrash): scene swaps are class-toggled CSS transitions with
// per-element stagger via transition-delay; ambient float is a CSS keyframe;
// the money counter is a short rAF tween. prefers-reduced-motion gets a
// static composition — no timers, no float, all callouts listed, finished
// invoice on screen.

const SCENE_MS = 4000;

const SCENES = [
  { label: "Snap the car in", icon: <CameraIcon /> },
  { label: "Price the estimate", icon: <ClipboardIcon /> },
  { label: "Parts on hand", icon: <PackageIcon /> },
  { label: "Invoice + get paid", icon: <InvoiceIcon /> },
];

export function MotionHero() {
  const [scene, setScene] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setReduced(true);
      setScene(3); // static version: finished invoice, everything visible
      return;
    }
    const t = setInterval(() => setScene((s) => (s + 1) % SCENES.length), SCENE_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <section id="product" className="mx-auto max-w-6xl px-6 pb-24">
      <style>{`
        @keyframes gos-float { from { transform: translateY(-6px); } to { transform: translateY(6px); } }
        @keyframes gos-drift { from { transform: translate(0,0); } to { transform: translate(10px,-12px); } }
      `}</style>

      <div className="relative mx-auto w-full max-w-5xl overflow-hidden rounded-3xl border border-border bg-surface-2 shadow-sm">
        {/* ambient background — soft drifting glows, transform-only */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div
            className="absolute -top-24 -start-24 h-72 w-72 rounded-full bg-brand-900/5 motion-reduce:animate-none"
            style={reduced ? undefined : { animation: "gos-drift 7s ease-in-out infinite alternate" }}
          />
          <div
            className="absolute -bottom-28 -end-20 h-80 w-80 rounded-full bg-brand-900/5 motion-reduce:animate-none"
            style={reduced ? undefined : { animation: "gos-drift 9s ease-in-out infinite alternate-reverse" }}
          />
        </div>

        <div className="relative grid items-center gap-10 p-8 sm:p-12 lg:grid-cols-[1fr_auto] lg:gap-16 lg:p-16">
          {/* ── Callout rail ─────────────────────────────── */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-text-mute">
              One flow
            </p>
            <ol className="mt-6 space-y-1.5">
              {SCENES.map((s, i) => {
                const active = reduced || i === scene;
                return (
                  <li
                    key={s.label}
                    className={`flex items-center gap-3 rounded-2xl border p-3.5 transition-all duration-500 ease-out sm:p-4 ${
                      active
                        ? "translate-x-0 border-border bg-surface opacity-100 shadow-sm"
                        : "translate-x-0 border-transparent opacity-40"
                    }`}
                  >
                    <span
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors duration-500 ${
                        active ? "bg-brand-900 text-white" : "bg-surface-2 text-text-mute"
                      }`}
                    >
                      {s.icon}
                    </span>
                    <span className="font-semibold tracking-tight">{s.label}</span>
                  </li>
                );
              })}
            </ol>
            {!reduced ? (
              <div className="mt-6 flex gap-1.5" aria-hidden="true">
                {SCENES.map((_, i) => (
                  <span
                    key={i}
                    className={`h-1 rounded-full transition-all duration-500 ${
                      i === scene ? "w-6 bg-brand-900" : "w-2.5 bg-border"
                    }`}
                  />
                ))}
              </div>
            ) : null}
          </div>

          {/* ── Phone ────────────────────────────────────── */}
          <div className="flex justify-center">
            <div
              className="relative w-60 sm:w-64 motion-reduce:animate-none"
              style={reduced ? undefined : { animation: "gos-float 5s ease-in-out infinite alternate" }}
            >
              <div className="relative aspect-[9/18] overflow-hidden rounded-[2.2rem] border border-border bg-surface shadow-xl">
                {/* status bar */}
                <div className="flex items-center justify-between px-5 pt-3 text-[9px] font-medium text-text-mute">
                  <span>9:41</span>
                  <span className="h-3.5 w-16 rounded-full bg-surface-2" aria-hidden="true" />
                </div>

                <div className="relative h-full px-4 pt-3">
                  <Scene active={reduced || scene === 0} title="New job card">
                    <MockField label="Owner" value="Hassan M." delay={0} active={reduced || scene === 0} />
                    <MockField label="Plate" value="DXB A 74215" delay={1} active={reduced || scene === 0} />
                    <MockField label="VIN" value="JT1…8842" delay={2} active={reduced || scene === 0} />
                    <MockField label="Model" value="Land Cruiser ’21" delay={3} active={reduced || scene === 0} />
                    <Chip active={reduced || scene === 0} delay={4} tone="ok">Filled from photo</Chip>
                  </Scene>

                  <Scene active={!reduced && scene === 1} title="Estimate">
                    <MockRow name="Front brake pads" amount="380" delay={0} active={scene === 1} />
                    <MockRow name="Brake discs skim" amount="250" delay={1} active={scene === 1} />
                    <MockRow name="Labour · 2 hrs" amount="840" delay={2} active={scene === 1} />
                    <TotalRow label="Total" active={!reduced && scene === 1} target={1470} delay={3} />
                    <Chip active={!reduced && scene === 1} delay={4} tone="ok">Approved on WhatsApp</Chip>
                  </Scene>

                  <Scene active={!reduced && scene === 2} title="Inventory">
                    <MockRow name="Brake pads (front)" amount="×8" delay={0} active={scene === 2} />
                    <MockRow name="Oil filter" amount="×24" delay={1} active={scene === 2} />
                    <MockRow name="Air filter" amount="×3" delay={2} active={scene === 2} />
                    <Chip active={!reduced && scene === 2} delay={3} tone="warn">Air filter low — reorder</Chip>
                    <Chip active={!reduced && scene === 2} delay={4} tone="ok">Invoice scanned → stock updated</Chip>
                  </Scene>

                  <Scene active={reduced || scene === 3} title="Tax invoice">
                    <MockRow name="Subtotal" amount="1,470" delay={0} active={reduced || scene === 3} />
                    <MockRow name="VAT 5%" amount="73.50" delay={1} active={reduced || scene === 3} />
                    <TotalRow label="Total" active={reduced || scene === 3} target={1543.5} decimals delay={2} />
                    {/* PAID stamp */}
                    <div
                      className={`pointer-events-none absolute inset-x-0 top-1/2 flex justify-center transition-all duration-500 ease-out ${
                        reduced || scene === 3 ? "scale-100 opacity-100" : "scale-150 opacity-0"
                      }`}
                      style={{ transitionDelay: reduced ? "0ms" : scene === 3 ? "1300ms" : "0ms" }}
                    >
                      <span className="-rotate-12 rounded-lg border-2 border-success-500 px-4 py-1 text-xl font-bold uppercase tracking-widest text-success-500">
                        Paid
                      </span>
                    </div>
                  </Scene>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Scene + mock UI pieces ─────────────────────────────── */

function Scene({ active, title, children }: { active: boolean; title: string; children: React.ReactNode }) {
  return (
    <div
      aria-hidden={!active}
      className={`absolute inset-x-4 top-10 transition-all duration-500 ease-out ${
        active ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      }`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-widest text-text-mute">{title}</p>
      <div className="relative mt-3 space-y-2">{children}</div>
    </div>
  );
}

/** Staggered child: builds in shortly after its scene becomes active. */
function stagger(active: boolean, delay: number) {
  return {
    className: `transition-all duration-500 ease-out ${active ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"}`,
    style: { transitionDelay: active ? `${200 + delay * 180}ms` : "0ms" },
  };
}

function MockField({ label, value, delay, active }: { label: string; value: string; delay: number; active: boolean }) {
  const s = stagger(active, delay);
  return (
    <div {...s} className={`rounded-lg border border-border bg-surface-2/60 px-3 py-2 ${s.className}`}>
      <p className="text-[9px] uppercase tracking-wide text-text-mute">{label}</p>
      <p className="text-xs font-semibold">{value}</p>
    </div>
  );
}

function MockRow({ name, amount, delay, active }: { name: string; amount: string; delay: number; active: boolean }) {
  const s = stagger(active, delay);
  return (
    <div {...s} className={`flex items-center justify-between rounded-lg border border-border bg-surface-2/60 px-3 py-2 ${s.className}`}>
      <span className="text-xs">{name}</span>
      <span className="text-xs font-semibold tabular-nums">{amount}</span>
    </div>
  );
}

function TotalRow({ label, target, active, delay, decimals = false }: { label: string; target: number; active: boolean; delay: number; decimals?: boolean }) {
  const s = stagger(active, delay);
  const value = useCountUp(target, active);
  return (
    <div {...s} className={`flex items-center justify-between rounded-lg bg-brand-900 px-3 py-2 text-white ${s.className}`}>
      <span className="text-xs font-medium">{label}</span>
      <span className="text-xs font-bold tabular-nums">
        AED {value.toLocaleString("en-AE", { minimumFractionDigits: decimals ? 2 : 0, maximumFractionDigits: decimals ? 2 : 0 })}
      </span>
    </div>
  );
}

function Chip({ children, active, delay, tone }: { children: React.ReactNode; active: boolean; delay: number; tone: "ok" | "warn" }) {
  const s = stagger(active, delay);
  return (
    <div {...s} className={`${s.className}`}>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${
          tone === "ok"
            ? "bg-success-50 text-success-700 dark:bg-success-500/10 dark:text-success-500"
            : "bg-warning-50 text-warning-600 dark:bg-warning-500/10"
        }`}
      >
        {tone === "ok" ? "✓" : "!"} {children}
      </span>
    </div>
  );
}

/** Tween 0 → target over 800ms when `active` flips true (rAF, no layout). */
function useCountUp(target: number, active: boolean) {
  const [v, setV] = useState(0);
  const raf = useRef<number>(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (!active) {
      setV(0);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setV(target);
      return;
    }
    const start = performance.now() + 700; // wait for the row to fade in
    const dur = 800;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / dur));
      setV(target * (1 - Math.pow(1 - t, 3))); // ease-out cubic
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, active]);
  return v;
}

/* Line icons — same 1.5px stroke voice as the rest of the homepage. */
function CameraIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.1-1.6h6.4L16.3 7h2.2A1.5 1.5 0 0 1 20 8.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-8Z" />
      <circle cx="12" cy="12.5" r="3" />
    </svg>
  );
}
function ClipboardIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4.5" width="14" height="16" rx="2" />
      <path d="M9 4.5V4a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4v.5" />
      <path d="M9 10h6M9 13.5h6M9 17h3.5" />
    </svg>
  );
}
function PackageIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="M4 7l8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  );
}
function InvoiceIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5h9L19 7.5V20.5H6V3.5Z" />
      <path d="M15 3.5v4h4" />
      <path d="M9.5 12h5M9.5 15.5h5" />
    </svg>
  );
}

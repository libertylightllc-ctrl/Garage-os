import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";

export const dynamic = "force-dynamic";

/**
 * Intake collision disambiguation panel (slice 3).
 *
 * Reached when the advisor tries to open a new job card for a plate
 * that's currently attached to an existing Vehicle in this garage.
 * Two entry points redirect here:
 *   - `plateLookupAction` (returning-customer tile on the intake
 *     landing page) — used to prefill the confirm form directly.
 *   - `createCustomerVehicleJobAction`'s pre-flight, when it detects
 *     Case B (plate under a different customer). Used to fall
 *     through with a warning card on the done page (slice 5); the
 *     panel replaces that.
 *
 * The panel itself is stateless — every button is a Link that
 * redirects to the right next step. No writes happen on click; the
 * mutating work (Choice 2 ownership transfer, Choice 3 plate
 * release) lives inside the confirm submit action's transaction,
 * so an abandoned panel leaves the world unchanged.
 *
 * Route is garage-scoped: findFirst with the caller's garageId and
 * notFound() on miss, same shape as the done page's cross-tenant
 * guard.
 */
export default async function ExistingVehicleDisambiguation({
    params,
    searchParams,
}: {
    params: Promise<{ vehicleId: string }>;
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
    const t = await getT();
    const { vehicleId } = await params;
    const sp = await searchParams;

    const vehicle = await prisma.vehicle.findFirst({
        where: { id: vehicleId, customer: { garageId: session.user.garageId } },
        include: { customer: { select: { id: true, name: true, phone: true } } },
    });
    if (!vehicle) notFound();

    // Forward whatever intake-form context arrived so downstream
    // pages / actions can carry it. `plate` is the plate the advisor
    // typed (which may already be normalised) and reflects what
    // caused this collision to surface.
    const plateTyped = sp.plate ?? vehicle.plate;
    const via = sp.via ?? "manual";
    // Fields to forward when we redirect. The advisor may have
    // typed some of them already (via Moulkia OCR or manually
    // filling the confirm form) — carry them through so Choice 3
    // (different car) doesn't blow away what the advisor entered.
    const forward = (extra: Record<string, string>) => {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries({
            via,
            assignedToId: sp.assignedToId ?? "",
            ...extra,
        })) {
            if (v) p.set(k, v);
        }
        return p.toString();
    };

    // ── Choice 1 — Same car, same owner ──────────────────────────
    // `vehicleId` in the URL means the action's transaction takes
    // the "repeat" branch (see createCustomerVehicleJobAction). The
    // confirm page does a garage-scoped DB lookup on vehicleId and
    // fills owner name / phone / plate / make / model / year / vin /
    // spec from the record — the URL carries none of that. PII in a
    // URL bar (and in server access logs + browser history +
    // referrer headers) is what this whole fix is about; the record
    // is already in the DB, so there's nothing to gain by
    // duplicating it into the query string.
    const sameOwnerHref = "/advisor/jobs/new/confirm?" + forward({
        via: "repeat",
        vehicleId: vehicle.id,
    });

    // ── Choice 2 — Same car, owner has changed ──────────────────
    // `editOwner=1` tells the confirm action to do a real FK move
    // to a new Customer + write a VehicleOwnershipTransfer row,
    // rather than mutating the existing Customer row in place (the
    // landmine flagged in docs/intake-duplicate-handling-spec.md).
    // The confirm page suppresses owner-name / phone / email
    // defaults when editOwner=1 (advisor is typing the NEW owner),
    // but still fills vehicle-spec defaults from the DB lookup on
    // vehicleId — the car itself is unchanged.
    const newOwnerHref = "/advisor/jobs/new/confirm?" + forward({
        via: "repeat",
        vehicleId: vehicle.id,
        editOwner: "1",
    });

    // ── Choice 3 — Different car — same plate number ────────────
    // The plate typed will be attached to a NEW Vehicle. The old
    // Vehicle keeps its VIN + history but loses this plate. All
    // writes happen atomically in the confirm submit action's
    // transaction; the URL carries only intent + the plate the
    // advisor typed on the physical car. Owner name / phone / VIN
    // for the NEW car are typed on the confirm form — never
    // forwarded through the URL, even if the OCR path had already
    // extracted them (that path was the Case B leak).
    const plateMovedHref = "/advisor/jobs/new/confirm?" + forward({
        via: "manual",
        releasePlateFrom: vehicle.id,
        plate: plateTyped,
    });

    // ── Choice 4 — Wrong plate — search again ───────────────────
    // Back to the intake landing page with the typed plate carried
    // forward so the advisor can correct it in the plate-search
    // input instead of retyping from scratch.
    const wrongPlateHref = `/advisor/jobs/new?plate=${encodeURIComponent(plateTyped)}`;

    return (
        <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 p-6">
            <AppNav role="ADVISOR" active="jobs" />
            <div>
                <Link href="/advisor" className="text-sm text-text-mute hover:underline">
                    {t("backActiveJobs")}
                </Link>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                    {t("intakePanelTitle")}
                </h1>
                <p className="mt-1 text-sm text-text-mute">
                    {t("intakePanelSubtitle").replace("{plate}", plateTyped)}
                </p>
            </div>

            {/* Existing record summary — the card the advisor is
                classifying against. Owner name is what makes Choice 3's
                consequence visible before they tap: "release {this
                person}'s plate." */}
            <section className="rounded-xl border border-border p-4 text-sm">
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-mute">
                    {t("intakePanelRecordHeading")}
                </h2>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                    <SummaryRow label={t("intakePanelOwnerLabel")} value={vehicle.customer.name} />
                    <SummaryRow label={t("intakePanelPhoneLabel")} value={vehicle.customer.phone} />
                    <SummaryRow label={t("intakePanelPlateLabel")} value={vehicle.plate || "—"} />
                    <SummaryRow
                        label={t("intakePanelVehicleLabel")}
                        value={[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" ")}
                    />
                    <SummaryRow label={t("intakePanelVinLabel")} value={vehicle.vin || "—"} />
                </dl>
            </section>

            {/* Choice 1 — primary. Sized large because this is the
                majority of taps in a returning-customer workflow. */}
            <ChoiceCard
                href={sameOwnerHref}
                title={t("intakePanelChoiceSameOwnerTitle")}
                subtitle={t("intakePanelChoiceSameOwnerSubtitle").replace(
                    "{owner}",
                    vehicle.customer.name,
                )}
                tone="primary"
            />

            {/* Choice 2 — same car, owner changed */}
            <ChoiceCard
                href={newOwnerHref}
                title={t("intakePanelChoiceNewOwnerTitle")}
                subtitle={t("intakePanelChoiceNewOwnerSubtitle")}
                tone="secondary"
            />

            {/* Choice 3 — different car. The subtitle names the
                previous owner because this is the only irreversible
                choice; the advisor sees whose record they're
                changing before they tap. */}
            <ChoiceCard
                href={plateMovedHref}
                title={t("intakePanelChoicePlateMovedTitle")}
                subtitle={t("intakePanelChoicePlateMovedSubtitle").replace(
                    "{owner}",
                    vehicle.customer.name,
                )}
                tone="secondary"
            />

            {/* Divider — separates the four classification choices
                from the "I typed the wrong plate" correction, which
                is what Choice 4 actually is. */}
            <div className="my-1 h-px w-full bg-border" role="separator" aria-hidden="true" />

            <ChoiceCard
                href={wrongPlateHref}
                title={t("intakePanelChoiceWrongPlateTitle")}
                subtitle={t("intakePanelChoiceWrongPlateSubtitle")}
                tone="ghost"
            />
        </main>
    );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
    return (
        <>
            <dt className="text-xs text-text-mute">{label}</dt>
            <dd className="text-sm font-medium">{value}</dd>
        </>
    );
}

function ChoiceCard({
    href,
    title,
    subtitle,
    tone,
}: {
    href: string;
    title: string;
    subtitle: string;
    tone: "primary" | "secondary" | "ghost";
}) {
    const base =
        "block rounded-xl border p-4 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60";
    const toneClass =
        tone === "primary"
            ? "border-brand-900/30 bg-brand-900 text-white hover:bg-brand-800 dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200"
            : tone === "secondary"
            ? "border-border bg-surface hover:bg-surface-2"
            : "border-transparent bg-transparent text-text-mute hover:bg-surface-2";
    const subtitleClass =
        tone === "primary"
            ? "mt-1 text-sm text-white/85 dark:text-brand-900/75"
            : "mt-1 text-sm text-text-mute";
    return (
        <Link href={href} className={`${base} ${toneClass}`}>
            <div className="text-base font-semibold">{title}</div>
            <div className={subtitleClass}>{subtitle}</div>
        </Link>
    );
}

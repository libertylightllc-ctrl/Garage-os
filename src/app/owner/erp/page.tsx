// Owner surface for ERPNext sync — flag toggle, summary counts,
// dead-letter list with Replay, recent failures.
//
// OWNER-only per the master/owner boundary — finance + admin, not
// operational floor. See src/lib/__tests__/master-owner-boundary.test.ts.
//
// No cursor edit, no manual override on entity-map rows. Those
// are runtime state; touching them from the UI is a Phase-N later
// decision if it becomes necessary.

import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { getSyncSummary } from "@/lib/erp-sync/status";
import {
    enableErpSyncAction,
    disableErpSyncAction,
    replayErpSyncJobAction,
    resetErpSyncCursorAction,
} from "@/app/actions/erp-sync";

export const dynamic = "force-dynamic";

export default async function OwnerErpPage({
    searchParams,
}: {
    searchParams: Promise<{ err?: string; status?: string }>;
}) {
    const session = await requireRole("OWNER");
    const user = session.user;
    const { err, status } = await searchParams;

    const garage = await prisma.garage.findUniqueOrThrow({
        where: { id: user.garageId },
        select: {
            id: true,
            name: true,
            erpSyncEnabled: true,
        },
    });
    const cursor = await prisma.erpSyncCursor.findUnique({
        where: { garageId: garage.id },
        select: { lastLedgerCreatedAt: true, lastLedgerId: true, updatedAt: true },
    });
    const summary = await getSyncSummary(garage.id);

    // Dead-letter + recent failed jobs — capped small so the page
    // stays readable when the queue backs up.
    const deadLetters = await prisma.erpSyncJob.findMany({
        where: { garageId: garage.id, status: "DEAD_LETTER" },
        orderBy: { updatedAt: "desc" },
        take: 20,
    });
    const failures = await prisma.erpSyncJob.findMany({
        where: { garageId: garage.id, status: "FAILED" },
        orderBy: { updatedAt: "desc" },
        take: 20,
    });

    return (
        <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight">
                    ERPNext sync
                </h1>
                <p className="text-sm text-text-mute">
                    One-way push of your ledger into ERPNext. GarageOS stays the source of truth.
                </p>
            </header>

            {err ? <ErrorBanner err={err} status={status} /> : null}

            {/* Enable / disable */}
            <section className="rounded-xl border border-border p-4">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <div className="text-sm text-text-mute">Status</div>
                        <div className="mt-0.5 flex items-center gap-2 text-lg font-semibold">
                            <span
                                className={`inline-block h-2.5 w-2.5 rounded-full ${
                                    garage.erpSyncEnabled ? "bg-emerald-500" : "bg-zinc-400"
                                }`}
                                aria-hidden
                            />
                            {garage.erpSyncEnabled ? "On" : "Off"}
                        </div>
                    </div>
                    {garage.erpSyncEnabled ? (
                        <form action={disableErpSyncAction}>
                            <button
                                className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-surface-2"
                                type="submit"
                            >
                                Turn off
                            </button>
                        </form>
                    ) : (
                        <EnableForm />
                    )}
                </div>
                {garage.erpSyncEnabled ? (
                    <div className="mt-3 flex items-start justify-between gap-3 text-xs text-text-mute">
                        <div>
                            {cursor ? (
                                <>
                                    Cursor last advanced{" "}
                                    <span className="tabular-nums">
                                        {cursor.updatedAt.toISOString()}
                                    </span>{" "}
                                    to ledger row created{" "}
                                    <span className="tabular-nums">
                                        {cursor.lastLedgerCreatedAt.toISOString()}
                                    </span>
                                    .
                                </>
                            ) : (
                                <>Cursor missing — the tailer will skip this garage. Turn sync off and back on to reseed.</>
                            )}
                        </div>
                        {/* Reset cursor to now — the recovery path for
                            a cursor seeded to a past date by accident
                            (2026-08-27 incident). Wipes and recreates
                            the row at now(); sync stays on. */}
                        <form action={resetErpSyncCursorAction}>
                            <button
                                className="whitespace-nowrap rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-surface-2"
                                type="submit"
                                title="Delete the current cursor and seed a fresh one at now. Skips every ledger row created before this moment. Use when the cursor was accidentally seeded to a past date."
                            >
                                Reset cursor to now
                            </button>
                        </form>
                    </div>
                ) : (
                    <div className="mt-3 text-xs text-text-mute">
                        Turning on will queue new ledger events for push, starting from the moment you flip the switch. Historical events are NOT backfilled unless you tick "Backfill from a past date" below.
                    </div>
                )}
            </section>

            {/* Summary counts */}
            <section className="grid grid-cols-2 gap-2 md:grid-cols-5">
                <StatCard label="Pending" value={summary.pending} tone="amber" />
                <StatCard label="Running" value={summary.running} tone="amber" />
                <StatCard label="Synced" value={summary.synced} tone="green" />
                <StatCard label="Failed" value={summary.failed} tone="red" />
                <StatCard label="Dead-lettered" value={summary.deadLettered} tone="red" />
            </section>

            {deadLetters.length > 0 ? (
                <JobList
                    title="Dead-lettered"
                    subtitle="Exhausted retries. Replay resets to Pending; the pre-flight check prevents duplicates on ERPNext side."
                    jobs={deadLetters}
                />
            ) : null}

            {failures.length > 0 ? (
                <JobList
                    title="Failed"
                    subtitle="Recent failures still under automatic retry. Manual replay clears the attempt counter."
                    jobs={failures}
                />
            ) : null}

            {deadLetters.length === 0 && failures.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-mute">
                    No failed or dead-lettered jobs. Everything either synced or is on its way.
                </p>
            ) : null}
        </main>
    );
}

/**
 * Enable-form with checkbox-gated backfill picker. Server-only, no
 * client JS — the datetime-local input stays in the DOM but is
 * visually hidden until the checkbox is ticked (Tailwind `peer` +
 * `peer-checked:` on a sibling wrapper). The server-side gate in
 * enableErpSyncAction (`backfill === "1"`) is the load-bearing
 * safety: the input's value is IGNORED unless the checkbox is
 * ticked, so a browser-autofilled picker value cannot silently
 * become the cursor's start position.
 */
function EnableForm() {
    // `group` on the form + `group-has-[input[name=backfill]:checked]`
    // on the picker div: pure CSS reveal, no client JS. The picker
    // stays in the DOM (so its value CAN be sent), but the server
    // gate (backfill=1) means the value is only READ when the
    // checkbox is ticked — the important safety.
    return (
        <form action={enableErpSyncAction} className="group flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-text-mute">
                    <input
                        type="checkbox"
                        name="backfill"
                        value="1"
                        className="h-3 w-3"
                    />
                    Backfill from a past date
                </label>
                <button
                    className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-white dark:text-black"
                    type="submit"
                >
                    Turn on
                </button>
            </div>
            <div className="hidden flex-col items-end gap-1 group-has-[input[name=backfill]:checked]:flex">
                <input
                    type="datetime-local"
                    name="startAt"
                    autoComplete="off"
                    title="Interpreted as UTC. Sync will pick up ledger rows created strictly after this moment."
                    className="rounded-md border border-border bg-transparent px-2 py-1.5 text-sm"
                />
                <span className="text-xs text-text-mute">
                    Interpreted as UTC. Backfill will queue every ledger event after this moment for push to ERPNext.
                </span>
            </div>
        </form>
    );
}

function ErrorBanner({ err, status }: { err: string; status?: string }) {
    const messages: Record<string, string> = {
        "bad-startat": "Tick 'Backfill from a past date' and pick a time, or turn on without ticking to start from now.",
        "no-job": "No job id was supplied to Replay.",
        "not-found": "That job isn't in this garage — someone else's dashboard or a deleted job.",
        "not-replayable": `Only Failed or Dead-lettered jobs can be replayed. That job is ${status ?? "in some other state"}.`,
    };
    const msg = messages[err] ?? "Something went wrong. Reload the page and try again.";
    return (
        <div
            role="alert"
            className="rounded-lg border border-red-500/30 bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-500"
        >
            {msg}
        </div>
    );
}

function StatCard({
    label,
    value,
    tone,
}: {
    label: string;
    value: number;
    tone: "green" | "amber" | "red";
}) {
    const toneCls =
        tone === "green"
            ? "text-emerald-700 dark:text-emerald-400"
            : tone === "amber"
              ? "text-amber-700 dark:text-amber-400"
              : "text-red-700 dark:text-red-400";
    return (
        <div className="rounded-lg border border-border p-3">
            <div className="text-xs text-text-mute">{label}</div>
            <div className={`mt-0.5 text-2xl font-semibold tabular-nums ${toneCls}`}>
                {value}
            </div>
        </div>
    );
}

function JobList({
    title,
    subtitle,
    jobs,
}: {
    title: string;
    subtitle: string;
    jobs: Array<{
        id: string;
        op: string;
        sourceType: string;
        sourceId: string;
        attempts: number;
        lastError: string | null;
        lastErrorField: string | null;
        updatedAt: Date;
    }>;
}) {
    return (
        <section>
            <div className="mb-2">
                <h2 className="text-base font-semibold">{title}</h2>
                <p className="text-xs text-text-mute">{subtitle}</p>
            </div>
            <div className="flex flex-col gap-2">
                {jobs.map((j) => (
                    <div
                        key={j.id}
                        className="rounded-lg border border-border p-3"
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium">
                                    {j.op}{" "}
                                    <span className="font-normal text-text-mute">
                                        · {j.sourceType} · {j.sourceId.slice(0, 24)}
                                    </span>
                                </div>
                                <div className="mt-0.5 text-xs text-text-mute">
                                    {j.attempts} attempts · last{" "}
                                    <span className="tabular-nums">
                                        {j.updatedAt.toISOString()}
                                    </span>
                                    {j.lastErrorField ? (
                                        <>
                                            {" "}· failing field:{" "}
                                            <span className="font-mono">{j.lastErrorField}</span>
                                        </>
                                    ) : null}
                                </div>
                                {j.lastError ? (
                                    <pre className="mt-2 max-h-24 overflow-y-auto rounded bg-surface-2 p-2 text-xs whitespace-pre-wrap">
                                        {j.lastError}
                                    </pre>
                                ) : null}
                            </div>
                            <form action={replayErpSyncJobAction}>
                                <input type="hidden" name="jobId" value={j.id} />
                                <button
                                    className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
                                    type="submit"
                                >
                                    Replay
                                </button>
                            </form>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}

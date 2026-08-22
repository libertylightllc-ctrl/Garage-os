"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Client-side "load parts from a job" hydrator for the new-quotation
 * form (AR 2026-08-22 Batch 9).
 *
 * Removes the two-screen flow (was: /owner/purchasing/new → create
 * empty shell → then either /owner/purchasing/from-estimate or the
 * detail page's Add-line form). Now: the owner types a JC# on
 * /owner/purchasing/new, taps Load, the tech's requested parts land
 * in an editable table below, and Create quotation posts the PO +
 * lines in one action.
 *
 * Behaviour rules the spec pinned:
 *   1. A tech's PartRequest carries through even without an estimate —
 *      the API route filters PartRequest rows directly, no estimate
 *      dependency.
 *   2. Bad JC# → visible red chip, never silent. "not found" and
 *      "found but no open requests" are DIFFERENT messages; a shop
 *      with a real job that happens to have zero requests shouldn't
 *      read as "you typed the wrong number."
 *   3. Manual entry preserved — hydrated rows are editable, removable,
 *      and the operator can still add more lines on the detail page
 *      after creation.
 *
 * Vehicle fill: on match, this component sets values directly on
 * the sibling form's vehicle inputs by `name=` and dispatches native
 * `input` events. The VehicleMatchFill component watches its plate
 * and JC# inputs for input events, so simply setting the JC# input
 * value + firing an input event triggers its own fetch-and-fill
 * path — which is what already carries the "don't overwrite what
 * the user typed" rule, the vehicle match chip, and the dismissable
 * cross-fill of make/model/year/engine/VIN. Zero cross-component
 * coupling; the hydrator just prods the input the operator would
 * otherwise have typed.
 */

interface Props {
    label: string;
    inputLabel: string;
    inputPlaceholder: string;
    loadLabel: string;
    loadingLabel: string;
    clearLabel: string;
    /** e.g. "Loaded {count} parts from JC-{number} — {vehicle}" */
    loadedFormat: string;
    /** e.g. "Job card #{n} not found in this garage." */
    notFoundFormat: string;
    /** e.g. "JC-{n} has no open part requests. Add lines by hand below." */
    emptyFormat: string;
    /** e.g. "Load failed. Please try again." */
    genericErrorFormat: string;
    tableHeaders: {
        description: string;
        qty: string;
        remove: string;
    };
}

interface HydratedLine {
    description: string;
    qty: number;
    partId: string | null;
}

interface HydratedJob {
    jobCardId: string;
    jobNumber: number;
    vehicleLabel: string;
    parts: HydratedLine[];
}

type Status =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "loaded"; job: HydratedJob }
    | { kind: "not-found"; number: number }
    | { kind: "empty"; number: number; vehicleLabel: string }
    | { kind: "error"; message: string };

export function HydrateLinesFromJob(props: Props) {
    const {
        label,
        inputLabel,
        inputPlaceholder,
        loadLabel,
        loadingLabel,
        clearLabel,
        loadedFormat,
        notFoundFormat,
        emptyFormat,
        genericErrorFormat,
        tableHeaders,
    } = props;

    const [rawInput, setRawInput] = useState("");
    const [status, setStatus] = useState<Status>({ kind: "idle" });
    const [lines, setLines] = useState<HydratedLine[]>([]);
    const abortRef = useRef<AbortController | null>(null);

    // Cancel any in-flight fetch on unmount so a slow response from a
    // stale mount can't race-set state on a fresh mount.
    useEffect(() => {
        return () => abortRef.current?.abort();
    }, []);

    const load = async () => {
        const trimmed = rawInput.trim();
        if (!trimmed) return;
        const parsed = Number.parseInt(trimmed, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) return;

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        setStatus({ kind: "loading" });
        try {
            const res = await fetch(
                `/api/jobs/by-number/${parsed}/part-requests`,
                { signal: controller.signal, cache: "no-store" },
            );
            if (res.status === 404) {
                setStatus({ kind: "not-found", number: parsed });
                setLines([]);
                return;
            }
            if (!res.ok) {
                setStatus({ kind: "error", message: genericErrorFormat });
                return;
            }
            const data: {
                jobCardId: string;
                jobNumber: number;
                vehicle: {
                    id: string;
                    make: string | null;
                    model: string | null;
                    year: number | null;
                    plate: string | null;
                    vin: string | null;
                    engineSize: string | null;
                    fuelType: string | null;
                } | null;
                parts: HydratedLine[];
            } = await res.json();

            const vehicleLabel = data.vehicle
                ? [
                      data.vehicle.make,
                      data.vehicle.model,
                      data.vehicle.year ? `(${data.vehicle.year})` : null,
                      data.vehicle.plate ? `· ${data.vehicle.plate}` : null,
                  ]
                      .filter(Boolean)
                      .join(" ")
                : "";

            // Prod the sibling VehicleMatchFill via its JC# input:
            // set the value + dispatch a native input event so
            // VehicleMatchFill's own change handler fires its
            // fetch-and-fill path (identical to the operator typing
            // the number). No cross-component coupling.
            if (typeof document !== "undefined" && data.vehicle) {
                const jobEl = document.querySelector<HTMLInputElement>(
                    'input[name="vehicle_jobNumber"]',
                );
                if (jobEl) {
                    // React overrides the setter on input.value; use
                    // the native setter so the event picks up the
                    // change (React uses value tracker to skip events
                    // that don't change it, but setting via native
                    // setter forces the tracker to re-sync).
                    const proto = Object.getPrototypeOf(jobEl) as {
                        constructor: { prototype: HTMLInputElement };
                    };
                    const desc = Object.getOwnPropertyDescriptor(
                        proto.constructor.prototype,
                        "value",
                    );
                    desc?.set?.call(jobEl, String(data.jobNumber));
                    jobEl.dispatchEvent(new Event("input", { bubbles: true }));
                    jobEl.dispatchEvent(new Event("change", { bubbles: true }));
                }
            }

            if (data.parts.length === 0) {
                setStatus({
                    kind: "empty",
                    number: parsed,
                    vehicleLabel,
                });
                setLines([]);
                return;
            }

            setStatus({
                kind: "loaded",
                job: {
                    jobCardId: data.jobCardId,
                    jobNumber: data.jobNumber,
                    vehicleLabel,
                    parts: data.parts,
                },
            });
            setLines(data.parts);
        } catch (e) {
            // AbortError is expected on rapid retype; suppress.
            if ((e as { name?: string }).name === "AbortError") return;
            setStatus({ kind: "error", message: genericErrorFormat });
        }
    };

    const clear = () => {
        abortRef.current?.abort();
        setStatus({ kind: "idle" });
        setLines([]);
        setRawInput("");
    };

    const format = (template: string, vars: Record<string, string | number>) =>
        template.replace(/\{(\w+)\}/g, (_, k) =>
            k in vars ? String(vars[k]) : `{${k}}`,
        );

    const removeLine = (idx: number) => {
        setLines((prev) => prev.filter((_, i) => i !== idx));
    };

    const setLineField = (
        idx: number,
        field: "description" | "qty",
        value: string,
    ) => {
        setLines((prev) =>
            prev.map((l, i) => {
                if (i !== idx) return l;
                if (field === "qty") {
                    const n = Number.parseInt(value, 10);
                    return { ...l, qty: Number.isFinite(n) && n > 0 ? n : 1 };
                }
                return { ...l, description: value };
            }),
        );
    };

    const showTable = status.kind === "loaded" && lines.length > 0;

    return (
        <fieldset className="flex flex-col gap-3 rounded-lg border border-brand-300/60 bg-brand-50/40 p-3 dark:border-brand-800/50 dark:bg-brand-950/30">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
                {label}
            </legend>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex flex-1 flex-col gap-1">
                    <span className="text-xs text-muted-foreground">{inputLabel}</span>
                    <input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        autoComplete="off"
                        placeholder={inputPlaceholder}
                        value={rawInput}
                        onChange={(e) => setRawInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                // Prevent the outer form submit — Enter
                                // in this field means "look up," not
                                // "create the whole PO."
                                e.preventDefault();
                                load();
                            }
                        }}
                        className="rounded-md border border-border bg-transparent px-3 py-2 text-sm tabular-nums"
                    />
                </label>
                <button
                    type="button"
                    onClick={load}
                    disabled={status.kind === "loading" || rawInput.trim() === ""}
                    className="inline-flex h-9 items-center justify-center rounded-md bg-brand-600 px-3 text-sm font-semibold text-white disabled:opacity-50 hover:bg-brand-700"
                >
                    {status.kind === "loading" ? loadingLabel : loadLabel}
                </button>
                {(status.kind === "loaded" ||
                    status.kind === "empty" ||
                    status.kind === "not-found" ||
                    status.kind === "error") ? (
                    <button
                        type="button"
                        onClick={clear}
                        className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-sm text-muted-foreground hover:text-foreground"
                    >
                        {clearLabel}
                    </button>
                ) : null}
            </div>

            {status.kind === "loaded" ? (
                <p className="rounded-md border border-emerald-300/60 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-200">
                    ✓{" "}
                    {format(loadedFormat, {
                        count: lines.length,
                        number: `JC-${status.job.jobNumber}`,
                        vehicle: status.job.vehicleLabel,
                    })}
                </p>
            ) : null}
            {status.kind === "not-found" ? (
                <p
                    role="alert"
                    className="rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800/50 dark:bg-rose-950/30 dark:text-rose-200"
                >
                    ⚠️ {format(notFoundFormat, { n: status.number })}
                </p>
            ) : null}
            {status.kind === "empty" ? (
                <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200">
                    ℹ️ {format(emptyFormat, { n: status.number })}
                </p>
            ) : null}
            {status.kind === "error" ? (
                <p
                    role="alert"
                    className="rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800/50 dark:bg-rose-950/30 dark:text-rose-200"
                >
                    ⚠️ {status.message}
                </p>
            ) : null}

            {showTable ? (
                <div className="overflow-hidden rounded-md border border-border bg-surface">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2">{tableHeaders.description}</th>
                                <th className="px-3 py-2 text-right">{tableHeaders.qty}</th>
                                <th className="px-3 py-2 w-16"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {lines.map((l, i) => (
                                <tr key={i}>
                                    <td className="px-3 py-2">
                                        <input
                                            type="text"
                                            name={`line_${i}_description`}
                                            required
                                            value={l.description}
                                            onChange={(e) =>
                                                setLineField(i, "description", e.target.value)
                                            }
                                            className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                                        />
                                        {l.partId ? (
                                            <input
                                                type="hidden"
                                                name={`line_${i}_partId`}
                                                value={l.partId}
                                            />
                                        ) : null}
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        <input
                                            type="number"
                                            name={`line_${i}_qty`}
                                            min="1"
                                            step="1"
                                            required
                                            value={l.qty}
                                            onChange={(e) =>
                                                setLineField(i, "qty", e.target.value)
                                            }
                                            className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-right text-sm tabular-nums"
                                        />
                                    </td>
                                    <td className="px-3 py-2 text-right">
                                        <button
                                            type="button"
                                            onClick={() => removeLine(i)}
                                            className="text-xs text-muted-foreground hover:text-rose-700"
                                            title={tableHeaders.remove}
                                        >
                                            ✕
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}
        </fieldset>
    );
}

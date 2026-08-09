"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Client-side match preview for the purchasing vehicle widgets.
 *
 * Two ways to identify the car:
 *   - Plate (calls /api/vehicles/by-plate)
 *   - Job card number (calls /api/vehicles/by-job)
 *
 * Both feed the same "matched garage record" chip + autofill of the
 * make/model/year/engine/VIN inputs, plus the OTHER identifier
 * (typing a JC# fills the plate; typing a plate fills the JC#).
 * Rules unchanged from the plate-only version:
 *
 *   1. Debounced fetch on input (250ms), immediate on change.
 *   2. Match → chip + autofill blank sibling inputs (never overwrite
 *      a value the user typed).
 *   3. Tracks which inputs THIS component filled (`data-vmf-filled`).
 *      A manual edit strips the flag so Dismiss leaves the user's
 *      value alone.
 *   4. Dismiss / no-match / cleared identifier → clear the
 *      still-flagged fields only.
 *
 * `jobNumberName` is optional so surfaces that don't want the JC#
 * path (there aren't any today, but future ones might) can leave it
 * off with no behavioural change.
 */
interface Props {
    /** name= on the plate input (usually `vehicle_plate`). */
    plateName: string;
    /** name= on the job-number input (usually `vehicle_jobNumber`). */
    jobNumberName?: string;
    /** name=s of the other vehicle inputs to auto-populate on match. */
    makeName: string;
    modelName: string;
    yearName: string;
    engineName: string;
    vinName: string;
    labels: {
        matchedLabel: string;
        dismissLabel: string;
        vinLabel: string;
    };
}

interface MatchPayload {
    id: string;
    make: string | null;
    model: string | null;
    year: number | null;
    plate: string;
    vin: string | null;
    engineSize: string | null;
    fuelType: string | null;
    jobNumber?: number | null;
}

const FILLED_FLAG = "data-vmf-filled";

type LookupSource = "plate" | "job";

export function VehicleMatchFill({
    plateName,
    jobNumberName,
    makeName,
    modelName,
    yearName,
    engineName,
    vinName,
    labels,
}: Props) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [match, setMatch] = useState<MatchPayload | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    // Track the most-recently-queried value per source so a redundant
    // keystroke doesn't fire another fetch.
    const lastQueriedRef = useRef<{ plate: string; job: string }>({
        plate: "",
        job: "",
    });

    function findForm(): HTMLFormElement | null {
        return rootRef.current?.closest("form") ?? null;
    }
    function findInput(name: string): HTMLInputElement | null {
        const form = findForm();
        if (!form) return null;
        return form.querySelector<HTMLInputElement>(`[name="${name}"]`);
    }

    // Every sibling input we may fill. Includes the OTHER identifier
    // (plate when the match came from job#, and vice versa) so a
    // dismiss covers everything the match populated.
    function fillableNames(): string[] {
        const names = [makeName, modelName, yearName, engineName, vinName, plateName];
        if (jobNumberName) names.push(jobNumberName);
        return names;
    }

    // Programmatic writes MUST NOT dispatch input events — the sibling
    // `input` listener strips the FILLED_FLAG on any input event, and
    // we'd end up wiping our own flag the instant we set it (so
    // Dismiss then couldn't tell which fields it had populated).
    function fillIfBlank(name: string, value: string | null) {
        const el = findInput(name);
        if (!el || value == null || value === "") return;
        if (el.value.trim() !== "") return;
        el.value = value;
        el.setAttribute(FILLED_FLAG, "1");
    }
    function clearIfFilledByMe(name: string) {
        const el = findInput(name);
        if (!el) return;
        if (el.getAttribute(FILLED_FLAG) !== "1") return;
        el.value = "";
        el.removeAttribute(FILLED_FLAG);
    }

    function applyMatch(m: MatchPayload) {
        setMatch(m);
        fillIfBlank(makeName, m.make);
        fillIfBlank(modelName, m.model);
        fillIfBlank(yearName, m.year != null ? String(m.year) : null);
        fillIfBlank(engineName, m.engineSize);
        fillIfBlank(vinName, m.vin);
        // Cross-fill the other identifier so an operator who typed
        // JC# sees the plate come back too, and vice versa. Both feed
        // the server's snapshot columns.
        fillIfBlank(plateName, m.plate);
        if (jobNumberName && m.jobNumber != null) {
            fillIfBlank(jobNumberName, String(m.jobNumber));
        }
    }

    function clearAllFilled() {
        fillableNames().forEach(clearIfFilledByMe);
    }

    async function lookup(source: LookupSource, raw: string) {
        const trimmed = raw.trim();
        if (!trimmed) {
            // Cleared input: drop chip only if the OTHER input is also
            // empty; otherwise we're mid-edit and the OTHER identifier
            // may still be a live match. Simpler rule: any clear drops
            // the chip; user re-types the still-set field to resurface.
            setMatch(null);
            clearAllFilled();
            lastQueriedRef.current[source] = "";
            return;
        }
        if (trimmed === lastQueriedRef.current[source]) return;
        lastQueriedRef.current[source] = trimmed;
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        const endpoint =
            source === "plate"
                ? `/api/vehicles/by-plate?plate=${encodeURIComponent(trimmed)}`
                : `/api/vehicles/by-job?number=${encodeURIComponent(trimmed)}`;
        try {
            const resp = await fetch(endpoint, {
                signal: ctrl.signal,
                cache: "no-store",
            });
            if (!resp.ok) return;
            const data = (await resp.json()) as { match: MatchPayload | null };
            // If the user's typed value changed while we were fetching,
            // discard this stale response.
            const currentValue =
                source === "plate"
                    ? findInput(plateName)?.value.trim() ?? ""
                    : (jobNumberName && findInput(jobNumberName)?.value.trim()) ?? "";
            if (currentValue !== trimmed) return;
            if (data.match) {
                applyMatch(data.match);
            } else {
                // Typed identifier didn't match: drop any chip + clear
                // fields we'd filled from a previous match.
                setMatch(null);
                clearAllFilled();
            }
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") return;
            // eslint-disable-next-line no-console
            console.warn("[vehicle-match-fill] lookup failed", err);
        }
    }

    useEffect(() => {
        const plateEl = findInput(plateName);
        const jobEl = jobNumberName ? findInput(jobNumberName) : null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const debounced = (fn: () => void) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(fn, 250);
        };

        const onPlateInput = () => debounced(() => lookup("plate", plateEl!.value));
        const onPlateChange = () => {
            if (timer) clearTimeout(timer);
            lookup("plate", plateEl!.value);
        };
        const onJobInput = () => debounced(() => lookup("job", jobEl!.value));
        const onJobChange = () => {
            if (timer) clearTimeout(timer);
            lookup("job", jobEl!.value);
        };

        if (plateEl) {
            plateEl.addEventListener("input", onPlateInput);
            plateEl.addEventListener("change", onPlateChange);
        }
        if (jobEl) {
            jobEl.addEventListener("input", onJobInput);
            jobEl.addEventListener("change", onJobChange);
        }

        // Strip the "filled by me" flag on manual edit so Dismiss
        // preserves the user's value. Applies to every field we might
        // have populated — including the cross-filled identifier.
        const siblings = fillableNames()
            .map(findInput)
            .filter((el): el is HTMLInputElement => el != null);
        const onSiblingInput = (ev: Event) => {
            const el = ev.currentTarget as HTMLInputElement;
            el.removeAttribute(FILLED_FLAG);
        };
        siblings.forEach((el) => el.addEventListener("input", onSiblingInput));

        return () => {
            if (plateEl) {
                plateEl.removeEventListener("input", onPlateInput);
                plateEl.removeEventListener("change", onPlateChange);
            }
            if (jobEl) {
                jobEl.removeEventListener("input", onJobInput);
                jobEl.removeEventListener("change", onJobChange);
            }
            siblings.forEach((el) =>
                el.removeEventListener("input", onSiblingInput),
            );
            if (timer) clearTimeout(timer);
            abortRef.current?.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function onDismiss() {
        setMatch(null);
        clearAllFilled();
        // Reset both last-queried caches so re-typing the same value
        // triggers a fresh fetch (otherwise the debounce would treat
        // "same input" as no-op and never resurface the chip).
        lastQueriedRef.current = { plate: "", job: "" };
    }

    const chipBits: string[] = [];
    if (match) {
        const mmy = [
            match.make,
            match.model,
            match.year != null ? String(match.year) : null,
        ]
            .filter((s): s is string => Boolean(s))
            .join(" ");
        if (mmy) chipBits.push(mmy);
        if (match.engineSize) chipBits.push(match.engineSize);
        if (match.plate) chipBits.push(match.plate);
        if (match.vin) chipBits.push(`${labels.vinLabel} ${match.vin}`);
        if (match.jobNumber != null) chipBits.push(`JC-${match.jobNumber}`);
    }

    return (
        <div ref={rootRef}>
            {match ? (
                <div
                    role="status"
                    className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-md border border-info-500/40 bg-info-50 px-3 py-1.5 text-xs text-info-700 dark:border-info-500/30 dark:bg-info-500/10 dark:text-info-500"
                >
                    <span>
                        <span className="font-medium">{labels.matchedLabel}</span>{" "}
                        {chipBits.join(" · ")}
                    </span>
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="rounded border border-info-500/40 bg-transparent px-2 py-0.5 text-xs font-medium text-info-700 hover:bg-info-500/10 dark:border-info-500/40 dark:text-info-500"
                    >
                        {labels.dismissLabel}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

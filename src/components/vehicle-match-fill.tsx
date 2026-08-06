"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Client-side plate-match preview for the purchasing vehicle widgets.
 *
 * Behaviour — enforces the "blank means blank" rule from the vehicle
 * autofill spec:
 *
 *   1. Watches the plate input. When the user stops typing (250ms
 *      debounce) or a datalist option is picked, fetches
 *      /api/vehicles/by-plate?plate=… scoped to the caller's garage.
 *
 *   2. On match: shows a small chip naming what was matched
 *      (make / model / year / engine · VIN) + a Dismiss button, and
 *      auto-populates ONLY the blank sibling inputs (make, model, year,
 *      engine, VIN). Fields the operator already typed are NEVER
 *      overwritten by the match.
 *
 *   3. Tracks which inputs THIS component filled (per-input `data-*`
 *      flag). Dismiss clears just those — anything the user typed
 *      themselves survives. Manually editing an autofilled input strips
 *      its "filled by me" flag so a later Dismiss can't wipe the user's
 *      edit.
 *
 *   4. On no-match / empty plate: chip hides, previously-filled inputs
 *      are cleared. What the user typed is untouched.
 *
 * The server-side `parseVehicleFormFields` no longer autofills from a
 * plate match — the whole preview + edit + submit round-trip runs in
 * the browser, and the server takes the form fields verbatim. That is
 * what makes "leave VIN blank → line stores no VIN" a real invariant:
 * nothing between the browser and the DB substitutes a value.
 *
 * Props are the input `name`s (not element refs) so the component works
 * inside plain `<form action=...>` markup without needing controlled
 * inputs. Sibling inputs are found by `[name="…"]` scoped to the same
 * closest `<form>`, matching the shape the purchasing pages already
 * render.
 */
interface Props {
    /** name= on the plate input (usually `vehicle_plate`). */
    plateName: string;
    /** name=s of the other vehicle inputs to auto-populate on match. */
    makeName: string;
    modelName: string;
    yearName: string;
    engineName: string;
    vinName: string;
    /** Localised labels. */
    labels: {
        /** "Matched garage record:" */
        matchedLabel: string;
        /** "Dismiss" */
        dismissLabel: string;
        /** "VIN" prefix inside the chip (matches the input label). */
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
}

const FILLED_FLAG = "data-vmf-filled";

export function VehicleMatchFill({
    plateName,
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
    const lastQueriedRef = useRef<string>("");

    // Find the plate input in the enclosing form so the component can
    // wire up without prop drilling refs from the server-rendered
    // markup. Scope every sibling query the same way.
    function findForm(): HTMLFormElement | null {
        return rootRef.current?.closest("form") ?? null;
    }
    function findInput(name: string): HTMLInputElement | null {
        const form = findForm();
        if (!form) return null;
        return form.querySelector<HTMLInputElement>(`[name="${name}"]`);
    }

    // Auto-populate a blank sibling input with the matched value and
    // flag it so Dismiss knows this component owns the change. If the
    // input already has a value the user typed, we leave it alone —
    // that is the "never overwrite" rule.
    // Programmatic writes (fill on match, clear on dismiss) MUST NOT
    // dispatch input events — the sibling `input` listener below
    // strips the FILLED_FLAG on any input event, and we'd end up
    // wiping our own flag the instant we set it (so Dismiss then
    // couldn't tell which fields it had populated). The unsaved-
    // changes guard on the enclosing form is fine to skip for
    // autofills: those aren't user changes and shouldn't count
    // toward "you have unsaved edits."
    function fillIfBlank(name: string, value: string | null) {
        const el = findInput(name);
        if (!el || value == null || value === "") return;
        if (el.value.trim() !== "") return;
        el.value = value;
        el.setAttribute(FILLED_FLAG, "1");
    }
    // Clear only inputs THIS component populated. If the user edited
    // an autofilled field, that field's flag has been stripped by the
    // change listener below, so it survives dismiss.
    function clearIfFilledByMe(name: string) {
        const el = findInput(name);
        if (!el) return;
        if (el.getAttribute(FILLED_FLAG) !== "1") return;
        el.value = "";
        el.removeAttribute(FILLED_FLAG);
    }

    // Fetch a match for the current plate value. Debounced by the
    // caller (via the setTimeout in the input listener).
    async function lookup(plate: string) {
        const trimmed = plate.trim();
        if (!trimmed) {
            // Cleared plate: drop any chip and clear the fields WE
            // populated (user-typed values survive).
            setMatch(null);
            [makeName, modelName, yearName, engineName, vinName].forEach(
                clearIfFilledByMe,
            );
            lastQueriedRef.current = "";
            return;
        }
        // Skip a redundant round trip when the user typed something new
        // but the trimmed value hasn't changed since the last fetch.
        if (trimmed === lastQueriedRef.current) return;
        lastQueriedRef.current = trimmed;
        // Abort any in-flight fetch — the newest keystroke wins.
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
            const resp = await fetch(
                `/api/vehicles/by-plate?plate=${encodeURIComponent(trimmed)}`,
                { signal: ctrl.signal, cache: "no-store" },
            );
            if (!resp.ok) return;
            const data = (await resp.json()) as { match: MatchPayload | null };
            // If the user's typed plate changed while we were fetching,
            // discard this stale response.
            const currentPlate = findInput(plateName)?.value.trim() ?? "";
            if (currentPlate !== trimmed) return;
            setMatch(data.match);
            if (data.match) {
                fillIfBlank(makeName, data.match.make);
                fillIfBlank(modelName, data.match.model);
                fillIfBlank(
                    yearName,
                    data.match.year != null ? String(data.match.year) : null,
                );
                fillIfBlank(engineName, data.match.engineSize);
                fillIfBlank(vinName, data.match.vin);
            } else {
                // Plate typed but not a garage record: clear any
                // previously-filled fields (from an earlier match).
                [makeName, modelName, yearName, engineName, vinName].forEach(
                    clearIfFilledByMe,
                );
            }
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") return;
            // Network hiccup: leave the form as-is. Server-side submit
            // still works — this is a UX affordance, not a data path.
            // eslint-disable-next-line no-console
            console.warn("[vehicle-match-fill] lookup failed", err);
        }
    }

    // Wire input listeners on mount. Kept in an effect so the plate
    // input rendered by the server is picked up after hydration.
    useEffect(() => {
        const plateEl = findInput(plateName);
        if (!plateEl) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onPlateInput = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => lookup(plateEl.value), 250);
        };
        // Datalist pick fires `change` immediately (no debounce needed).
        const onPlateChange = () => {
            if (timer) clearTimeout(timer);
            lookup(plateEl.value);
        };
        plateEl.addEventListener("input", onPlateInput);
        plateEl.addEventListener("change", onPlateChange);

        // Whenever the user edits an autofilled sibling, strip the
        // "filled by me" flag so Dismiss can't wipe their change.
        const siblings = [makeName, modelName, yearName, engineName, vinName]
            .map(findInput)
            .filter((el): el is HTMLInputElement => el != null);
        const onSiblingInput = (ev: Event) => {
            const el = ev.currentTarget as HTMLInputElement;
            el.removeAttribute(FILLED_FLAG);
        };
        siblings.forEach((el) => el.addEventListener("input", onSiblingInput));

        return () => {
            plateEl.removeEventListener("input", onPlateInput);
            plateEl.removeEventListener("change", onPlateChange);
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
        [makeName, modelName, yearName, engineName, vinName].forEach(
            clearIfFilledByMe,
        );
        // Clear the record so the same plate can re-fetch if the user
        // triggers another change — otherwise the debounce would treat
        // "same plate" as no-op and never resurface the chip.
        lastQueriedRef.current = "";
    }

    // The chip lists the matched vehicle in a single line — make model
    // year · engine · VIN — with nulls skipped. This is the "what did
    // it match" surface the operator was missing.
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
        if (match.vin) chipBits.push(`${labels.vinLabel} ${match.vin}`);
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

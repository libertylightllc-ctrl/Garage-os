"use client";

import { useState } from "react";

/**
 * Per-unlinked-PO-line receive mode picker (AR 2026-08-16).
 *
 * Renders under an unlinked PO line inside the receive form. Two
 * radios — Direct-fit (default) or Stock item — plus context-
 * dependent inputs and hints:
 *
 *   • Direct-fit selected (default): show cost input + optional
 *     part-number input. Both are what the server action reads
 *     from formData: `cost_<lineId>` and `partNo_<lineId>`.
 *   • Stock item selected: show a note that the line must be
 *     linked to a catalogue part on the line-edit form before it
 *     can enter stock. No inputs to fill here.
 *
 * Catalogue hint (when supplied): shown regardless of mode. Does
 * NOT change the default — the owner still decides. AR's rule
 * (2026-08-16): the safe default is Direct-fit so a shop never
 * accidentally fills the catalogue with duplicates; the hint
 * catches the genuine stock items without guessing.
 *
 * Client-only because the radio drives which sibling inputs
 * render — server RSC can't respond to a click without a form
 * submit round-trip.
 */

export interface ReceiveModeToggleProps {
    lineId: string;
    catalogueHint: {
        partName: string;
        partSku: string;
        label: string;
    } | null;
    labels: {
        directOption: string;
        directHelp: string;
        stockOption: string;
        stockHelp: string;
        costLabel: string;
        partNoLabel: string;
    };
    /** Pre-fill the cost input with the PO line's own unitCost when known. */
    defaultCost: string;
}

export function ReceiveModeToggle(props: ReceiveModeToggleProps) {
    const { lineId, catalogueHint, labels, defaultCost } = props;
    const [mode, setMode] = useState<"DIRECT" | "STOCK">("DIRECT");
    const nameMode = `mode_${lineId}`;
    const nameCost = `cost_${lineId}`;
    const namePartNo = `partNo_${lineId}`;

    return (
        <div className="mt-2 ms-2 rounded-md border border-border/60 bg-surface-2/50 px-3 py-2 text-xs">
            {catalogueHint ? (
                <p className="mb-2 text-warning-700 dark:text-warning-500">
                    💡 {catalogueHint.label}
                </p>
            ) : null}
            <div className="flex flex-col gap-1.5">
                <label className="flex items-start gap-2">
                    <input
                        type="radio"
                        name={nameMode}
                        value="DIRECT"
                        checked={mode === "DIRECT"}
                        onChange={() => setMode("DIRECT")}
                        className="mt-0.5"
                    />
                    <span>
                        <span className="font-medium">{labels.directOption}</span>
                        <span className="ms-2 text-muted-foreground">
                            {labels.directHelp}
                        </span>
                    </span>
                </label>
                <label className="flex items-start gap-2">
                    <input
                        type="radio"
                        name={nameMode}
                        value="STOCK"
                        checked={mode === "STOCK"}
                        onChange={() => setMode("STOCK")}
                        className="mt-0.5"
                    />
                    <span>
                        <span className="font-medium">{labels.stockOption}</span>
                        <span className="ms-2 text-muted-foreground">
                            {labels.stockHelp}
                        </span>
                    </span>
                </label>
            </div>
            {mode === "DIRECT" ? (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {labels.costLabel}
                        </span>
                        <input
                            type="number"
                            step="0.01"
                            min="0"
                            required
                            name={nameCost}
                            defaultValue={defaultCost}
                            className="w-28 rounded-md border border-border bg-transparent px-2 py-1 text-right text-sm tabular-nums"
                        />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {labels.partNoLabel}
                        </span>
                        <input
                            type="text"
                            name={namePartNo}
                            maxLength={64}
                            className="w-40 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                        />
                    </label>
                </div>
            ) : null}
        </div>
    );
}

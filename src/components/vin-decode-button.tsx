"use client";

import { useState } from "react";
import { isValidVin } from "@/lib/jobcard-fields";

/**
 * Client-side VIN decode trigger — slice intake-vin.
 *
 * Sits next to the VIN input on /advisor/jobs/new/confirm. When the
 * advisor taps "Decode VIN":
 *
 *   1. Read the current VIN from the form input (name="vin").
 *   2. Validate 17 chars (no I/O/Q) via isValidVin before sending —
 *      saves an unnecessary round trip.
 *   3. POST to /api/vin/decode. Server-side calls NHTSA with timeout.
 *   4. Merge non-blank fields back into the form, preserving any
 *      OCR / typed values that are already set (OCR is primary for
 *      UAE; VIN decode fills gaps + adds fuel type).
 *
 * Why a 'fill blanks only' rule: the advisor's intake flow often
 * starts with a Moulkia photo OCR that pre-populates make/model/year
 * already. NHTSA frequently returns "Not Applicable" / empty for
 * GCC-spec vehicles. Overwriting a known-good Toyota Land Cruiser
 * with a blank would be worse than doing nothing.
 *
 * Display: a small status line under the button (idle / loading /
 * success-with-found-fields / error). The advisor can edit any
 * decoded field afterward — the helper text says so explicitly.
 */

interface NhtsaResult {
  vin: string;
  make: string | null;
  model: string | null;
  year: string | null;
  fuelType: "PETROL" | "DIESEL" | "HYBRID" | "ELECTRIC" | "OTHER" | null;
  engine: string | null;
  errorCode: string | null;
  errorText: string | null;
}

export interface VinDecodeLabels {
  decodeBtn: string;
  decoding: string;
  invalidVin: string;
  notFound: string;
  networkError: string;
  decodedNote: string;
  filledFields: string;
}

export function VinDecodeButton({ labels }: { labels: VinDecodeLabels }) {
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "ok">("idle");
  const [message, setMessage] = useState<string>("");

  /**
   * Read the VIN out of the same form the button lives in (no prop
   * threading). Walk up to <form>, find the named input.
   * This component is rendered inside the intake <form> so document-
   * scoped name="vin" is safe (one intake form per page).
   */
  function readForm() {
    const form = document.querySelector("form") as HTMLFormElement | null;
    if (!form) return null;
    return form;
  }

  function getInput(name: string): HTMLInputElement | HTMLSelectElement | null {
    return document.querySelector(
      `form [name="${name}"]`,
    ) as HTMLInputElement | HTMLSelectElement | null;
  }

  function fillIfEmpty(name: string, value: string | null): boolean {
    if (!value) return false;
    const el = getInput(name);
    if (!el) return false;
    if (el.value && el.value.trim()) return false; // preserve OCR / typed
    el.value = value;
    // Synthesise an input event so any React-controlled siblings
    // (none here today, but defensive) pick up the change.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  async function onDecode() {
    const form = readForm();
    if (!form) return;
    const vinInput = getInput("vin") as HTMLInputElement | null;
    const vinRaw = vinInput?.value?.trim() ?? "";
    if (!isValidVin(vinRaw)) {
      setStatus("error");
      setMessage(labels.invalidVin);
      return;
    }
    setStatus("loading");
    setMessage("");
    try {
      const resp = await fetch("/api/vin/decode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vin: vinRaw }),
      });
      if (!resp.ok) {
        const j = (await resp.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        // 502 → NHTSA / timeout. 400 → invalid VIN (shouldn't fire,
        // we pre-validated). Anything else → generic network error.
        setMessage(resp.status === 502 ? labels.notFound : (j.error ?? labels.networkError));
        return;
      }
      const data = (await resp.json()) as NhtsaResult;
      const filled: string[] = [];
      if (fillIfEmpty("make", data.make)) filled.push("Make");
      if (fillIfEmpty("model", data.model)) filled.push("Model");
      if (fillIfEmpty("year", data.year)) filled.push("Year");
      if (fillIfEmpty("fuelType", data.fuelType)) filled.push("Fuel type");
      // 'engine' has no field on the form yet — exposed in the
      // success message so the advisor can capture it manually in
      // the complaint / notes if useful.
      if (filled.length === 0 && !data.engine) {
        setStatus("error");
        setMessage(labels.notFound);
        return;
      }
      setStatus("ok");
      setMessage(
        `${labels.filledFields}: ${filled.join(", ")}${data.engine ? ` · ${data.engine}` : ""}`,
      );
    } catch {
      setStatus("error");
      setMessage(labels.networkError);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onDecode}
        disabled={status === "loading"}
        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
      >
        {status === "loading" ? (
          <>
            <span
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden="true"
            />
            {labels.decoding}
          </>
        ) : (
          <>🔎 {labels.decodeBtn}</>
        )}
      </button>
      {message ? (
        <p
          className={
            "text-xs " +
            (status === "ok" ? "text-success-700 dark:text-success-500" : "text-danger-700 dark:text-danger-500")
          }
        >
          {message}
        </p>
      ) : status === "idle" ? (
        <p className="text-xs text-text-mute">{labels.decodedNote}</p>
      ) : null}
    </div>
  );
}

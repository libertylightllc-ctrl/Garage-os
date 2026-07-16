"use client";

// Combined delivery + reminder form (Workflow-Spec step 16). Delivery is
// gated behind scheduling at least one maintenance reminder, so instead
// of two separate forms we merge them: reminder types + service date +
// mileage-out in one payload, one Mark Delivered button. The button is
// disabled until all three inputs are valid, and the server ALSO rejects
// invalid payloads (see validateDeliveryInput / recordDeliveryAction).

import { useState } from "react";

export type DeliveryFormTypeOption = {
  key: string;
  label: string;
};

export function DeliveryForm({
  jobId,
  today,
  reminderTypes,
  action,
  labels,
}: {
  jobId: string;
  today: string;
  reminderTypes: DeliveryFormTypeOption[];
  action: (formData: FormData) => void | Promise<void>;
  labels: {
    heading: string;
    remindersLabel: string;
    serviceDateLabel: string;
    mileageOutLabel: string;
    markDelivered: string;
    disabledHelp: string;
  };
}) {
  const [typeCount, setTypeCount] = useState(0);
  const [serviceDate, setServiceDate] = useState(today);
  const [mileage, setMileage] = useState("");

  const mileageOk = mileage.trim() !== "" && Number(mileage) >= 0;
  const dateOk = serviceDate.trim() !== "";
  const canSubmit = typeCount > 0 && dateOk && mileageOk;

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-xl border border-border p-4 text-sm"
    >
      <input type="hidden" name="jobId" value={jobId} />
      <h2 className="text-sm font-medium">{labels.heading}</h2>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-text-mute">{labels.remindersLabel}</legend>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {reminderTypes.map((rt) => (
            <label key={rt.key} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                name="types"
                value={rt.key}
                onChange={(e) =>
                  setTypeCount((c) => (e.target.checked ? c + 1 : c - 1))
                }
              />
              {rt.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-xs text-text-mute">
        {labels.serviceDateLabel}
        <input
          type="date"
          name="serviceDate"
          value={serviceDate}
          onChange={(e) => setServiceDate(e.target.value)}
          className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-text-mute">
        {labels.mileageOutLabel}
        <input
          name="mileageOut"
          type="number"
          min="0"
          value={mileage}
          onChange={(e) => setMileage(e.target.value)}
          className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
        />
      </label>

      {!canSubmit ? (
        <p className="text-xs text-text-mute">{labels.disabledHelp}</p>
      ) : null}

      <button
        type="submit"
        disabled={!canSubmit}
        className="self-start inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {labels.markDelivered}
      </button>
    </form>
  );
}

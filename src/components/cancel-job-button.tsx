"use client";

// Small client wrapper so we can wire a native confirm() dialog to the
// cancel-job form. The server action itself lives in src/app/actions/jobs.ts
// (cancelJobAction) — this component just gates the form submit.

export function CancelJobButton({
  jobId,
  label,
  confirmMessage,
  action,
}: {
  jobId: string;
  label: string;
  confirmMessage: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(confirmMessage)) e.preventDefault();
      }}
    >
      <input type="hidden" name="jobId" value={jobId} />
      <button
        type="submit"
        className="inline-flex h-10 items-center justify-center rounded-lg border border-danger-500/40 bg-transparent px-3 text-sm font-medium text-danger-600 hover:bg-danger-50 transition-colors dark:hover:bg-danger-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-500/60"
      >
        ✕ {label}
      </button>
    </form>
  );
}

"use client";

// Client-side wrapper for the logo upload form. The server action is
// the real security boundary — these client checks are UX only (fast
// reject + preview before the upload round-trip). Anything that escapes
// these checks is caught again by validateLogoFile() server-side.

import { useId, useRef, useState } from "react";
import { uploadGarageLogoAction } from "@/app/actions/garage-logo";

const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 500 * 1024;

interface Labels {
  pick: string;
  picked: string;
  replace: string;
  upload: string;
  uploading: string;
  errTooLarge: string; // {limit}
  errBadType: string;
}

export function GarageLogoForm({
  currentLogoUrl,
  labels,
}: {
  currentLogoUrl: string | null;
  labels: Labels;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Picked-file preview lives only in memory — never sent anywhere
  // until the user hits Upload. Cleared on form reset.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pickedName, setPickedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const f = e.target.files?.[0];
    if (!f) {
      setPreviewUrl(null);
      setPickedName(null);
      return;
    }
    // Client-side reject — same rules the server enforces. The user
    // sees the error immediately instead of waiting for the upload to
    // round-trip + redirect with ?error=. Server still re-checks.
    if (!ALLOWED_MIME.includes(f.type)) {
      setError(labels.errBadType);
      setPreviewUrl(null);
      setPickedName(null);
      e.target.value = ""; // forget the picked file
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(labels.errTooLarge.replace("{limit}", String(MAX_BYTES / 1024)));
      setPreviewUrl(null);
      setPickedName(null);
      e.target.value = "";
      return;
    }
    // Object URL = local preview. Revoke any previous one to avoid a
    // memory leak across multiple picks.
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
    setPickedName(f.name);
  }

  const displayUrl = previewUrl ?? currentLogoUrl;

  return (
    <form
      ref={formRef}
      action={uploadGarageLogoAction}
      onSubmit={() => setSubmitting(true)}
      className="flex flex-col gap-3"
    >
      <div className="flex items-start gap-4">
        {/* Preview — falls back to the saved logo when no fresh pick.
            48px square keeps the layout tight while still being big
            enough to see the chosen brand. eslint disabled because
            object URLs aren't friendly with next/image. */}
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2">
          {displayUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={displayUrl}
              alt=""
              className="max-h-14 max-w-14 object-contain"
            />
          ) : (
            <span className="text-xs text-text-mute">—</span>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <label
            htmlFor={inputId}
            className="inline-flex h-10 w-fit items-center justify-center rounded-lg border border-border px-4 text-sm font-medium hover:bg-surface-2 transition-colors cursor-pointer"
          >
            {pickedName ?? (currentLogoUrl ? labels.replace : labels.pick)}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            name="logo"
            type="file"
            accept={ALLOWED_MIME.join(",")}
            className="sr-only"
            onChange={onPick}
            required
          />
          {pickedName ? (
            <p className="text-xs text-text-mute">
              {labels.picked}: {pickedName}
            </p>
          ) : null}
          {error ? (
            <p className="text-xs font-medium text-danger-600 dark:text-danger-500">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <button
        type="submit"
        disabled={!pickedName || submitting}
        className="inline-flex h-10 w-fit items-center justify-center rounded-lg px-5 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? labels.uploading : labels.upload}
      </button>
    </form>
  );
}

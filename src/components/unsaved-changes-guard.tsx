"use client";

import { useEffect } from "react";

/**
 * Attaches a `beforeunload` warning to the given form once any field has
 * been edited. Removes the warning when the form is submitted (so a
 * successful submit doesn't prompt the owner). No prompt when nothing
 * has been touched.
 *
 * Draft-persist is a separate follow-up spec — this is the narrow "don't
 * lose typed fields to an accidental tab close" guard. See
 * docs/new-po-draft-persistence-spec.md.
 */
export function UnsavedChangesGuard({ formId }: { formId: string }) {
    useEffect(() => {
        const form = document.getElementById(formId);
        if (!form) return;
        let dirty = false;
        const markDirty = () => {
            dirty = true;
        };
        const clearOnSubmit = () => {
            dirty = false;
        };
        const beforeUnload = (e: BeforeUnloadEvent) => {
            if (!dirty) return;
            // Modern browsers ignore custom text and show a native
            // "Leave site?" prompt — the returnValue assignment is the
            // documented way to trigger it. Do not localize; the browser
            // ignores it.
            e.preventDefault();
            e.returnValue = "";
        };
        form.addEventListener("input", markDirty);
        form.addEventListener("change", markDirty);
        form.addEventListener("submit", clearOnSubmit);
        window.addEventListener("beforeunload", beforeUnload);
        return () => {
            form.removeEventListener("input", markDirty);
            form.removeEventListener("change", markDirty);
            form.removeEventListener("submit", clearOnSubmit);
            window.removeEventListener("beforeunload", beforeUnload);
        };
    }, [formId]);
    return null;
}

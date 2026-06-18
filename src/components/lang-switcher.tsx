"use client";

import { useRouter } from "next/navigation";

// Sets a `lang` cookie and re-renders server components (preserves the current path).
export function LangSwitcher({ locale }: { locale: string }) {
    const router = useRouter();
    function set(l: string) {
        document.cookie = `lang=${l};path=/;max-age=31536000`;
        router.refresh();
    }
    const base = "px-2 py-0.5 text-xs rounded";
    const on = "bg-brand-900 text-white dark:bg-white dark:text-brand-900";
    const off = "text-text-mute";
    return (
        <div className="fixed end-3 top-3 z-50 flex gap-1 rounded-full border border-border bg-surface/80 p-0.5 backdrop-blur">
            <button onClick={() => set("en")} className={`${base} ${locale === "en" ? on : off}`}>
                EN
            </button>
            <button onClick={() => set("ar")} className={`${base} ${locale === "ar" ? on : off}`}>
                ع
            </button>
        </div>
    );
}

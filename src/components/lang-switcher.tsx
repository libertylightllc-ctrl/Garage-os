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
  const on = "bg-zinc-900 text-white dark:bg-white dark:text-black";
  const off = "text-zinc-500 dark:text-zinc-400";
  return (
    <div className="fixed end-3 top-3 z-50 flex gap-1 rounded-full border border-black/10 bg-white/80 p-0.5 backdrop-blur dark:border-white/15 dark:bg-black/50">
      <button onClick={() => set("en")} className={`${base} ${locale === "en" ? on : off}`}>
        EN
      </button>
      <button onClick={() => set("ar")} className={`${base} ${locale === "ar" ? on : off}`}>
        ع
      </button>
    </div>
  );
}

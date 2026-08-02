import { GarageBrand } from "@/components/garage-brand";
import { LangSwitcher } from "@/components/lang-switcher";
import { getLocale } from "@/i18n/server";

/**
 * Thin top strip shown on mobile above the page content. Holds the
 * brand mark, role badge, and language toggle in a single row so the
 * EN/ع buttons have a proper home in the app's top bar and never float
 * over page content. Settings and Sign out live in the "More" sheet so
 * the strip stays short.
 *
 * Hidden on md+ (desktop uses DesktopSideNav instead).
 */
export async function MobileTopStrip({
    logoUrl,
    roleLabel,
}: {
    logoUrl: string | null;
    roleLabel: string;
}) {
    const locale = await getLocale();
    return (
        // print:hidden — defensive against printable pages that render
        // the mobile shell. Screen-only navigation strip.
        <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-2 border-b border-border bg-surface/80 px-4 backdrop-blur md:hidden print:hidden">
            <div className="flex min-w-0 items-center gap-2">
                <GarageBrand size="mark" logoUrl={logoUrl} />
                {logoUrl ? null : (
                    <span className="truncate text-[13px] font-semibold tracking-tight">
                        Garage Os
                    </span>
                )}
            </div>
            <div className="flex items-center gap-2">
                <span className="truncate text-[12px] font-normal text-text-mute">{roleLabel}</span>
                <LangSwitcher locale={locale} inline />
            </div>
        </header>
    );
}

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
        //
        // Layout: flex-wrap so a long role label ("Service Advisor",
        // Arabic labels) never crowds the language toggle off-screen.
        // On a narrow viewport the toggle wraps to a second row and
        // the strip grows via min-h instead of h. Role label never
        // truncates.
        <header className="sticky top-0 z-30 flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-surface/80 px-4 py-1.5 backdrop-blur md:hidden print:hidden">
            <div className="flex items-center gap-2">
                <GarageBrand size="mark" logoUrl={logoUrl} />
                {logoUrl ? null : (
                    <span className="text-[13px] font-semibold tracking-tight">
                        Garage Os
                    </span>
                )}
                <span className="text-[12px] font-normal text-text-mute">· {roleLabel}</span>
            </div>
            <LangSwitcher locale={locale} inline />
        </header>
    );
}

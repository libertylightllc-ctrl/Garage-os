import { GarageBrand } from "@/components/garage-brand";

/**
 * Thin top strip shown on mobile above the page content. Holds only
 * the brand mark + role badge — Settings and Sign out are down in the
 * "More" sheet so the whole top row can be shorter and the content
 * gets more of the small viewport.
 *
 * Hidden on md+ (desktop uses DesktopSideNav instead).
 */
export function MobileTopStrip({
    logoUrl,
    roleLabel,
}: {
    logoUrl: string | null;
    roleLabel: string;
}) {
    return (
        // print:hidden — defensive against printable pages that render
        // the mobile shell. Screen-only navigation strip.
        <header className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-border bg-surface/80 px-4 backdrop-blur md:hidden print:hidden">
            <div className="flex items-center gap-2">
                <GarageBrand size="mark" logoUrl={logoUrl} />
                {logoUrl ? null : (
                    <span className="text-[13px] font-semibold tracking-tight">
                        Garage Os
                    </span>
                )}
            </div>
            <span className="text-[12px] font-normal text-text-mute">{roleLabel}</span>
        </header>
    );
}

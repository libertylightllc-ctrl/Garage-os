// Per-garage brand display. Pure: takes the logoUrl as a prop, doesn't
// query the DB. Each caller (app-nav, login, invoice editor, /c/invoice,
// etc.) is responsible for fetching its garage's logoUrl and passing it
// here, which keeps tenant scoping at the call site where the auth /
// token lookup already happens.
//
// Size:
//   "mark" → small square monogram (nav header, customer page corner)
//   "full" → wide wordmark (login screen, invoice / estimate headers)
//
// Fallback: when logoUrl is null/undefined (most garages haven't
// uploaded one yet), render the bundled default GarageOS brand. Net
// effect for the day this ships: zero visible change anywhere until a
// garage actually uploads.

interface GarageBrandProps {
  size: "mark" | "full";
  /** From Garage.logoUrl — null/undefined → default GarageOS brand. */
  logoUrl?: string | null;
  /** Extra classes for layout-context tweaks at the call site. */
  className?: string;
}

export function GarageBrand({ size, logoUrl, className }: GarageBrandProps) {
  // Custom URLs come either from /api/files/logo-* (local dev) or a
  // Supabase Storage public URL (prod). Both are <img>-loadable.
  const src =
    logoUrl ??
    (size === "full" ? "/brand/garageos-logo.png" : "/brand/garageos-mark.png");
  const defaultClasses =
    size === "full"
      ? "h-12 w-auto max-w-[200px] object-contain dark:invert"
      : "h-8 w-auto max-w-[64px] object-contain dark:invert";
  // dark:invert flips the black GarageOS mark white in dark mode. For
  // an UPLOADED logo (logoUrl present), inverting would mangle the
  // shop's actual brand colors — skip the dark:invert in that case.
  const finalClasses = logoUrl
    ? defaultClasses.replace(" dark:invert", "")
    : defaultClasses;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className={className ? `${finalClasses} ${className}` : finalClasses}
    />
  );
}

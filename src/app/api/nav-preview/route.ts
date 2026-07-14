import { NextResponse } from "next/server";

/**
 * Preview-only nav-shell override. Visit /api/nav-preview?on to opt IN
 * (sets a cookie so AppNav renders the new bottom-bar / More-sheet
 * shell for any signed-in role), or /api/nav-preview?off to opt OUT.
 * Redirects to /advisor after toggling.
 *
 * This exists to let a phone tester see the new shell on a Vercel
 * preview URL without having a MASTER account in prod. It is
 * intentionally a no-op on prod-main (the merge rollout removes the
 * cookie check in favour of the per-role gate — see slice plan).
 */
export function GET(req: Request) {
    const url = new URL(req.url);
    const on = url.searchParams.has("on");
    const off = url.searchParams.has("off");

    const redirect = NextResponse.redirect(new URL("/advisor", url.origin));

    if (on) {
        redirect.cookies.set("nav-preview", "1", {
            path: "/",
            httpOnly: false,
            sameSite: "lax",
            maxAge: 60 * 60 * 24 * 7, // 7 days
        });
    } else if (off) {
        redirect.cookies.delete("nav-preview");
    }

    return redirect;
}

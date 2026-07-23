# LangSwitcher placement — follow-up

**Status:** deferred, not built.
**Owner:** AR.
**Context:** captured on 2026-07-23 after prod hotfix `pe-16 xl:pe-0` on
`/advisor/jobs/[id]` header.

## The problem this fixes-around

`LangSwitcher` at [src/components/lang-switcher.tsx:16](src/components/lang-switcher.tsx:16)
renders as a floating `fixed end-3 top-3 z-50` pill from [src/app/layout.tsx:43](src/app/layout.tsx:43).
It sits on top of every page's viewport corner and overlaps anything a
page places at top-end. Two known workarounds live in the code:

- Marketing home reserves right-end space on its nav via
  `pe-16 xl:pe-0` at [src/components/marketing/marketing-home.tsx:30](src/components/marketing/marketing-home.tsx:30).
- Advisor job detail now does the same at
  [src/app/advisor/jobs/[id]/page.tsx:155](src/app/advisor/jobs/[id]/page.tsx:155)
  (added by this hotfix).

Every new page that puts an action at top-end has to remember `pe-16
xl:pe-0`, or the switcher covers it. That's the trap.

## Option D — move the switcher into AppNav (deferred)

For authenticated pages, put the EN/ع toggle inside the AppNav header
row instead of as a floating pill. Keeps the marketing pill for
pre-shell pages.

### What changes
1. **Add an EN/ع toggle to `<AppNav>`** — probably on the far end of
   the nav strip, next to the user avatar / sign-out area. Same client
   behaviour as `LangSwitcher` today (cookie write + `router.refresh()`).
2. **`layout.tsx` conditionally renders the floating pill** only when
   the app shell is absent (public / marketing / login / `/c/*`
   pages). Simplest gate: check for the `data-app-shell` marker the same
   way `globals.css` already keys shell padding, or by inspecting the
   pathname on the server.
3. **Drop `pe-16 xl:pe-0` reservations** on the two pages that carry
   them today (marketing home, advisor job detail header) — the pill
   won't overlap authenticated pages anymore, and marketing keeps its
   own pill so its reservation stays needed there.

### Why deferred, not shipped now
- Real refactor: touches `AppNav`, `layout.tsx`, `LangSwitcher`, plus
  design consideration for how the toggle lives inside the nav row.
- Design decision: mobile users on the bottom-tab-bar shell need the
  toggle somewhere visible (there's no top nav on mobile — check
  `BottomTabBar` at [src/components/nav-shell/BottomTabBar.tsx](src/components/nav-shell/BottomTabBar.tsx)).
  Might have to keep the floating pill on the mobile shell too.
- Blast radius vs. urgency: the `pe-16` pattern works everywhere it's
  applied. The trap is only that future page authors have to remember
  it; it's not silently broken code.

### When to build
When either of these becomes true:
1. Someone adds a top-end action to a third page and forgets `pe-16` —
   the collision reappears in prod.
2. The top-end area on one of the existing pages needs to hold **more
   than a single link** (Print + Share + Cancel + ...), at which point
   the `pe-16` reservation isn't enough anymore and we need real layout.

### Not in scope for the follow-up
- Removing the `LangSwitcher` from public / marketing / `/c/*` pages.
  Those pages don't have `AppNav`, so the floating pill is still the
  right shape there.
- Changing the switcher's visual (still EN/ع buttons, still the same
  cookie).

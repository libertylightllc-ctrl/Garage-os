# Apex vs. www cookie-scope gap

**Status:** SPEC — auth-session part NOT built. Filed 2026-07-29
alongside the lang-cookie fix (see
`src/components/lang-switcher.tsx`). This document exists so the
same-class gap on the NextAuth session cookie doesn't get lost.

## What the class is

Vercel canonicalizes `garageos.shop` → `www.garageos.shop` with a
308 at the platform level (confirmed by
`curl -sI https://garageos.shop/…`). Any cookie set with
`document.cookie = "…; path=/"` and no explicit `Domain=` attribute
is **host-only**: stored under `www.garageos.shop`, invisible on
`garageos.shop`.

The failure sequence:

1. User's browser initiates a request to the apex host (a bookmark,
   a re-open from browser history, a share, a WhatsApp message body
   that used `APP_URL=https://garageos.shop`, or a client that
   dedupes 301/308 into future requests).
2. Vercel 308's to www. Browser lands on www.
3. Any cookies previously written host-only on www are visible on
   this request. Good.
4. **But** any browser bookkeeping that replays the ORIGINAL apex
   URL on subsequent refreshes (Chrome does this when its cache
   entry expires) issues a fresh apex request. Apex has no cookies.
   Vercel 308's to www again, but the cookies never followed —
   they were set host-only on www, and Set-Cookie response headers
   flow from server → browser one-way. The browser now has NO
   cookies scoped to apex to send, and no way to lift the www
   cookies onto apex.

Server reads no cookie, renders as if the user is new. For the
lang cookie this shows up as "toggle reset to EN." For the auth
session cookie this shows up as "signed-out state on a session that
should be live."

## Where this shows up today

### Fixed 2026-07-29 (this commit)

**`lang` cookie** — LangSwitcher now writes with
`domain=.garageos.shop` on prod, host-only on localhost (the
`.localhost` / `.garageos.shop` split is browser-refusal-safe: a
domain attribute on localhost is silently dropped, which is fine on
a single-host dev server but would break the toggle if forced).

### NOT fixed — spec only

**`authjs.session-token` (and `__Secure-authjs.session-token` in
prod)** — NextAuth writes these cookies via its own cookie
strategy, defaulting to host-only. Same failure mode as the lang
cookie, higher stakes:

- Owner bookmarks `https://garageos.shop/owner` when signed in via
  www. Session cookie exists on www only.
- Reopens the bookmark → apex → 308 → www. Cookies scoped to www
  come along because the browser's already-established cookie jar
  for www still has them. Session works.
- **BUT** — the moment the browser replays the original apex URL
  (see above), or the user pastes the apex URL directly, the
  request lands on apex first. No auth cookie on apex → server
  reads unauthenticated → `requireRole()` redirects to `/login`.
  The user thinks they were signed out. They weren't.
- Session confusion is materially worse than a language toggle:
  the user assumes their session lapsed for a security reason and
  signs in again — creating a second session token they now have
  to manage. Repeat over a week and the user has a graveyard of
  parallel sessions and no idea which is real.

Also affected by inference (same host-only default):
- `theme` (if we add one)
- Any future consent / feature-flag cookie

## Why not fix the auth cookie in the same commit

- NextAuth's cookie config is centralized in `auth.ts` and touches
  every sign-in / sign-out / callback path. A misconfigured domain
  attribute logs everyone out at next request. Deliberate,
  reviewed, done on its own commit.
- The blast radius includes the `__Host-` prefix on
  `__Secure-authjs.session-token`. `__Host-` prefixed cookies MUST
  be host-only and MUST NOT have a `Domain` attribute — trying to
  set a parent domain on a `__Host-`-prefixed name is a spec
  violation and the browser rejects. NextAuth doesn't use `__Host-`
  today (verify before touching), but any switch would collide
  with parent-domain scoping.
- Session cookies are `httpOnly` (JS can't touch them), so the fix
  has to live in the server config, not in a client helper like
  LangSwitcher.

## Proposed fix (auth-session — spec only)

1. **First, fix `APP_URL`.** Set to `https://www.garageos.shop` on
   Vercel so every outgoing WhatsApp link (and any future email /
   SMS link) starts on the canonical host. Zero code change. This
   doesn't fix the class — a shared / bookmarked / re-opened URL
   still hits apex — but it removes the 308 hop from the primary
   flow. See `src/lib/whatsapp.ts:appUrl()` for how it's read.
2. **Then, scope the NextAuth session cookie to `.garageos.shop`**
   in `auth.ts` via the `cookies` config option. Set for prod only
   — localhost stays host-only. Verify NextAuth doesn't use a
   `__Host-` prefix (it doesn't today, but check on the change).
3. **Roll out during a low-traffic window.** Existing host-only
   session cookies stay valid until they expire; users signed in
   on www continue to work. New sessions are parent-domain-scoped
   and survive the apex bounce. No forced re-sign-in.
4. **Verify the same three cases** the lang fix uses:
   - Localhost: host-only, sign-in still works.
   - Prod www: parent-domain, sign-in still works.
   - Prod apex direct hit: parent-domain cookie visible after 308,
     session recognized.

## Related

- `src/components/lang-switcher.tsx` — the fixed piece.
- `src/lib/whatsapp.ts` — where `APP_URL` is read; canonicalization
  makes outgoing links land on www directly.
- `auth.ts` — where the fix lives when it's built.
- `src/middleware.ts` — the admin gate reads
  `authjs.session-token` presence; a domain-scoped cookie must
  still be visible here.
- `docs/optimistic-concurrency-spec.md` — sibling spec doc pattern
  for "class of bug, narrow fix now, wider fix later."

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/tokens";

/**
 * Per-document customer/supplier link tokens — Phase 2 (2026-08-10).
 *
 * Every customer-facing URL (/c/invoice/[t], /c/estimate/[t], /c/po/[t],
 * /c/delivery/[t]) accepts EITHER shape:
 *
 *   1. Raw publicToken (Phase 2 write path). 32 URL-safe base64 chars
 *      from crypto.randomBytes(24). Contains "-" and "_" (never "~"),
 *      never appears in a cuid, so shape is unambiguous.
 *   2. HMAC-signed `<cuid>~<24-char-b64url-sig>` (Phase 1 legacy). Kept
 *      alive during the grace window so existing WhatsApp threads with
 *      old links still verify. Removed entirely in Phase 3.
 *
 * The dispatch is byte-cheap: `token.includes("~")` decides which path,
 * because base64url and cuid alphabets exclude "~" entirely — see
 * https://www.rfc-editor.org/rfc/rfc4648#section-5 (URL-safe base64)
 * and the cuid v1 alphabet (0-9, a-z only). One character determines
 * the shape; no format ambiguity.
 *
 * The resolver is async because a raw publicToken requires a DB
 * lookup to convert to an id — that's the whole point of decoupling
 * link validity from a shared secret. The HMAC path stays sync inside
 * verifyToken() (kept in @/lib/tokens for module-scope isolation) so
 * the AUTH_SECRET-based crypto stays out of this file.
 */

export type DocumentKind = "invoice" | "estimate" | "po" | "delivery";

/**
 * Generate a fresh URL-safe token. 24 raw bytes → 32 base64url chars =
 * 192 bits of entropy. That's an order of magnitude above the "no
 * realistic collision in the lifetime of the product" bar (~2^96 for
 * the birthday bound at billions of tokens). Choice locked in Phase 1
 * backfill; this must NOT change without a fresh migration/backfill,
 * or existing tokens in customer inboxes would look inconsistent with
 * newly-issued ones (cosmetic, not security).
 */
export function newPublicToken(): string {
    return randomBytes(24).toString("base64url");
}

/**
 * Resolve a customer URL token to the target row's id, whichever shape
 * the token happens to be. Returns null when neither path matches.
 * The customer page then either loads by id or renders the friendly
 * invalid-link page.
 *
 * Path preference: publicToken FIRST (raw = new). After the grace
 * window closes and HMAC is removed in Phase 3, the fallback branch
 * disappears entirely.
 */
export async function resolveDocumentToken(
    kind: DocumentKind,
    token: string,
): Promise<string | null> {
    if (!token) return null;

    // Phase-2 path — raw publicToken. Absence of "~" is the signal.
    if (!token.includes("~")) {
        const row = await lookupByPublicToken(kind, token);
        return row?.id ?? null;
        // If null here, DO NOT fall through to HMAC — a raw token that
        // doesn't resolve is a bad token, not a candidate for a second
        // interpretation. The HMAC path requires the "~" separator.
    }

    // Phase-1 fallback — HMAC-signed `<id>~<sig>`. Kept alive so
    // customer inboxes with pre-Phase-2 links still verify. Removed
    // in Phase 3 (~90d after Phase 2 lands in Prod).
    return verifyToken(kind, token);
}

/**
 * Ensure the row has a publicToken and return it. If the row already
 * carries one (backfill ran, or Phase-2 create-site path set it), that
 * value is returned as-is. If missing (a new row created before every
 * create-site was updated), a fresh token is generated and persisted
 * — the write happens once, subsequent reads return the same token.
 *
 * Caller passes the row it already loaded so we don't re-read Prisma
 * just to check the column. `id` + `publicToken` are enough — the
 * caller doesn't need to `select` them explicitly since Prisma
 * returns all scalar fields on a naked findFirst/findUnique with
 * only `include`.
 *
 * Safety net for the emit side: even if a create site was missed,
 * the sender action always produces a link that will verify. Belt-
 * and-braces with the Phase-1 backfill (which covered every existing
 * row) and the Phase-2 create-site updates (which cover every new
 * row) — this catches any gap between the two.
 */
export async function ensurePublicToken(
    kind: DocumentKind,
    row: { id: string; publicToken: string | null },
): Promise<string> {
    if (row.publicToken) return row.publicToken;
    const fresh = newPublicToken();
    // Persist so the next sender/render sees the same value. If two
    // concurrent senders race and both generate, the @unique index on
    // publicToken blocks the second write — treat P2002 as "someone
    // else got there first" and re-read.
    try {
        await updatePublicToken(kind, row.id, fresh);
        return fresh;
    } catch (e: unknown) {
        // Prisma unique-violation on publicToken — vanishingly rare
        // (192-bit entropy) but possible under a concurrent race
        // (two senders on the same tokenless row). Re-read and use
        // whichever token won.
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Unique constraint")) {
            const reread = await lookupPublicTokenById(kind, row.id);
            if (reread) return reread;
        }
        throw e;
    }
}

// ── kind → table dispatch ────────────────────────────────────────

async function lookupByPublicToken(
    kind: DocumentKind,
    publicToken: string,
): Promise<{ id: string } | null> {
    switch (kind) {
        case "invoice":
            return prisma.invoice.findUnique({ where: { publicToken }, select: { id: true } });
        case "estimate":
            return prisma.estimate.findUnique({ where: { publicToken }, select: { id: true } });
        case "po":
            return prisma.purchaseOrder.findUnique({ where: { publicToken }, select: { id: true } });
        case "delivery":
            // Delivery URLs target the JobCard the delivery hangs off.
            return prisma.jobCard.findUnique({ where: { publicToken }, select: { id: true } });
    }
}

async function updatePublicToken(
    kind: DocumentKind,
    id: string,
    publicToken: string,
): Promise<void> {
    switch (kind) {
        case "invoice":
            await prisma.invoice.update({ where: { id }, data: { publicToken } });
            return;
        case "estimate":
            await prisma.estimate.update({ where: { id }, data: { publicToken } });
            return;
        case "po":
            await prisma.purchaseOrder.update({ where: { id }, data: { publicToken } });
            return;
        case "delivery":
            await prisma.jobCard.update({ where: { id }, data: { publicToken } });
            return;
    }
}

async function lookupPublicTokenById(
    kind: DocumentKind,
    id: string,
): Promise<string | null> {
    switch (kind) {
        case "invoice": {
            const r = await prisma.invoice.findUnique({ where: { id }, select: { publicToken: true } });
            return r?.publicToken ?? null;
        }
        case "estimate": {
            const r = await prisma.estimate.findUnique({ where: { id }, select: { publicToken: true } });
            return r?.publicToken ?? null;
        }
        case "po": {
            const r = await prisma.purchaseOrder.findUnique({ where: { id }, select: { publicToken: true } });
            return r?.publicToken ?? null;
        }
        case "delivery": {
            const r = await prisma.jobCard.findUnique({ where: { id }, select: { publicToken: true } });
            return r?.publicToken ?? null;
        }
    }
}

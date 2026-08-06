"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOperational } from "@/lib/action-guards";
import {
  pickEstimateForConversion,
  filterConvertibleLines,
} from "@/lib/estimate-to-po";
import { buildPoLineVehicleSnapshot, resolvePoVehicles } from "@/lib/po-vehicle";
import { purchaseOrderMessage } from "@/lib/po-message";
import { poDocKind, isLineUnpriced, canMarkOrdered } from "@/lib/po-doc-kind";
import { normalizeToE164, buildWaMeUrl } from "@/lib/wa";
import { signId } from "@/lib/tokens";
import { appUrl } from "@/lib/whatsapp";
import { getLocale, getT } from "@/i18n/server";
import { logPoSend } from "@/lib/po-send-log";

// Inventory Phase 2 — purchasing. OWNER-only, garage-scoped: garageId
// always from the session, and every supplier/part/PO id is re-checked
// against the caller's garage before use (no cross-tenant writes).
//
// 2a covers building + sending a PO (DRAFT → ORDERED) and cancelling.
// Receiving (→ RECEIVED, which moves stock) is 2b — see
// receivePurchaseOrderAction there. Nothing here touches the live
// job / estimate flow.


function fail(msg: string, path = "/owner/purchasing"): never {
  redirect(`${path}?error=${encodeURIComponent(msg)}`);
}

function optional(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? "").trim();
  return s === "" ? null : s;
}

/**
 * Parse a non-negative money string bound for Prisma Decimal.
 *
 * Returns a discriminated result so callers can distinguish three
 * cases that used to collapse into a single `null`:
 *   { ok: true,  value: string  } — a real, storable non-negative price
 *   { ok: true,  value: null    } — BLANK input (Layer 0, 2026-08-01:
 *                                   for PO lines this means "awaiting
 *                                   a supplier quote" and is written
 *                                   to the DB as `unitCost: null`,
 *                                   NOT as an error)
 *   { ok: false                 } — garbage input the caller must
 *                                   reject (NaN / Infinity / negative
 *                                   / non-numeric)
 *
 * The previous `string | null` return conflated blank and invalid, so
 * every caller had to reject blank with "must be a non-negative
 * number" — which is exactly what the PO/RFQ reshape needs to stop
 * doing. Zero is admitted as a real price (a supplier warranty
 * replacement or courtesy line at zero cost) — see isLinePriced
 * in src/lib/po-doc-kind.ts.
 */
type ParsedMoney =
  | { ok: true; value: string | null }
  | { ok: false };

function parseMoney(raw: string): ParsedMoney {
  const s = raw.trim();
  if (s === "") return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: s };
}

/** Positive integer; null on invalid. */
function parsePositiveInt(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Create a DRAFT purchase order for a supplier. Lines are added on the
 * detail page. The supplier must be active and in the caller's garage.
 *
 * Two-mode (2026-08-02): the form carries a `mode` field ("quote" |
 * "order"). Server behavior is identical — both write a DRAFT — but
 * mode carries through to the detail-page redirect so the add-line
 * cost input can render `required` on order mode and optional on quote
 * mode. The redirect anchors to `#add-line` so a mode=order caller
 * lands with the line-entry form on-screen instead of scrolling to the
 * top of an empty document. AR's rule stays intact: Mark Ordered is
 * the ONLY thing that turns a quotation into a purchase order — the
 * user reviews the DRAFT and clicks it themselves.
 */
export async function createPurchaseOrderAction(formData: FormData) {
  const user = await requireOperational();

  const supplierId = String(formData.get("supplierId") ?? "").trim();
  const rawMode = String(formData.get("mode") ?? "").trim();
  // Whitelist — quote is the safer default (cost optional).
  const mode: "quote" | "order" = rawMode === "order" ? "order" : "quote";
  const backTo = `/owner/purchasing/new?mode=${mode}`;
  if (!supplierId) fail("Choose a supplier.", backTo);

  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, garageId: user.garageId, active: true },
    select: { id: true },
  });
  if (!supplier) fail("Supplier not found.", backTo);

  const po = await prisma.purchaseOrder.create({
    data: {
      garageId: user.garageId, // from session — never from input
      supplierId: supplier.id,
      // Persist the author's intent. Reload no longer drops mode — the
      // detail page reads intent off the PO row itself and the title
      // reads "Purchase Order (draft)" for a DRAFT+ORDER doc instead
      // of falsely calling it a Request for Quotation.
      intent: mode === "order" ? "ORDER" : "QUOTE",
      reference: optional(formData.get("reference")),
      note: optional(formData.get("note")),
    },
    select: { id: true },
  });

  revalidatePath("/owner/purchasing");
  redirect(`/owner/purchasing/${po.id}?mode=${mode}`);
}

/** Load a PO scoped to the caller's garage, or fail. */
async function ownedPO(poId: string, garageId: string) {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, garageId },
    select: { id: true, status: true },
  });
  return po;
}

/**
 * Add a line to a DRAFT purchase order.
 *
 * Layer 1 (2026-08-02): the input is a text field backed by a
 * `<datalist>` of catalogue Part names in this garage. The user can
 * either pick a suggestion (in which case the value matches a Part
 * exactly, case-insensitive) OR type free text for a part the shop
 * doesn't stock. Both paths add a line to the PO:
 *
 *   - Exact-match → linked line: `partId` set, `description` snapshots
 *     the Part name so the "originally asked for" record survives even
 *     if the Part is renamed later.
 *   - No match     → free-text line: `partId` null, `description` is
 *     what the user typed. Layer 5 attaches a catalogue Part at goods
 *     receipt; until then the line renders description-only on every
 *     surface.
 *
 * Nothing writes to the inventory catalogue at any point. Stock only
 * moves at goods receipt (Layer 5).
 */
export async function addPoLineAction(formData: FormData) {
  const user = await requireOperational();

  const poId = String(formData.get("poId") ?? "").trim();
  // Datalist combo — one text input carries both cases. Trim before
  // any lookup so trailing whitespace never creates a false-free-text
  // when the user's suggestion had a trailing space.
  const lineText = String(formData.get("lineText") ?? "").trim();
  const qty = parsePositiveInt(String(formData.get("qty") ?? ""));
  const unitCostResult = parseMoney(String(formData.get("unitCost") ?? ""));

  const back = `/owner/purchasing/${poId}`;
  if (!poId) fail("Missing purchase order.");

  const po = await ownedPO(poId, user.garageId);
  if (!po) fail("Purchase order not found.");
  if (po.status !== "DRAFT") fail("Lines can only be changed on a draft order.", back);
  if (!lineText) fail("Enter a part name or description.", back);
  if (qty === null) fail("Quantity must be a whole number greater than 0.", back);
  // Blank → { ok:true, value:null } = awaiting a supplier quote (Layer
  // 0). Garbage → { ok:false } is what we still reject. See parseMoney.
  if (!unitCostResult.ok)
    fail("Unit cost must be a non-negative number (or leave blank while waiting for a quote).", back);
  const unitCost = unitCostResult.value;

  // Exact-match against catalogue Parts in this garage. Case-insensitive
  // because the datalist suggestion the user picked may not preserve
  // the exact case of the Part.name. `equals + mode:"insensitive"` is
  // an indexable predicate on Postgres; no full-scan risk.
  //
  // Vehicle snapshot (2026-08-02 — AR bug): a manually-added line
  // NEVER inherits a vehicle from the matched Part's original estimate
  // chain. The Layer 1 rewrite briefly read
  // `Part.autoCreatedFromLine.estimate.jobCard.vehicle` here and
  // snapshotted whatever car the Part was born from — silently
  // attaching e.g. FORD FOCUS 2014 / JC-79 to a line the owner typed
  // into a standalone PO with no source job. A supplier could then be
  // sent a part for the wrong car. The chain is out — manual lines
  // ship with every vehicle-snapshot column null and the surfaces
  // render "(no vehicle linked)" until the doc-level default lands
  // (follow-up: add-vehicle-entry-on-standalone-po).
  const match = await prisma.part.findFirst({
    where: {
      garageId: user.garageId,
      name: { equals: lineText, mode: "insensitive" },
    },
    select: {
      id: true,
      name: true,
    },
  });

  await prisma.purchaseOrderLine.create({
    data: {
      purchaseOrderId: po.id,
      // Linked path: the Part's canonical name goes to `description` so
      // the row satisfies the CHECK constraint even if partId is later
      // nulled by a migration and to preserve the "originally asked for"
      // text if the Part is renamed.
      //
      // Free-text path: partId stays null; description IS the identity.
      partId: match?.id ?? null,
      description: match?.name ?? lineText,
      qty,
      unitCost,
    },
  });

  revalidatePath(back);
  redirect(back);
}

/**
 * Edit qty + unitCost on an existing PO line. DRAFT-only (matches add /
 * remove) — non-DRAFT edits would desync the receiving math: qty is the
 * cap for `outstanding = qty - receivedQty` in receivePurchaseOrderAction,
 * and both the atomic cap-check and the RECEIVED status recompute read
 * from qty. Editing after ORDERED / PARTIALLY_RECEIVED / RECEIVED would
 * either break receipt caps or rewrite a paid-supplier audit trail; the
 * server rejects, not just the UI. Name/description editing is NOT part
 * of this action — those come from the linked Part and stay read-only.
 */
export async function editPoLineAction(formData: FormData) {
  const user = await requireOperational();

  const poId = String(formData.get("poId") ?? "").trim();
  const lineId = String(formData.get("lineId") ?? "").trim();
  const qty = parsePositiveInt(String(formData.get("qty") ?? ""));
  const unitCostResult = parseMoney(String(formData.get("unitCost") ?? ""));
  // Stale-write guard — the form renders the row's `updatedAt` (as an
  // ISO string) into a hidden input. We narrow the WHERE by that same
  // timestamp so a save from a stale tab produces count===0 instead of
  // silently overwriting a change made in another tab. Prisma stores
  // DateTime at ms precision on Postgres timestamp(3); `@updatedAt` is
  // set from JS Date, so the round-trip is exact. See
  // docs/optimistic-concurrency-spec.md for the wider gap this is a
  // narrow slice of.
  const expectedUpdatedAtRaw = String(formData.get("expectedUpdatedAt") ?? "").trim();

  const back = `/owner/purchasing/${poId}`;
  if (!poId || !lineId) fail("Missing line.", back);

  const po = await ownedPO(poId, user.garageId);
  if (!po) fail("Purchase order not found.");
  if (po.status !== "DRAFT") fail("Lines can only be changed on a draft order.", back);
  if (qty === null) fail("Quantity must be a whole number greater than 0.", back);
  // Same rule as addPoLineAction: blank unitCost is a legitimate
  // "awaiting a supplier quote" write. Only garbage rejects.
  if (!unitCostResult.ok)
    fail("Unit cost must be a non-negative number (or leave blank while waiting for a quote).", back);
  const unitCost = unitCostResult.value;
  const expectedUpdatedAt = expectedUpdatedAtRaw ? new Date(expectedUpdatedAtRaw) : null;
  if (!expectedUpdatedAt || Number.isNaN(expectedUpdatedAt.getTime())) {
    // Old client bundle submitting without the hidden input, or a
    // hand-crafted POST — treat as stale so we never silently overwrite.
    fail("stale_line", back);
  }

  // Scope the update through the owned PO so a foreign lineId can't match,
  // AND narrow by updatedAt so a stale tab produces count===0.
  const claim = await prisma.purchaseOrderLine.updateMany({
    where: { id: lineId, purchaseOrderId: po.id, updatedAt: expectedUpdatedAt },
    data: { qty, unitCost },
  });
  if (claim.count === 0) {
    // Distinguish "row deleted" from "row changed since fetch" so the
    // banner can say the right thing. Row still there → someone edited
    // it under us; row gone → someone removed it.
    const stillExists = await prisma.purchaseOrderLine.findFirst({
      where: { id: lineId, purchaseOrderId: po.id },
      select: { id: true },
    });
    if (!stillExists) fail("line_not_found", back);
    fail("stale_line", back);
  }

  revalidatePath(back);
  redirect(back);
}

/** Remove a line from a DRAFT purchase order (both scoped to the garage). */
export async function removePoLineAction(formData: FormData) {
  const user = await requireOperational();

  const poId = String(formData.get("poId") ?? "").trim();
  const lineId = String(formData.get("lineId") ?? "").trim();
  const back = `/owner/purchasing/${poId}`;
  if (!poId || !lineId) fail("Missing line.", back);

  const po = await ownedPO(poId, user.garageId);
  if (!po) fail("Purchase order not found.");
  if (po.status !== "DRAFT") fail("Lines can only be changed on a draft order.", back);

  // Scope the delete through the owned PO so a foreign lineId can't match.
  await prisma.purchaseOrderLine.deleteMany({
    where: { id: lineId, purchaseOrderId: po.id },
  });

  revalidatePath(back);
  redirect(back);
}

/**
 * Move a PO to ORDERED (sent to supplier) or CANCELLED.
 *   - ORDERED requires a DRAFT with at least one line.
 *   - CANCELLED is allowed from DRAFT or ORDERED (not from RECEIVED — that
 *     already moved stock).
 * RECEIVED is a separate action (2b) because it mutates stock.
 */
export async function setPoStatusAction(formData: FormData) {
  const user = await requireOperational();

  const poId = String(formData.get("poId") ?? "").trim();
  const next = String(formData.get("status") ?? "").trim();
  const back = `/owner/purchasing/${poId}`;
  if (!poId) fail("Missing purchase order.");
  if (next !== "ORDERED" && next !== "CANCELLED") fail("Invalid status.", back);

  const po = await ownedPO(poId, user.garageId);
  if (!po) fail("Purchase order not found.");

  if (next === "ORDERED") {
    if (po.status !== "DRAFT") fail("Only a draft order can be sent.", back);
    // 2026-08-01 rule: cannot commit to buy while any line is still
    // awaiting a supplier quote. `canMarkOrdered` admits 0 (a warranty
    // replacement or courtesy line at zero cost is a real order) but
    // rejects null unitCost (the quote hasn't landed yet) and rejects
    // an empty PO. Marking Ordered is the ONLY thing that turns a
    // quotation into a purchase order; every other surface (title,
    // WhatsApp body, print, public link) derives from status, not
    // from prices. See docs/po-doc-kind rule.
    const lines = await prisma.purchaseOrderLine.findMany({
      where: { purchaseOrderId: po.id },
      select: { unitCost: true },
    });
    if (!canMarkOrdered(lines)) {
      fail(
        lines.length === 0
          ? "Add at least one line before ordering."
          : "Every line needs a supplier price before you can order (blank = still waiting for a quote; 0 is fine).",
        back,
      );
    }
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "ORDERED", orderedAt: new Date() },
    });
  } else {
    if (po.status === "RECEIVED") fail("A received order can't be cancelled.", back);
    if (po.status === "PARTIALLY_RECEIVED")
      fail("This order has already been partly received — it can't be cancelled.", back);
    if (po.status === "CANCELLED") fail("Already cancelled.", back);
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: "CANCELLED" },
    });
  }

  revalidatePath(back);
  revalidatePath("/owner/purchasing");
  redirect(back);
}

/** Thrown inside the receive transaction when a line's atomic cap-check
 *  fails (a concurrent receipt already consumed the outstanding qty). */
class OverReceiveError extends Error {}

/**
 * Receive stock against an ORDERED (or already PARTIALLY_RECEIVED) purchase
 * order — PARTIAL receiving (2b). The form carries a per-line "receive now"
 * quantity (`recv_<lineId>`); each is 0..outstanding. For every line with a
 * positive quantity we, in ONE transaction:
 *   1. increment the line's receivedQty,
 *   2. increment the part's qtyOnHand,
 *   3. write a PartMovement (audit; reason carries the PO reference).
 * Then the PO status is recomputed: all lines fully received → RECEIVED
 * (stamped), otherwise PARTIALLY_RECEIVED. Receiving can happen over many
 * days: 6 now, 4 later — each receipt adds only its own amount.
 *
 * STOCK INTEGRITY — never receive more than outstanding, never double-count:
 * the per-line increment is a CONDITIONAL updateMany —
 *   where: { receivedQty: { lte: qty - receiveNow } }
 * i.e. only bump receivedQty if the result stays ≤ the ordered qty. Because
 * `qty - receiveNow` is a constant, Postgres re-evaluates it on the locked
 * row, so two concurrent receipts can't both push a line past its ordered
 * quantity — the loser matches 0 rows and the whole transaction aborts
 * (nothing applied). The pre-loop check below is a friendly early-out; THIS
 * is the guarantee.
 */
export async function receivePurchaseOrderAction(formData: FormData) {
  const user = await requireOperational();

  const poId = String(formData.get("poId") ?? "").trim();
  const back = `/owner/purchasing/${poId}`;
  if (!poId) fail("Missing purchase order.");

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, garageId: user.garageId },
    include: {
      lines: { select: { id: true, partId: true, qty: true, receivedQty: true } },
      supplier: { select: { name: true } },
    },
  });
  if (!po) fail("Purchase order not found.");
  if (po.status !== "ORDERED" && po.status !== "PARTIALLY_RECEIVED")
    fail("Only an ordered order can be received.", back);

  // Parse the per-line "receive now" quantities. Each must be a whole
  // number between 0 and that line's outstanding (ordered − alreadyReceived).
  const receipts: { lineId: string; partId: string; qty: number; receiveNow: number }[] = [];
  for (const l of po.lines) {
    const raw = String(formData.get(`recv_${l.id}`) ?? "").trim();
    const n = raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0) fail("Received quantity must be a whole number of 0 or more.", back);
    const outstanding = l.qty - l.receivedQty;
    if (n > outstanding) fail(`You can't receive more than the ${outstanding} still outstanding on a line.`, back);
    // Layer 0 (2026-08-01): partId is nullable — a free-text RFQ line
    // can go all the way to ORDERED without ever being linked to a
    // catalogue Part. Those lines aren't stock-tracked, so we can't
    // move stock on them; the shop needs to link a Part first (Layer
    // 5 auto-links on the DRAFT → ORDERED transition; until then it
    // stays a manual step on the line edit form).
    if (n > 0 && l.partId === null) {
      fail("Link a catalogue part to this line before receiving stock.", back);
    }
    if (n > 0 && l.partId !== null) {
      receipts.push({ lineId: l.id, partId: l.partId, qty: l.qty, receiveNow: n });
    }
  }
  if (receipts.length === 0) fail("Enter a quantity to receive on at least one line.", back);

  const reason = `Received PO${po.reference ? ` ${po.reference}` : ""} — ${po.supplier.name}`;

  try {
    await prisma.$transaction(async (tx) => {
      for (const r of receipts) {
        // Atomic cap: bump receivedQty only if it stays ≤ ordered qty.
        const cap = r.qty - r.receiveNow; // max current receivedQty that still allows this receipt
        const claim = await tx.purchaseOrderLine.updateMany({
          where: { id: r.lineId, purchaseOrderId: po.id, receivedQty: { lte: cap } },
          data: { receivedQty: { increment: r.receiveNow } },
        });
        if (claim.count === 0) throw new OverReceiveError();

        await tx.part.update({
          where: { id: r.partId },
          data: { qtyOnHand: { increment: r.receiveNow } },
        });
        await tx.partMovement.create({
          data: { partId: r.partId, delta: r.receiveNow, reason },
        });
      }

      // Recompute status from the fresh line state (inside the tx).
      const fresh = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: po.id },
        select: { qty: true, receivedQty: true },
      });
      const allFull = fresh.every((f) => f.receivedQty >= f.qty);
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: {
          status: allFull ? "RECEIVED" : "PARTIALLY_RECEIVED",
          receivedAt: allFull ? new Date() : null,
        },
      });
    });
  } catch (e) {
    if (e instanceof OverReceiveError) {
      fail("Another receipt updated this order — reload and try again.", back);
    }
    throw e;
  }

  revalidatePath(back);
  revalidatePath("/owner/purchasing");
  redirect(back);
}

/** Thrown inside the return transaction when a line's return-cap fails
 *  (a concurrent return already consumed the received qty). */
class OverReturnError extends Error {}
/** Thrown when a return would drive a part's on-hand stock below zero. */
class NegativeStockError extends Error {}

/**
 * Return received parts to the supplier (2c) — PARTIAL returns. The form
 * carries a per-line "return now" quantity (`ret_<lineId>`); each is
 * 0..(receivedQty − returnedQty). For every line with a positive quantity
 * we, in ONE transaction:
 *   1. increment the line's returnedQty,
 *   2. DECREMENT the part's qtyOnHand,
 *   3. write a NEGATIVE PartMovement (audit; reason carries the PO reference).
 * The PO status is left as-is (a return doesn't un-receive the order); the
 * returnedQty tracks how much went back. Returnable only on an order that
 * has received stock (PARTIALLY_RECEIVED or RECEIVED).
 *
 * STOCK INTEGRITY — two atomic guards, both conditional updateMany:
 *   - never return more than received: bump returnedQty only where
 *     `returnedQty <= receivedQty - returnNow` (constant cap, re-checked on
 *     the locked row) → a concurrent/over return matches 0 rows and aborts.
 *   - never drive stock negative: decrement qtyOnHand only where
 *     `qtyOnHand >= returnNow` → if stock isn't there, 0 rows → abort.
 * Either miss rolls the whole transaction back (nothing applied).
 */
export async function returnPurchaseOrderAction(formData: FormData) {
  const user = await requireOperational();

  const poId = String(formData.get("poId") ?? "").trim();
  const back = `/owner/purchasing/${poId}`;
  if (!poId) fail("Missing purchase order.");

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, garageId: user.garageId },
    include: {
      lines: { select: { id: true, partId: true, receivedQty: true, returnedQty: true } },
      supplier: { select: { name: true } },
    },
  });
  if (!po) fail("Purchase order not found.");
  if (po.status !== "RECEIVED" && po.status !== "PARTIALLY_RECEIVED")
    fail("You can only return parts from a received order.", back);

  // Parse the per-line "return now" quantities. Each must be a whole number
  // between 0 and what's still returnable (receivedQty − alreadyReturned).
  const returns: { lineId: string; partId: string; receivedQty: number; returnNow: number }[] = [];
  for (const l of po.lines) {
    const raw = String(formData.get(`ret_${l.id}`) ?? "").trim();
    const n = raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0) fail("Return quantity must be a whole number of 0 or more.", back);
    const returnable = l.receivedQty - l.returnedQty;
    if (n > returnable) fail(`You can't return more than the ${returnable} received on a line.`, back);
    // Same story as the receive flow above — an unlinked free-text
    // line has no Part row to move stock against. Refuse rather than
    // silently drop; the operator needs to know why nothing happened.
    if (n > 0 && l.partId === null) {
      fail("Link a catalogue part to this line before returning to supplier.", back);
    }
    if (n > 0 && l.partId !== null) {
      returns.push({ lineId: l.id, partId: l.partId, receivedQty: l.receivedQty, returnNow: n });
    }
  }
  if (returns.length === 0) fail("Enter a quantity to return on at least one line.", back);

  const reason = `Returned to supplier PO${po.reference ? ` ${po.reference}` : ""} — ${po.supplier.name}`;

  try {
    await prisma.$transaction(async (tx) => {
      for (const r of returns) {
        // Guard 1 — never return more than received.
        const cap = r.receivedQty - r.returnNow; // max current returnedQty that still allows this return
        const claimLine = await tx.purchaseOrderLine.updateMany({
          where: { id: r.lineId, purchaseOrderId: po.id, returnedQty: { lte: cap } },
          data: { returnedQty: { increment: r.returnNow } },
        });
        if (claimLine.count === 0) throw new OverReturnError();

        // Guard 2 — never drive stock negative.
        const claimStock = await tx.part.updateMany({
          where: { id: r.partId, qtyOnHand: { gte: r.returnNow } },
          data: { qtyOnHand: { decrement: r.returnNow } },
        });
        if (claimStock.count === 0) throw new NegativeStockError();

        await tx.partMovement.create({
          data: { partId: r.partId, delta: -r.returnNow, reason },
        });
      }
    });
  } catch (e) {
    if (e instanceof OverReturnError) {
      fail("Another return updated this order — reload and try again.", back);
    }
    if (e instanceof NegativeStockError) {
      fail("That return would drive stock below zero — check the current stock first.", back);
    }
    throw e;
  }

  revalidatePath(back);
  revalidatePath("/owner/purchasing");
  redirect(back);
}


/**
 * Convert an advisor's estimate into a DRAFT PO for a single supplier.
 *
 * Estimate line prices are IGNORED — that's the customer charge, not the
 * supplier cost. Each PO line's unitCost comes from the owner's editable
 * value in the form (prefilled on render from Part.cost). Qty likewise:
 * form value, prefilled from EstimateLine.qty (ceil'd since PO qty is
 * Int and estimate qty is Decimal).
 *
 * Guarded with requireOperational (OWNER + MASTER). Pinned by
 * master-owner-boundary.test.ts.
 *
 * Every id is re-verified against the caller's garage before use — the
 * form is a UI convenience, not a permission source. See
 * docs/Estimate-to-PO-Spec.md for the locked design decisions.
 */
export async function createPoFromEstimateAction(formData: FormData) {
  const user = await requireOperational();

  const jobCardId = String(formData.get("jobCardId") ?? "").trim();
  const estimateId = String(formData.get("estimateId") ?? "").trim();
  const supplierId = String(formData.get("supplierId") ?? "").trim();

  // For the error redirect, we need a URL the owner can retry from.
  // The from-estimate page keys on ?jobNumber= — try to send them back
  // there. If we can look up the job's number cheaply, use it; if not,
  // land them on the empty search screen.
  async function retryPath(): Promise<string> {
    if (!jobCardId) return "/owner/purchasing/from-estimate";
    const jc = await prisma.jobCard.findFirst({
      where: { id: jobCardId, garageId: user.garageId },
      select: { number: true },
    });
    return jc?.number
      ? `/owner/purchasing/from-estimate?jobNumber=${jc.number}`
      : "/owner/purchasing/from-estimate";
  }

  if (!jobCardId) fail("Missing job card.", "/owner/purchasing/from-estimate");
  if (!estimateId) fail("Missing estimate.", await retryPath());
  if (!supplierId) fail("Choose a supplier.", await retryPath());

  // Verify the job card exists in this garage. A missing/foreign id is
  // either stale form data or a tampered submission — treat identically.
  const jobCard = await prisma.jobCard.findFirst({
    where: { id: jobCardId, garageId: user.garageId },
    select: { id: true },
  });
  if (!jobCard) fail("Job card not found.", "/owner/purchasing/from-estimate");

  // Verify the estimate belongs to this job (and by inheritance, this
  // garage). Load lines so we can re-check them against the submitted
  // include[] set — form data can lie; the DB is truth. Also load the
  // jobCard's number + vehicle so we can snapshot per line without a
  // second round trip.
  const estimate = await prisma.estimate.findFirst({
    where: { id: estimateId, jobCardId: jobCard.id },
    select: {
      id: true,
      lines: {
        select: {
          id: true,
          kind: true,
          partId: true,
          declined: true,
          // Layer 1 (2026-08-02): free-text lines carry through with
          // partId null; the description IS the line identity. The PO
          // line's description column persists the snapshot even after
          // Layer 5 attaches a partId at receive.
          description: true,
          qty: true,
        },
      },
      jobCard: {
        select: {
          number: true,
          vehicle: {
            select: {
              id: true,
              make: true,
              model: true,
              year: true,
              plate: true,
              vin: true,
              engineSize: true,
              fuelType: true,
            },
          },
        },
      },
    },
  });
  if (!estimate) fail("Estimate not found on this job.", await retryPath());

  // Snapshot source — every line under this from-estimate action
  // resolves to the SAME vehicle (the job's own car), so we build the
  // snapshot object once and spread it into every line's create. See
  // the schema comment on PurchaseOrderLine for the "written once"
  // lifecycle rule.
  const vehicleSnapshot = buildPoLineVehicleSnapshot({
    jobNumber: estimate.jobCard.number,
    vehicle: estimate.jobCard.vehicle,
  });

  // Same convertibility filter the UI shows — anything the form claimed
  // to include must be in this set. A line that's since been declined or
  // unlinked (rare, but possible if the advisor edits mid-flow) drops
  // out here rather than sneaking into the PO.
  const { convertible } = filterConvertibleLines(estimate.lines);
  const convertibleIds = new Set(convertible.map((l) => l.id));

  const includedIds = formData
    .getAll("include")
    .map(String)
    .filter((s) => s.length > 0);
  const validIncludedIds = includedIds.filter((id) => convertibleIds.has(id));

  if (validIncludedIds.length === 0) {
    fail("Choose at least one part.", await retryPath());
  }

  // Supplier — must be active + in this garage. Matches every other PO
  // action so the same picker semantics apply.
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, garageId: user.garageId, active: true },
    select: { id: true },
  });
  if (!supplier) fail("Supplier not found.", await retryPath());

  // Build PO lines. Each line's qty and unitCost come from the form
  // (the owner may have edited both from the prefill). Linked lines
  // (partId set) re-verify the Part exists in the caller's garage;
  // free-text lines (partId null, Layer 1) skip that lookup and
  // write description-only.
  interface LineToCreate {
    // Layer 1 (2026-08-02): partId is nullable — a free-text estimate
    // line converts to a description-only PO line so the shop can
    // quote parts they don't stock. The schema's row-level CHECK
    // ("partId OR description") is satisfied by the description alone.
    partId: string | null;
    description: string;
    qty: number;
    // Layer 0 (2026-08-01): null = the advisor left the cost blank
    // because the supplier quote hasn't landed yet. The resulting PO
    // line reads as unpriced on every surface and blocks Mark Ordered
    // until a real price is entered. See parseMoney + canMarkOrdered.
    unitCost: string | null;
  }
  const linesToCreate: LineToCreate[] = [];
  for (const lineId of validIncludedIds) {
    const line = convertible.find((l) => l.id === lineId);
    if (!line) continue; // defensive; convertibleIds already narrowed
    const qty = parsePositiveInt(String(formData.get(`qty_${lineId}`) ?? ""));
    if (qty === null) fail("Invalid quantity.", await retryPath());
    const costResult = parseMoney(String(formData.get(`cost_${lineId}`) ?? ""));
    // Blank cost → { ok:true, value:null } is fine (awaiting quote).
    // Only garbage (NaN / negative / non-numeric) rejects.
    if (!costResult.ok) fail("Invalid unit cost.", await retryPath());
    // Description is the estimate line's own text. Kept on the PO row
    // even when partId is non-null so the "originally asked for" wording
    // survives if the linked Part is later renamed or Layer 5 links a
    // catalogue Part with a slightly different name. Trim to defend
    // against a stray whitespace-only DB row satisfying the CHECK.
    const description = String(line.description ?? "").trim();
    if (!description && line.partId === null) {
      // Impossible in practice — the schema's own CHECK prevents a row
      // with both fields null from existing — but if a data-migration
      // ever leaves one, catch it here rather than at the DB error.
      fail("This line has no description — reload and try again.", await retryPath());
    }
    if (line.partId !== null) {
      // Linked line — verify the Part is still in this garage.
      const part = await prisma.part.findFirst({
        where: { id: line.partId, garageId: user.garageId },
        select: { id: true },
      });
      if (!part) fail("Part not found — reload and try again.", await retryPath());
      linesToCreate.push({
        partId: part.id,
        description,
        qty,
        unitCost: costResult.value,
      });
    } else {
      // Free-text line (Layer 1). partId stays null; the description
      // IS the line identity until Layer 5 attaches a Part at receive.
      linesToCreate.push({
        partId: null,
        description,
        qty,
        unitCost: costResult.value,
      });
    }
  }

  // Create the PO + its lines atomically. Nested writes give us that
  // for free without an explicit $transaction call. The PO is DRAFT so
  // the owner can still edit / send it via the existing detail page —
  // reuses everything downstream (Mark ordered, Receive, Return).
  const po = await prisma.purchaseOrder.create({
    data: {
      garageId: user.garageId,
      supplierId: supplier.id,
      reference: optional(formData.get("reference")),
      note: optional(formData.get("note")),
      lines: {
        create: linesToCreate.map((l) => ({
          partId: l.partId,
          description: l.description,
          qty: l.qty,
          unitCost: l.unitCost,
          ...vehicleSnapshot,
        })),
      },
    },
    select: { id: true },
  });

  revalidatePath("/owner/purchasing");
  redirect(`/owner/purchasing/${po.id}`);
}


/**
 * Send-via-WhatsApp: log the intent, then redirect to wa.me.
 *
 * The button used to be a plain <a href="wa.me/…"> with a server-
 * computed href, which meant we had no idea whether the user clicked
 * it — no audit row. This action inverts that: form POST → server
 * builds the same body → writes a HANDED_OFF row → redirects to the
 * wa.me URL. The user's WhatsApp opens with the message drafted; they
 * still have to hit Send inside WhatsApp. That's why the audit status
 * is HANDED_OFF, not SENT — we know we handed it off, we don't know
 * they sent it.
 *
 * documentKind is captured HERE, before the redirect, from
 * poDocKind(po.lines) — deliberately not recomputed on read. A PO can
 * be edited from RFQ into a priced PO after sending; the row still
 * says "this went out as an RFQ" because that's what left the shop.
 *
 * The log write is fire-and-forget-safe (see logPoSend). If the audit
 * row fails to persist for any reason, the wa.me redirect still
 * happens — losing a row is strictly better than blocking a legit
 * send.
 */
export async function sendPurchaseOrderWhatsAppAction(formData: FormData) {
  const user = await requireOperational();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/owner/purchasing");

  const po = await prisma.purchaseOrder.findFirst({
    where: { id, garageId: user.garageId },
    include: {
      supplier: {
        select: { name: true, phone: true, contactPerson: true },
      },
      lines: {
        orderBy: { createdAt: "asc" },
        include: {
          part: {
            select: {
              name: true,
              // No `autoCreatedFromLine` — removed 2026-08-02 with the
              // resolver's chain fallback. See resolvePoVehicles.
            },
          },
        },
      },
    },
  });
  if (!po) redirect("/owner/purchasing");

  const detailPath = `/owner/purchasing/${po.id}`;

  const phoneE164 = normalizeToE164(po.supplier.phone);
  if (!phoneE164) {
    // No usable phone — this shouldn't normally reach the action because
    // the button is disabled server-side. But defence in depth: bounce
    // back cleanly rather than throw.
    redirect(detailPath);
  }

  // Capture documentKind + doc metadata BEFORE anything else. The
  // whole point of the snapshot is that a later edit (unpriced line
  // gets a price, RFQ → PO) does NOT rewrite the audit row.
  //
  // 2026-08-02: also collapses PO_DRAFT into "PO" for the send-audit
  // column. The audit is a two-way ledger (RFQ / PO), not a three-way
  // display — a DRAFT+ORDER sent to a supplier is a purchase order
  // being priced, and belongs in the PO bucket. Title, however, uses
  // the full three-way classifier so the supplier's copy reads
  // "Purchase Order (draft)" while it's still uncommitted.
  const docKind = poDocKind({
    status: po.status,
    orderedAt: po.orderedAt,
    intent: po.intent,
  });
  const capturedDocKind: "PO" | "RFQ" = docKind === "RFQ" ? "RFQ" : "PO";
  const t = await getT();
  const locale = await getLocale();
  const docTitle =
    docKind === "RFQ"
      ? t("documentRfq")
      : docKind === "PO_DRAFT"
      ? t("documentPurchaseOrderDraft")
      : t("documentPurchaseOrder");
  const docNumber = po.reference?.trim() ? po.reference : `#${po.id.slice(-6).toUpperCase()}`;

  const publicUrl = `${appUrl()}/c/po/${signId("po", po.id)}`;
  const vehicles = resolvePoVehicles(po.lines);
  const garage = await prisma.garage.findUnique({
    where: { id: user.garageId },
    select: { name: true },
  });

  const messageBody = purchaseOrderMessage({
    doc: { title: docTitle, number: docNumber, isRfq: capturedDocKind === "RFQ" },
    garage: { name: garage?.name ?? "" },
    supplier: { contactPerson: po.supplier.contactPerson },
    // Render rule (Layer 0, 2026-08-01): Part.name when the line
    // is linked to a catalogue Part, the line's stored description
    // otherwise. The row CHECK guarantees at least one of the two.
    lines: po.lines.map((l) => ({
      qty: l.qty,
      description: l.part?.name ?? l.description ?? "",
    })),
    note: po.note,
    publicUrl,
    perLineVehicle: po.lines.map((l) => vehicles.perLine.get(l.id) ?? null),
    perLineUnpriced: po.lines.map(isLineUnpriced),
    distinctVehicles: vehicles.distinct,
    lang: locale === "ar" ? "ar" : "en",
  });

  const waHref = buildWaMeUrl(phoneE164, messageBody);

  // Sender name for the audit snapshot. `user.name` on SessionUser is
  // populated from the JWT (see src/auth.ts); fall back to email if
  // the JWT was minted before name was included. Frozen here so a
  // future rename or offboarding can't rewrite the row.
  const senderName = user.name?.trim() || user.email || "unknown";

  await logPoSend({
    purchaseOrderId: po.id,
    garageId: user.garageId,
    channel: "WHATSAPP",
    recipient: phoneE164,            // snapshot of what we actually opened WhatsApp with
    documentKind: capturedDocKind,   // captured BEFORE the redirect, not on read
    sentByUserId: user.id,
    sentByName: senderName,          // snapshot — future User.name changes don't rewrite this row
    status: "HANDED_OFF",            // wa.me is a hand-off; we can't observe delivery
  });

  // Revalidate so the Sent history section reflects the new row when
  // the user comes back to the page.
  revalidatePath(detailPath);
  redirect(waHref);
}

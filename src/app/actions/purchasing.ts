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

/** Non-negative money string for Prisma Decimal; null on invalid. */
function parseMoney(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return s;
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
 */
export async function createPurchaseOrderAction(formData: FormData) {
  const user = await requireOperational();

  const supplierId = String(formData.get("supplierId") ?? "").trim();
  if (!supplierId) fail("Choose a supplier.", "/owner/purchasing/new");

  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, garageId: user.garageId, active: true },
    select: { id: true },
  });
  if (!supplier) fail("Supplier not found.", "/owner/purchasing/new");

  const po = await prisma.purchaseOrder.create({
    data: {
      garageId: user.garageId, // from session — never from input
      supplierId: supplier.id,
      reference: optional(formData.get("reference")),
      note: optional(formData.get("note")),
    },
    select: { id: true },
  });

  revalidatePath("/owner/purchasing");
  redirect(`/owner/purchasing/${po.id}`);
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
 * Add a line to a DRAFT purchase order. The part must be in the caller's
 * garage. Unit cost defaults are handled by the form; here we validate.
 */
export async function addPoLineAction(formData: FormData) {
  const user = await requireOperational();

  const poId = String(formData.get("poId") ?? "").trim();
  const partId = String(formData.get("partId") ?? "").trim();
  const qty = parsePositiveInt(String(formData.get("qty") ?? ""));
  const unitCost = parseMoney(String(formData.get("unitCost") ?? ""));

  const back = `/owner/purchasing/${poId}`;
  if (!poId) fail("Missing purchase order.");

  const po = await ownedPO(poId, user.garageId);
  if (!po) fail("Purchase order not found.");
  if (po.status !== "DRAFT") fail("Lines can only be changed on a draft order.", back);
  if (!partId) fail("Choose a part.", back);
  if (qty === null) fail("Quantity must be a whole number greater than 0.", back);
  if (unitCost === null) fail("Unit cost must be a non-negative number.", back);

  const part = await prisma.part.findFirst({
    where: { id: partId, garageId: user.garageId },
    select: { id: true },
  });
  if (!part) fail("Part not found.", back);

  await prisma.purchaseOrderLine.create({
    data: { purchaseOrderId: po.id, partId: part.id, qty, unitCost },
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
  const unitCost = parseMoney(String(formData.get("unitCost") ?? ""));

  const back = `/owner/purchasing/${poId}`;
  if (!poId || !lineId) fail("Missing line.", back);

  const po = await ownedPO(poId, user.garageId);
  if (!po) fail("Purchase order not found.");
  if (po.status !== "DRAFT") fail("Lines can only be changed on a draft order.", back);
  if (qty === null) fail("Quantity must be a whole number greater than 0.", back);
  if (unitCost === null) fail("Unit cost must be a non-negative number.", back);

  // Scope the update through the owned PO so a foreign lineId can't match.
  // updateMany returns { count } — a count of 0 means the line wasn't on
  // this PO (or was deleted between page render and submit). Silently
  // succeeding on a no-op edit would look like it worked but mutate
  // nothing; make it loud.
  const claim = await prisma.purchaseOrderLine.updateMany({
    where: { id: lineId, purchaseOrderId: po.id },
    data: { qty, unitCost },
  });
  if (claim.count === 0) fail("Line not found — reload and try again.", back);

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
    const lineCount = await prisma.purchaseOrderLine.count({
      where: { purchaseOrderId: po.id },
    });
    if (lineCount === 0) fail("Add at least one line before ordering.", back);
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
    if (n > 0) receipts.push({ lineId: l.id, partId: l.partId, qty: l.qty, receiveNow: n });
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
    if (n > 0) returns.push({ lineId: l.id, partId: l.partId, receivedQty: l.receivedQty, returnNow: n });
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
  // include[] set — form data can lie; the DB is truth.
  const estimate = await prisma.estimate.findFirst({
    where: { id: estimateId, jobCardId: jobCard.id },
    select: {
      id: true,
      lines: {
        select: { id: true, kind: true, partId: true, declined: true },
      },
    },
  });
  if (!estimate) fail("Estimate not found on this job.", await retryPath());

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

  // Build PO lines. Each line's qty and unitCost come from the form (the
  // owner may have edited both from the prefill). We look up the Part on
  // each so we can (a) verify it exists in this garage and (b) pull the
  // partId cleanly — we already know it's non-null because the line was
  // in `convertible`.
  interface LineToCreate {
    partId: string;
    qty: number;
    unitCost: string; // Prisma Decimal accepts numeric strings
  }
  const linesToCreate: LineToCreate[] = [];
  for (const lineId of validIncludedIds) {
    const line = convertible.find((l) => l.id === lineId);
    if (!line || line.partId === null) continue; // already filtered, defensive
    const qty = parsePositiveInt(String(formData.get(`qty_${lineId}`) ?? ""));
    if (qty === null) fail("Invalid quantity.", await retryPath());
    const cost = parseMoney(String(formData.get(`cost_${lineId}`) ?? ""));
    if (cost === null) fail("Invalid unit cost.", await retryPath());
    // Verify the Part is still in this garage (protects against a part
    // being deleted between page render and submit — rare but real).
    const part = await prisma.part.findFirst({
      where: { id: line.partId, garageId: user.garageId },
      select: { id: true },
    });
    if (!part) fail("Part not found — reload and try again.", await retryPath());
    linesToCreate.push({ partId: part.id, qty, unitCost: cost });
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
          qty: l.qty,
          unitCost: l.unitCost,
        })),
      },
    },
    select: { id: true },
  });

  revalidatePath("/owner/purchasing");
  redirect(`/owner/purchasing/${po.id}`);
}

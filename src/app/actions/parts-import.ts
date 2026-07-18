"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { validateInvoiceImage, saveUpload, LogoValidationError } from "@/lib/storage";
import { extractPartsInvoice, ocrCostUsd, OcrDisabledError, type OcrAttempt } from "@/lib/ocr";
import { requireOperational } from "@/lib/action-guards";

// Inventory OCR import — photograph a supplier parts invoice → OCR into a
// DRAFT PartsImport the OWNER reviews before anything hits the catalog.
// OWNER-only, garage-scoped: garageId always from the session. The image is
// validated (magic-byte + size) and stored (audit trail). Nothing becomes a
// catalog Part until confirmPartsImportAction runs on the owner's confirmed
// rows.


function fail(msg: string, path = "/owner/inventory"): never {
  redirect(`${path}?error=${encodeURIComponent(msg)}`);
}

/** One AiEvent row per OCR attempt — cost/latency metering, like Moulkia. */
async function logAttempts(attempts: OcrAttempt[], garageId: string, userId: string) {
  for (const a of attempts) {
    await prisma.aiEvent.create({
      data: {
        garageId,
        userId,
        kind: "OCR",
        model: a.model,
        sourceType: a.error ? `PARTS_INVOICE:${a.error}` : "PARTS_INVOICE",
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        costEstimate: ocrCostUsd(a.model, a.tokensIn, a.tokensOut),
        latencyMs: a.latencyMs,
      },
    });
  }
}

/**
 * Step 1 — owner uploads an invoice photo. Validate → store → OCR → create a
 * DRAFT PartsImport + its lines, then send the owner to the review table. The
 * import is created even when OCR reads nothing, so the image is kept and the
 * owner lands on a page (never a dead error) where they can discard.
 */
export async function startPartsImportAction(formData: FormData) {
  const user = await requireOperational();

  const file = formData.get("invoice");
  if (!(file instanceof File) || file.size === 0) {
    fail("Choose an invoice photo to import.");
  }
  const f = file as File;

  try {
    await validateInvoiceImage(f);
  } catch (e) {
    if (e instanceof LogoValidationError) fail(`Invoice photo: ${e.message}`);
    throw e;
  }

  // Store the image (private, garage-scoped, audit trail) and OCR it. The
  // upload happens first so the audit image survives even if OCR flakes.
  const imageUrl = await saveUpload(f, user.garageId);
  const base64 = Buffer.from(await f.arrayBuffer()).toString("base64");
  const mediaType = f.type || "image/jpeg";

  let r;
  try {
    r = await extractPartsInvoice(base64, mediaType);
  } catch (e) {
    // Production with no key → OcrDisabledError (never mock). Fail with a
    // clean message rather than a 500 or fake data.
    if (e instanceof OcrDisabledError) {
      fail("Invoice scanning is temporarily unavailable. Please add parts manually, or try again later.");
    }
    throw e;
  }
  await logAttempts(r.attempts, user.garageId, user.id);

  const imp = await prisma.partsImport.create({
    data: {
      garageId: user.garageId, // from session — never input
      imageUrl,
      supplierName: r.fields.supplierName || null,
      createdById: user.id,
      lines: {
        create: r.fields.lines.map((l) => ({
          name: l.name,
          sku: l.sku || null,
          qty: l.qty,
          unitCost: String(l.unitCost),
          flagged: l.flagged,
          include: true,
        })),
      },
    },
    select: { id: true },
  });

  revalidatePath("/owner/inventory");
  redirect(`/owner/inventory/import/${imp.id}`);
}

/** Parse a money string ≥ 0, else null. */
function money(raw: string): string | null {
  const s = raw.trim();
  if (s === "") return "0";
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return s;
}
/** Parse a whole number ≥ 0, else null. */
function count(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return 0;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}
function randomSku(): string {
  return "IMP-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * Step 2 — the owner confirms. Reads the FINAL (owner-edited) row values from
 * the review form and creates catalog Parts for only the checked rows with a
 * non-blank name. Blank SKUs get an auto id; duplicate SKUs (existing or
 * within the batch) are skipped, not overwritten. Marks the import CONFIRMED.
 * Garage-scoped; nothing here trusts a form garageId.
 */
export async function confirmPartsImportAction(formData: FormData) {
  const user = await requireOperational();

  const importId = String(formData.get("importId") ?? "").trim();
  const back = `/owner/inventory/import/${importId}`;
  if (!importId) fail("Missing import.");

  const imp = await prisma.partsImport.findFirst({
    where: { id: importId, garageId: user.garageId },
    select: { id: true, status: true },
  });
  if (!imp) fail("Import not found.");
  if (imp.status !== "DRAFT") fail("This import was already handled.", back);

  const rowCount = Number(formData.get("rowCount") ?? 0);
  const included = new Set(formData.getAll("include").map((v) => String(v)));

  // Existing SKUs in this garage — to skip duplicates rather than clash.
  const existing = await prisma.part.findMany({
    where: { garageId: user.garageId },
    select: { sku: true },
  });
  const takenSku = new Set(existing.map((p) => p.sku));

  const toCreate: { sku: string; name: string; cost: string; price: string; qtyOnHand: number }[] = [];
  let skipped = 0;

  for (let i = 0; i < rowCount; i++) {
    if (!included.has(String(i))) continue; // owner unchecked this row
    const name = String(formData.get(`name_${i}`) ?? "").trim();
    if (!name) {
      skipped++;
      continue;
    }
    const qty = count(String(formData.get(`qty_${i}`) ?? ""));
    const unitCost = money(String(formData.get(`unitCost_${i}`) ?? ""));
    if (qty === null || unitCost === null) {
      skipped++;
      continue;
    }
    let sku = String(formData.get(`sku_${i}`) ?? "").trim();
    if (!sku) {
      do {
        sku = randomSku();
      } while (takenSku.has(sku));
    }
    if (takenSku.has(sku)) {
      skipped++; // duplicate SKU — don't overwrite an existing catalog part
      continue;
    }
    takenSku.add(sku);
    toCreate.push({ sku, name, cost: unitCost, price: unitCost, qtyOnHand: qty });
  }

  await prisma.$transaction([
    ...toCreate.map((p) =>
      prisma.part.create({
        data: {
          garageId: user.garageId,
          sku: p.sku,
          name: p.name,
          cost: p.cost,
          price: p.price,
          qtyOnHand: p.qtyOnHand,
        },
      }),
    ),
    prisma.partsImport.update({ where: { id: imp.id }, data: { status: "CONFIRMED" } }),
  ]);

  revalidatePath("/owner/inventory");
  redirect(`/owner/inventory?imported=${toCreate.length}${skipped ? `&skipped=${skipped}` : ""}`);
}

/** Discard a draft import (keeps the image for the audit trail). Garage-scoped. */
export async function discardPartsImportAction(formData: FormData) {
  const user = await requireOperational();
  const importId = String(formData.get("importId") ?? "").trim();
  if (!importId) fail("Missing import.");

  const imp = await prisma.partsImport.findFirst({
    where: { id: importId, garageId: user.garageId },
    select: { id: true, status: true },
  });
  if (!imp) fail("Import not found.");
  if (imp.status === "DRAFT") {
    await prisma.partsImport.update({ where: { id: imp.id }, data: { status: "DISCARDED" } });
  }

  revalidatePath("/owner/inventory");
  redirect("/owner/inventory");
}

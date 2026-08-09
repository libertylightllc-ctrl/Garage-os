"use server";

import { revalidatePath } from "next/cache";
import { requireAdvisor } from "@/lib/action-guards";
import { prisma } from "@/lib/prisma";

/**
 * Update the customer's editable identity fields — name, phone, TRN.
 * Fired from /advisor/customers/[id] (the sole customer-detail
 * surface).
 *
 * Motivation: the customer, not the vehicle, owns these fields.
 * Editing them on a vehicle page produces the "three cars, three
 * TRN forms" bug that AR flagged. Consolidating here means:
 *   - one form, one save; the change applies to every vehicle the
 *     customer owns automatically (there is only one row);
 *   - the plate-transfer workflow (AGENTS.md "vehicle sold →
 *     advisor can edit owner name + mobile") has its natural home.
 *
 * Every field is optional-with-blank-means-clear semantics:
 *   - name empty → error (name is required on Customer)
 *   - phone empty → error (phone is required on Customer)
 *   - trn empty → stored as null (walk-in retail, not VAT-registered)
 *
 * Guard: requireAdvisor (ADVISOR + OWNER + MASTER). Garage-scoped by
 * WHERE id + garageId; a stale/forged customerId that belongs to
 * another garage produces count === 0 and we return silently rather
 * than throwing, so an unlucky race can't leak cross-garage existence
 * via error text.
 */
export async function updateCustomerAction(formData: FormData) {
    const user = await requireAdvisor();
    const customerId = String(formData.get("customerId") ?? "").trim();
    const rawName = String(formData.get("name") ?? "").trim();
    const rawPhone = String(formData.get("phone") ?? "").trim();
    // Trim + normalise TRN to null on empty. UAE TRNs are 15 digits
    // but we accept whatever the shop enters — GCC TRNs, KSA TRNs
    // later, hand-written spacing all round-trip cleanly. Wrong-
    // format TRN is a data-quality issue, not a save-time error.
    const rawTrn = String(formData.get("trn") ?? "").trim();

    if (!customerId) return;
    if (!rawName) throw new Error("Customer name is required.");
    if (!rawPhone) throw new Error("Customer phone is required.");

    await prisma.customer.updateMany({
        where: { id: customerId, garageId: user.garageId },
        data: {
            name: rawName,
            phone: rawPhone,
            trn: rawTrn === "" ? null : rawTrn,
        },
    });

    // The customer detail page + any vehicle detail page that shows
    // the customer's name will restat on next visit; nothing else on
    // the app reads Customer.trn/name/phone dynamically.
    revalidatePath(`/advisor/customers/${customerId}`);
    revalidatePath(`/advisor/vehicles`);
}

"use server";

import { revalidatePath } from "next/cache";
import { requireAdvisor } from "@/lib/action-guards";
import { prisma } from "@/lib/prisma";

/**
 * Customer-scoped updates initiated from the advisor's vehicle detail
 * page. Owner-of-the-vehicle edits (name, phone, TRN) all belong on
 * that surface because that is where the advisor is actually looking
 * at "this car's owner."
 *
 * For the compliance commit only `trn` ships. Name / phone edits are
 * covered by AGENTS.md ("advisor can edit owner name + mobile") but
 * are a separate slice — bundling more here would widen the PR beyond
 * the FTA-compliance intent.
 *
 * Guard: requireAdvisor (ADVISOR + OWNER + MASTER). Garage-scoped by
 * joining Customer → this action's user.garageId; a stale/forged
 * customerId that belongs to another garage produces count === 0 and
 * we return silently rather than throwing, so an unlucky race can't
 * leak "customer X exists in another garage" via the error text.
 */
export async function updateCustomerTrnAction(formData: FormData) {
    const user = await requireAdvisor();
    const customerId = String(formData.get("customerId") ?? "").trim();
    // Trim + normalise to null on empty. UAE TRNs are 15 digits but we
    // accept whatever the shop enters — GCC TRNs, KSA TRNs later, and
    // hand-written spacing all round-trip cleanly. Validation is a
    // separate concern from persistence; wrong-format TRN is a data-
    // quality issue, not a save-time error.
    const raw = String(formData.get("trn") ?? "").trim();
    const trn = raw === "" ? null : raw;

    if (!customerId) return;

    // Garage-scoped update. `updateMany` with a scoped where returns
    // count === 0 for cross-garage attempts — no throw, no leak.
    await prisma.customer.updateMany({
        where: { id: customerId, garageId: user.garageId },
        data: { trn },
    });

    revalidatePath(`/advisor/vehicles`);
}

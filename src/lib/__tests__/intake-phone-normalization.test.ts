/**
 * Phone normalization on public intake paths (AR 2026-08-21).
 *
 * Public booking + WhatsApp webhook previously created / upserted
 * Customer rows on the RAW phone the caller sent. The same person
 * typing "+971 50 123 4567" one day and "0501234567" the next
 * produced two rows. Moulkia intake had normalizeUaePhone() wired
 * (intake-moulkia.ts:311); these two paths did not.
 *
 * Fix pins:
 *   A) createBookingPublic: three format variants of the SAME UAE
 *      phone all resolve to one Customer row.
 *   B) Blank / all-punctuation phone after normalization is refused
 *      (rejected with "Missing booking details").
 *
 * Cleanup by garage prefix.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error("REDIRECT:" + url); },
}));
// createBookingPublic doesn't call auth() (it's the public path),
// but intake.ts imports @/lib/action-guards → @/auth at module load
// and next-auth's env module fails to import under Vitest. Stub it.
vi.mock("@/auth", () => ({ auth: async () => null }));

// runIntake makes a live model call — mock it so the test doesn't hit
// the network. Return an AI-shaped proposal so the Booking row's
// aiProposalJson field is well-formed.
vi.mock("@/lib/intake", () => ({
  runIntake: async () => ({ likelyIssue: "test", suggestedServices: ["diag"], urgency: "normal" }),
}));

const { createBookingPublic } = await import("@/app/actions/intake");

const P = "phone-normalize-test-";
const gid = P + "g1";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function cleanup() {
  await prisma.jobStep.deleteMany({ where: { jobCard: { garageId: gid } } });
  await prisma.jobCard.deleteMany({ where: { garageId: gid } });
  await prisma.booking.deleteMany({ where: { garageId: gid } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: gid } } });
  await prisma.customer.deleteMany({ where: { garageId: gid } });
  await prisma.garage.deleteMany({ where: { id: gid } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.garage.create({ data: { id: gid, name: gid } });
});
afterAll(cleanup);

describe("createBookingPublic — phone normalisation", () => {
  it("three format variants resolve to ONE Customer row", async () => {
    const base = {
      garageId: gid, name: "Ahmed",
      make: "Toyota", model: "Camry", plate: "AAA 111",
      text: "AC not cold",
    };

    // Three shapes of the same UAE mobile.
    for (const phone of ["+971 50 123 4567", "0501234567", "971501234567"]) {
      await expect(
        createBookingPublic(form({ ...base, phone })),
      ).rejects.toThrow(/REDIRECT/);
    }

    const customers = await prisma.customer.findMany({ where: { garageId: gid } });
    expect(customers).toHaveLength(1);
    expect(customers[0].phone).toBe("501234567");

    // Three bookings on the ONE customer.
    const bookings = await prisma.booking.findMany({ where: { garageId: gid } });
    expect(bookings).toHaveLength(3);
    for (const b of bookings) expect(b.customerId).toBe(customers[0].id);
  });

  it("blank phone after normalisation is refused", async () => {
    // All-punctuation input — normalizeUaePhone strips it to "".
    await expect(
      createBookingPublic(form({
        garageId: gid, name: "X", phone: "()-+",
        make: "T", model: "C", plate: "P",
        text: "test",
      })),
    ).rejects.toThrow(/Missing booking details/);
    expect(await prisma.customer.count({ where: { garageId: gid } })).toBe(0);
  });

  it("blank phone in the form is refused (same error)", async () => {
    await expect(
      createBookingPublic(form({
        garageId: gid, name: "X", phone: "",
        make: "T", model: "C", plate: "P",
        text: "test",
      })),
    ).rejects.toThrow(/Missing booking details/);
    expect(await prisma.customer.count({ where: { garageId: gid } })).toBe(0);
  });
});

/**
 * Phone normalisation on public intake paths.
 *
 * AR 2026-08-21 (original): pin that createBookingPublic runs
 * normalizeUaePhone before the upsert so "+971 50 123 4567" /
 * "0501234567" / "971501234567" of the same person collapse to
 * one Customer row (previously created three).
 *
 * AR 2026-08-23 (contract change): the four write paths now route
 * through `normalizeCustomerPhoneForWrite` and store E.164 shape
 * ("971501234567") — NOT the 9-digit legacy shape ("501234567").
 * Unresolvable input (a real string that isn't dialable) is stored
 * RAW with phoneNeedsReview=true rather than refused — losing the
 * number is worse than a flagged row. Only truly-blank input is
 * refused.
 *
 * Fix pins:
 *   A) createBookingPublic: three format variants of the SAME UAE
 *      phone all resolve to one Customer row, stored as E.164.
 *   B) Bare 9-digit UAE mobile (leading 0 dropped in copy-paste)
 *      resolves to E.164 too — the two normalisers now agree.
 *   C) Unresolvable input (all-punctuation, "call me at 5pm")
 *      is stored raw with phoneNeedsReview=true, NOT refused.
 *   D) Truly-blank input (empty string) IS refused — nothing to store.
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
  it("three format variants resolve to ONE Customer row, stored as E.164", async () => {
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
    // AR 2026-08-23 — write-time contract stores E.164, not the
    // 9-digit legacy shape. Was "501234567" under normalizeUaePhone.
    expect(customers[0].phone).toBe("971501234567");
    expect(customers[0].phoneNeedsReview).toBe(false);

    // Three bookings on the ONE customer.
    const bookings = await prisma.booking.findMany({ where: { garageId: gid } });
    expect(bookings).toHaveLength(3);
    for (const b of bookings) expect(b.customerId).toBe(customers[0].id);
  });

  it("bare 9-digit UAE mobile (leading 0 lost) resolves to E.164 too", async () => {
    // AR 2026-08-23 — the exact shape that used to be storable as
    // "567424133" and rejected at wa.me send time. Widened
    // normalizeToE164 now prefixes 971 at the write path, so the
    // send path can direct-dial next time.
    await expect(
      createBookingPublic(form({
        garageId: gid, name: "Ahmed",
        make: "Toyota", model: "Camry", plate: "AAA 222",
        text: "AC not cold", phone: "567424133",
      })),
    ).rejects.toThrow(/REDIRECT/);
    const customers = await prisma.customer.findMany({ where: { garageId: gid } });
    expect(customers).toHaveLength(1);
    expect(customers[0].phone).toBe("971567424133");
    expect(customers[0].phoneNeedsReview).toBe(false);
  });

  it("unresolvable input is stored raw with phoneNeedsReview=true, NOT refused", async () => {
    // "()-+" strips to just "+" then to empty digits — E.164 rejects.
    // AR 2026-08-23 contract: store raw, flag it, keep going. Losing
    // what the caller typed is worse than a flagged row.
    await expect(
      createBookingPublic(form({
        garageId: gid, name: "X", phone: "()-+",
        make: "T", model: "C", plate: "P",
        text: "test",
      })),
    ).rejects.toThrow(/REDIRECT/);
    const customers = await prisma.customer.findMany({ where: { garageId: gid } });
    expect(customers).toHaveLength(1);
    expect(customers[0].phone).toBe("()-+");
    expect(customers[0].phoneNeedsReview).toBe(true);
  });

  it("truly-blank phone (empty string) IS refused — nothing to store", async () => {
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

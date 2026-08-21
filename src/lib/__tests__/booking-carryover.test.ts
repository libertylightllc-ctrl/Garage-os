/**
 * confirmBookingAction — Booking → JobCard carry-over (AR 2026-08-21).
 *
 * Regression: confirming a booking created the JobCard with only
 * garageId / vehicleId / advisorId / bookingId / status / publicToken.
 * The customer's own complaint text and any photos they uploaded on
 * the public booking page were left on the Booking row and never
 * propagated. Advisor opened the fresh job and saw an empty
 * complaint field + no photos.
 *
 * Fix pins:
 *   A) Booking.rawText → JobCard.complaint (trimmed; empty stays null)
 *   B) Booking.photoUrls[] → one JobStep(type=PHOTO) per URL,
 *      transcript="Booking photo" so the timeline reads correctly
 *   C) Empty rawText / photoUrls[] both no-op cleanly (no bogus
 *      JobStep rows written)
 *   D) The action is transactional — all-or-nothing across
 *      jobCard.create + jobStep.createMany + booking.update
 *      (implicit via prisma.$transaction; not directly asserted, but
 *      the success path DOES exercise the whole transaction).
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { mockSessionAndSeed } from "@/lib/__tests__/helpers/mock-session-and-seed";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error("REDIRECT:" + url); },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const { confirmBookingAction } = await import("@/app/actions/intake");

const P = "booking-carryover-test-";
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
  await prisma.user.deleteMany({ where: { garageId: gid } });
  await prisma.garage.deleteMany({ where: { id: gid } });
}

async function seedBooking(opts: { rawText: string | null; photoUrls: string[] }) {
  const customer = await prisma.customer.create({
    data: { garageId: gid, name: "C", phone: P + "phone", waId: P + "phone" },
  });
  const vehicle = await prisma.vehicle.create({
    data: { customerId: customer.id, make: "T", model: "C", plate: P + "plt" },
  });
  const booking = await prisma.booking.create({
    data: {
      garageId: gid,
      customerId: customer.id,
      vehicleId: vehicle.id,
      channel: "WEB",
      rawText: opts.rawText,
      photoUrls: opts.photoUrls,
      status: "PROPOSED",
    },
  });
  return booking;
}

beforeEach(async () => {
  await cleanup();
  await prisma.garage.create({ data: { id: gid, name: gid } });
  mockAuth.mockReset();
  mockAuth.mockResolvedValue(
    await mockSessionAndSeed({ id: P + "adv", garageId: gid, role: "ADVISOR" }),
  );
});
afterAll(cleanup);

describe("confirmBookingAction — carry-over", () => {
  it("A) rawText → JobCard.complaint (trimmed)", async () => {
    const booking = await seedBooking({
      rawText: "  car makes a grinding noise on the left  ",
      photoUrls: [],
    });

    await expect(
      confirmBookingAction(form({ bookingId: booking.id })),
    ).rejects.toThrow(/REDIRECT:\/advisor\/jobs\//);

    const job = await prisma.jobCard.findFirst({
      where: { bookingId: booking.id },
      select: { complaint: true, id: true },
    });
    expect(job).not.toBeNull();
    expect(job!.complaint).toBe("car makes a grinding noise on the left");
  });

  it("A) empty/whitespace-only rawText → complaint stays NULL", async () => {
    const booking = await seedBooking({ rawText: "   \n  ", photoUrls: [] });

    await expect(
      confirmBookingAction(form({ bookingId: booking.id })),
    ).rejects.toThrow(/REDIRECT/);

    const job = await prisma.jobCard.findFirst({
      where: { bookingId: booking.id },
      select: { complaint: true },
    });
    expect(job!.complaint).toBeNull();
  });

  it("B) photoUrls[] → one JobStep(PHOTO) per URL, transcript='Booking photo'", async () => {
    const urls = [
      "https://xyz.supabase.co/storage/v1/object/sign/bucket/g_1/one.jpg?token=a",
      "https://xyz.supabase.co/storage/v1/object/sign/bucket/g_1/two.jpg?token=b",
      "https://xyz.supabase.co/storage/v1/object/sign/bucket/g_1/three.jpg?token=c",
    ];
    const booking = await seedBooking({ rawText: "note", photoUrls: urls });

    await expect(
      confirmBookingAction(form({ bookingId: booking.id })),
    ).rejects.toThrow(/REDIRECT/);

    const job = await prisma.jobCard.findFirstOrThrow({ where: { bookingId: booking.id } });
    const steps = await prisma.jobStep.findMany({
      where: { jobCardId: job.id },
      orderBy: { createdAt: "asc" },
    });
    expect(steps).toHaveLength(3);
    for (const s of steps) {
      expect(s.type).toBe("PHOTO");
      expect(s.transcript).toBe("Booking photo");
    }
    const stepUrls = new Set(steps.map((s) => s.photoUrl));
    for (const u of urls) expect(stepUrls.has(u)).toBe(true);
  });

  it("C) empty photoUrls → zero JobStep rows created", async () => {
    const booking = await seedBooking({ rawText: "just text", photoUrls: [] });
    await expect(
      confirmBookingAction(form({ bookingId: booking.id })),
    ).rejects.toThrow(/REDIRECT/);
    const job = await prisma.jobCard.findFirstOrThrow({ where: { bookingId: booking.id } });
    const stepCount = await prisma.jobStep.count({ where: { jobCardId: job.id } });
    expect(stepCount).toBe(0);
  });

  it("booking flips to CONFIRMED and the JobCard is linked back via bookingId", async () => {
    const booking = await seedBooking({ rawText: "hi", photoUrls: [] });
    await expect(
      confirmBookingAction(form({ bookingId: booking.id })),
    ).rejects.toThrow(/REDIRECT/);
    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after!.status).toBe("CONFIRMED");
    const job = await prisma.jobCard.findFirst({ where: { bookingId: booking.id } });
    expect(job).not.toBeNull();
  });
});

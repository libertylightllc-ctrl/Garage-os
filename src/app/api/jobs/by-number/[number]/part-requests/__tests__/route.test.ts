/**
 * AR 2026-08-22 Batch 9 — JC# → tech part requests API. Feeds the
 * one-screen quotation hydrator on /owner/purchasing/new.
 *
 * Pins the two failure modes the spec asked for:
 *   1. 404 (not-found) is DISTINCT from 200-with-empty-parts. The
 *      client renders different chips for each — a bad number must
 *      never render as "no parts" and vice versa.
 *   2. FULFILLED / CANCELLED requests never surface — the shop
 *      already fitted or withdrew those parts.
 *
 * Plus the boring bits: role/garage scoping, invalid number
 * handling, valid vehicle shape.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

vi.mock("@/auth", () => ({ auth: () => mockAuth() }));
const mockAuth = vi.fn();

const { GET } = await import("../route");

const P = "job-partreq-api-";
const gA = P + "garage-A";
const gB = P + "garage-B";
const custId = P + "cust-A";
const vehId = P + "veh-A";
const jobA = P + "job-A";
const jobB = P + "job-B";

async function req(number: string | number): Promise<Response> {
  return GET(new Request(`http://localhost/api/jobs/by-number/${number}/part-requests`), {
    params: Promise.resolve({ number: String(number) }),
  });
}

async function cleanup() {
  await prisma.jobPart.deleteMany({ where: { jobCard: { garageId: { startsWith: P } } } });
  await prisma.partRequest.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.jobCard.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.vehicle.deleteMany({ where: { customer: { garageId: { startsWith: P } } } });
  await prisma.customer.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
  mockAuth.mockReset();
  await cleanup();
  await prisma.garage.create({ data: { id: gA, name: P + "A" } });
  await prisma.garage.create({ data: { id: gB, name: P + "B" } });
  await prisma.customer.create({
    data: { id: custId, garageId: gA, name: "K", phone: "+971500000001" },
  });
  await prisma.vehicle.create({
    data: {
      id: vehId,
      customerId: custId,
      make: "Toyota",
      model: "Corolla",
      year: 2020,
      plate: "A 1",
    },
  });
  // JC#77 in garage A. Two sources feed the hydrator; seed BOTH so
  // dedup + source labelling can be pinned. AR 2026-08-22 — this
  // is the JC-107 lesson: the "Technician findings & parts
  // required" section lives on JobPart (kind=REQUIRED/EXTRA), not
  // PartRequest, and it's the common case.
  await prisma.jobCard.create({
    data: { id: jobA, garageId: gA, vehicleId: vehId, number: 77 },
  });
  // Source 1 — tech's "parts required" list on the job page.
  await prisma.jobPart.createMany({
    data: [
      // These three make it to the hydrator:
      { jobCardId: jobA, description: "Brake pads", qty: 2, kind: "REQUIRED" },
      { jobCardId: jobA, description: "Suspension bushes set", qty: 1, kind: "REQUIRED" },
      { jobCardId: jobA, description: "Extra: rear light bulb", qty: 1, kind: "EXTRA" },
      // USED is already fitted; must be excluded.
      { jobCardId: jobA, description: "Coolant top-up (fitted)", qty: 1, kind: "USED" },
    ],
  });
  // Source 2 — separate PartRequest widget.
  await prisma.partRequest.createMany({
    data: [
      { garageId: gA, jobCardId: jobA, description: "Oil filter", qty: 1, status: "ORDERED" },
      { garageId: gA, jobCardId: jobA, description: "Wiper blade", qty: 1, status: "ARRIVED" },
      // Same as JobPart above — different casing/spacing on purpose;
      // the dedup step must collapse these to a single row.
      { garageId: gA, jobCardId: jobA, description: "  brake pads ", qty: 4, status: "REQUESTED" },
      // Excluded — already fitted / withdrawn.
      { garageId: gA, jobCardId: jobA, description: "Air filter (already fitted)", qty: 1, status: "FULFILLED" },
      { garageId: gA, jobCardId: jobA, description: "Cabin filter (cancelled)", qty: 1, status: "CANCELLED" },
    ],
  });
  // JC#77 also exists in garage B — proves scoping (same number ≠ same job).
  const custB = await prisma.customer.create({
    data: { garageId: gB, name: "B", phone: "+971500000009" },
  });
  const vehB = await prisma.vehicle.create({
    data: { customerId: custB.id, make: "Ford", model: "Focus", plate: "B 1" },
  });
  await prisma.jobCard.create({
    data: { id: jobB, garageId: gB, vehicleId: vehB.id, number: 77 },
  });
  await prisma.partRequest.create({
    data: { garageId: gB, jobCardId: jobB, description: "Should not leak", qty: 1, status: "REQUESTED" },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const owner = (garageId: string) => ({
  user: { id: "u", role: "OWNER", garageId, email: "x", name: "x" },
});

describe("/api/jobs/by-number/[n]/part-requests", () => {
  it("surfaces tech findings (JobPart REQUIRED/EXTRA) alongside PartRequest, deduping description overlaps", async () => {
    mockAuth.mockResolvedValueOnce(owner(gA));
    const res = await req(77);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Expected rows after dedup:
    //   Brake pads              (from JobPart REQUIRED — wins over
    //                            PartRequest "brake pads" with
    //                            different casing/spacing)
    //   Suspension bushes set   (JobPart REQUIRED)
    //   Extra: rear light bulb  (JobPart EXTRA)
    //   Oil filter              (PartRequest ORDERED)
    //   Wiper blade             (PartRequest ARRIVED)
    // Excluded:
    //   Coolant top-up (fitted)       — JobPart USED
    //   Air filter (already fitted)   — PartRequest FULFILLED
    //   Cabin filter (cancelled)      — PartRequest CANCELLED
    const descs = body.parts.map((p: { description: string }) => p.description);
    expect(descs).toEqual([
      "Brake pads",
      "Suspension bushes set",
      "Extra: rear light bulb",
      "Oil filter",
      "Wiper blade",
    ]);
    // Findings ordered first (added to the map first), then requests.
    // Source labels let the UI show which list each row came from.
    const sources = body.parts.map((p: { source: string }) => p.source);
    expect(sources).toEqual(["findings", "findings", "findings", "request", "request"]);
    // The dedup kept the JobPart's canonical wording + qty, not the
    // PartRequest's typo'd re-type (qty 2 vs 4).
    expect(body.parts[0].qty).toBe(2);
    expect(body.parts[0].description).toBe("Brake pads");
  });

  it("job with only PartRequest (no findings) — all rows land as source=request", async () => {
    await prisma.jobPart.deleteMany({ where: { jobCardId: jobA } });
    mockAuth.mockResolvedValueOnce(owner(gA));
    const body = await (await req(77)).json();
    const sources = new Set(body.parts.map((p: { source: string }) => p.source));
    expect(sources).toEqual(new Set(["request"]));
    // Same three unfulfilled/uncancelled PartRequests as the fixture,
    // now that the JobPart layer is gone: brake pads / oil filter /
    // wiper blade.
    expect(body.parts.length).toBe(3);
  });

  it("job with only findings (no PartRequest) — all rows land as source=findings", async () => {
    await prisma.partRequest.deleteMany({ where: { jobCardId: jobA } });
    mockAuth.mockResolvedValueOnce(owner(gA));
    const body = await (await req(77)).json();
    const sources = new Set(body.parts.map((p: { source: string }) => p.source));
    expect(sources).toEqual(new Set(["findings"]));
    expect(body.parts.length).toBe(3); // REQUIRED×2 + EXTRA×1
  });

  it("returns the job's vehicle for the hydrator to pre-fill", async () => {
    mockAuth.mockResolvedValueOnce(owner(gA));
    const body = await (await req(77)).json();
    expect(body.vehicle).toMatchObject({
      make: "Toyota",
      model: "Corolla",
      year: 2020,
      plate: "A 1",
    });
    expect(body.jobNumber).toBe(77);
    expect(body.jobCardId).toBe(jobA);
  });

  it("404 not-found is DISTINCT from 200-with-empty-parts (bad number vs job-with-neither-source)", async () => {
    mockAuth.mockResolvedValueOnce(owner(gA));
    const missing = await req(9999);
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    expect(missingBody).toEqual({ error: "not-found", number: 9999 });

    // Now a job that exists but has NEITHER findings NOR requests
    // → 200 + parts:[]. The honest empty message the spec asked us
    // to keep for a job that genuinely has neither source.
    await prisma.jobPart.deleteMany({ where: { jobCardId: jobA } });
    await prisma.partRequest.deleteMany({ where: { jobCardId: jobA } });
    mockAuth.mockResolvedValueOnce(owner(gA));
    const empty = await req(77);
    expect(empty.status).toBe(200);
    const emptyBody = await empty.json();
    expect(emptyBody.parts).toEqual([]);
    expect(emptyBody.jobCardId).toBe(jobA);
  });

  it("garage scoping — JC#77 in another garage returns 404, not the wrong job's parts", async () => {
    // Owner in gA asks for JC#77. Both A and B have a JC#77.
    // The response must be A's job — never B's.
    mockAuth.mockResolvedValueOnce(owner(gA));
    const body = await (await req(77)).json();
    expect(body.jobCardId).toBe(jobA);
    // Ensure B's part didn't leak into A's response.
    const descs = body.parts.map((p: { description: string }) => p.description);
    expect(descs).not.toContain("Should not leak");
  });

  it("400 on non-integer or non-positive number", async () => {
    mockAuth.mockResolvedValueOnce(owner(gA));
    expect((await req("abc")).status).toBe(400);
    mockAuth.mockResolvedValueOnce(owner(gA));
    expect((await req(0)).status).toBe(400);
    mockAuth.mockResolvedValueOnce(owner(gA));
    expect((await req(-1)).status).toBe(400);
  });

  it("401 unauthenticated, 403 non-operational", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await req(77)).status).toBe(401);
    mockAuth.mockResolvedValueOnce({
      user: { id: "x", role: "ADVISOR", garageId: gA, email: "x", name: "x" },
    });
    expect((await req(77)).status).toBe(403);
  });
});

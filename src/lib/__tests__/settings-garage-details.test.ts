/**
 * updateGarageDetailsAction — Batch B (AR 2026-08-19).
 *
 * The action edits Garage.{name,trn,address,defaultLang} scoped to
 * the caller's own garage. Operational (requireOperational — OWNER +
 * MASTER) — ADVISOR + TECH + CASHIER refused. Widened 2026-08-20
 * after narrow-gate audit; matches pricing-defaults precedent
 * (2026-08-14). Test coverage:
 *
 *   A) OWNER happy path — all four fields updated, DB row reflects,
 *      redirect 'ok=garage-details'.
 *   B) Field-length caps — name too long, trn too long, address too
 *      long each redirect with the specific error slug.
 *   C) Blank optional fields clear to null (address / trn / lang).
 *   D) Invalid defaultLang value → redirect error, no DB write.
 *   E) MASTER allowed; ADVISOR refused before any DB write.
 *   F) Tenant isolation — a smuggled garageId in formData is
 *      IGNORED. The action only ever updates session.garageId.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { mockSessionAndSeed } from "@/lib/__tests__/helpers/mock-session-and-seed";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: () => mockAuth() }));

const { updateGarageDetailsAction } = await import("@/app/actions/settings");

const P = "settings-garage-details-test-";
const gA = P + "garage-A";
const gB = P + "garage-B";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function cleanup() {
  await prisma.user.deleteMany({ where: { garageId: { startsWith: P } } });
  await prisma.garage.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
  await cleanup();
  mockAuth.mockReset();
  for (const g of [gA, gB]) {
    await prisma.garage.create({
      data: {
        id: g,
        name: `${g} — seeded`,
        trn: "100000000000001",
        address: null,
        defaultLang: null,
      },
    });
  }
});
afterAll(cleanup);

async function ownerOf(garageId: string) {
  return mockSessionAndSeed({
    id: P + "owner-" + garageId,
    garageId,
    role: "OWNER",
  });
}

describe("updateGarageDetailsAction", () => {
  it("A) OWNER: updates name, trn, address, defaultLang", async () => {
    mockAuth.mockResolvedValue(await ownerOf(gA));

    await expect(
      updateGarageDetailsAction(form({
        name: "Deira Central Motors",
        trn: "100000000000042",
        address: "P.O. Box 12345\nShop 7, Al Ittihad Rd\nDeira, Dubai",
        defaultLang: "ar",
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-details/);

    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.name).toBe("Deira Central Motors");
    expect(g!.trn).toBe("100000000000042");
    expect(g!.address).toBe("P.O. Box 12345\nShop 7, Al Ittihad Rd\nDeira, Dubai");
    expect(g!.defaultLang).toBe("ar");
    // Other garage untouched.
    const gOther = await prisma.garage.findUnique({ where: { id: gB } });
    expect(gOther!.name).toBe(`${gB} — seeded`);
  });

  it("B) name required — empty name rejected", async () => {
    mockAuth.mockResolvedValue(await ownerOf(gA));
    await expect(
      updateGarageDetailsAction(form({
        name: "",
        trn: "",
        address: "",
        defaultLang: "",
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?error=garage-name-required/);

    // No DB write.
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.name).toBe(`${gA} — seeded`);
  });

  it("B) name > 80 chars rejected", async () => {
    mockAuth.mockResolvedValue(await ownerOf(gA));
    await expect(
      updateGarageDetailsAction(form({
        name: "x".repeat(81),
        trn: "",
        address: "",
        defaultLang: "",
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?error=garage-name-too-long/);
  });

  it("B) TRN > 40 chars rejected", async () => {
    mockAuth.mockResolvedValue(await ownerOf(gA));
    await expect(
      updateGarageDetailsAction(form({
        name: "OK",
        trn: "1".repeat(41),
        address: "",
        defaultLang: "",
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?error=trn-too-long/);
  });

  it("B) address > 400 chars rejected", async () => {
    mockAuth.mockResolvedValue(await ownerOf(gA));
    await expect(
      updateGarageDetailsAction(form({
        name: "OK",
        trn: "",
        address: "y".repeat(401),
        defaultLang: "",
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?error=address-too-long/);
  });

  it("C) blank optional fields clear to null", async () => {
    mockAuth.mockResolvedValue(await ownerOf(gA));

    // Seed with values.
    await prisma.garage.update({
      where: { id: gA },
      data: { trn: "100000000000042", address: "OLD ADDR", defaultLang: "ar" },
    });

    await expect(
      updateGarageDetailsAction(form({
        name: "Deira Central Motors",
        trn: "",
        address: "",
        defaultLang: "",
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-details/);

    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.trn).toBeNull();
    expect(g!.address).toBeNull();
    expect(g!.defaultLang).toBeNull();
  });

  it("D) invalid defaultLang rejected, no DB write", async () => {
    mockAuth.mockResolvedValue(await ownerOf(gA));
    await expect(
      updateGarageDetailsAction(form({
        name: "OK",
        trn: "",
        address: "",
        defaultLang: "es", // not supported
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?error=garage-lang-invalid/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.defaultLang).toBeNull();
  });

  it("E) MASTER allowed — writes go through (widened 2026-08-20)", async () => {
    mockAuth.mockResolvedValue(
      await mockSessionAndSeed({
        id: P + "master-" + gA,
        garageId: gA,
        role: "MASTER",
      }),
    );
    await expect(
      updateGarageDetailsAction(form({
        name: "Set by MASTER",
        trn: "",
        address: "",
        defaultLang: "",
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-details/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.name).toBe("Set by MASTER");
  });

  it("E) ADVISOR refused", async () => {
    mockAuth.mockResolvedValue(
      await mockSessionAndSeed({
        id: P + "adv-" + gA,
        garageId: gA,
        role: "ADVISOR",
      }),
    );
    await expect(
      updateGarageDetailsAction(form({
        name: "hacked",
        trn: "",
        address: "",
        defaultLang: "",
      })),
    ).rejects.toThrow(/Not authorized/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.name).toBe(`${gA} — seeded`);
  });

  it("F) tenant isolation — smuggled garageId in form ignored", async () => {
    mockAuth.mockResolvedValue(await ownerOf(gA));
    await expect(
      updateGarageDetailsAction(form({
        name: "trying to touch B",
        trn: "",
        address: "",
        defaultLang: "",
        // Attempted attack: the form claims garageId=gB. The action
        // MUST ignore it and write to session.garageId (=gA) only.
        garageId: gB,
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-details/);

    const a = await prisma.garage.findUnique({ where: { id: gA } });
    const b = await prisma.garage.findUnique({ where: { id: gB } });
    expect(a!.name).toBe("trying to touch B");
    expect(b!.name).toBe(`${gB} — seeded`); // untouched
  });
});

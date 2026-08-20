/**
 * Garage identity editors — AR 2026-08-19 (Batch B), split into four
 * per-field actions 2026-08-20 after AR hit the two-tab overwrite:
 * saving the address on one tab silently wiped the defaultLang that
 * a fresh save on another tab had just written, because the old
 * single-form shape posted every field on every save.
 *
 * Operational (requireOperational — OWNER + MASTER) — ADVISOR + TECH
 * + CASHIER refused. Coverage:
 *
 *   A) Each action writes ONLY its own column — the linchpin
 *      assertion that makes the two-tab bug unrepresentable.
 *   B) Field-length caps for name / TRN / address.
 *   C) Blank optional fields clear to null (TRN / address / lang).
 *   D) Invalid defaultLang value rejected.
 *   E) MASTER allowed on each of the four; ADVISOR refused on each.
 *   F) Tenant isolation — a smuggled garageId in formData is
 *      ignored. Each action only ever writes session.garageId.
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

const {
  updateGarageNameAction,
  updateGarageTrnAction,
  updateGarageAddressAction,
  updateGarageDefaultLangAction,
} = await import("@/app/actions/settings");

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

async function operationalOf(garageId: string, role: "OWNER" | "MASTER" = "OWNER") {
  return mockSessionAndSeed({
    id: P + role.toLowerCase() + "-" + garageId,
    garageId,
    role,
  });
}

describe("garage identity — per-field actions", () => {
  it("A) name save touches ONLY name — trn / address / defaultLang untouched", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));

    // Seed the other three fields with values so we can prove they
    // survive a name save unmodified.
    await prisma.garage.update({
      where: { id: gA },
      data: { trn: "100000000000042", address: "SEEDED ADDR", defaultLang: "ar" },
    });

    await expect(
      updateGarageNameAction(form({ name: "Deira Central Motors" })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-name/);

    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.name).toBe("Deira Central Motors");
    // Linchpin — the three sibling fields DIDN'T move.
    expect(g!.trn).toBe("100000000000042");
    expect(g!.address).toBe("SEEDED ADDR");
    expect(g!.defaultLang).toBe("ar");
  });

  it("A) address save touches ONLY address — the two-tab overwrite bug (2026-08-20)", async () => {
    // The exact incident: operator has Settings open on tab A with
    // an old defaultLang=null in the DOM. Tab B sets defaultLang=ar.
    // Tab A now saves the address. Under the old single-form shape,
    // tab A's save would clobber defaultLang back to null. Split
    // forms make it structurally impossible.
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await prisma.garage.update({
      where: { id: gA },
      data: { defaultLang: "ar" }, // simulate tab B's earlier save
    });

    await expect(
      updateGarageAddressAction(form({
        address: "P.O. Box 12345\nShop 7, Al Ittihad Rd\nDeira, Dubai",
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-address/);

    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.address).toBe("P.O. Box 12345\nShop 7, Al Ittihad Rd\nDeira, Dubai");
    // defaultLang MUST have survived the address save.
    expect(g!.defaultLang).toBe("ar");
  });

  it("A) trn save touches ONLY trn", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await prisma.garage.update({
      where: { id: gA },
      data: { address: "SEEDED", defaultLang: "en" },
    });
    await expect(
      updateGarageTrnAction(form({ trn: "100000000000099" })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-trn/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.trn).toBe("100000000000099");
    expect(g!.address).toBe("SEEDED");
    expect(g!.defaultLang).toBe("en");
  });

  it("A) defaultLang save touches ONLY defaultLang", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await prisma.garage.update({
      where: { id: gA },
      data: { name: "Kept Name", trn: "TRN-KEEP", address: "ADDR-KEEP" },
    });
    await expect(
      updateGarageDefaultLangAction(form({ defaultLang: "ar" })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-default-lang/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.defaultLang).toBe("ar");
    expect(g!.name).toBe("Kept Name");
    expect(g!.trn).toBe("TRN-KEEP");
    expect(g!.address).toBe("ADDR-KEEP");
  });

  it("B) name required — empty name rejected", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await expect(
      updateGarageNameAction(form({ name: "" })),
    ).rejects.toThrow(/REDIRECT:\/settings\?error=garage-name-required/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.name).toBe(`${gA} — seeded`);
  });

  it("B) name > 80 rejected", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await expect(
      updateGarageNameAction(form({ name: "x".repeat(81) })),
    ).rejects.toThrow(/REDIRECT:\/settings\?error=garage-name-too-long/);
  });

  it("B) TRN > 40 rejected", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await expect(
      updateGarageTrnAction(form({ trn: "1".repeat(41) })),
    ).rejects.toThrow(/REDIRECT:\/settings\?error=trn-too-long/);
  });

  it("B) address > 400 rejected", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await expect(
      updateGarageAddressAction(form({ address: "y".repeat(401) })),
    ).rejects.toThrow(/REDIRECT:\/settings\?error=address-too-long/);
  });

  it("C) blank optional TRN clears to null", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await prisma.garage.update({ where: { id: gA }, data: { trn: "OLD" } });
    await expect(
      updateGarageTrnAction(form({ trn: "" })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-trn/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.trn).toBeNull();
  });

  it("C) blank optional address clears to null", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await prisma.garage.update({ where: { id: gA }, data: { address: "OLD ADDR" } });
    await expect(
      updateGarageAddressAction(form({ address: "" })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-address/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.address).toBeNull();
  });

  it("C) blank optional defaultLang clears to null", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await prisma.garage.update({ where: { id: gA }, data: { defaultLang: "ar" } });
    await expect(
      updateGarageDefaultLangAction(form({ defaultLang: "" })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-default-lang/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.defaultLang).toBeNull();
  });

  it("D) invalid defaultLang rejected, no DB write", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await expect(
      updateGarageDefaultLangAction(form({ defaultLang: "es" })),
    ).rejects.toThrow(/REDIRECT:\/settings\?error=garage-lang-invalid/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.defaultLang).toBeNull();
  });

  it("E) MASTER allowed on every one of the four", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA, "MASTER"));
    await expect(
      updateGarageNameAction(form({ name: "By MASTER" })),
    ).rejects.toThrow(/ok=garage-name/);
    await expect(
      updateGarageTrnAction(form({ trn: "TRN-BY-MASTER" })),
    ).rejects.toThrow(/ok=garage-trn/);
    await expect(
      updateGarageAddressAction(form({ address: "ADDR BY MASTER" })),
    ).rejects.toThrow(/ok=garage-address/);
    await expect(
      updateGarageDefaultLangAction(form({ defaultLang: "ar" })),
    ).rejects.toThrow(/ok=garage-default-lang/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.name).toBe("By MASTER");
    expect(g!.trn).toBe("TRN-BY-MASTER");
    expect(g!.address).toBe("ADDR BY MASTER");
    expect(g!.defaultLang).toBe("ar");
  });

  it("E) ADVISOR refused on every one of the four", async () => {
    mockAuth.mockResolvedValue(
      await mockSessionAndSeed({
        id: P + "adv-" + gA, garageId: gA, role: "ADVISOR",
      }),
    );
    await expect(updateGarageNameAction(form({ name: "hack" }))).rejects.toThrow(/Not authorized/);
    await expect(updateGarageTrnAction(form({ trn: "hack" }))).rejects.toThrow(/Not authorized/);
    await expect(updateGarageAddressAction(form({ address: "hack" }))).rejects.toThrow(/Not authorized/);
    await expect(updateGarageDefaultLangAction(form({ defaultLang: "ar" }))).rejects.toThrow(/Not authorized/);
    const g = await prisma.garage.findUnique({ where: { id: gA } });
    expect(g!.name).toBe(`${gA} — seeded`);
  });

  it("F) tenant isolation — smuggled garageId in form ignored (on name save)", async () => {
    mockAuth.mockResolvedValue(await operationalOf(gA));
    await expect(
      updateGarageNameAction(form({
        name: "trying to touch B",
        garageId: gB, // attempted attack
      })),
    ).rejects.toThrow(/REDIRECT:\/settings\?ok=garage-name/);
    const a = await prisma.garage.findUnique({ where: { id: gA } });
    const b = await prisma.garage.findUnique({ where: { id: gB } });
    expect(a!.name).toBe("trying to touch B");
    expect(b!.name).toBe(`${gB} — seeded`); // untouched
  });
});

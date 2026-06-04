"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// PUBLIC — a new garage signs itself up (creates the Garage + its OWNER user).
export async function signupAction(formData: FormData) {
  const garageName = String(formData.get("garageName") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const password = String(formData.get("password") ?? "");
  const trn = String(formData.get("trn") ?? "").trim() || null;

  if (!garageName || !name || !email || password.length < 6) redirect("/signup?error=1");

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) redirect("/signup?error=exists");

  const passwordHash = await bcrypt.hash(password, 10);
  const garage = await prisma.garage.create({ data: { name: garageName, country: "UAE", trn } });
  await prisma.user.create({
    data: { garageId: garage.id, role: "OWNER", name, email, passwordHash },
  });

  redirect("/login?new=1");
}

async function requireOwner() {
  const session = await auth();
  if (!session?.user || session.user.role !== "OWNER") throw new Error("Not authorized");
  return session.user;
}

const STAFF_ROLES = ["ADVISOR", "TECH", "CASHIER"] as const;

export async function addStaffAction(formData: FormData) {
  const owner = await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const role = String(formData.get("role") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!name || !email || password.length < 6 || !STAFF_ROLES.includes(role as never)) {
    redirect("/owner/staff?error=1");
  }
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) redirect("/owner/staff?error=exists");

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.create({
    data: { garageId: owner.garageId, role: role as never, name, email, passwordHash },
  });
  revalidatePath("/owner/staff");
}

export async function removeStaffAction(formData: FormData) {
  const owner = await requireOwner();
  const userId = String(formData.get("userId") ?? "");

  // Detach references first so the FK delete is safe; never remove an OWNER.
  await prisma.$transaction(async (tx) => {
    const target = await tx.user.findFirst({
      where: { id: userId, garageId: owner.garageId, role: { not: "OWNER" } },
      select: { id: true },
    });
    if (!target) return;
    await tx.jobCard.updateMany({ where: { advisorId: userId }, data: { advisorId: null } });
    await tx.jobStep.updateMany({ where: { techId: userId }, data: { techId: null } });
    await tx.aiEvent.updateMany({ where: { userId }, data: { userId: null } });
    await tx.user.delete({ where: { id: userId } });
  });
  revalidatePath("/owner/staff");
}

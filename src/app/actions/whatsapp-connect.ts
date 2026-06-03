"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";

async function requireOwner() {
  const session = await auth();
  if (!session?.user || session.user.role !== "OWNER") throw new Error("Not authorized");
  return session.user;
}

// Real flow: Meta Embedded Signup popup returns a code → exchange for the WABA + phone
// number id + a long-lived token. Here (no BSP creds) we simulate a successful connect so
// the multi-tenant send/receive path is exercisable. Token is stored ENCRYPTED either way.
export async function connectWhatsAppAction(formData: FormData) {
  const owner = await requireOwner();
  const phoneNumberId = String(formData.get("phoneNumberId") ?? "").trim() || `mock-${randomUUID().slice(0, 8)}`;
  const phoneNumber = String(formData.get("phoneNumber") ?? "").trim() || "+9715XXXXXXXX";
  const token = String(formData.get("token") ?? "").trim() || `mock-token-${randomUUID()}`;

  await prisma.whatsAppAccount.upsert({
    where: { garageId: owner.garageId },
    update: {
      status: "CONNECTED",
      phoneNumberId,
      phoneNumber,
      accessTokenEnc: encryptSecret(token),
      connectedAt: new Date(),
    },
    create: {
      garageId: owner.garageId,
      status: "CONNECTED",
      phoneNumberId,
      phoneNumber,
      accessTokenEnc: encryptSecret(token),
      connectedAt: new Date(),
    },
  });
  revalidatePath("/owner/whatsapp");
}

export async function disconnectWhatsAppAction() {
  const owner = await requireOwner();
  await prisma.whatsAppAccount.updateMany({
    where: { garageId: owner.garageId },
    data: { status: "DISCONNECTED", accessTokenEnc: null },
  });
  revalidatePath("/owner/whatsapp");
}

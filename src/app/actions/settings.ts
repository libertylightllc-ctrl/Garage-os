"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// Self-serve account/garage settings. Each action is keyed to
// session.user.id (or session.user.garageId for owner-only actions) —
// never to anything in formData. A tampered POST cannot aim at a
// different user or garage row.

function back(error: string): never {
  redirect(`/settings?error=${encodeURIComponent(error)}`);
}

export async function updateProfileNameAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) back("name-required");
  if (name.length > 80) back("name-too-long");

  // Strictly scoped by session id — cannot ever touch a different row.
  await prisma.user.update({
    where: { id: session.user.id },
    data: { name },
  });

  revalidatePath("/settings");
  redirect("/settings?ok=name");
}

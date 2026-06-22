import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

// Single source of truth for "create a new tenant" — used by the operator
// CLI in scripts/create-garage.ts. Public self-signup is closed; the
// operator runs this server-side. Keep this file framework-free (no
// next/navigation, no redirect) so it stays callable from a Node script
// without dragging in App-Router-only code.

export interface CreateGarageInput {
  garageName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  trn?: string | null;
}

export interface CreateGarageResult {
  garageId: string;
  ownerId: string;
  email: string;
  garageName: string;
  ownerName: string;
}

export type CreateGarageErrorCode =
  | "MISSING_FIELDS"
  | "PASSWORD_TOO_SHORT"
  | "EMAIL_EXISTS";

export class CreateGarageError extends Error {
  constructor(public readonly code: CreateGarageErrorCode, message: string) {
    super(message);
    this.name = "CreateGarageError";
  }
}

const MIN_PASSWORD_LENGTH = 6;

export async function createGarageWithOwner(
  input: CreateGarageInput,
): Promise<CreateGarageResult> {
  const garageName = input.garageName.trim();
  const ownerName = input.ownerName.trim();
  const email = input.ownerEmail.toLowerCase().trim();
  const password = input.ownerPassword;
  const trn = input.trn?.trim() || null;

  if (!garageName || !ownerName || !email) {
    throw new CreateGarageError(
      "MISSING_FIELDS",
      "garageName, ownerName, and ownerEmail are all required",
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new CreateGarageError(
      "PASSWORD_TOO_SHORT",
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) {
    throw new CreateGarageError(
      "EMAIL_EXISTS",
      `A user with email ${email} already exists`,
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);

  // Transaction so a User-create failure rolls back the Garage too — no
  // orphan Garage rows can leak in if the second insert ever blows up.
  // invoiceSeq + jobSeq inherit their schema defaults (0).
  return await prisma.$transaction(async (tx) => {
    const garage = await tx.garage.create({
      data: { name: garageName, country: "UAE", trn },
      select: { id: true, name: true },
    });
    const user = await tx.user.create({
      data: {
        garageId: garage.id,
        role: "OWNER",
        name: ownerName,
        email,
        passwordHash,
      },
      select: { id: true, name: true, email: true },
    });
    return {
      garageId: garage.id,
      ownerId: user.id,
      email: user.email,
      garageName: garage.name,
      ownerName: user.name,
    };
  });
}

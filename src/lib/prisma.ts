import { PrismaClient } from "@/generated/prisma/client";
import { makePgAdapter } from "@/lib/pg-adapter";

// Prisma 7's `prisma-client` generator is driverless — it needs a driver adapter.
// Single shared client across hot-reloads in dev (avoids exhausting connections).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter: makePgAdapter() });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

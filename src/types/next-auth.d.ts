import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    role?: string;
    garageId?: string;
    // Operator admin marker. Set ONLY by the "admin-credentials" provider
    // in src/auth.ts. Regular staff sign-in (credentials/dev-bypass)
    // must never set this — that's enforced by the provider returning
    // shape, not by callback logic. See requireAdmin() for gating.
    isAdmin?: boolean;
  }
  interface Session {
    user: {
      id: string;
      role: string;
      garageId: string;
      isAdmin?: boolean;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    role?: string;
    garageId?: string;
    isAdmin?: boolean;
  }
}

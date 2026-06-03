import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    role?: string;
    garageId?: string;
  }
  interface Session {
    user: {
      id: string;
      role: string;
      garageId: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    role?: string;
    garageId?: string;
  }
}

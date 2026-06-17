import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

// Dev-only "sign in as a role" bypass — double-gated so it cannot leak
// to production:
//   1. NODE_ENV must be "development" (Vercel sets "production")
//   2. DEV_AUTH_BYPASS must be "1" (only present in local .env)
// If either gate is false the dev-bypass provider isn't registered, so
// NextAuth has no /api/auth/callback/dev-bypass endpoint at all in prod
// — 404, not "wrong credentials".
const DEV_BYPASS =
  process.env.NODE_ENV === "development" &&
  process.env.DEV_AUTH_BYPASS === "1";

const baseProvider = Credentials({
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
  },
  authorize: async (credentials) => {
    const email = String(credentials?.email ?? "").toLowerCase().trim();
    const password = String(credentials?.password ?? "");
    if (!email || !password) return null;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash) return null;

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return null;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      garageId: user.garageId,
    };
  },
});

// Second provider: email-only, no password check. Only created when
// both gates pass. Used by /dev/login to switch roles in local dev.
const devBypassProvider = Credentials({
  id: "dev-bypass",
  name: "Dev Bypass",
  credentials: { email: { label: "Email", type: "text" } },
  authorize: async (credentials) => {
    if (!DEV_BYPASS) return null;
    const email = String(credentials?.email ?? "").toLowerCase().trim();
    if (!email) return null;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      garageId: user.garageId,
    };
  },
});

// Staff-only auth: email + password, JWT sessions. Customers never log in.
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: DEV_BYPASS ? [baseProvider, devBypassProvider] : [baseProvider],
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        token.uid = user.id;
        token.role = user.role;
        token.garageId = user.garageId;
      }
      return token;
    },
    session: ({ session, token }) => {
      if (session.user) {
        session.user.id = typeof token.uid === "string" ? token.uid : "";
        session.user.role = typeof token.role === "string" ? token.role : "";
        session.user.garageId =
          typeof token.garageId === "string" ? token.garageId : "";
      }
      return session;
    },
  },
});

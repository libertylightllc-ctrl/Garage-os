import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { authenticateStaff, authenticateAdmin } from "@/lib/login-auth";

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

// Operator-admin JWTs expire after this many seconds regardless of the
// global session.maxAge. Short on purpose — admins have cross-garage
// read; a stale stolen token shouldn't last past lunch. Set absolutely
// at login (not slid forward on activity). See jwt callback below.
const ADMIN_TTL_SECONDS = 4 * 60 * 60;

const baseProvider = Credentials({
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
  },
  // Credential verify + brute-force lockout live in authenticateStaff
  // (src/lib/login-auth.ts) so the lockout path is directly testable.
  // It returns the shaped user (NO isAdmin — staff can never mint an
  // operator token) or null on bad email / wrong password / locked.
  authorize: async (credentials) =>
    authenticateStaff(
      String(credentials?.email ?? ""),
      String(credentials?.password ?? "")
    ),
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

// Third provider: operator admin. Authenticates against AdminUser (NOT
// User). The whole reason this is a separate provider — not a flag on
// User — is "regular staff can never become admin," the invariant the
// panel rests on. This provider is the ONLY code path that returns
// isAdmin:true. Bootstrap admins with scripts/create-admin.ts.
const adminProvider = Credentials({
  id: "admin-credentials",
  name: "Admin",
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
  },
  // Credential verify + brute-force lockout + audit logging all live in
  // authenticateAdmin (src/lib/login-auth.ts) — testable in isolation.
  // Returns the admin shape (NO role, NO garageId — admins sit above
  // garages; isAdmin:true is set ONLY here) or null on any failure.
  authorize: async (credentials) =>
    authenticateAdmin(
      String(credentials?.email ?? ""),
      String(credentials?.password ?? "")
    ),
});

// Staff-only auth: email + password, JWT sessions. Customers never log in.
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: DEV_BYPASS
    ? [baseProvider, devBypassProvider, adminProvider]
    : [baseProvider, adminProvider],
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        token.uid = user.id;
        // Carry whichever shape the provider returned. Staff providers
        // omit isAdmin entirely; the admin provider omits role/garageId.
        // This prevents a stale token carrying both sets of claims.
        if (user.isAdmin) {
          token.isAdmin = true;
          token.role = undefined;
          token.garageId = undefined;
          // Absolute 4h expiry from login — we set token.exp explicitly
          // so NextAuth treats the token as expired regardless of the
          // global session.maxAge sliding window.
          token.exp = Math.floor(Date.now() / 1000) + ADMIN_TTL_SECONDS;
        } else {
          token.isAdmin = undefined;
          token.role = user.role;
          token.garageId = user.garageId;
        }
      }
      return token;
    },
    session: ({ session, token }) => {
      if (session.user) {
        session.user.id = typeof token.uid === "string" ? token.uid : "";
        session.user.role = typeof token.role === "string" ? token.role : "";
        session.user.garageId =
          typeof token.garageId === "string" ? token.garageId : "";
        session.user.isAdmin = token.isAdmin === true;
      }
      return session;
    },
  },
});

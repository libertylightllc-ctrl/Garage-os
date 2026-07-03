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
  authorize: async (credentials) => {
    const email = String(credentials?.email ?? "").toLowerCase().trim();
    const password = String(credentials?.password ?? "");
    if (!email || !password) return null;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash) return null;

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return null;

    // Best-effort lastLoginAt write. Phase 3 admin per-shop view uses
    // this to flag accounts that have gone quiet. Don't block sign-in
    // if the write fails — a missing log row is better than a refused
    // login the user can't explain.
    prisma.user
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch(() => {});

    // Explicitly omit isAdmin — staff sign-in can NEVER produce an
    // operator-admin token. AdminUser is a separate table; the only
    // code path that returns isAdmin:true is adminProvider below.
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
  authorize: async (credentials) => {
    // Lazy import keeps src/lib/admin-audit out of the edge bundle the
    // NextAuth middleware tree-shake would otherwise pull in.
    const { logAdminAccess } = await import("@/lib/admin-audit");

    const email = String(credentials?.email ?? "").toLowerCase().trim();
    const password = String(credentials?.password ?? "");
    if (!email || !password) {
      await logAdminAccess({
        actorAdminId: null,
        action: "login_failed",
        meta: { reason: "missing_credentials", email: email || null },
      });
      return null;
    }

    const admin = await prisma.adminUser.findUnique({ where: { email } });
    if (!admin) {
      await logAdminAccess({
        actorAdminId: null,
        action: "login_failed",
        meta: { reason: "no_such_admin", email },
      });
      return null;
    }

    // Locked accounts cannot sign in even with the correct password.
    // Phase 1 doesn't populate failedLogins/lockedUntil yet — that's
    // Phase 2 hardening — but we honour the lock when set.
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      await logAdminAccess({
        actorAdminId: admin.id,
        action: "login_failed",
        meta: { reason: "locked", email },
      });
      return null;
    }

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) {
      await logAdminAccess({
        actorAdminId: admin.id,
        action: "login_failed",
        meta: { reason: "wrong_password", email },
      });
      return null;
    }

    // Best-effort lastLoginAt write. Don't block sign-in on it.
    prisma.adminUser
      .update({
        where: { id: admin.id },
        data: { lastLoginAt: new Date(), failedLogins: 0 },
      })
      .catch(() => {});

    await logAdminAccess({
      actorAdminId: admin.id,
      action: "login_success",
      meta: { email },
    });

    // Shape: NO role, NO garageId. Admins sit above garages.
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      isAdmin: true,
    };
  },
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

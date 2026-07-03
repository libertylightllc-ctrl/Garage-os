import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    // Load env BEFORE any test file imports — guarantees .env.local
    // (local dev DB) wins over .env (prod) for tests that hit a real
    // DB. See vitest.setup.ts.
    setupFiles: ["./vitest.setup.ts"],
    // Force forks (separate Node process per test file). The default
    // `threads` pool shares globalThis across files — including the
    // prisma singleton in src/lib/prisma.ts — and the Prisma pg adapter's
    // prepared-statement cache races when concurrent test files
    // hammer it ("bind message supplies N parameters, but prepared
    // statement '' requires 0"). Forks isolate fully. ~100ms slower
    // startup; flake gone.
    pool: "forks",
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});

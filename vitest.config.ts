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
    // Force forks (separate Node process per test file) for isolation.
    pool: "forks",
    // Run test FILES one at a time (no cross-file parallelism). Many
    // suites hit the same local Postgres, and the Prisma pg adapter's
    // unnamed-prepared-statement cache races when concurrent files
    // hammer it ("bind message supplies N parameters, but prepared
    // statement '' requires M"). Serial file execution removes the
    // contention entirely — deterministic, at the cost of a slightly
    // longer suite. Tests within a file still run in order.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});

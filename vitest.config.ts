import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// One test run for the whole workspace. Workspace packages resolve to their
// TypeScript sources, so tests never depend on a previous build. The aliases
// match whole import names, so @dialwarden/entitlement/testing (throwaway test
// keys, never in the image) resolves to its own file.
const source = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@dialwarden\/entitlement\/testing$/,
        replacement: source("packages/entitlement/test/testing.ts"),
      },
      {
        find: /^@dialwarden\/entitlement$/,
        replacement: source("packages/entitlement/src/index.ts"),
      },
      {
        find: /^@dialwarden\/formats$/,
        replacement: source("packages/formats/src/index.ts"),
      },
      {
        find: /^@dialwarden\/packs-schema$/,
        replacement: source("packages/packs-schema/src/index.ts"),
      },
    ],
  },
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "tools/*/src/**/*.test.{ts,mjs}",
      "packs/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    // argon2id and scrypt make some server tests slower than the default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// One test run for the whole workspace. Workspace packages resolve to their
// TypeScript sources, so tests never depend on a previous build.
const source = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@dialwarden/entitlement": source("packages/entitlement/src/index.ts"),
      "@dialwarden/formats": source("packages/formats/src/index.ts"),
      "@dialwarden/packs-schema": source("packages/packs-schema/src/index.ts"),
    },
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
  },
});

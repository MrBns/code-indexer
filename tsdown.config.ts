import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  // The CLI has no importable API surface, so type declarations are unnecessary.
  dts: false,
  clean: true,
  // Keep the compiler as a regular dependency instead of bundling ~8 MB of it.
  external: ["typescript"],
});

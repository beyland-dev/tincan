import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/bin.ts"],
    // The fake phone is a dev-only demo dependency; keep it out of the published bundle.
    deps: { neverBundle: ["@beyland/tincan-fake-phone"] },
    dts: {
      generator: "tsgo",
    },
  },
  test: {
    testTimeout: 20_000,
  },
});

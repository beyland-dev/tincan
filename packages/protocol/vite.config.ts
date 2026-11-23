import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/paths.ts"],
    dts: {
      generator: "tsgo",
    },
  },
});

import preact from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vite-plus";

const app = {
  dts: false,
  deps: { alwaysBundle: [/^@beyland\//, "zod"], neverBundle: ["electron"] },
};

// Only allow the Vite HMR websocket during dev; production builds keep `connect-src 'self'`.
function devPortCsp(): Plugin {
  let port = 5174;
  return {
    name: "tincan-dev-port-csp",
    apply: "serve",
    configResolved: (config) => void (port = config.server.port ?? port),
    transformIndexHtml: (html) =>
      html.replace("connect-src 'self'", `connect-src 'self' ws://localhost:${port}`),
  };
}

export default defineConfig({
  // The renderer: `vp build` (index.html → dist/renderer), `vp dev` for hot reload.
  plugins: [preact(), devPortCsp()],
  base: "./",
  server: { port: 5174, strictPort: true },
  build: { outDir: "dist/renderer", target: "chrome140", emptyOutDir: true },
  // The main process (ESM) and the preload, which a sandboxed renderer only runs as CommonJS.
  pack: [
    { ...app, entry: { main: "src/main/index.ts" }, format: "esm", clean: false },
    { ...app, entry: { preload: "src/preload/index.ts" }, format: "cjs", clean: false },
  ],
});

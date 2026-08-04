import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Builds only the page. The Bun side is not bundled at all — `okf ui` runs it
 * from source, and `build:headless` compiles it for agents — so this output is
 * exactly what the server hands to the browser.
 */
export default defineConfig(({ mode }) => ({
  root: resolve(here, "src/mainview"),
  // Relative base: the app loads the page over `views://`, not from a server root.
  base: "./",
  build: {
    outDir: resolve(here, "src/mainview/dist"),
    emptyOutDir: true,
    target: "es2023",
    minify: "esbuild",
    cssMinify: true,
    // Sourcemaps are ~3.5x the size of the code they describe and ship inside
    // the app, so they are a debug-build feature. `--mode development` brings
    // them back when a production crash actually needs reading.
    sourcemap: mode === "development",
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
}));

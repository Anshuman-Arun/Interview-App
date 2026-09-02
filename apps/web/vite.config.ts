import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: currentDir,
  plugins: [react()],
  // Rolldown's Windows dependency scanner treats tldraw's Vite-specific
  // "?url" asset specifiers as filesystem names. Leave this asset package to
  // normal Vite transforms instead of dependency pre-bundling.
  optimizeDeps: {
    exclude: ["@tldraw/assets", "@tldraw/assets/imports.vite.js"]
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    strictPort: false
  },
  resolve: {
    alias: {
      "~": path.resolve(currentDir, "src")
    }
  },
  build: {
    outDir: path.resolve(currentDir, "../../dist/apps/web"),
    emptyOutDir: true,
    sourcemap: true
  }
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: currentDir,
  plugins: [react()],
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

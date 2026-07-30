import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: join(__dirname, "../dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
});

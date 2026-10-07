import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/my2cents/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/my2cents/api": "http://localhost:8000" },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
});

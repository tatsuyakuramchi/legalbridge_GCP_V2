import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: ".",
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": "http://localhost:8081" } },
  build: { outDir: "dist/client" }
});

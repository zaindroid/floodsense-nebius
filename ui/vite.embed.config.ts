import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Static IIFE bundle for the plain-HTML UI (ui-merged). The maplibre worker is emitted as an asset next to it.
export default defineConfig({
  plugins: [react()],
  base: "./",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: "dist-embed",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    lib: { entry: "src/embed/map3d.tsx", name: "FloodMap3DBundle", formats: ["iife"], fileName: () => "map3d.js" },
    rollupOptions: { output: { inlineDynamicImports: true, assetFileNames: "[name][extname]" } },
  },
});

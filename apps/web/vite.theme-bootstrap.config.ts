import { defineConfig } from "vite";

const outDir = process.env.THEME_BOOTSTRAP_OUT_DIR ?? "public";

export default defineConfig({
  publicDir: false,
  build: {
    lib: {
      entry: "../../packages/ui/src/atoms/theme-bootstrap.ts",
      formats: ["iife"],
      name: "BakeryThemeBootstrap",
      fileName: () => "theme-bootstrap.js",
    },
    outDir,
    // `public` also holds the brand favicon set; never wipe it.
    emptyOutDir: false,
  },
});

import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    outDir: "dist",
  },
  {
    entry: {
      index: "src/browser/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    treeshake: true,
    outDir: "dist/browser",
    platform: "browser",
  },
  {
    entry: {
      index: "src/node/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    treeshake: true,
    outDir: "dist/node",
    platform: "node",
    external: ["sharp"],
  },
])


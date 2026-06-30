import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const workspaceRoot = resolve(__dirname, "../..");

const aliases = {
  "@mcsp/core": resolve(workspaceRoot, "packages/core/src/index.ts"),
  "@mcsp/shared": resolve(workspaceRoot, "packages/shared/src/index.ts"),
  "@renderer": resolve(__dirname, "src/renderer/src")
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@mcsp/core", "@mcsp/shared"] })],
    resolve: {
      alias: aliases
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "analyze-worker": resolve(__dirname, "src/workers/analyze-worker.ts")
        }
      }
    }
  },
  preload: {
    resolve: {
      alias: aliases
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts")
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].js"
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      alias: aliases
    },
    plugins: [react()]
  }
});

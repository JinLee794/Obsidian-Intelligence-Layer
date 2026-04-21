import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/__tests__/**/*.test.ts",
      "src/__tests__/integration/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    reporters: ["verbose"],
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});

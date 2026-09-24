import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 30_000,
  },
});

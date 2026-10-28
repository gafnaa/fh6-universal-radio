import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./ui/test/setup.js"],
    include: ["ui/test/**/*.test.js"],
  },
});

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    // Tests run against src/mocks/characters.fixture.ts, not the preview characters.
    env: { NEXT_PUBLIC_MOCK_FIXTURES: "test" },
  },
});

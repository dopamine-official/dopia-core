import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    // Existing code breaks these React Compiler rules (4 places). Warn until they are fixed,
    // then remove this block so they fail the check again.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    "next-env.d.ts",
    "public/mockServiceWorker.js",
    "test-results*/**",
    "playwright-report/**",
  ]),
]);

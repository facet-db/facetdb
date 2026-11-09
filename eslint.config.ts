// Type-aware rules only. Biome owns formatting, style and every fast rule; this config extends no
// preset so the two tools never disagree. It runs through `pnpm lint:types`, apart from the fast
// lint, because it builds the full type program. Only files a package tsconfig covers are linted
// here (src/); vitest configs are Biome's alone.
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: [
    "packages/*/src/**/*.ts",
    "plugins/*/src/**/*.ts",
    "apps/*/src/**/*.ts",
    "apps/*/src/**/*.tsx",
  ],
  ignores: ["**/dist/**", "**/node_modules/**", "**/generated/**"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: {
    // `if (x)` where the type says x can never be falsy: the mechanical form of "no fear-based TypeScript".
    "@typescript-eslint/no-unnecessary-condition": "error",
    // `if (probability)` is ambiguous for numbers and strings; write `probability > 0`.
    "@typescript-eslint/strict-boolean-expressions": [
      "error",
      { allowString: false, allowNumber: false, allowNullableObject: false },
    ],
    // `probability || 0` treats a legitimate 0 as missing; `??` was meant.
    "@typescript-eslint/prefer-nullish-coalescing": "error",
  },
});

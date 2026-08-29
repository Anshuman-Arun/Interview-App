import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "coverage/**", "eslint.config.js"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/require-await": "off"
    }
  },
  {
    files: ["scripts/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked]
  }
);

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "coverage/**", "dist/**", "eslint.config.js"] },
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
    files: ["scripts/**/*.mjs", "apps/desktop/**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked]
  },
  {
    files: ["apps/desktop/**/*.cjs"],
    languageOptions: {
      globals: {
        require: "readonly",
        URL: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  },
  {
    files: ["tests/fixtures/local-runtime-worker.mjs", "tests/fixtures/supervised-process-worker.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly"
      }
    }
  }
);

import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";
import svelteConfig from "./packages/app/svelte.config.js";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.tmp/**",
      "**/.tools/**",
      "**/target/**",
      "**/Syncpeer.AppDir/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs["flat/recommended"],
  {
    files: ["**/*.{js,mjs,cjs,ts,svelte}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "no-debugger": process.env.NODE_ENV === "production" ? "error" : "off",
      "prefer-promise-reject-errors": "off",
    },
  },
  {
    files: ["packages/app/**/*.svelte"],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: [".svelte"],
        parser: tseslint.parser,
        svelteConfig,
      },
    },
  },
  prettier,
  svelte.configs["flat/prettier"],
);

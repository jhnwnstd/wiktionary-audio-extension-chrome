import globals from "globals";

export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
        FFmpeg: "readonly",
        WebAssembly: "readonly",
        importScripts: "readonly",
      }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^(log|_)" }],
      "no-redeclare": "error",
      "no-constant-condition": "warn",
      "no-debugger": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "eqeqeq": ["error", "always"],
      "no-var": "error",
      "prefer-const": ["warn", { destructuring: "all" }],
      "no-throw-literal": "error",
      "no-self-assign": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "warn",
    }
  },
  {
    files: ["src/offscreen.js"],
    languageOptions: {
      sourceType: "module",
    }
  },
  {
    files: ["tests/**/*.js", "playwright.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      }
    }
  },
  {
    ignores: ["src/vendor/**", "node_modules/**", "test-results/**", "playwright-report/**"]
  }
];

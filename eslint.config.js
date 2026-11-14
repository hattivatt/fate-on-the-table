import js from "@eslint/js";
import globals from "globals";

const foundryGlobals = {
  game: "readonly",
  canvas: "readonly",
  foundry: "readonly",
  ui: "readonly",
  Hooks: "readonly",
  CONFIG: "readonly",
  CONST: "readonly",
  PIXI: "readonly",
  libWrapper: "readonly",
  fromUuid: "readonly",
  fromUuidSync: "readonly",
  ChatMessage: "readonly",
  Roll: "readonly",
  TextEditor: "readonly",
  Actor: "readonly",
};

const sharedRules = {
  "no-unused-vars": [
    "error",
    {
      // Framework overrides (ApplicationV2 _renderHTML(context, options), hook
      // handlers) routinely ignore positional args; only vars are checked.
      args: "none",
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrors: "none",
    },
  ],
  "no-empty": ["error", { allowEmptyCatch: false }],
};

const esModule = {
  ecmaVersion: 2024,
  sourceType: "module",
};

export default [
  {
    ignores: [
      "node_modules/",
      ".devenv/",
      ".direnv/",
      "packs/challenge-contest/",
      "dist/",
    ],
  },
  js.configs.recommended,
  {
    files: ["scripts/**/*.js", "packs/**/*.js"],
    languageOptions: {
      ...esModule,
      globals: { ...globals.browser, ...globals.es2024, ...foundryGlobals },
    },
    rules: sharedRules,
  },
  {
    files: ["tests/**/*.js", "tools/**/*.{js,mjs}", "eslint.config.js"],
    languageOptions: {
      ...esModule,
      globals: { ...globals.node, ...foundryGlobals },
    },
    rules: sharedRules,
  },
];

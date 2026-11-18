import tseslint from "typescript-eslint";
import policy from "./tools/policy-rules.mjs";

const platformSelectors = [
  {
    selector:
      "MemberExpression[object.name='process'][property.name='platform']",
    message: "平台差异只允许位于已审阅的平台配置/可执行文件发现边界。",
  },
  {
    selector:
      "MemberExpression[object.name='process'][property.value='platform']",
    message: "不能用 computed property 绕过平台边界。",
  },
  {
    selector:
      "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='platform']",
    message: "Destructuring platform does not bypass the reviewed boundary.",
  },
];

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "test-results/**",
      "docs/validation/**",
    ],
  },
  {
    files: ["src/**/*.ts", "extension/**/*.js"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: { policy },
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "policy/no-silent-catch": "error",
      "policy/no-empty-fallback": "error",
      "policy/default-context-download": "error",
      "no-restricted-syntax": ["error", ...platformSelectors],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...["node:os", "os", "node:process", "process"].map((name) => ({
              name,
              importNames: ["platform"],
              message: "Platform discovery belongs in config.ts or runtime.ts.",
            })),
          ],
        },
      ],
      "max-lines": [
        "error",
        { max: 300, skipBlankLines: false, skipComments: false },
      ],
    },
  },
  ...Object.entries({
    "src/cli.ts": 395,
    "src/broker.ts": 320,
    "src/runtime.ts": 307,
  }).map(([file, max]) => ({
    // Frozen debt: warn at 300 and fail on growth. Split in a separate PR.
    files: [file],
    rules: {
      "max-lines": ["warn", { max: 300 }],
      "policy/legacy-size-cap": ["error", { max }],
    },
  })),
  {
    // Existing executable discovery and display-default boundaries only.
    files: ["src/config.ts", "src/runtime.ts"],
    rules: { "no-restricted-syntax": "off", "no-restricted-imports": "off" },
  },
];

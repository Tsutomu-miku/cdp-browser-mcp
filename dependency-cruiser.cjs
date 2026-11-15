module.exports = {
  forbidden: [
    {
      name: "no-cycles",
      severity: "error",
      from: { path: "^src/" },
      to: { circular: true },
    },
    {
      name: "no-unresolved",
      severity: "error",
      from: { path: "^src/" },
      to: { couldNotResolve: true },
    },
    {
      name: "production-not-tests",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^(test|examples|spike)/" },
    },
    {
      name: "domain-is-pure",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { pathNot: "^src/domain/" },
    },
    {
      name: "session-does-not-wire-adapters",
      severity: "error",
      from: { path: "^src/session/" },
      to: {
        path: "^src/((adapters|entrypoints|transport)/|(cdp|devtools|downloads|headers|runtime)\\.ts$)",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "session-no-concrete-io",
      severity: "error",
      from: { path: "^src/session/" },
      to: {
        // dependency-cruiser 18 归一化 Node built-in 时去掉 node: 前缀。
        path: "^((fs|child_process)(/|$)|node_modules/(playwright|playwright-core|puppeteer|chrome-devtools-mcp|@modelcontextprotocol)/)",
      },
    },
    {
      name: "transport-does-not-wire-adapters",
      severity: "error",
      from: { path: "^src/transport/" },
      to: { path: "^src/adapters/" },
    },
    {
      name: "only-entrypoints-compose",
      severity: "error",
      from: { path: "^src/(domain|session|adapters|transport)/" },
      to: { path: "^src/entrypoints/" },
    },
    {
      name: "no-test-only-dependency-in-production",
      severity: "error",
      from: { path: "^src/" },
      to: { dependencyTypes: ["npm-dev"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".js", ".ts", ".json"],
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
    },
  },
};

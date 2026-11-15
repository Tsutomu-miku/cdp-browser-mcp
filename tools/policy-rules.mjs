// 原创方案样例；只识别有明确语法与协议契约的模式，不声称判断所有吞错/兼容。
const key = (node) =>
  node?.type === "Identifier"
    ? node.name
    : node?.type === "Literal"
      ? node.value
      : undefined;
const metadata = (messages) => ({ type: "problem", schema: [], messages });
const isEmptyResult = (node) =>
  !node ||
  (node.type === "Identifier" && node.name === "undefined") ||
  (node.type === "Literal" && node.value === null) ||
  (node.type === "ObjectExpression" && node.properties.length === 0) ||
  (node.type === "ArrayExpression" && node.elements.length === 0);

// Deliberately syntactic: guarded fallbacks must propagate unhandled errors.
// Skip nested functions; a throw in an unrelated callback is not propagation.
function containsThrow(node, visitorKeys) {
  if (node.type === "ThrowStatement") return true;
  if (node.type.includes("Function")) return false;
  return (visitorKeys[node.type] || []).some((key) => {
    const children = Array.isArray(node[key]) ? node[key] : [node[key]];
    return children.some((child) => child && containsThrow(child, visitorKeys));
  });
}

export default {
  rules: {
    "legacy-size-cap": {
      meta: {
        ...metadata({
          growth:
            "Frozen size debt grew past {{max}} lines; split the module first.",
        }),
        schema: [
          {
            type: "object",
            properties: { max: { type: "integer", minimum: 1 } },
            required: ["max"],
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        return {
          Program(node) {
            const lines = context.sourceCode.lines;
            const count = lines.length - (lines.at(-1) === "" ? 1 : 0);
            const { max } = context.options[0];
            if (count > max)
              context.report({ node, messageId: "growth", data: { max } });
          },
        };
      },
    },
    "no-empty-fallback": {
      meta: metadata({
        fallback:
          "Do not turn an arbitrary failure into an empty result; handle a known error and rethrow the rest.",
      }),
      create(context) {
        function check(body) {
          if (body.type !== "BlockStatement") {
            if (isEmptyResult(body))
              context.report({ node: body, messageId: "fallback" });
            return;
          }
          if (containsThrow(body, context.sourceCode.visitorKeys)) return;
          function visit(node) {
            if (node.type.includes("Function")) return;
            if (node.type === "ReturnStatement" && isEmptyResult(node.argument))
              context.report({ node, messageId: "fallback" });
            for (const key of context.sourceCode.visitorKeys[node.type] || []) {
              const children = Array.isArray(node[key])
                ? node[key]
                : [node[key]];
              for (const child of children) if (child) visit(child);
            }
          }
          visit(body);
        }
        return {
          CatchClause(node) {
            check(node.body);
          },
          CallExpression(node) {
            if (
              node.callee.type !== "MemberExpression" ||
              key(node.callee.property) !== "catch"
            )
              return;
            const handler = node.arguments[0];
            if (
              ["ArrowFunctionExpression", "FunctionExpression"].includes(
                handler?.type,
              )
            )
              check(handler.body);
          },
        };
      },
    },
    "no-silent-catch": {
      meta: metadata({
        silent:
          "不得用空 catch 或空 Promise.catch 回调吞错；注释不能替代失败策略。",
      }),
      create(context) {
        return {
          CatchClause(node) {
            if (node.body.body.length === 0)
              context.report({ node, messageId: "silent" });
          },
          CallExpression(node) {
            if (
              node.callee.type !== "MemberExpression" ||
              key(node.callee.property) !== "catch"
            )
              return;
            const handler = node.arguments[0];
            if (
              !handler ||
              !["ArrowFunctionExpression", "FunctionExpression"].includes(
                handler.type,
              )
            )
              return;
            if (
              handler.body.type === "BlockStatement" &&
              handler.body.body.length === 0
            )
              context.report({ node: handler, messageId: "silent" });
          },
        };
      },
    },
    "default-context-download": {
      meta: metadata({
        context:
          "默认 context 的下载命令禁止 browserContextId；见 CDP 契约与 v0.1.1 回归。",
        explicit:
          "下载命令参数须为显式对象，不得用变量、展开或动态键隐藏 context 参数。",
        single:
          "不得在 catch 中重新设置下载行为作为失败降级；默认 context 使用单一路径。",
        legacy:
          "Page.setDownloadBehavior is a second protocol path; use the frozen browser default-context command.",
      }),
      create(context) {
        return {
          CallExpression(node) {
            if (
              node.callee.type !== "MemberExpression" ||
              key(node.callee.property) !== "send"
            )
              return;
            const method = node.arguments[0];
            if (
              method?.type !== "Literal" ||
              ![
                "Browser.setDownloadBehavior",
                "Browser.cancelDownload",
                "Page.setDownloadBehavior",
              ].includes(method.value)
            )
              return;
            if (method.value === "Page.setDownloadBehavior") {
              context.report({ node, messageId: "legacy" });
              return;
            }
            if (method.value === "Browser.setDownloadBehavior") {
              for (
                let ancestor = node.parent;
                ancestor;
                ancestor = ancestor.parent
              ) {
                if (ancestor.type === "CatchClause") {
                  context.report({ node, messageId: "single" });
                  break;
                }
                if (
                  ancestor.type === "CallExpression" &&
                  ancestor.callee.type === "MemberExpression" &&
                  key(ancestor.callee.property) === "catch"
                ) {
                  context.report({ node, messageId: "single" });
                  break;
                }
                if (
                  [
                    "ArrowFunctionExpression",
                    "FunctionExpression",
                    "FunctionDeclaration",
                  ].includes(ancestor.type)
                ) {
                  const parent = ancestor.parent;
                  if (
                    parent?.type === "CallExpression" &&
                    parent.callee.type === "MemberExpression" &&
                    key(parent.callee.property) === "catch"
                  )
                    context.report({ node, messageId: "single" });
                  break;
                }
              }
            }
            const params = node.arguments[1];
            if (params?.type !== "ObjectExpression") {
              context.report({ node, messageId: "explicit" });
              return;
            }
            for (const property of params.properties) {
              if (
                property.type === "SpreadElement" ||
                (property.computed && property.key.type !== "Literal")
              )
                context.report({ node: property, messageId: "explicit" });
              else if (key(property.key) === "browserContextId")
                context.report({ node: property, messageId: "context" });
            }
          },
        };
      },
    },
  },
};

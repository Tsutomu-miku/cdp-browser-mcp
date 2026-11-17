// A real stdio MCP peer at the external official-process boundary; never Chrome.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { once } from "node:events";
import { serveAttach } from "../../src/attach/server.js";
import { attachOptionsSchema } from "../../src/attach/options.js";

const scenario = process.argv[3];
if (process.argv[2] === "upstream") {
  console.error(JSON.stringify({ fakeUpstreamPid: process.pid }));
  const server = new McpServer({
    name: "official-process-fixture",
    version: "1.0.0",
  });
  server.registerTool("list_pages", { inputSchema: {} }, async () => {
    if (scenario === "pending" || scenario === "pending-eof") {
      console.error(JSON.stringify({ authorizationPending: true }));
      await new Promise(() => {});
    }
    if (scenario === "approval-gate") {
      const approved = once(process, "SIGUSR1");
      console.error(JSON.stringify({ authorizationPending: true }));
      await approved;
    }
    if (!["ready", "approval-gate"].includes(scenario))
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              {
                stopped: "Could not connect to Chrome. Cause: ECONNREFUSED",
                old: "Could not connect to Chrome. Cause: Chrome/143 remote debugging unavailable",
                disabled:
                  "Could not connect to Chrome. Cause: ENOENT DevToolsActivePort",
                denied:
                  "Could not connect to Chrome. Cause: WebSocket connection closed",
              }[scenario] ?? "Unknown fixture scenario",
          },
        ],
      };
    return { content: [{ type: "text", text: "1: https://example.com/" }] };
  });
  server.registerTool(
    "page_echo",
    {
      description: "Fixture page operation",
      inputSchema: { pageId: z.number(), text: z.string() },
      outputSchema: { pageId: z.number(), text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify(args) }],
      structuredContent: args,
      _meta: { fixture: true },
    }),
  );
  server.registerTool("tool_error", { inputSchema: {} }, async () => ({
    isError: true,
    content: [{ type: "text", text: "Official operation failed" }],
  }));
  server.registerTool("disconnect", { inputSchema: {} }, async () =>
    process.exit(1),
  );
  process.stdin.once("end", () => void server.close());
  await server.connect(new StdioServerTransport());
} else {
  try {
    await serveAttach(
      attachOptionsSchema.parse({
        timeoutMs:
          scenario === "pending"
            ? 1000
            : scenario === "pending-eof"
              ? 120000
              : 5000,
      }),
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", import.meta.filename, "upstream", scenario],
        stderr: "inherit",
      }),
    );
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}

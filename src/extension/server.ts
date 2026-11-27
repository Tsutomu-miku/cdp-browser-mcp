import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { RelayClient } from "./client.js";

/** MCP initialization never touches Chrome. The installed extension owns browser access. */
export async function serveExtension(directory: string) {
  const relay = new RelayClient(directory);
  const server = new Server(
    { name: "cdp-browser-mcp-extension", version: "0.4.2" },
    {
      capabilities: { tools: {} },
      instructions:
        "Daily Chrome extension. Use list_pages and explicit pageId. Use type_text with submitKey for a focused search field, and includeSnapshot on actions only when you need another element. Only human-approved origins are visible. One MCP client claims each page until release/disconnect. No lane headers, account/download isolation, tab creation/closing or browser-wide diagnostics. Stop access in the extension popup.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () =>
    relay.call("tools/list"),
  );
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const label = server.getClientVersion()?.name.trim().slice(0, 64);
    return relay.call(
      "tools/call",
      request.params,
      extra.signal,
      label || undefined,
    );
  });
  const stop = async () => {
    relay.close();
    await server.close();
  };
  server.onclose = () => relay.close();
  const ended = new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
    process.stdin.once("end", resolve);
  });
  try {
    await server.connect(new StdioServerTransport());
    await ended;
  } finally {
    await stop();
  }
}

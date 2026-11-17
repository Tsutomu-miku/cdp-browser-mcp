import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { attachFailure, verifyAttach } from "./connection.js";
import type { AttachOptions } from "./options.js";

const instructions =
  "Attach controls your daily Chrome default profile and all its windows. Official tools are forwarded unchanged. There are no agent/tab leases, lane header injection or isolated downloads. Use isolated mode for multiple agents or CI.";

/** Owns only the official subprocess and MCP relay, never Chrome or its profile. */
export async function serveAttach(
  options: AttachOptions,
  transport: Transport,
) {
  const upstream = new Client({
    name: "cdp-browser-mcp-attach",
    version: "0.3.0",
  });
  const server = new Server(
    { name: "cdp-browser-mcp-attach", version: "0.3.0" },
    { capabilities: { tools: {} }, instructions },
  );
  const lifetime = new AbortController();
  let stopping = false;
  const stop = () => {
    stopping = true;
    lifetime.abort(Error("Attach session stopped"));
  };
  const report = (state: string, message: string) =>
    console.error(
      JSON.stringify({
        event: "attach",
        state,
        channel: options.channel,
        message,
      }),
    );
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
  upstream.onclose = () =>
    lifetime.abort(
      Error(
        "Official server disconnected; reconnect and approve the Chrome dialog again.",
      ),
    );
  server.onclose = stop;
  try {
    report(
      "waiting-for-authorization",
      "Connecting; not yet authorized. Start Chrome 144+, enable chrome://inspect/#remote-debugging and click Allow / 允许 yourself. No agent may approve for you.",
    );
    await upstream.connect(transport, {
      timeout: options.timeoutMs,
      signal: lifetime.signal,
    });
    await verifyAttach(upstream, options, lifetime.signal);
    server.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
      upstream.listTools(request.params, { signal: extra.signal }),
    );
    server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      upstream.callTool(request.params, undefined, {
        signal: extra.signal,
        timeout: 90000,
      }),
    );
    await server.connect(new StdioServerTransport());
    lifetime.signal.throwIfAborted();
    report("connected", instructions);
    await new Promise<void>((resolve) => {
      lifetime.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
      if (lifetime.signal.aborted) resolve();
    });
    if (!stopping) throw lifetime.signal.reason;
  } catch (error) {
    if (!stopping) throw attachFailure(error, options.channel);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.stdin.removeListener("end", stop);
    upstream.onclose = undefined;
    server.onclose = undefined;
    await Promise.all([server.close(), upstream.close()]);
  }
}

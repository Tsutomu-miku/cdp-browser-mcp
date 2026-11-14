import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readAdmin, rpc } from "./broker.js";
import { headerSchema } from "./config.js";
export async function serveMcp(
  stateDir: string,
  agentId: string,
  lane: string,
  headers: Record<string, string> = {},
) {
  const admin = await readAdmin(stateDir),
    session = await rpc<{ token: string }>(admin, "register", { agentId });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    rpc(admin, method, params, session.token);
  const server = new McpServer({
    name: "cdp-browser-mcp",
    version: "0.2.0-extension-poc.1",
  });
  let activeTab: string | undefined;
  let stopped = false;
  const result = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });
  const tab = async () => {
    if (!activeTab) activeTab = (await call("open", { lane, headers })).tabId;
    return activeTab!;
  };
  const run = async (action: string, args: Record<string, unknown>) =>
    result(await call("action", { tabId: await tab(), action, args }));
  server.registerTool(
    "browser_navigate",
    {
      description:
        "Navigate the current agent-owned tab. Returns an accessibility snapshot with refs.",
      inputSchema: { url: z.string() },
    },
    (args) => run("navigate", args),
  );
  const element = {
    element: z
      .string()
      .optional()
      .describe("Human-readable element description"),
    ref: z
      .string()
      .optional()
      .describe("Exact ref from the latest accessibility snapshot"),
    selector: z.string().optional().describe("CSS selector alternative to ref"),
  };
  server.registerTool(
    "browser_click",
    {
      description: "Click an element in the current tab.",
      inputSchema: element,
    },
    (args) => run("click", args),
  );
  server.registerTool(
    "browser_type",
    {
      description: "Fill a field in the current tab.",
      inputSchema: {
        ...element,
        text: z.string(),
        submit: z.boolean().optional(),
        slowly: z.boolean().optional(),
      },
    },
    (args) => run("type", args),
  );
  server.registerTool(
    "browser_snapshot",
    {
      description:
        "Capture accessibility snapshot and element refs for the current tab.",
      inputSchema: {},
    },
    () => run("snapshot", {}),
  );
  server.registerTool(
    "browser_extract",
    {
      description: "Extract visible text from the current tab.",
      inputSchema: { selector: z.string().optional() },
    },
    (args) => run("extract", args),
  );
  server.registerTool(
    "browser_take_screenshot",
    {
      description:
        "Capture the current tab. Extension backend requires activating the tab and clicking its toolbar button first.",
      inputSchema: {},
    },
    async () => {
      const shot = await call("action", {
        tabId: await tab(),
        action: "screenshot",
        args: {},
      });
      return {
        content: [
          { type: "image" as const, data: shot.data, mimeType: shot.mimeType },
        ],
      };
    },
  );
  server.registerTool(
    "browser_close",
    {
      description:
        "Close the current tab and release its lane and download ownership.",
      inputSchema: {},
    },
    async () => {
      const id = await tab();
      const r = await call("close", { tabId: id });
      activeTab = undefined;
      return result(r);
    },
  );
  server.registerTool(
    "browser_tabs",
    {
      description:
        "List/open/select/close owned tabs. Extension backend also lists available Chrome tabs and explicitly attaches a chromeTabId; headers replaces a tab policy ({} removes).",
      inputSchema: {
        action: z.enum([
          "list",
          "new",
          "select",
          "close",
          "available",
          "attach",
          "headers",
        ]),
        chromeTabId: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Native Chrome tab ID for extension attach"),
        tabId: z.string().optional(),
        lane: z.string().optional(),
        headers: headerSchema.optional(),
      },
    },
    async (args) => {
      if (args.action === "available") return result(await call("available"));
      if (args.action === "attach") {
        if (args.chromeTabId === undefined) throw Error("chromeTabId required");
        const t = await call("attach", {
          chromeTabId: args.chromeTabId,
          lane: args.lane || lane,
          headers: { ...headers, ...args.headers },
        });
        activeTab = t.tabId;
        return result(t);
      }
      if (args.action === "headers") {
        if (!args.headers) throw Error("headers required; use {} to remove");
        return result(
          await call("headers", {
            tabId: args.tabId || (await tab()),
            headers: args.headers,
          }),
        );
      }
      if (args.action === "list") return result(await call("list"));
      if (args.action === "new") {
        const t = await call("open", {
          lane: args.lane || lane,
          headers: { ...headers, ...args.headers },
        });
        activeTab = t.tabId;
        return result(t);
      }
      if (!args.tabId) throw Error("tabId required");
      if (args.action === "select") {
        const own = await call("list");
        if (!own.some((t: { tabId: string }) => t.tabId === args.tabId))
          throw Error("Tab not owned by this agent");
        activeTab = args.tabId;
        return result({ selected: activeTab });
      }
      const r = await call("close", { tabId: args.tabId });
      if (activeTab === args.tabId) activeTab = undefined;
      return result(r);
    },
  );
  server.registerTool(
    "browser_downloads",
    {
      description: "List only downloads attributed to this agent.",
      inputSchema: {},
    },
    async () => result(await call("downloads")),
  );
  server.registerTool(
    "browser_lease",
    {
      description: "Renew this tab lease while a human is inspecting it.",
      inputSchema: {},
    },
    async () => result(await call("renew", { tabId: await tab() })),
  );
  // Idle/disconnected clients do not renew automatically: a crashed process must lose its tabs.
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await call("unregister");
    } catch (e) {
      console.error(
        JSON.stringify({ event: "mcp.cleanup-failed", error: String(e) }),
      );
    }
    await server.close();
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
  // StdioServerTransport does not translate stdin EOF into onclose. Without
  // this handler a normal client disconnect exits before releasing its tabs.
  process.stdin.once("end", () => {
    void stop();
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  server.server.onclose = () => {
    void stop();
  };
}

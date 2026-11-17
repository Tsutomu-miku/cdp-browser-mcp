import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { upstreamTransport } from "../upstream.js";
import type { Audit } from "./audit.js";

const core = new Set([
  "list_pages",
  "select_page",
  "take_snapshot",
  "take_screenshot",
  "click",
  "drag",
  "fill",
  "fill_form",
  "hover",
  "press_key",
  "wait_for",
  "evaluate_script",
  "navigate_page",
  "list_network_requests",
  "get_network_request",
  "list_console_messages",
  "get_console_message",
  "handle_dialog",
]);

/** One persistent official action backend, shared by authenticated MCP peers. */
export class ExtensionTools {
  private client = new Client({
    name: "cdp-browser-mcp-extension",
    version: "0.4.0",
  });
  private owners = new Map<number, string>();
  private active = new Map<string, number>();
  private disconnected = new Set<string>();
  private started?: Promise<void>;
  private stopping = false;
  constructor(
    readonly endpoint: string,
    readonly token: string,
    readonly audit: Audit,
    readonly failed: (error: Error) => void,
  ) {
    this.client.onclose = () => {
      if (!this.stopping)
        this.failed(
          Error(
            "Official extension backend disconnected; its session is invalid",
          ),
        );
    };
    this.client.onerror = (error) => this.failed(error);
  }
  private ready() {
    this.started ??= (async () => {
      const transport = await upstreamTransport(
        [
          "--wsEndpoint",
          this.endpoint,
          "--wsHeaders",
          JSON.stringify({ Authorization: `Bearer ${this.token}` }),
          "--pageIdRouting",
          "--no-usage-statistics",
          "--no-performance-crux",
        ],
        "inherit",
      );
      await this.client.connect(transport);
    })();
    return this.started;
  }
  async list() {
    await this.ready();
    const result = await this.client.listTools();
    return {
      ...result,
      tools: [
        ...result.tools.filter((tool) => core.has(tool.name)),
        {
          name: "extension_release_page",
          description:
            "Release this MCP client's page claim without closing the daily tab.",
          inputSchema: {
            type: "object" as const,
            properties: { pageId: { type: "integer" } },
            required: ["pageId"],
          },
        },
      ],
    };
  }
  async call(
    owner: string,
    request: CallToolRequest["params"],
    signal: AbortSignal,
  ) {
    const { name, arguments: args = {} } = request;
    const pageId = args.pageId;
    if (name === "extension_release_page") {
      if (this.active.has(owner))
        throw Error("Wait for pending operations before releasing a page");
      if (typeof pageId !== "number" || this.owners.get(pageId) !== owner)
        throw Error("Page is not claimed by this MCP client");
      this.owners.delete(pageId);
      await this.audit.write("page.released", { client: owner, pageId });
      return {
        content: [
          {
            type: "text" as const,
            text: "Page released; daily tab remains open.",
          },
        ],
      };
    }
    if (!core.has(name))
      throw Error(`Tool is not available in extension mode: ${name}`);
    if (name !== "list_pages") {
      if (typeof pageId !== "number" || !Number.isSafeInteger(pageId))
        throw Error("Use list_pages, then pass an explicit pageId");
      const current = this.owners.get(pageId);
      if (current && current !== owner)
        throw Error(
          "Page is claimed by another MCP client; release it or end that client's session",
        );
      this.owners.set(pageId, owner);
    }
    this.active.set(owner, (this.active.get(owner) ?? 0) + 1);
    try {
      await this.audit.write("tool.started", {
        client: owner,
        tool: name,
        pageId: typeof pageId === "number" ? pageId : undefined,
      });
      await this.ready();
      const result = await this.client.callTool(request, undefined, {
        timeout: 90000,
        signal,
      });
      await this.audit.write("tool.finished", {
        client: owner,
        tool: name,
        outcome: result.isError ? "error" : "ok",
      });
      return result;
    } catch (error) {
      await this.audit.write("tool.finished", {
        client: owner,
        tool: name,
        outcome: "failed; do not replay mutations",
      });
      throw error;
    } finally {
      const remaining = this.active.get(owner)! - 1;
      if (remaining) this.active.set(owner, remaining);
      else {
        this.active.delete(owner);
        if (this.disconnected.delete(owner)) await this.release(owner);
      }
    }
  }
  async release(owner: string) {
    if (this.active.has(owner)) {
      this.disconnected.add(owner);
      return;
    }
    for (const [pageId, current] of this.owners)
      if (current === owner) this.owners.delete(pageId);
    await this.audit.write("client.disconnected", { client: owner });
  }
  async close() {
    this.stopping = true;
    await this.client.close();
  }
}

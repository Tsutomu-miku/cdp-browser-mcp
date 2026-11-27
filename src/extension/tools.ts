import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { upstreamTransport } from "../upstream.js";
import type { Audit } from "./audit.js";
import type { ExtensionActivity } from "./activity.js";

const core = new Set([
  "list_pages",
  "select_page",
  "take_snapshot",
  "take_screenshot",
  "click",
  "drag",
  "fill",
  "fill_form",
  "type_text",
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

const interactive = new Set([
  "click",
  "drag",
  "fill",
  "fill_form",
  "type_text",
  "hover",
  "press_key",
  "evaluate_script",
  "navigate_page",
]);

/** One persistent official action backend, shared by authenticated MCP peers. */
export class ExtensionTools {
  private client = new Client({
    name: "cdp-browser-mcp-extension",
    version: "0.4.2",
  });
  private owners = new Map<number, string>();
  private active = new Map<string, number>();
  private disconnected = new Set<string>();
  private started?: Promise<void>;
  private readonly lifetime = new AbortController();
  constructor(
    readonly endpoint: string,
    readonly token: string,
    readonly audit: Audit,
    readonly failed: (error: Error) => void,
    readonly activity?: ExtensionActivity,
  ) {
    this.client.onclose = () => {
      if (!this.lifetime.signal.aborted)
        this.failed(
          Error(
            "Official extension backend disconnected; its session is invalid",
          ),
        );
    };
    this.client.onerror = (error) => this.failed(error);
  }
  private ready() {
    const { signal } = this.lifetime;
    signal.throwIfAborted();
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
      signal.throwIfAborted();
      await this.client.connect(transport, { signal });
    })();
    return this.started;
  }
  async list() {
    await this.ready();
    const result = await this.client.listTools();
    return {
      ...result,
      tools: [
        ...result.tools
          .filter((tool) => core.has(tool.name))
          .map((tool) =>
            tool.name !== "type_text"
              ? tool
              : {
                  ...tool,
                  inputSchema: {
                    ...tool.inputSchema,
                    properties: {
                      ...tool.inputSchema.properties,
                      includeSnapshot: {
                        type: "boolean",
                        description:
                          "Also return a snapshot after typing and submitting.",
                      },
                    },
                  },
                },
          ),
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
  private async run(request: CallToolRequest["params"], signal: AbortSignal) {
    const options = { timeout: 90000, signal };
    if (request.name !== "type_text")
      return await this.client.callTool(request, undefined, options);

    const { includeSnapshot, ...args } = request.arguments ?? {};
    const typed = CallToolResultSchema.parse(
      await this.client.callTool(
        { ...request, arguments: args },
        undefined,
        options,
      ),
    );
    if (includeSnapshot !== true || typed.isError) return typed;

    const snapshot = CallToolResultSchema.parse(
      await this.client.callTool(
        { name: "take_snapshot", arguments: { pageId: args.pageId } },
        undefined,
        options,
      ),
    );
    return {
      ...typed,
      content: [
        ...typed.content,
        ...(snapshot.isError
          ? [
              {
                type: "text" as const,
                text: "Typing completed before the snapshot failed. Inspect the page before retrying.",
              },
            ]
          : []),
        ...snapshot.content,
      ],
      structuredContent: {
        ...typed.structuredContent,
        ...snapshot.structuredContent,
      },
      isError: snapshot.isError,
    };
  }
  async call(
    owner: string,
    request: CallToolRequest["params"],
    signal: AbortSignal,
    label = "MCP",
  ) {
    const { name, arguments: args = {} } = request;
    const pageId = args.pageId;
    if (name === "extension_release_page") {
      if (this.active.has(owner))
        throw Error("Wait for pending operations before releasing a page");
      if (typeof pageId !== "number" || this.owners.get(pageId) !== owner)
        throw Error("Page is not claimed by this MCP client");
      this.owners.delete(pageId);
      this.activity?.forget(pageId);
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
    let stopActivity: (() => void) | undefined;
    try {
      await this.audit.write("tool.started", {
        client: owner,
        tool: name,
        pageId: typeof pageId === "number" ? pageId : undefined,
      });
      await this.ready();
      if (this.activity && typeof pageId === "number" && interactive.has(name))
        stopActivity = await this.activity.start(
          this.client,
          pageId,
          label,
          signal,
          this.lifetime.signal,
        );
      const result = await this.run(request, signal);
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
      try {
        stopActivity?.();
      } finally {
        const remaining = this.active.get(owner)! - 1;
        if (remaining) this.active.set(owner, remaining);
        else {
          this.active.delete(owner);
          if (this.disconnected.delete(owner)) await this.release(owner);
        }
      }
    }
  }
  async release(owner: string) {
    if (this.active.has(owner)) {
      this.disconnected.add(owner);
      return;
    }
    for (const [pageId, current] of this.owners) {
      if (current !== owner) continue;
      this.owners.delete(pageId);
      this.activity?.forget(pageId);
    }
    await this.audit.write("client.disconnected", { client: owner });
  }
  async close() {
    this.lifetime.abort(Error("Extension backend is stopping"));
    await this.client.close();
  }
}

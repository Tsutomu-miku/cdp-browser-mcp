import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { upstreamTransport } from "./upstream.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Log } from "./runtime.js";

interface SnapshotNode {
  id: string;
  role: string;
  name?: string;
  value?: string;
  children?: SnapshotNode[];
}
const texts = (r: CallToolResult) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
export class Devtools {
  readonly client = new Client({
    name: "cdp-browser-mcp",
    version: "0.3.0",
  });
  transport?: StdioClientTransport;
  private stopping = false;
  constructor(
    readonly log: Log,
    readonly disconnected: () => void,
    readonly timeoutMs: number,
  ) {}
  async start(endpoint: string, workspace: string) {
    this.transport = await upstreamTransport(
      [
        "--browserUrl",
        endpoint,
        "--pageIdRouting",
        "--experimentalStructuredContent",
        "--no-usage-statistics",
        "--no-performance-crux",
        "--no-file-navigations",
        "--workspace",
        workspace,
      ],
      "pipe",
    );
    this.client.onclose = () => {
      if (!this.stopping) this.disconnected();
    };
    // Drain stderr without logging arbitrary browser/page data or upstream startup prose.
    this.transport.stderr?.on("data", () => {});
    await this.client.connect(this.transport);
    await this.call("list_pages"); // Forces attachment before reporting ready.
    this.log("devtools.attached", {
      version: "1.13.0",
      endpoint,
      pid: this.transport.pid,
    });
  }
  async call(
    name: string,
    args: Record<string, unknown> = {},
    timeout = this.timeoutMs,
  ): Promise<CallToolResult> {
    const result = (await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout },
    )) as CallToolResult;
    if (result.isError)
      throw Error(`chrome-devtools-mcp ${name}: ${texts(result)}`);
    return result;
  }
  async pageId(url: string) {
    const r = await this.call("list_pages");
    const pages = r.structuredContent!.pages as { id: number; url: string }[];
    const page = pages.find((p) => p.url === url);
    if (!page) throw Error("Official server did not discover the owned page");
    return page.id;
  }
  async evaluate(pageId: number, source: string, args?: string[]) {
    const r = await this.call("evaluate_script", {
      pageId,
      function: source,
      args,
      waitForStableDom: false,
    });
    const match = texts(r).match(/```json\n([\s\S]*?)\n```/);
    if (!match) throw Error("Official evaluate_script JSON result missing");
    return JSON.parse(match[1]);
  }
  private async tree(pageId: number) {
    const r = await this.call("take_snapshot", { pageId });
    return r.structuredContent!.snapshot as unknown as SnapshotNode;
  }
  async snapshot(pageId: number) {
    const tree = await this.tree(pageId);
    const lines: string[] = [];
    const visit = (n: SnapshotNode, depth: number) => {
      lines.push(
        `${"  ".repeat(depth)}- ${n.role}${n.name ? " " + JSON.stringify(n.name) : ""} [ref=${n.id}]${n.value ? ": " + n.value : ""}`,
      );
      n.children?.forEach((c) => visit(c, depth + 1));
    };
    visit(tree, 0);
    return lines.join("\n");
  }
  private async uid(pageId: number, args: Record<string, unknown>) {
    if (typeof args.ref === "string") return args.ref;
    if (typeof args.selector !== "string")
      throw Error("Provide ref from browser_snapshot or a CSS selector");
    const nodes: SnapshotNode[] = [];
    const visit = (n: SnapshotNode, root = false) => {
      if (!root && ["RootWebArea", "Iframe", "iframe"].includes(n.role)) return;
      if (!["RootWebArea", "StaticText", "InlineTextBox"].includes(n.role))
        nodes.push(n);
      n.children?.forEach((c) => visit(c));
    };
    visit(await this.tree(pageId), true);
    const index = await this.evaluate(
      pageId,
      `(...elements) => elements.findIndex(el => el === document.querySelector(${JSON.stringify(args.selector)}))`,
      nodes.map((n) => n.id),
    );
    if (index < 0)
      throw Error(
        "Selector must match an accessible element in the latest snapshot",
      );
    return nodes[index].id;
  }
  async action(pageId: number, method: string, args: Record<string, unknown>) {
    if (method === "extract")
      return {
        text: (
          await this.evaluate(
            pageId,
            `() => { const el = document.querySelector(${JSON.stringify(typeof args.selector === "string" ? args.selector : "body")}); if (!el) throw Error('Selector not found'); return el.innerText; }`,
          )
        ).slice(0, 100000),
      };
    switch (method) {
      case "navigate": {
        const url = new URL(String(args.url));
        if (!["http:", "https:", "about:"].includes(url.protocol))
          throw Error("Only http(s) and about URLs are supported");
        await this.call("navigate_page", { pageId, url: url.href });
        break;
      }
      case "click":
        await this.call("click", { pageId, uid: await this.uid(pageId, args) });
        break;
      case "type": {
        const uid = await this.uid(pageId, args);
        if (args.slowly) {
          await this.call("click", { pageId, uid });
          await this.call("type_text", { pageId, text: String(args.text) });
        } else
          await this.call("fill", { pageId, uid, value: String(args.text) });
        if (args.submit) await this.call("press_key", { pageId, key: "Enter" });
        break;
      }
      case "snapshot":
        break;
      default:
        throw Error(`Unknown browser action: ${method}`);
    }
    return {
      url: await this.evaluate(pageId, "() => location.href"),
      snapshot: await this.snapshot(pageId),
    };
  }
  async stop() {
    this.stopping = true;
    await this.client.close();
  }
}

// Only page-scoped diagnostics cross the ownership boundary. Global lifecycle and policy tools stay private.
export const diagnosticNames = [
  "take_screenshot",
  "list_network_requests",
  "get_network_request",
  "list_console_messages",
  "get_console_message",
  "performance_start_trace",
  "performance_analyze_insight",
  "lighthouse_audit",
  "get_css_styles",
];

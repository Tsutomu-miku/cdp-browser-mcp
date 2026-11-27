import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { NativeChannel } from "./native-channel.js";

/** Resolve official page IDs to exact CDP sessions without comparing tab URLs. */
export class ExtensionActivity {
  private probes = new Map<string, { sessionId?: string }>();
  private pages = new Map<number, Promise<string | undefined>>();
  private running = new Map<string, number>();

  constructor(readonly channel: Pick<NativeChannel, "send">) {}

  observe(command: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }) {
    const expression = command.params?.expression;
    if (command.method !== "Runtime.evaluate" || typeof expression !== "string")
      return;
    const probe = this.probes.get(expression.split("\n", 1)[0]);
    if (probe && command.sessionId?.startsWith("page:"))
      probe.sessionId = command.sessionId;
  }

  private async resolve(client: Client, pageId: number, signal: AbortSignal) {
    // Puppeteer sends this read-only expression through the page's root session.
    const expression = `0 /* cdp-browser-mcp activity ${randomUUID()} */`;
    const probe: { sessionId?: string } = {};
    this.probes.set(expression, probe);
    try {
      const result = await client.callTool(
        {
          name: "evaluate_script",
          arguments: {
            pageId,
            function: expression,
            format: "script",
            // An unrelated page dialog must remain for the user or the next tool.
            dialogAction: "",
            waitForStableDom: false,
          },
        },
        undefined,
        { timeout: 3000, signal },
      );
      if (!result.isError && probe.sessionId) return probe.sessionId;
      console.error(
        "CDP Browser MCP: could not resolve activity indicator for page",
        pageId,
      );
      return undefined;
    } catch (error) {
      if (
        error instanceof McpError &&
        error.code === ErrorCode.RequestTimeout
      ) {
        console.error(
          "CDP Browser MCP: activity lookup timed out for page",
          pageId,
        );
        return undefined;
      }
      throw error;
    } finally {
      this.probes.delete(expression);
    }
  }

  async start(
    client: Client,
    pageId: number,
    label: string,
    signal: AbortSignal,
    lifetime: AbortSignal,
  ) {
    let pending = this.pages.get(pageId);
    if (!pending) {
      pending = this.resolve(client, pageId, lifetime);
      this.pages.set(pageId, pending);
    }
    let sessionId: string | undefined;
    try {
      sessionId = await pending;
    } finally {
      if (!sessionId && this.pages.get(pageId) === pending)
        this.pages.delete(pageId);
    }
    signal.throwIfAborted();
    if (!sessionId) return undefined;
    const count = this.running.get(sessionId) ?? 0;
    if (count === 0) this.channel.send({ kind: "activity", sessionId, label });
    this.running.set(sessionId, count + 1);
    return () => {
      const remaining = this.running.get(sessionId)! - 1;
      if (remaining > 0) this.running.set(sessionId, remaining);
      else {
        this.running.delete(sessionId);
        this.channel.send({ kind: "activity", sessionId });
      }
    };
  }

  forget(pageId: number) {
    this.pages.delete(pageId);
  }
}

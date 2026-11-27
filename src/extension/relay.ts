import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { NativeChannel } from "./native-channel.js";
import { ExtensionTools } from "./tools.js";
import type { Audit } from "./audit.js";
import { ExtensionActivity } from "./activity.js";

const command = z.object({
  id: z.number().int(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().optional(),
});
const message = z.object({
  kind: z.literal("cdp"),
  message: z.record(z.string(), z.unknown()),
});

/** Only the official subprocess may open CDP; other local clients get scoped MCP calls. */
export async function startRelay(
  channel: Pick<NativeChannel, "send" | "on" | "off">,
  audit: Audit,
  activitySupported = false,
) {
  const token = randomBytes(32).toString("hex");
  const cdpToken = randomBytes(32).toString("hex");
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024 * 1024,
  });
  const http = createServer((_req, response) => response.writeHead(404).end());
  let cdp: WebSocket | undefined;
  let tools: ExtensionTools;
  let closing = false;
  let browserAccessed = false;
  const activity = activitySupported
    ? new ExtensionActivity(channel)
    : undefined;
  const nativeMessage = (value: unknown) => {
    if (
      value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "revoke"
    ) {
      z.object({ kind: z.literal("revoke") })
        .strict()
        .parse(value);
      if (browserAccessed && !closing) {
        closing = true;
        for (const peer of sockets.clients) peer.terminate();
        http.emit("revoked");
      }
      return;
    }
    const parsed = message.parse(value);
    if (cdp?.readyState === WebSocket.OPEN)
      cdp.send(JSON.stringify(parsed.message));
  };
  channel.on("message", nativeMessage);
  http.on("upgrade", (request, socket, head) => {
    const expected = request.url === "/cdp" ? cdpToken : token;
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const wanted = Buffer.from(`Bearer ${expected}`);
    if (
      closing ||
      request.headers.origin ||
      request.headers.host !== `127.0.0.1:${port}` ||
      !["/mcp", "/cdp"].includes(request.url ?? "") ||
      supplied.length !== wanted.length ||
      !timingSafeEqual(supplied, wanted) ||
      (request.url === "/cdp" && cdp)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (peer) => {
      if (request.url === "/cdp") {
        cdp = peer;
        browserAccessed = true;
        const forward = async (bytes: unknown) => {
          const parsed = command.parse(JSON.parse(String(bytes)));
          activity?.observe(parsed);
          try {
            channel.send({ kind: "command", message: parsed });
          } catch (error) {
            peer.send(
              JSON.stringify({
                id: parsed.id,
                sessionId: parsed.sessionId,
                error: { code: -32000, message: (error as Error).message },
              }),
            );
          }
        };
        peer.on("message", (bytes) => {
          void forward(bytes).catch((error) => {
            peer.close(1008, error.message.slice(0, 100));
            http.emit("error", error);
          });
        });
        peer.once("close", () => {
          cdp = undefined;
          if (!closing) {
            channel.send({ kind: "reset" });
            http.emit(
              "error",
              Error(
                "Official CDP disconnected; the extension generation and its page IDs are invalid. Start a new MCP session.",
              ),
            );
          }
        });
      } else {
        const client = randomUUID();
        const pending = new Map<number, AbortController>();
        peer.on("message", async (bytes) => {
          let id: number | undefined;
          try {
            const raw = JSON.parse(String(bytes));
            if (raw && Object.hasOwn(raw, "cancel")) {
              const { cancel } = z
                .object({ cancel: z.number().int() })
                .parse(raw);
              pending
                .get(cancel)
                ?.abort(
                  Error(
                    "MCP request cancelled; operation outcome may be unknown",
                  ),
                );
              return;
            }
            const request = z
              .object({
                id: z.number().int(),
                method: z.enum(["tools/list", "tools/call"]),
                params: z.unknown().optional(),
                label: z.string().trim().min(1).max(64).optional(),
              })
              .parse(raw);
            if (pending.has(request.id)) {
              peer.close(1008, "Duplicate relay request ID");
              return;
            }
            id = request.id;
            const controller = new AbortController();
            pending.set(id, controller);
            const result =
              request.method === "tools/list"
                ? await tools.list()
                : await tools.call(
                    client,
                    CallToolRequestSchema.parse({
                      method: request.method,
                      params: request.params,
                    }).params,
                    controller.signal,
                    request.label,
                  );
            if (peer.readyState === WebSocket.OPEN)
              peer.send(JSON.stringify({ id, result }));
          } catch (error) {
            if (peer.readyState === WebSocket.OPEN)
              peer.send(
                JSON.stringify({
                  id,
                  error: { message: (error as Error).message },
                }),
              );
          } finally {
            if (id !== undefined) pending.delete(id);
          }
        });
        peer.once("close", () => {
          for (const controller of pending.values())
            controller.abort(Error("MCP client disconnected"));
          void tools
            .release(client)
            .catch((error) => http.emit("error", error));
        });
      }
      peer.on("error", () => {
        peer.terminate();
        void audit
          .write("peer.transport-error")
          .catch((error) => http.emit("error", error));
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const port = (http.address() as { port: number }).port;
  tools = new ExtensionTools(
    `ws://127.0.0.1:${port}/cdp`,
    cdpToken,
    audit,
    (error) => http.emit("error", error),
    activity,
  );
  return {
    endpoint: `ws://127.0.0.1:${port}/mcp`,
    token,
    http,
    async close() {
      closing = true;
      channel.off("message", nativeMessage);
      for (const peer of sockets.clients) peer.terminate();
      await tools.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}

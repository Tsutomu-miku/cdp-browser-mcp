import { WebSocket } from "ws";
import { readRelay } from "./state.js";

/** One authenticated relay peer; connection loss releases its page claims. No replay. */
export class RelayClient {
  private peer?: WebSocket;
  private starting?: Promise<WebSocket>;
  private nextId = 0;
  private stopped = false;
  private pending = new Map<
    number,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(readonly directory: string) {}
  private connect() {
    this.starting ??= (async () => {
      if (this.stopped) throw Error("Extension MCP session ended");
      const { endpoint, token } = await readRelay(this.directory);
      // EOF can arrive while discovery is awaiting filesystem I/O.
      if (this.stopped) throw Error("Extension MCP session ended");
      const peer = new WebSocket(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: 5000,
        maxPayload: 32 * 1024 * 1024,
      });
      this.peer = peer;
      peer.on("message", (bytes) => {
        try {
          const message = JSON.parse(String(bytes));
          const pending = this.pending.get(message.id);
          if (!pending) return; // Late responses never cause a request replay.
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) pending.reject(Error(message.error.message));
          else pending.resolve(message.result);
        } catch (error) {
          peer.close(1002, "Invalid relay response");
          this.reject(error as Error);
        }
      });
      peer.on("error", (error) => this.reject(error));
      peer.once("close", () =>
        this.reject(
          Error(
            "Extension relay disconnected; action outcome may be unknown. Restart this MCP session; do not replay mutations blindly.",
          ),
        ),
      );
      await new Promise<void>((resolve, reject) => {
        peer.once("open", resolve);
        peer.once("error", reject);
      });
      return peer;
    })();
    return this.starting;
  }
  private reject(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  async call(
    method: "tools/list" | "tools/call",
    params?: unknown,
    signal?: AbortSignal,
    label?: string,
  ) {
    const peer = await this.connect();
    signal?.throwIfAborted();
    if (this.stopped || peer.readyState !== WebSocket.OPEN)
      throw Error(
        "Extension relay is not connected; restart this MCP session after fixing setup, changing consent or restarting Chrome",
      );
    const id = ++this.nextId;
    return await new Promise<any>((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cancel = () => {
        if (peer.readyState === WebSocket.OPEN)
          peer.send(JSON.stringify({ cancel: id }));
        fail(
          Error(
            "Extension request cancelled; operation outcome may be unknown",
          ),
        );
      };
      const timer = setTimeout(() => {
        if (peer.readyState === WebSocket.OPEN)
          peer.send(JSON.stringify({ cancel: id }));
        fail(
          Error("Extension request timed out; do not replay mutations blindly"),
        );
      }, 95000);
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: fail,
        timer,
      });
      signal?.addEventListener("abort", cancel, { once: true });
      peer.send(JSON.stringify({ id, method, params, label }));
    });
  }
  close() {
    this.stopped = true;
    this.reject(Error("Extension MCP session ended"));
    this.peer?.terminate();
  }
}

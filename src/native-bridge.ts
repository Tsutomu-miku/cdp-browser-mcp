import { createServer, type Server, type Socket } from "node:net";
import { chmod, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./config.js";
import type { Log } from "./runtime.js";

export const NATIVE_PROTOCOL = 1;
export const HOST_NAME = "io.github.tsutomu_miku.cdp_browser_mcp";
export const MAX_NATIVE_BYTES = 8 * 1024 * 1024;

/** One authenticated native host at a time; commands are never replayed. */
export class NativeBridge {
  private server?: Server;
  private socket?: Socket;
  private sockets = new Set<Socket>();
  private token = randomBytes(32).toString("hex");
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  ready = false;
  hostPid?: number;
  generation = 0;
  private stopping = false;
  constructor(
    readonly config: Config,
    readonly log: Log,
    readonly restore: () => Promise<void>,
  ) {}
  async start() {
    if (!["darwin", "linux"].includes(process.platform))
      throw Error(
        "Extension native bridge currently supports macOS/Linux Unix sockets only",
      );
    if (!this.config.extensionId)
      throw Error(
        "extension backend requires extensionId from chrome://extensions",
      );
    const socketPath = join(this.config.stateDir, "native.sock");
    await rm(socketPath, { force: true });
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    const identity = join(this.config.stateDir, `native-${process.pid}.tmp`);
    try {
      await writeFile(
        identity,
        JSON.stringify({
          socket: socketPath,
          token: this.token,
          extensionId: this.config.extensionId,
        }),
        { mode: 0o600 },
      );
      await rename(identity, join(this.config.stateDir, "native.json"));
    } finally {
      await rm(identity, { force: true });
    }
    await chmod(join(this.config.stateDir, "native.json"), 0o600);
  }
  private accept(socket: Socket) {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "",
      authenticated = false;
    const handshake = setTimeout(
      () => socket.destroy(Error("Native handshake timeout")),
      3000,
    );
    socket.on("data", (data) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_NATIVE_BYTES)
        return socket.destroy(Error("Native frame too large"));
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (!authenticated) {
            const supplied = Buffer.from(String(message.token));
            const expected = Buffer.from(this.token);
            if (
              message.kind !== "hello" ||
              message.version !== NATIVE_PROTOCOL ||
              message.extensionId !== this.config.extensionId ||
              supplied.length !== expected.length ||
              !timingSafeEqual(supplied, expected)
            )
              throw Error("Invalid native handshake");
            if (this.socket)
              throw Error(
                "A native host is already connected to this stateDir",
              );
            clearTimeout(handshake);
            authenticated = true;
            this.socket = socket;
            this.hostPid = message.pid;
            this.generation++;
            this.log("native.connected", {
              pid: this.hostPid,
              generation: this.generation,
            });
            void this.restore()
              .then(() => {
                if (this.socket === socket && !this.stopping) this.ready = true;
              })
              .catch((error) => socket.destroy(error));
          } else {
            if (message.kind !== "response" || typeof message.id !== "string")
              throw Error("Invalid native response");
            const pending = this.pending.get(message.id);
            if (!pending) continue; // A timed-out command may complete later; never replay it.
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (typeof message.error === "string")
              pending.reject(Error(message.error));
            else pending.resolve(message.result);
          }
        } catch (error) {
          socket.destroy(error as Error);
          return;
        }
      }
    });
    socket.on("error", (error) =>
      this.log("native.transport-error", { error: error.message }),
    );
    socket.on("close", () => {
      clearTimeout(handshake);
      this.sockets.delete(socket);
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      this.hostPid = undefined;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          Error(
            "Native host disconnected; operation outcome may be unknown. Do not replay mutations blindly.",
          ),
        );
      }
      this.pending.clear();
      this.log("native.disconnected");
    });
  }
  async waitReady() {
    const deadline = Date.now() + this.config.actionTimeoutMs;
    while (!this.ready && !this.stopping && Date.now() < deadline)
      await delay(50);
    if (!this.ready)
      throw Error(
        "Extension unavailable. Load the unpacked extension and install its native manifest; later requests can reconnect.",
      );
  }
  async call(
    method: string,
    params: Record<string, unknown> = {},
    restoring = false,
  ): Promise<any> {
    if (!restoring) await this.waitReady();
    if (!this.socket) throw Error("Native host is disconnected");
    const socket = this.socket,
      id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Error(
            `Extension ${method} timed out; mutation outcome may be unknown`,
          ),
        );
        // Break a wedged channel so the extension launches a fresh host.
        socket.destroy(Error("Native health/action timeout"));
      }, this.config.actionTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(
        JSON.stringify({
          kind: "request",
          version: NATIVE_PROTOCOL,
          id,
          method,
          params,
        }) + "\n",
      );
    });
  }
  async stop() {
    this.stopping = true;
    this.ready = false;
    for (const socket of this.sockets) socket.destroy();
    if (this.server)
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(join(this.config.stateDir, "native.sock"), { force: true });
    await rm(join(this.config.stateDir, "native.json"), { force: true });
  }
}

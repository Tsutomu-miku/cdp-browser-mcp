import { EventEmitter } from "node:events";

export class CdpClosedError extends Error {}
export class CdpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
export class CdpSession extends EventEmitter {
  closed = false;
  constructor(
    readonly connection: CdpConnection,
    readonly id: string,
    readonly parentId?: string,
  ) {
    super();
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed)
      return Promise.reject(new CdpClosedError("CDP session closed"));
    return this.connection.command(method, params, this.id);
  }
}
/** One independent browser WebSocket; every child uses the flat sessionId envelope. */
export class CdpConnection extends EventEmitter {
  closed = false;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      sessionId?: string;
    }
  >();
  readonly sessions = new Map<string, CdpSession>();
  private constructor(readonly socket: WebSocket) {
    super();
    this.socket.addEventListener("message", (e) =>
      this.receive(JSON.parse(String(e.data))),
    );
    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const id of this.sessions.keys()) this.drop(id);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new CdpClosedError("CDP transport disconnected"));
      }
      this.pending.clear();
      this.emit("disconnected");
    });
  }
  static async connect(endpoint: string) {
    const response = await fetch(endpoint + "/json/version", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error(`CDP health: HTTP ${response.status}`);
    const info = (await response.json()) as { webSocketDebuggerUrl: string };
    const url = new URL(info.webSocketDebuggerUrl);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      throw Error("CDP must stay on loopback");
    const socket = new WebSocket(url);
    const cdp = new CdpConnection(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(Error("CDP WebSocket failed")),
        { once: true },
      );
    });
    return cdp;
  }
  send(method: string, params: Record<string, unknown> = {}) {
    return this.command(method, params);
  }
  command(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any> {
    if (this.closed)
      return Promise.reject(new CdpClosedError("CDP transport closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`CDP timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer, sessionId });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  session(id: string, parentId?: string) {
    let session = this.sessions.get(id);
    if (!session) {
      session = new CdpSession(this, id, parentId);
      this.sessions.set(id, session);
    }
    return session;
  }
  async attach(targetId: string) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return this.session(sessionId);
  }
  private drop(id: string) {
    for (const child of [...this.sessions.values()])
      if (child.parentId === id) this.drop(child.id);
    const s = this.sessions.get(id);
    if (s) {
      s.closed = true;
      s.emit("closed");
      this.sessions.delete(id);
    }
    for (const [key, p] of this.pending)
      if (p.sessionId === id) {
        clearTimeout(p.timer);
        p.reject(new CdpClosedError("CDP target detached"));
        this.pending.delete(key);
      }
  }
  private receive(message: any) {
    if (message.id) {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(message.id);
      if (message.error)
        p.reject(new CdpError(message.error.code, message.error.message));
      else p.resolve(message.result);
      return;
    }
    if (message.sessionId && !this.sessions.has(message.sessionId)) return;
    if (message.method === "Target.attachedToTarget")
      this.session(message.params.sessionId, message.sessionId);
    if (message.method === "Target.detachedFromTarget")
      this.drop(message.params.sessionId);
    (message.sessionId ? this.sessions.get(message.sessionId) : this)?.emit(
      message.method,
      message.params,
    );
  }
  async close() {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      this.socket.addEventListener("close", () => resolve(), { once: true });
      this.socket.close();
    });
  }
}

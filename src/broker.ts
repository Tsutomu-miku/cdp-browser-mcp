import {
  createServer,
  request,
  type Server,
  type IncomingMessage,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Steward } from "./steward.js";
import { type Config, idSchema, headerSchema } from "./config.js";
import { logger } from "./runtime.js";
import type { BrowserBackend } from "./backend.js";
import { ExtensionBackend } from "./extension-backend.js";
export interface Admin {
  pid: number;
  token: string;
  socket: string;
}
export class SupervisorBusyError extends Error {
  constructor() {
    super(
      "A browser service is already running or starting for this state directory",
    );
  }
}
const envelope = z
  .object({
    method: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const openSchema = z.object({
  lane: z.string().default("default"),
  headers: headerSchema.default({}),
});
const actionSchema = z.object({
  tabId: z.string().uuid(),
  action: z.enum([
    "navigate",
    "click",
    "type",
    "snapshot",
    "extract",
    "screenshot",
  ]),
  args: z.record(z.string(), z.unknown()).default({}),
});
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function readAdmin(stateDir: string): Promise<Admin> {
  return JSON.parse(await readFile(join(stateDir, "admin.json"), "utf8"));
}
export async function rpc<T = any>(
  admin: Admin,
  method: string,
  params: Record<string, unknown> = {},
  token = admin.token,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: admin.socket,
        path: "/rpc",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (s) => {
          body += s;
          if (body.length > 2 * 1024 * 1024)
            res.destroy(Error("RPC response too large"));
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(body);
            if (res.statusCode !== 200) reject(Error(value.error));
            else resolve(value);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(90000, () => req.destroy(Error("Steward RPC timeout")));
    req.end(JSON.stringify({ method, params }));
  });
}
async function body(req: IncomingMessage) {
  let data = "";
  for await (const part of req) {
    data += part;
    if (data.length > 128 * 1024) throw Error("RPC request too large");
  }
  return envelope.parse(JSON.parse(data));
}
export class Broker {
  readonly steward: BrowserBackend;
  readonly admin: Admin;
  readonly agents = new Map<string, { agentId: string }>();
  private server?: Server;
  private closing?: Promise<void>;
  private locked = false;
  constructor(readonly config: Config) {
    this.steward =
      config.backend === "extension"
        ? new ExtensionBackend(config, logger(config))
        : new Steward(config, logger(config));
    this.admin = {
      pid: process.pid,
      token: randomBytes(32).toString("hex"),
      socket: join(config.stateDir, "control.sock"),
    };
  }
  async start() {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.config.stateDir, 0o700);
    const lock = join(this.config.stateDir, "lock");
    try {
      await mkdir(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let old: Admin;
      try {
        old = await readAdmin(this.config.stateDir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          throw new SupervisorBusyError();
        throw Error(
          "Steward lock exists without valid admin.json; inspect this stateDir before removing the lock",
        );
      }
      let live = true;
      try {
        process.kill(old.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") live = false;
        else throw e;
      }
      if (live) throw new SupervisorBusyError();
      await rm(lock, { recursive: true });
      await mkdir(lock);
    }
    this.locked = true;
    try {
      await rm(this.admin.socket, { force: true });
      // Concurrent starters must see a complete identity or no identity.
      const identity = join(this.config.stateDir, `admin-${process.pid}.tmp`);
      try {
        await writeFile(identity, JSON.stringify(this.admin), { mode: 0o600 });
        await rename(identity, join(this.config.stateDir, "admin.json"));
      } finally {
        await rm(identity, { force: true });
      }
      await writeFile(
        join(this.config.stateDir, "launch-config.json"),
        JSON.stringify(this.config, null, 2),
        { mode: 0o600 },
      );
      await this.steward.start();
      this.server = createServer((req, res) => {
        void (async () => {
          try {
            if (req.method !== "POST" || req.url !== "/rpc")
              throw Error("Use POST /rpc");
            const bearer = (req.headers.authorization || "").replace(
              /^Bearer /,
              "",
            );
            const isAdmin = same(bearer, this.admin.token),
              agent = this.agents.get(bearer);
            if (!isAdmin && !agent) {
              res.writeHead(401);
              res.end(JSON.stringify({ error: "Unauthorized" }));
              return;
            }
            const { method, params } = await body(req);
            const result = await this.dispatch(
              method,
              params,
              isAdmin,
              agent?.agentId,
            );
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: e instanceof Error ? e.message : String(e),
              }),
            );
          }
        })();
      });
      this.server.requestTimeout = 10000;
      this.server.headersTimeout = 10000;
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.admin.socket, resolve);
      });
      await chmod(this.admin.socket, 0o600);
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  private async dispatch(
    method: string,
    p: Record<string, unknown>,
    admin: boolean,
    scopedAgent?: string,
  ): Promise<unknown> {
    if (admin) {
      if (method === "register") {
        const agentId = idSchema.parse(p.agentId);
        if ([...this.agents.values()].some((a) => a.agentId === agentId))
          throw Error(
            "Agent already has an active MCP session; choose a unique agentId",
          );
        const token = randomBytes(32).toString("hex");
        this.agents.set(token, { agentId });
        return { agentId, token };
      }
      if (method === "health") return this.steward.health();
      if (method === "status")
        return {
          ...this.steward.health(),
          tabs: this.steward.list(),
          agents: [...this.agents.values()],
          downloads: this.steward.downloads?.completed || [],
        };
      if (method === "reconnect") {
        await this.steward.recover();
        return this.steward.health();
      }
      if (method === "stop") {
        setImmediate(() => {
          void this.stop().catch((e) => {
            console.error(e);
            process.exitCode = 1;
          });
        });
        return { stopping: true };
      }
      if (method === "reclaim") {
        const agentId = idSchema.parse(p.agentId);
        await this.steward.closeAgent(agentId);
        for (const [key, a] of this.agents)
          if (a.agentId === agentId) this.agents.delete(key);
        return { reclaimed: agentId };
      }
    }
    const agentId =
      scopedAgent || (admin ? idSchema.parse(p.agentId) : undefined);
    if (!agentId) throw Error("Agent scope required");
    switch (method) {
      case "open": {
        const v = openSchema.parse(p);
        return this.steward.open(agentId, v.lane, v.headers);
      }
      case "list":
        return this.steward.list(agentId);
      case "available":
        if (!this.steward.available)
          throw Error("Available Chrome tabs require extension backend");
        return this.steward.available();
      case "attach": {
        if (!this.steward.attach)
          throw Error("Attaching existing tabs requires extension backend");
        const v = openSchema.parse(p);
        return this.steward.attach(
          agentId,
          z.number().int().nonnegative().parse(p.chromeTabId),
          v.lane,
          v.headers,
        );
      }
      case "headers":
        if (!this.steward.setHeaders)
          throw Error("Dynamic header replacement requires extension backend");
        return this.steward.setHeaders(
          agentId,
          z.string().uuid().parse(p.tabId),
          headerSchema.parse(p.headers),
        );
      case "close":
        return this.steward.closeTab(agentId, z.string().uuid().parse(p.tabId));
      case "renew":
        return this.steward.renew(agentId, z.string().uuid().parse(p.tabId));
      case "action": {
        const v = actionSchema.parse(p);
        return this.steward.action(agentId, v.tabId, v.action, v.args);
      }
      case "downloads":
        if (this.config.backend === "extension")
          throw Error(
            "Extension PoC does not manage downloads; they remain in Chrome's configured directory",
          );
        return (this.steward.downloads?.completed || []).filter(
          (d) => d.agentId === agentId,
        );
      case "unregister": {
        await this.steward.closeAgent(agentId);
        for (const [key, a] of this.agents)
          if (a.agentId === agentId) this.agents.delete(key);
        return { closed: agentId };
      }
      default:
        throw Error(`Unknown or unauthorized method: ${method}`);
    }
  }
  async stop() {
    if (this.closing) return this.closing;
    if (!this.locked) return;
    this.closing = (async () => {
      if (this.server?.listening) {
        this.server.closeIdleConnections();
        await new Promise<void>((resolve, reject) =>
          this.server!.close((e) => (e ? reject(e) : resolve())),
        );
      }
      try {
        await this.steward.stop();
      } finally {
        await rm(this.admin.socket, { force: true });
        await rm(join(this.config.stateDir, "admin.json"), { force: true });
        await rm(join(this.config.stateDir, "lock"), {
          recursive: true,
          force: true,
        });
        this.locked = false;
      }
    })();
    return this.closing;
  }
}

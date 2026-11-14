import { createServer as createNetServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
  statfs,
  stat,
} from "node:fs/promises";
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import type { Config } from "./config.js";
export type Log = (event: string, data?: Record<string, unknown>) => void;
export function logger(config: Config): Log {
  const path = join(config.stateDir, "events.jsonl");
  return (event, data = {}) => {
    if (existsSync(path) && statSync(path).size > config.maxLogBytes)
      renameSync(path, path + ".1");
    appendFileSync(
      path,
      JSON.stringify({ time: new Date().toISOString(), event, ...data }) + "\n",
      { mode: 0o600 },
    );
  };
}
export async function diskUsage(path: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isDirectory()) total += await diskUsage(p);
    else if (e.isFile()) total += (await stat(p)).size;
  }
  return total;
}
export async function guardDisk(config: Config) {
  const fs = await statfs(config.stateDir);
  const free = Number(fs.bavail) * Number(fs.bsize);
  if (free < config.minFreeBytes)
    throw Error(`Disk guard: available ${free} below ${config.minFreeBytes}`);
  const downloads = join(config.stateDir, "downloads");
  const bytes = existsSync(downloads) ? await diskUsage(downloads) : 0;
  if (bytes >= config.maxDownloadBytes)
    throw Error(
      `Disk guard: downloads ${bytes} reached ${config.maxDownloadBytes}`,
    );
  return { free, downloadBytes: bytes };
}
export class ChromeProcess {
  child?: ChildProcess;
  endpoint?: string;
  constructor(
    readonly config: Config,
    readonly log: Log,
  ) {}
  private async closeOrphan(profile: string) {
    const active = join(profile, "DevToolsActivePort");
    const record = join(this.config.stateDir, "chrome-endpoint.json");
    if (!existsSync(active) && !existsSync(record)) return;
    const port = existsSync(record)
      ? JSON.parse(await readFile(record, "utf8")).port
      : Number((await readFile(active, "utf8")).split("\n")[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Error("Invalid dedicated profile DevToolsActivePort");
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      await fetch(endpoint + "/json/version", {
        signal: AbortSignal.timeout(2000),
      });
    } catch (e) {
      if (
        (e as { cause?: NodeJS.ErrnoException }).cause?.code === "ECONNREFUSED"
      )
        return;
      throw e;
    }
    const browser = await chromium.connectOverCDP(endpoint, {
      noDefaults: true,
      timeout: 3000,
    });
    try {
      const session = await browser.newBrowserCDPSession();
      const command = await session.send("Browser.getBrowserCommandLine");
      if (
        !command.arguments.includes(`--user-data-dir=${profile}`) ||
        !command.arguments.includes("--disable-shared-workers")
      )
        throw Error(
          "Stale CDP port belongs to a different browser; refusing to close it",
        );
      try {
        await session.send("Browser.close");
      } catch (e) {
        if (browser.isConnected()) throw e;
      }
      this.log("chrome.orphan-closed");
    } finally {
      await browser.close();
    }
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(endpoint + "/json/version", {
          signal: AbortSignal.timeout(1000),
        });
      } catch (e) {
        if (
          (e as { cause?: NodeJS.ErrnoException }).cause?.code ===
          "ECONNREFUSED"
        )
          return;
        throw e;
      }
      await delay(100);
    }
    throw Error("Owned orphan Chrome did not stop");
  }
  async start() {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    const profile = join(this.config.stateDir, "profile"),
      marker = join(profile, ".steward-profile");
    await mkdir(profile, { recursive: true, mode: 0o700 });
    if (!existsSync(marker)) {
      if ((await readdir(profile)).length)
        throw Error(
          "Refusing an unmarked, nonempty profile; use a new dedicated stateDir",
        );
      await writeFile(marker, "Dedicated browser-steward profile\n", {
        mode: 0o600,
      });
    }
    await this.closeOrphan(profile);
    await guardDisk(this.config);
    if (this.config.cdpPort) {
      const probe = createNetServer();
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(this.config.cdpPort, "127.0.0.1", () =>
          probe.close((e) => (e ? reject(e) : resolve())),
        );
      });
    }
    await rm(join(this.config.stateDir, "downloads", "staging"), {
      recursive: true,
      force: true,
    });
    const defaultDir = join(this.config.stateDir, "downloads", "unattributed");
    await mkdir(defaultDir, { recursive: true, mode: 0o700 });
    await mkdir(join(profile, "Default"), { recursive: true, mode: 0o700 });
    const prefsPath = join(profile, "Default", "Preferences");
    const prefs = existsSync(prefsPath)
      ? JSON.parse(await readFile(prefsPath, "utf8"))
      : {};
    prefs.download = {
      ...prefs.download,
      default_directory: defaultDir,
      prompt_for_download: false,
    };
    await writeFile(prefsPath, JSON.stringify(prefs), { mode: 0o600 });
    await rm(join(profile, "DevToolsActivePort"), { force: true });
    const args = [
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${this.config.cdpPort}`,
      "--enable-automation",
      "--disable-shared-workers",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--disable-session-crashed-bubble",
      ...(this.config.headless ? ["--headless=new"] : []),
      "about:blank",
    ];
    this.child = spawn(this.config.executablePath!, args, {
      detached: true,
      stdio: "ignore",
    });
    let spawnError: Error | undefined;
    this.child.once("error", (e) => {
      spawnError = e;
    });
    try {
      for (let i = 0; i < 150; i++) {
        if (spawnError) throw spawnError;
        if (this.child.exitCode !== null || this.child.signalCode !== null)
          throw Error(
            "Dedicated Chrome exited during startup (check executable/display/profile)",
          );
        try {
          const lines = (
            await readFile(join(profile, "DevToolsActivePort"), "utf8")
          )
            .trim()
            .split("\n");
          // Fixed-port Chrome does not always write DevToolsActivePort.
          if (lines[0]) {
            this.endpoint = `http://127.0.0.1:${Number(lines[0])}`;
            break;
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        if (this.config.cdpPort) {
          const endpoint = `http://127.0.0.1:${this.config.cdpPort}`;
          try {
            const r = await fetch(endpoint + "/json/version", {
              signal: AbortSignal.timeout(300),
            });
            if (r.ok) {
              this.endpoint = endpoint;
              break;
            }
          } catch (e) {
            if (!(e instanceof TypeError) && !(e instanceof DOMException))
              throw e;
          }
        }
        await delay(100);
      }
      if (!this.endpoint) throw Error("Dedicated Chrome CDP startup timeout");
      await writeFile(
        join(this.config.stateDir, "chrome-endpoint.json"),
        JSON.stringify({ port: Number(new URL(this.endpoint).port) }),
        { mode: 0o600 },
      );
      this.log("chrome.started", {
        pid: this.child.pid,
        endpoint: this.endpoint,
        mode: this.config.headless ? "headless=new" : "headed",
      });
      return this.endpoint;
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  async stop() {
    const child = this.child;
    this.child = undefined;
    this.endpoint = undefined;
    if (!child?.pid) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    };
    kill("SIGTERM");
    for (
      let i = 0;
      i < 50 && child.exitCode === null && child.signalCode === null;
      i++
    )
      await delay(100);
    if (child.exitCode === null && child.signalCode === null) kill("SIGKILL");
    await rm(join(this.config.stateDir, "chrome-endpoint.json"), {
      force: true,
    });
    this.log("chrome.stopped", { pid: child.pid });
  }
}

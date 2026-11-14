import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readAdmin, rpc } from "./broker.js";
import type { Config } from "./config.js";

export type StartupMessage =
  | { type: "ready" }
  | { type: "busy" }
  | { type: "error"; error: string };

// Only transport absence means "not running". Authentication/protocol errors
// must not start a second service over an unhealthy one.
export async function runningSupervisor(stateDir: string) {
  try {
    const admin = await readAdmin(stateDir);
    const health = await rpc(admin, "health");
    return { admin, health };
  } catch (e) {
    if (
      ["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(
        (e as NodeJS.ErrnoException).code || "",
      )
    )
      return undefined;
    throw e;
  }
}

export async function ensureSupervisor(config: Config) {
  const existing = await runningSupervisor(config.stateDir);
  if (existing) {
    // v0.1.0 health omitted backend and always meant CDP.
    const backend = existing.health.backend ?? "cdp";
    if (backend !== config.backend)
      throw Error(
        "This stateDir is running a different browser backend; use separate state directories",
      );
    return { ...existing, alreadyRunning: true };
  }

  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./cli.js", import.meta.url)), "serve"],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  try {
    const message = await new Promise<StartupMessage>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            Error(
              "Browser startup timed out; run serve in the foreground to inspect it",
            ),
          ),
        25000,
      );
      const finish = (error?: Error, value?: StartupMessage) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value!);
      };
      child.once("error", (e) => finish(e));
      child.once("exit", (code, signal) =>
        finish(
          Error(`Browser service exited during startup (${signal || code})`),
        ),
      );
      child.once("message", (value) =>
        finish(undefined, value as StartupMessage),
      );
      child.send(config, (error) => {
        if (error) finish(error);
      });
    });
    if (message.type === "error") throw Error(message.error);
    if (message.type === "busy") {
      // The broker lock elects the startup owner. Concurrent MCP clients wait
      // for that owner; they never retry launching another browser.
      for (let i = 0; i < 250; i++) {
        const running = await runningSupervisor(config.stateDir);
        if (running) return { ...running, alreadyRunning: true };
        await delay(100);
      }
      throw Error(
        `Another browser service did not become ready. Inspect ${config.stateDir}/lock and events.jsonl`,
      );
    }
    const running = await runningSupervisor(config.stateDir);
    if (!running)
      throw Error("Browser service stopped before accepting connections");
    return { ...running, alreadyRunning: false };
  } catch (e) {
    // A failed startup must not leave a run-owned child in the background.
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    throw e;
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}

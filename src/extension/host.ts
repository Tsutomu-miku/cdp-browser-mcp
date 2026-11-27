#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { rm, writeFile, rename } from "node:fs/promises";
import { z } from "zod";
import { NativeChannel } from "./native-channel.js";
import { reserveState } from "./state.js";
import { Audit } from "./audit.js";
import { startRelay } from "./relay.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "state-dir": { type: "string" },
    "extension-id": { type: "string" },
  },
});

async function main() {
  const extensionId = z
    .string()
    .regex(/^[a-p]{32}$/)
    .parse(values["extension-id"]);
  if (
    !values["state-dir"] ||
    positionals[0] !== `chrome-extension://${extensionId}/`
  )
    throw Error(
      "Invalid native host caller origin or explicit state directory",
    );
  const directory = resolve(values["state-dir"]);
  const reservation = await reserveState(directory);
  const channel = new NativeChannel(process.stdin, process.stdout);
  const lifetime = new AbortController();
  const fail = (error: unknown) => lifetime.abort(error);
  channel.on("failure", fail);
  channel.once("ended", () => lifetime.abort());
  const stop = () => lifetime.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  const identityPath = join(directory, "relay.json");
  const temporary = join(directory, `relay-${process.pid}.tmp`);
  let published = false;
  try {
    let activitySupported = false;
    await new Promise<void>((done, reject) => {
      channel.once("message", (value) => {
        try {
          const hello = z
            .object({
              kind: z.literal("hello"),
              version: z.literal(2),
              activity: z.literal(true).optional(),
            })
            .parse(value);
          activitySupported = hello.activity === true;
          done();
        } catch (error) {
          reject(error);
        }
      });
      lifetime.signal.addEventListener(
        "abort",
        () => reject(lifetime.signal.reason),
        { once: true },
      );
    });
    const audit = new Audit(directory);
    relay = await startRelay(channel, audit, activitySupported);
    relay.http.on("error", fail);
    relay.http.once("revoked", () => {
      channel.send({ kind: "revoking", version: 2 });
      stop();
    });
    const identity = JSON.stringify({
      pid: process.pid,
      endpoint: relay.endpoint,
      token: relay.token,
    });
    await writeFile(temporary, identity, { mode: 0o600, flag: "wx" });
    await rename(temporary, identityPath);
    published = true;
    channel.send({ kind: "ready", version: 2 });
    await audit.write("host.ready");
    await new Promise<void>((done) => {
      lifetime.signal.addEventListener("abort", () => done(), { once: true });
      if (lifetime.signal.aborted) done();
    });
    if (lifetime.signal.reason?.name !== "AbortError")
      throw lifetime.signal.reason;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    try {
      await relay?.close();
    } finally {
      await reservation.handle.close();
      if (published) await rm(identityPath);
      await rm(temporary, { force: true });
      await rm(reservation.path);
      process.stdin.destroy();
    }
  }
}

main().catch((error) => {
  console.error("Extension host stopped:", error);
  process.exitCode = 1;
  process.stdin.destroy();
});

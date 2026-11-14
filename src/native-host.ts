#!/usr/bin/env node
import { connect, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MAX_NATIVE_BYTES, NATIVE_PROTOCOL } from "./native-bridge.js";

// Chrome starts this executable. stdout is exclusively the standard native protocol.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "state-dir": { type: "string" },
    "extension-id": { type: "string" },
  },
});
if (
  !values["state-dir"] ||
  !/^[a-p]{32}$/.test(values["extension-id"] || "") ||
  positionals[0] !== `chrome-extension://${values["extension-id"]}/`
) {
  process.stderr.write("Invalid native host configuration or caller origin\n");
  process.exit(1);
}
let socket: Socket | undefined,
  reconnect: NodeJS.Timeout | undefined,
  ended = false,
  input = Buffer.alloc(0);
function send(message: unknown) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > 1024 * 1024)
    throw Error("Host-to-extension frame exceeds Chrome's 1 MiB limit");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}
function stop() {
  ended = true;
  if (reconnect) clearTimeout(reconnect);
  socket?.destroy();
}
async function open() {
  if (ended) return;
  try {
    const identity = JSON.parse(
      await readFile(join(values["state-dir"]!, "native.json"), "utf8"),
    );
    if (identity.extensionId !== values["extension-id"])
      throw Error("Extension identity mismatch");
    const current = connect(identity.socket);
    socket = current;
    let buffer = "";
    current.setEncoding("utf8");
    current.on("connect", () =>
      current.write(
        JSON.stringify({
          kind: "hello",
          version: NATIVE_PROTOCOL,
          token: identity.token,
          extensionId: values["extension-id"],
          pid: process.pid,
        }) + "\n",
      ),
    );
    current.on("data", (data) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 1024 * 1024)
        return current.destroy(Error("Broker frame too large"));
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        try {
          send(JSON.parse(buffer.slice(0, end)));
        } catch (error) {
          current.destroy(error as Error);
          return;
        }
        buffer = buffer.slice(end + 1);
      }
    });
    current.on("error", (error) =>
      process.stderr.write(`Native socket: ${error.message}\n`),
    );
    // Socket loss ends this native channel. Chrome's extension owns reconnection.
    current.on("close", () => {
      stop();
      process.stdin.destroy();
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      process.stderr.write(String(error) + "\n");
      stop();
      process.exitCode = 1;
      process.stdin.destroy();
      return;
    }
    reconnect = setTimeout(() => void open(), 1000);
  }
}
process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length > MAX_NATIVE_BYTES) {
      stop();
      process.stdin.destroy();
      process.exitCode = 1;
      return;
    }
    if (input.length < length + 4) break;
    try {
      const message = JSON.parse(
        input.subarray(4, length + 4).toString("utf8"),
      );
      if (message.kind === "ping" && message.version === NATIVE_PROTOCOL)
        send({ kind: "pong", version: NATIVE_PROTOCOL });
      else {
        if (message.kind !== "response" || typeof message.id !== "string")
          throw Error("Invalid extension frame");
        if (socket?.writable) socket.write(JSON.stringify(message) + "\n");
      }
    } catch (error) {
      process.stderr.write(String(error) + "\n");
      stop();
      process.stdin.destroy();
      process.exitCode = 1;
      return;
    }
    input = input.subarray(length + 4);
  }
});
process.stdin.on("end", stop);
process.stdout.on("error", stop);
process.once("SIGTERM", () => {
  stop();
  process.stdin.destroy();
});
void open();

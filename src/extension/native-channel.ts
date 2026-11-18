import { EventEmitter } from "node:events";
import { endianness } from "node:os";
import type { Readable, Writable } from "node:stream";

const LIMIT = 32 * 1024 * 1024;
const little = endianness() === "LE";

/** Chrome Native Messaging framing. stdout must contain nothing else. */
export class NativeChannel extends EventEmitter {
  private input = Buffer.alloc(0);
  constructor(
    readonly source: Readable,
    readonly destination: Writable,
  ) {
    super();
    source.on("data", (chunk: Buffer) => {
      try {
        this.input = Buffer.concat([this.input, chunk]);
        while (this.input.length >= 4) {
          const length = little
            ? this.input.readUInt32LE()
            : this.input.readUInt32BE();
          if (!length || length > LIMIT)
            throw Error("Invalid native frame length");
          if (this.input.length < length + 4) break;
          const message = JSON.parse(
            this.input.subarray(4, length + 4).toString("utf8"),
          );
          this.input = this.input.subarray(length + 4);
          this.emit("message", message);
        }
      } catch (error) {
        this.emit("failure", error);
      }
    });
    source.on("end", () => this.emit("ended"));
    source.on("error", (error) => this.emit("failure", error));
    destination.on("error", (error) => this.emit("failure", error));
  }
  send(message: unknown) {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > 1024 * 1024)
      throw Error("Native command exceeds Chrome's 1 MiB host limit");
    const header = Buffer.alloc(4);
    if (little) header.writeUInt32LE(body.length);
    else header.writeUInt32BE(body.length);
    this.destination.write(Buffer.concat([header, body]));
  }
}

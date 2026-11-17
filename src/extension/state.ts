import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const relayIdentity = z.object({
  pid: z.number().int().positive(),
  endpoint: z.string().url(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Reserve one host per explicit state directory; reclaim only a proven dead PID. */
export async function reserveState(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, "host.lock");
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return { path, handle };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Serialize stale-owner recovery; never let two removers unlink a fresh lock.
  const recoveryPath = join(directory, "host-recovery.lock");
  const recovery = await open(recoveryPath, "wx", 0o600);
  try {
    const { pid } = z
      .object({ pid: z.number().int().positive() })
      .parse(JSON.parse(await readFile(path, "utf8")));
    try {
      process.kill(pid, 0);
      throw Error(
        "An extension host already owns this directory; use one Chrome profile per installation",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await rm(path);
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    return { path, handle };
  } finally {
    await recovery.close();
    await rm(recoveryPath);
  }
}

export async function readRelay(directory: string) {
  try {
    const identity = relayIdentity.parse(
      JSON.parse(await readFile(join(directory, "relay.json"), "utf8")),
    );
    const url = new URL(identity.endpoint);
    process.kill(identity.pid, 0);
    if (
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/mcp"
    )
      throw Error(
        "Extension relay must be an authenticated loopback MCP endpoint",
      );
    return identity;
  } catch (error) {
    throw Error(
      "Extension relay unavailable. Open the Chrome profile with the extension installed, enable it in its popup, and check the native host installation. Then restart this MCP session. No browser was started.",
      { cause: error },
    );
  }
}

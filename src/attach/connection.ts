import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AttachOptions } from "./options.js";

export function attachArgs({ channel }: AttachOptions) {
  return [
    "--autoConnect",
    "--channel",
    channel,
    "--no-usage-statistics",
    "--no-performance-crux",
  ];
}

export function attachFailure(error: unknown, channel: string) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Attach not connected / 未连接或未授权 (${channel}). ${detail}\n` +
      "Start Chrome 144+ yourself (update via chrome://settings/help), using the selected channel. " +
      "Open chrome://inspect/#remote-debugging and enable Remote Debugging. " +
      "Click Allow / 允许 in Chrome's connection approval dialog, then retry. " +
      "A timeout can mean approval is still pending; it is not proof of refusal. " +
      "Chrome may report the same connection error for a stopped browser, an older version, disabled debugging or denied approval; no connection has been claimed.",
    { cause: error },
  );
}

/** MCP initialization alone is not readiness: official attachment is lazy. */
export async function verifyAttach(
  client: Pick<Client, "callTool">,
  options: AttachOptions,
  signal: AbortSignal,
) {
  const result = (await client.callTool(
    { name: "list_pages", arguments: {} },
    undefined,
    { timeout: options.timeoutMs, signal },
  )) as CallToolResult;
  if (result.isError)
    throw Error(
      result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    );
}

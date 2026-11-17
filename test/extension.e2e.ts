import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Explicit opt-in: uses a disposable Chrome for Testing profile, never daily Chrome.
if (!process.env.EXTENSION_CHROME_PATH)
  throw Error(
    "Set EXTENSION_CHROME_PATH to an extension-capable Chrome for Testing executable",
  );
const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "extension-e2e-"));
const unpacked = join(root, "extension"),
  profile = join(root, "profile"),
  state = join(root, "state");
await cp("extension", unpacked, { recursive: true });
const manifest = JSON.parse(
  await readFile(join(unpacked, "manifest.json"), "utf8"),
);
// Test-only key fixes the ID before launching this disposable browser.
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = publicKey.export({ type: "spki", format: "der" });
manifest.key = key.toString("base64");
const extensionId = [
  ...createHash("sha256").update(key).digest("hex").slice(0, 32),
]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join("");
await writeFile(join(unpacked, "manifest.json"), JSON.stringify(manifest));
await execute(process.execPath, [
  "dist/extension/setup.js",
  "install-native",
  "--extension-id",
  extensionId,
  "--state-dir",
  state,
  "--browser-user-data-dir",
  profile,
]);
const site = createServer((request, response) => {
  if (request.url === "/data") {
    response.end("synthetic-network");
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<!doctype html><title>Extension synthetic signed-in page</title><h1>Signed in as Synthetic User</h1><label>Message <input id="message"></label><div id="canvas" style="width:400px;height:200px;background:steelblue;padding:20px"><button>Canvas start</button><button style="margin-left:150px">Canvas end</button></div><p id="result"></p><script>localStorage.identity='synthetic-user'; console.log('synthetic-console'); fetch('/data'); document.querySelector('#canvas').addEventListener('pointerup',()=>document.querySelector('#result').textContent='drag-visible');</script>`,
  );
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
let context:
  | Awaited<ReturnType<typeof chromium.launchPersistentContext>>
  | undefined;
const clients: Client[] = [];
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.EXTENSION_CHROME_PATH,
    headless: true,
    args: [
      `--disable-extensions-except=${unpacked}`,
      `--load-extension=${unpacked}`,
      "--enable-unsafe-extension-debugging",
    ],
  });
  const worker =
    context.serviceWorkers().find((w) => w.url().includes(extensionId)) ??
    (await context.waitForEvent("serviceworker"));
  worker.on("console", (message) =>
    console.error("extension:", message.text()),
  );
  await mkdir("test-results", { recursive: true });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByLabel("Approved origins").fill(base);
  await popup.getByRole("button", { name: "Save and enable access" }).click();
  await popup
    .getByRole("status")
    .filter({ hasText: "Access enabled" })
    .waitFor();
  await popup.screenshot({ path: "test-results/extension-popup.png" });
  const page = context.pages()[0];
  await page.goto(base);
  await page.screenshot({ path: "test-results/extension-before.png" });
  for (let i = 0; i < 600; i++) {
    try {
      if (
        JSON.parse(await readFile(join(state, "relay.json"), "utf8")).endpoint
      )
        break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  console.error(
    "extension status",
    await worker.evaluate(async () =>
      (globalThis as any).chrome.storage.local.get(null),
    ),
  );
  const initialHost = JSON.parse(
    await readFile(join(state, "relay.json"), "utf8"),
  ).pid;
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: "extension-e2e", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "dist/cli.js",
          "mcp",
          "--mode",
          "extension",
          "--state-dir",
          state,
        ],
        stderr: "inherit",
      }),
    );
    clients.push(client);
  }
  console.error(
    "tools",
    (await clients[0].listTools()).tools.map((t) => t.name),
  );
  const call = async (
    i: number,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const result = await clients[i].callTool(
      { name, arguments: args },
      undefined,
      { timeout: 30000 },
    );
    console.error(
      name,
      JSON.stringify(
        (result.content as any[]).map((item) =>
          item.type === "image"
            ? {
                type: "image",
                mimeType: item.mimeType,
                base64Bytes: item.data.length,
              }
            : item,
        ),
      ).slice(0, 1600),
    );
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  };
  const pages = await call(0, "list_pages");
  const text = (pages.content as { text: string }[])
    .map((c) => c.text)
    .join("\n");
  const pageId = Number(text.match(/(?:^|\n)(\d+):/)?.[1]);
  assert.ok(Number.isSafeInteger(pageId), text);
  await call(0, "select_page", { pageId, bringToFront: true });
  const snapshot = await call(0, "take_snapshot", { pageId });
  assert.match(JSON.stringify(snapshot), /Signed in as Synthetic User/);
  await assert.rejects(
    clients[1].callTool({ name: "take_snapshot", arguments: { pageId } }),
    /claimed by another/,
  );
  const shot = await call(0, "take_screenshot", { pageId });
  const image = (shot.content as any[]).find((item) => item.type === "image");
  assert.ok(image?.data.length > 1000);
  await writeFile(
    "test-results/extension-official.png",
    Buffer.from(image.data, "base64"),
  );
  const snapshotText = JSON.stringify(snapshot);
  const from_uid = snapshotText.match(/uid=(\S+) button \\\"Canvas start/)?.[1];
  const to_uid = snapshotText.match(/uid=(\S+) button \\\"Canvas end/)?.[1];
  assert.ok(from_uid && to_uid, snapshotText);
  await call(0, "drag", { pageId, from_uid, to_uid });
  assert.equal(await page.locator("#result").innerText(), "drag-visible");
  await page.screenshot({ path: "test-results/extension-after.png" });
  await call(0, "navigate_page", { pageId, type: "reload" });
  assert.match(
    JSON.stringify(await call(0, "list_network_requests", { pageId })),
    /\/data/,
  );
  assert.match(
    JSON.stringify(await call(0, "list_console_messages", { pageId })),
    /synthetic-console/,
  );
  const identity = await call(0, "evaluate_script", {
    pageId,
    function: "() => localStorage.identity",
  });
  assert.match(JSON.stringify(identity), /synthetic-user/);
  await call(0, "extension_release_page", { pageId });
  await call(1, "take_snapshot", { pageId });
  await clients[1].close();
  await delay(100);
  await call(0, "take_snapshot", { pageId });
  assert.equal(
    JSON.parse(await readFile(join(state, "relay.json"), "utf8")).pid,
    initialHost,
    "MCP sessions must share one native host",
  );
  const privateState = JSON.parse(
    await worker.evaluate(async () =>
      JSON.stringify(
        await (globalThis as any).chrome.storage.session.get("bridge"),
      ),
    ),
  );
  const beforePause = Object.keys(privateState.bridge.targets).length;
  assert.ok(beforePause > 0);
  await popup.getByRole("button", { name: "Pause all access" }).click();
  await popup
    .getByRole("status")
    .filter({ hasText: "Access paused" })
    .waitFor();
  for (let i = 0; i < 100; i++) {
    const targets = await worker.evaluate(
      async () =>
        (await (globalThis as any).chrome.storage.session.get("bridge")).bridge
          .targets,
    );
    if (Object.keys(targets).length === 0) break;
    await delay(50);
  }
  assert.equal(
    Object.keys(
      await worker.evaluate(
        async () =>
          (await (globalThis as any).chrome.storage.session.get("bridge"))
            .bridge.targets,
      ),
    ).length,
    0,
  );
  await delay(100);
  await assert.rejects(
    clients[0].callTool({ name: "list_pages", arguments: {} }),
    /not connected|disconnected|session.*invalid/i,
  );
  assert.equal(page.isClosed(), false);
  assert.equal(new URL(page.url()).origin, base);
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/extension-e2e.json",
    JSON.stringify(
      {
        browser: context.browser()?.version(),
        extensionId,
        pageId,
        nativeHost: true,
        officialTools: true,
        concurrentClients: true,
        sharedHost: true,
        popupConsentAndPause: true,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(clients.map((client) => client.close()));
  await context?.close();
  await new Promise<void>((done, reject) =>
    site.close((error) => (error ? reject(error) : done())),
  );
  console.error("test profile:", root);
}

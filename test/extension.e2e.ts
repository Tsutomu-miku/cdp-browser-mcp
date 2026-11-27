import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let loginRequests = 0;
const site = createServer((request, response) => {
  if (request.url === "/login") {
    loginRequests++;
    response.setHeader(
      "Set-Cookie",
      "session=extension-synthetic; HttpOnly; SameSite=Lax; Path=/",
    );
    response.writeHead(302, { Location: "/" }).end();
    return;
  }
  if (!request.headers.cookie?.includes("session=extension-synthetic")) {
    response
      .writeHead(401, { "Content-Type": "text/html" })
      .end("<title>Sign in required</title><h1>Sign in required</h1>");
    return;
  }
  if (request.url === "/data") {
    response.end("synthetic-network");
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.setHeader(
    "Content-Security-Policy",
    "style-src 'self'; script-src 'unsafe-inline'",
  );
  response.end(
    `<!doctype html><title>Extension synthetic signed-in page</title><h1>Signed in as Synthetic User</h1><form action="/"><label>Search <input id="message" name="q" autofocus></label></form><div id="canvas"><button>Canvas start</button><button>Canvas end</button></div><p id="result"></p><script>
      console.log('synthetic-console'); fetch('/data');
      const canvas = document.querySelector('#canvas');
      Object.assign(canvas.style, {width:'400px', height:'200px', background:'steelblue', padding:'20px'});
      canvas.lastElementChild.style.marginLeft = '150px';
      canvas.addEventListener('pointerup',()=>document.querySelector('#result').textContent='drag-visible');
      document.querySelector('#message').value = new URLSearchParams(location.search).get('q') ?? '';
    </script>`,
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
  const origins = popup.getByLabel("Approved origins");
  const selectedOrigin = base.replace("127.0.0.1", "localhost");
  await origins.fill(selectedOrigin);
  await popup.getByRole("button", { name: "Save and enable access" }).click();
  await popup
    .getByRole("status")
    .filter({ hasText: "Access enabled" })
    .waitFor();
  const scope = popup.getByRole("combobox", { name: "Website access" });
  assert.equal(await scope.inputValue(), "approved");
  await scope.click();
  assert.equal(
    await scope.evaluate((element) => element.matches(":open")),
    true,
  );
  await popup.keyboard.press("ArrowDown");
  await popup.keyboard.press("Enter");
  assert.equal(await scope.inputValue(), "all");
  assert.equal(await origins.isHidden(), true);
  assert.equal(await origins.isDisabled(), true);
  assert.equal(
    await worker.evaluate(
      async () =>
        (await (globalThis as any).chrome.storage.local.get("access")).access
          .allSites,
    ),
    false,
    "Selecting a scope must not grant access before saving",
  );
  await popup.getByLabel("Sensitive origins to hide").fill(selectedOrigin);
  await popup.getByRole("button", { name: "Save and enable access" }).click();
  await popup
    .getByText("Reconnect any open MCP sessions to apply changes.")
    .waitFor();
  await popup.reload();
  await popup
    .getByRole("status")
    .filter({ hasText: "Access enabled" })
    .waitFor();
  assert.equal(await scope.inputValue(), "all");
  await scope.selectOption("approved");
  assert.equal(await origins.isDisabled(), false);
  assert.equal(await origins.inputValue(), selectedOrigin);
  await scope.selectOption("all");
  await popup
    .locator("main")
    .screenshot({ path: "test-results/extension-popup.png" });
  // Chrome auto-sizes toolbar popups independently of tabs showing popup.html.
  await popup.bringToFront();
  const layout = await popup.evaluate(async () => {
    const { action, extension } = (globalThis as any).chrome;
    await action.openPopup();
    const [view] = extension.getViews({ type: "popup" }) as Window[];
    if (!view) throw Error("Toolbar popup did not open");
    await new Promise<void>((resolve) => {
      view.requestAnimationFrame(() =>
        view.requestAnimationFrame(() => resolve()),
      );
    });
    const { document, innerWidth } = view;
    const main = document.querySelector("main")!;
    const title = document.querySelector("h1")!.getBoundingClientRect();
    const status = document.querySelector("#status")!.getBoundingClientRect();
    const save = document
      .querySelector('button[type="submit"]')!
      .getBoundingClientRect();
    const layout = {
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      headerOverlaps: title.right > status.left && title.bottom > status.top,
      saveClipped:
        save.right >
        innerWidth - parseFloat(view.getComputedStyle(main).paddingRight),
    };
    view.close();
    return layout;
  });
  assert.deepEqual(layout, {
    width: 356,
    scrollWidth: 356,
    headerOverlaps: false,
    saveClipped: false,
  });
  const hiddenPage = await context.newPage();
  await hiddenPage.goto(selectedOrigin);
  const page = context.pages()[0];
  assert.equal(
    (await fetch(base)).status,
    401,
    "A fresh client must see the login wall",
  );
  await page.goto(base + "/login");
  await page.evaluate(() => localStorage.setItem("identity", "synthetic-user"));
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
    const name = i === 0 ? "Codex" : "extension-e2e";
    const client = new Client({ name, version: "1" });
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
  assert.ok(text.includes(base), "All sites must expose an unlisted origin");
  assert.ok(
    !text.includes(selectedOrigin),
    "The sensitive origin must be hidden",
  );
  const pageId = Number(text.match(/(?:^|\n)(\d+):/)?.[1]);
  assert.ok(Number.isSafeInteger(pageId), text);
  await call(0, "select_page", { pageId, bringToFront: true });
  const snapshot = await call(0, "take_snapshot", { pageId });
  assert.match(JSON.stringify(snapshot), /Signed in as Synthetic User/);
  const activityBadge = page.locator("#cdp-browser-mcp-activity");
  assert.equal(await activityBadge.count(), 0);
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
  await activityBadge.waitFor({ state: "detached", timeout: 5000 });
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
  const searchSnapshot = JSON.stringify(
    await call(0, "take_snapshot", { pageId }),
  );
  const searchUid = searchSnapshot.match(/uid=(\S+) textbox \\"Search/)?.[1];
  assert.ok(searchUid, searchSnapshot);
  const baselineStart = performance.now();
  await call(0, "fill", { pageId, uid: searchUid, value: "youtube" });
  await call(0, "press_key", { pageId, key: "Enter", includeSnapshot: true });
  const baselineMs = Math.round(performance.now() - baselineStart);
  assert.equal(new URL(page.url()).searchParams.get("q"), "youtube");
  await page.goto(base);
  await page.locator("#message").focus();
  const combinedStart = performance.now();
  const submitted = await call(0, "type_text", {
    pageId,
    text: "youtube",
    submitKey: "Enter",
    includeSnapshot: true,
  });
  const combinedMs = Math.round(performance.now() - combinedStart);
  assert.equal(new URL(page.url()).searchParams.get("q"), "youtube");
  assert.match(JSON.stringify(submitted), /Latest page snapshot/);
  console.error("Search and snapshot", { baselineMs, combinedMs });
  await page.evaluate(() => {
    document.documentElement.style.transform = "translateX(-48px)";
    document.body.style.minHeight = "200vh";
    scrollTo(0, 120);
  });
  await activityBadge.waitFor({ state: "visible", timeout: 2000 });
  const edges = await activityBadge.evaluate((badge) => {
    const bounds = badge.getBoundingClientRect();
    const viewport = document.documentElement;
    return {
      right: Math.round(viewport.clientWidth - bounds.right),
      bottom: Math.round(viewport.clientHeight - bounds.bottom),
    };
  });
  assert.deepEqual(edges, { right: 0, bottom: 0 });
  await delay(1500);
  assert.ok(
    await activityBadge.isVisible(),
    "Short actions must leave a readable indicator",
  );
  await activityBadge.waitFor({ state: "detached", timeout: 3500 });
  await page.goto(base);
  const sibling = await context.newPage();
  await sibling.goto(base);
  await page.bringToFront();
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
  // Pause must disconnect a real CDP request while the page still awaits it.
  const interrupted = assert.rejects(
    clients[0].callTool({
      name: "evaluate_script",
      arguments: {
        pageId,
        function:
          "() => { document.body.dataset.pauseStarted = 'yes'; return new Promise(() => {}); }",
      },
    }),
    /not connected|disconnected|session.*invalid/i,
  );
  await page
    .locator('body[data-pause-started="yes"]')
    .waitFor({ timeout: 5000 });
  await activityBadge.waitFor({ state: "visible", timeout: 2000 });
  assert.equal(
    await activityBadge.evaluate((el) => getComputedStyle(el).pointerEvents),
    "none",
  );
  assert.equal(await sibling.locator("#cdp-browser-mcp-activity").count(), 0);
  await page.screenshot({ path: "test-results/extension-activity.png" });
  await popup.getByRole("button", { name: "Pause all access" }).click();
  await popup
    .getByRole("status")
    .filter({ hasText: "Access paused" })
    .waitFor();
  await interrupted;
  await activityBadge.waitFor({ state: "detached", timeout: 2000 });
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
  assert.equal(
    loginRequests,
    1,
    "MCP must reuse the existing authenticated browser instead of signing in again",
  );
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
        pauseInterruptedPendingCommand: true,
        loginWallVerified: true,
        loginRequests,
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

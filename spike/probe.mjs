import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const root = await mkdtemp(tmpdir() + "/steward-spike-");
const records = [],
  intercepted = [];
const blocked = process.argv.includes("--block");
const headed = process.argv.includes("--headed");
const srv = createServer((req, res) => {
  const u = new URL(req.url, "http://local");
  const a = u.searchParams.get("a");
  records.push({
    path: u.pathname,
    agent: a,
    headers: {
      lane: req.headers["x-lane"],
      cookie: req.headers.cookie,
      dest: req.headers["sec-fetch-dest"],
      sw: req.headers["service-worker"],
    },
  });
  res.setHeader("Cache-Control", "no-store");
  if (u.pathname === "/login") {
    res.setHeader("Set-Cookie", "identity=synthetic; Path=/; SameSite=Lax");
    return res.end("ok");
  }
  if (u.pathname === "/sw.js") {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(
      `fetch('/sw-fetch?a=${a}'); self.addEventListener('install',()=>self.skipWaiting());`,
    );
  }
  if (u.pathname === "/shared.js") {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(
      `fetch('/shared-fetch?a=${a}'); onconnect=e=>e.ports[0].postMessage('ok');`,
    );
  }
  if (u.pathname === "/worker.js") {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(
      `Promise.all([fetch('/worker-fetch?a=${a}'),new Promise(r=>{const w=new Worker('/nested.js?a=${a}');w.onmessage=r;})]).then(()=>postMessage('done'));`,
    );
  }
  if (u.pathname === "/nested.js") {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(
      `fetch('/nested-fetch?a=${a}').then(()=>postMessage('done'));`,
    );
  }
  if (u.pathname === "/page") {
    res.setHeader("Content-Type", "text/html");
    return res.end(`<link rel="stylesheet" href="/css?a=${a}"><script src="/js?a=${a}"></script><img src="/img?a=${a}"><iframe src="/iframe?a=${a}"></iframe><script>
 window.done=Promise.all([fetch('/fetch?a=${a}'),new Promise(r=>{const x=new XMLHttpRequest();x.onload=r;x.open('GET','/xhr?a=${a}');x.send()}),new Promise(r=>{const w=new Worker('/worker.js?a=${a}');w.onmessage=r})]);navigator.sendBeacon('/beacon?a=${a}','ok');
 try{const w=new SharedWorker('/shared.js?a=${a}');w.port.start();window.shared=w;}catch(e){window.sharedError=e.message}
 navigator.serviceWorker.register('/sw.js?a=${a}').then(()=>window.sw='registered',e=>window.sw=e.message);
 </script>`);
  }
  if (u.pathname === "/iframe") {
    res.setHeader("Content-Type", "text/html");
    return res.end(`<script>fetch('/iframe-fetch?a=${a}')</script>`);
  }
  if (u.pathname === "/js") res.setHeader("Content-Type", "text/javascript");
  if (u.pathname === "/css") res.setHeader("Content-Type", "text/css");
  res.end("");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const args = [
  `--user-data-dir=${root}/profile`,
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  ...(headed ? [] : ["--headless=new"]),
  ...(blocked ? ["--disable-shared-workers"] : []),
  "about:blank",
];
const chrome = spawn(
  process.env.CHROME_PATH ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome"),
  args,
  { stdio: "ignore" },
);
let a, b;
try {
  const { readFile } = await import("node:fs/promises");
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number(
        (await readFile(root + "/profile/DevToolsActivePort", "utf8")).split(
          "\n",
        )[0],
      );
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(port);
  a = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  if (blocked)
    await a.contexts()[0].route("**/*", async (route) => {
      const q = route.request();
      const h = await q.allHeaders();
      intercepted.push({
        url: q.url(),
        type: q.resourceType(),
        dest: h["sec-fetch-dest"],
        sw: h["service-worker"],
        serviceWorker: !!q.serviceWorker(),
      });
      if (
        h["service-worker"] === "script" ||
        h["sec-fetch-dest"] === "serviceworker" ||
        q.serviceWorker()
      )
        await route.abort("blockedbyclient");
      else await route.continue();
    });
  const pa = await a.contexts()[0].newPage(),
    pb = await b.contexts()[0].newPage();
  await pa.goto(base + "/login");
  assert.equal((await b.contexts()[0].cookies())[0].value, "synthetic");
  await pa.setExtraHTTPHeaders({ "x-lane": "A" });
  await pb.setExtraHTTPHeaders({ "x-lane": "B" });
  await Promise.all([pa.goto(base + "/page?a=A"), pb.goto(base + "/page?a=B")]);
  await Promise.all([
    pa.evaluate(() => window.done),
    pb.evaluate(() => window.done),
  ]);
  await new Promise((r) => setTimeout(r, 1500));
  for (const x of records.filter(
    (x) =>
      x.agent && !x.path.startsWith("/sw") && !x.path.startsWith("/shared"),
  ))
    assert.equal(x.headers.lane, x.agent, JSON.stringify(x));
  const out = {
    mode: headed ? "headed" : "headless=new",
    blocked,
    version: a.version(),
    cookieShared: true,
    pageIndependent: pa.url() !== pb.url(),
    records,
    intercepted,
    sw: await pa.evaluate(() => window.sw),
    sharedError: await pa.evaluate(() => window.sharedError),
  };
  await mkdir("test-results", { recursive: true });
  await writeFile(
    `test-results/spike-${blocked ? "block" : "baseline"}-${headed ? "headed" : "headless"}.json`,
    JSON.stringify(out, null, 2),
  );
  console.log(JSON.stringify(out, null, 2));
  if (blocked)
    assert.equal(
      records.filter(
        (x) => x.path.startsWith("/sw") || x.path.startsWith("/shared"),
      ).length,
      0,
      "Worker requests must never reach server",
    );
} finally {
  await a?.close();
  await b?.close();
  chrome.kill("SIGTERM");
  await new Promise((r) =>
    chrome.exitCode !== null ? r() : chrome.once("exit", r),
  );
  await new Promise((r) => srv.close(r));
  await rm(root, { recursive: true, force: true });
}

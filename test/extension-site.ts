import { createServer } from "node:http";
export async function extensionSite() {
  const records: {
    seq: number;
    path: string;
    tag: string | null;
    kind: string | null;
    lane: string | null;
    custom: string | null;
    loggedIn: boolean;
    destination: string | null;
  }[] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url!, "http://localhost");
    const loggedIn =
      req.headers.cookie?.includes("poc_session=synthetic-login") || false;
    records.push({
      seq: records.length + 1,
      path: u.pathname,
      tag: u.searchParams.get("tag"),
      kind: u.searchParams.get("kind"),
      lane: (req.headers["x-lane"] as string) || null,
      custom: (req.headers["x-poc"] as string) || null,
      loggedIn,
      destination: (req.headers["sec-fetch-dest"] as string) || null,
    });
    res.setHeader("cache-control", "no-store");
    if (u.pathname === "/session" && req.method === "POST") {
      req.resume();
      res.writeHead(303, {
        "set-cookie":
          "poc_session=synthetic-login; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600",
        location: "/private",
      });
      res.end();
      return;
    }
    if (u.pathname === "/stall") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<h1>Synthetic stalled response</h1>");
      return;
    }
    if (u.pathname === "/echo") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(records.at(-1)));
      return;
    }
    if (u.pathname === "/style.css") {
      res.setHeader("content-type", "text/css");
      res.end(
        "body {font: 18px system-ui; margin: 36px; background:#f5f7fb} button,input {font:inherit;padding:8px} h1{color:#163c70}",
      );
      return;
    }
    if (u.pathname === "/pixel.svg") {
      res.setHeader("content-type", "image/svg+xml");
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><circle cx="15" cy="15" r="12" fill="green"/></svg>',
      );
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    const tag = u.searchParams.get("tag") || "none",
      q = encodeURIComponent(tag);
    if (u.pathname === "/login") {
      res.end(
        '<h1>Synthetic sign in</h1><form method="post" action="/session"><label>Username <input name="user" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>',
      );
      return;
    }
    if (u.pathname === "/private") {
      res.end(
        loggedIn
          ? '<link rel="stylesheet" href="/style.css"><h1>Signed in as Synthetic User</h1><p>Existing profile session reused through the extension.</p><label>Message <input id="message"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#message\').value">Save</button><p id="result"></p>'
          : "<h1>Sign in required</h1>",
      );
      return;
    }
    if (
      ["/script.js", "/dedicated.js", "/shared.js", "/sw.js"].includes(
        u.pathname,
      )
    ) {
      res.setHeader("content-type", "text/javascript");
      if (u.pathname === "/script.js")
        res.end(
          `fetch('/echo?kind=fetch&tag=${q}');const x=new XMLHttpRequest();x.open('GET','/echo?kind=xhr&tag=${q}');x.send();navigator.sendBeacon('/echo?kind=beacon&tag=${q}','ok');new Worker('/dedicated.js?tag=${q}');`,
        );
      if (u.pathname === "/dedicated.js")
        res.end(`fetch('/echo?kind=dedicated-fetch&tag=${q}');`);
      if (u.pathname === "/shared.js")
        res.end(
          "onconnect = e => { e.ports[0].onmessage = async m => { const r = await fetch('/echo?kind=shared-background&tag=' + m.data); e.ports[0].postMessage(await r.json()); }; e.ports[0].start(); };",
        );
      if (u.pathname === "/sw.js")
        res.end(
          "self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>{e.waitUntil(fetch('/echo?kind=sw-background&tag='+e.data.tag));});self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.pathname==='/sw-forward')e.respondWith(fetch('/echo?kind=sw-forwarded&tag='+u.searchParams.get('tag')));if(u.pathname==='/sw-cache')e.respondWith(Promise.resolve(new Response('synthetic SW response, no network')));});",
        );
      return;
    }
    if (u.pathname === "/frame") {
      res.end(
        `<p>Frame ${tag}</p><script>fetch('/echo?kind=frame-fetch&tag=${q}')</script>`,
      );
      return;
    }
    if (u.pathname === "/probe") {
      res.end(
        `<h1>Probe ${tag}</h1><link rel="stylesheet" href="/style.css?tag=${q}"><img src="/pixel.svg?tag=${q}"><script src="/script.js?tag=${q}"></script><iframe src="/frame?tag=${q}"></iframe>`,
      );
      return;
    }
    if (u.pathname === "/workers") {
      res.end(`<h1>Worker boundary ${tag}</h1><pre id="worker-result">pending</pre><button id="background" onclick="navigator.serviceWorker.controller.postMessage({tag:'${tag}'})">ServiceWorker background fetch</button><script>
(async()=>{const sw=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller) await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));navigator.serviceWorker.controller.postMessage({tag:'${tag}'});await fetch('/sw-forward?tag=${q}');const cache=await(await fetch('/sw-cache?tag=${q}')).text();const w=new SharedWorker('/shared.js','poc-shared');w.port.start();w.port.onmessage=e=>{document.querySelector('#worker-result').textContent=JSON.stringify({shared:e.data,cache,ready:true})};w.port.postMessage('${tag}');globalThis.testSharedWorker=w;})();</script>`);
      return;
    }
    res.end("<h1>Synthetic test server</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    records,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

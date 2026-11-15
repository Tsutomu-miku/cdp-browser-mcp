import { createServer } from "node:http";
export interface RequestRecord {
  sequence: number;
  method: string;
  host: string;
  path: string;
  agent: string | null;
  lane?: string;
  environment?: string;
  identity?: string;
  dest?: string;
}
export async function syntheticSite() {
  const records: RequestRecord[] = [];
  let base = "";
  const server = createServer((req, res) => {
    const u = new URL(req.url!, "http://synthetic");
    const a = u.searchParams.get("a");
    records.push({
      sequence: records.length + 1,
      method: req.method!,
      host: new URL("http://" + req.headers.host).hostname,
      path: u.pathname,
      agent: a,
      lane: req.headers["x-lane"] as string,
      environment: req.headers["x-environment"] as string,
      identity: req.headers.cookie,
      dest: req.headers["sec-fetch-dest"] as string,
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.end();
      return;
    }
    const outside = base.replace("127.0.0.1", "localhost");
    if (u.pathname === "/persistent-login") {
      res.setHeader(
        "Set-Cookie",
        "persistentIdentity=shared-profile; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax",
      );
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<script>localStorage.setItem("shared-login","shared-profile")</script><body>Logged in</body>',
      );
      return;
    }
    if (u.pathname === "/persistent-private") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<body>${req.headers.cookie?.includes("persistentIdentity=shared-profile") ? "Signed in" : "Missing login"}<script>document.body.append(' storage='+localStorage.getItem('shared-login'))</script></body>`,
      );
      return;
    }
    if (u.pathname.startsWith("/redirect-")) {
      res.writeHead(302, {
        Location:
          (u.pathname === "/redirect-in" ? base : outside) +
          (u.pathname === "/redirect-import"
            ? "/policy-import"
            : "/policy-echo") +
          "?a=" +
          a,
      });
      res.end();
      return;
    }
    if (u.pathname === "/policy") {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><title>Policy ${a}</title><a id="download" href="${outside}/download?a=${a}">Download</a><iframe src="${outside}/policy-frame?a=${a}"></iframe><script>
      window.done=Promise.all([
        fetch('${outside}/policy-fetch?a=${a}',{headers:{'x-lane':'SPOOFED'}}),
        fetch('/redirect-out?a=${a}'),fetch('${outside}/redirect-in?a=${a}'),
        new Promise((r,j)=>{let x=new XMLHttpRequest();x.onload=r;x.onerror=j;x.open('POST','${outside}/policy-xhr?a=${a}');x.send('test')}),
        ...['worker','module'].map(kind=>new Promise((r,j)=>{const w=new Worker('/policy-'+kind+'?a=${a}',kind==='module'?{type:'module'}:{});w.onmessage=r;w.onerror=j}))
      ]); navigator.sendBeacon('${outside}/policy-beacon?a=${a}','test');
      console.log('owned-console-${a}');
      </script>`);
      return;
    }
    if (u.pathname === "/policy-frame") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<script>fetch('/policy-frame-fetch?a=${a}');new Worker('/policy-frame-worker?a=${a}')</script>`,
      );
      return;
    }
    if (u.pathname === "/policy-worker") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(
        `importScripts('${outside}/policy-import?a=${a}');importScripts('/redirect-import?a=${a}');Promise.all([fetch('${outside}/policy-worker-fetch?a=${a}',{headers:{'x-lane':'SPOOFED'}}),new Promise(r=>{let w=new Worker('/policy-nested?a=${a}');w.onmessage=r}),new Promise(r=>{let w=new Worker('/redirect-worker?a=${a}');w.onmessage=r;w.onerror=r})]).then(()=>postMessage('done'))`,
      );
      return;
    }
    if (u.pathname === "/policy-module") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(
        `import '${outside}/policy-import?a=${a}';fetch('${outside}/policy-module-fetch?a=${a}').then(()=>postMessage('done'))`,
      );
      return;
    }
    if (u.pathname === "/policy-frame-worker") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(
        `new Worker('/policy-nested?a=${a}');fetch('/policy-frame-worker-fetch?a=${a}').then(()=>postMessage('done'))`,
      );
      return;
    }
    if (u.pathname === "/policy-nested") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(
        `importScripts('${outside}/policy-import?a=${a}');fetch('${outside}${u.pathname}-fetch?a=${a}').then(()=>postMessage('done'))`,
      );
      return;
    }
    if (u.pathname === "/policy-import") {
      res.setHeader("Content-Type", "text/javascript");
      res.end("");
      return;
    }

    if (u.pathname === "/login") {
      res.setHeader(
        "Set-Cookie",
        "identity=synthetic-shared-login; Path=/; SameSite=Lax",
      );
      res.end("Logged in once");
      return;
    }
    if (u.pathname === "/page") {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><title>Agent ${a}</title><link rel="stylesheet" href="/style?a=${a}"><script src="/script?a=${a}"></script><img src="/image?a=${a}"><label>Name<input id="name"></label><button id="apply" onclick="document.querySelector('#value').textContent=document.querySelector('#name').value">Apply</button><div id="value"></div><a id="next" href="/navigation?a=${a}">Next</a><a id="download" href="/download?a=${a}">Download</a><iframe src="/iframe?a=${a}"></iframe><iframe src="${base.replace("127.0.0.1", "localhost")}/iframe?a=${a}"></iframe><script>
  window.done=Promise.all([
   fetch('/fetch?a=${a}',{headers:{'x-lane':'SPOOFED'}}),
   new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.onload=resolve;x.onerror=reject;x.open('POST','/xhr?a=${a}');x.send('test')}),
   new Promise((resolve,reject)=>{const w=new Worker('/worker?a=${a}');w.onmessage=resolve;w.onerror=reject}),
   navigator.serviceWorker.register('/sw?a=${a}').then(()=>{window.swBlocked=false},()=>{window.swBlocked=true})
  ]);navigator.sendBeacon('/beacon?a=${a}','test');
  try{window.shared=new SharedWorker('/shared?a=${a}');window.sharedBlocked=false}catch{window.sharedBlocked=true}
  </script>`);
      return;
    }
    if (u.pathname === "/iframe") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        `<body>Frame ${a}<a id="frame-download" href="/download?a=${a}">Frame download</a><script>fetch('/iframe-fetch?a=${a}');new Worker('/iframe-worker?a=${a}');window.backgroundPolicy=navigator.serviceWorker.register('/sw?a=${a}').then(()=>false,()=>true)</script></body>`,
      );
      return;
    }
    if (u.pathname === "/worker") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(
        `Promise.all([fetch('/worker-fetch?a=${a}'),new Promise(r=>{let w=new Worker('/nested-worker?a=${a}');w.onmessage=r})]).then(()=>postMessage('done'))`,
      );
      return;
    }
    if (u.pathname === "/nested-worker" || u.pathname === "/iframe-worker") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(
        `fetch('/${u.pathname === "/nested-worker" ? "nested-fetch" : "iframe-worker-fetch"}?a=${a}').then(()=>postMessage('done'))`,
      );
      return;
    }
    if (u.pathname === "/sw" || u.pathname === "/shared") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(`fetch('/forbidden-background?a=${a}');`);
      return;
    }
    if (u.pathname === "/download") {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="same-name.txt"',
      );
      res.end("private download for " + a);
      return;
    }
    if (u.pathname === "/navigation") {
      res.setHeader("Content-Type", "text/html");
      res.end(`<body>Navigation ${a}<a href="/page?a=${a}">Back</a></body>`);
      return;
    }
    if (u.pathname === "/image") {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      return;
    }
    if (u.pathname === "/script")
      res.setHeader("Content-Type", "text/javascript");
    if (u.pathname === "/style") res.setHeader("Content-Type", "text/css");
    res.end("");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    records,
    close: () =>
      new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r()))),
  };
}

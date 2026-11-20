import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type RequestListener, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import { LoadPilot, Server, ServerPool, Algorithm, type LoadPilotOptions } from "../src/index.js";
import { routeMatcher } from "../src/routing/RouteMatcher.js";

const limits = { timeout: 10_000 };
function signal() {
  let notify = () => {};
  const promise = new Promise<void>((resolve) => { notify = resolve; });
  return { promise, resolve: () => notify() };
}

async function backend(t: TestContext, handler: RequestListener, tls = false) {
  const server = tls ? createHttpsServer({
    key: readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url)),
    cert: readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url)),
  }, handler) : createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `${tls ? "https" : "http"}://127.0.0.1:${address.port}`;
}

function pool(route: string, ...urls: string[]) {
  return new ServerPool({ route, servers: urls.map((url) => new Server(url)) });
}

async function start(t: TestContext, options: Partial<LoadPilotOptions> = {}) {
  const pilot = new LoadPilot({ name: t.name, port: 0, ...options });
  t.after(() => pilot.stop());
  await pilot.start();
  assert.ok(pilot.port);
  return pilot;
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }
function exchange(pilot: LoadPilot, path: string, options: {
  method?: string; headers?: OutgoingHttpHeaders; body?: string;
} = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: pilot.port ?? 0, path,
      method: options.method, headers: options.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers,
        body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error("Test client timed out")));
    req.on("error", reject);
    req.end(options.body);
  });
}

test("Configuration validation and public exports", () => {
  assert.equal(Algorithm.ROUND_ROBIN, "round-robin");
  for (const upstreamTimeoutMs of [0, -1, 1.1, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => new LoadPilot({ name: "Invalid", port: 0, upstreamTimeoutMs }), /upstreamTimeoutMs/);
  }
  assert.throws(() => new LoadPilot({ name: " ", port: 0 }), /name/);
  for (const port of [-1, 65536, 1.5]) assert.throws(() => new LoadPilot({ name: "Invalid", port }), /port/);
  for (const url of ["ftp://localhost", "http://user:pass@localhost", "http://localhost/?q=1", "http://localhost/#x"]) {
    assert.throws(() => new Server(url), /Invalid HTTP backend/);
  }
});

test("RouteMatcher excludes queries and uses root only as an in-base fallback", () => {
  const root = pool("/");
  const auth = pool("/auth");
  const pools = new Map([["/", root], ["/auth", auth]]);
  assert.equal(routeMatcher.getServerPoolFromRoute("/gateway/auth?x=/other", "/gateway", pools), auth);
  assert.equal(routeMatcher.getServerPoolFromRoute("/gateway?x=1", "/gateway", pools), root);
  assert.equal(routeMatcher.getServerPoolFromRoute("/gateway/authentication", "/gateway", pools), root);
  assert.equal(routeMatcher.getServerPoolFromRoute("/gatewayXYZ/auth", "/gateway", pools), null);
});

for (const [base, target, prefix, expected] of [
  ["/gateway", "/gateway/auth/login?remember=true", "", "/auth/login?remember=true"],
  [undefined, "/auth/login?remember=true", "", "/auth/login?remember=true"],
  ["/api/v1", "/api/v1/auth/login", "", "/auth/login"],
  ["/gateway", "/gateway/auth/login?remember=true", "/internal", "/internal/auth/login?remember=true"],
  ["/gateway/", "/gateway/auth/", "/internal/", "/internal/auth/"],
  [undefined, "/auth/a%2Fb/%E2%9C%93/?x=a%2Bb&x=2", "", "/auth/a%2Fb/%E2%9C%93/?x=a%2Bb&x=2"],
  ["/gateway", "/gateway?x=1", "/internal", "/internal/?x=1"],
  [undefined, "/auth/./%2e%2e/login", "/internal", "/internal/auth/./%2e%2e/login"],
] as const) {
  test(`Path forwarding: ${target} with base ${base ?? "/"} and backend prefix ${prefix}`, limits, async (t) => {
    const url = await backend(t, (req, res) => res.end(req.url));
    const pilot = await start(t, { route: base, pools: [pool("/", url + prefix)] });
    const result = await exchange(pilot, target);
    assert.equal(result.status, 200);
    assert.equal(result.body, expected);
  });
}

for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
  test(`${method} forwards real bodies, end-to-end headers and responses`, limits, async (t) => {
    const body = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? JSON.stringify({ value: "Hello ✓" }) : "";
    const received = signal();
    let observed: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string } | undefined;
    const url = await backend(t, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        observed = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
        received.resolve();
        res.writeHead(201, { "content-type": "application/json", "x-backend": "real",
          "set-cookie": ["a=1; Path=/", "b=2; HttpOnly"], "content-length": "11" });
        res.end('{"ok":true}');
      });
    });
    const pilot = await start(t, { route: "/gateway", pools: [pool("/auth", url)] });
    const result = await exchange(pilot, "/gateway/auth/login?x=1&x=2", { method, body,
      headers: { "host": "public.example:8080", "content-type": "application/json", "content-length": Buffer.byteLength(body),
        "authorization": "Bearer test-only", "cookie": "session=test", "x-application": "custom",
        "accept": "application/json", "user-agent": "loadpilot-test", "forwarded": "for=spoofed",
        "x-forwarded-for": "spoofed", "x-forwarded-host": "spoofed", "x-forwarded-proto": "https",
        "x-forwarded-port": "spoofed" } });
    await received.promise;
    assert.ok(observed);
    assert.equal(observed.method, method);
    assert.equal(observed.url, "/auth/login?x=1&x=2");
    assert.equal(observed.body, body);
    assert.equal(observed.headers.host, new URL(url).host);
    assert.equal(observed.headers.authorization, "Bearer test-only");
    assert.equal(observed.headers.cookie, "session=test");
    assert.equal(observed.headers["x-application"], "custom");
    assert.equal(observed.headers["user-agent"], "loadpilot-test");
    assert.equal(observed.headers.accept, "application/json");
    assert.equal(observed.headers["content-type"], "application/json");
    assert.equal(observed.headers["content-length"], String(Buffer.byteLength(body)));
    assert.equal(observed.headers.forwarded, undefined);
    assert.equal(observed.headers["x-forwarded-for"], "::ffff:127.0.0.1");
    assert.equal(observed.headers["x-forwarded-host"], "public.example:8080");
    assert.equal(observed.headers["x-forwarded-proto"], "http");
    assert.equal(observed.headers["x-forwarded-port"], undefined);
    assert.equal(result.status, 201);
    assert.equal(result.body, method === "HEAD" ? "" : '{"ok":true}');
    assert.equal(result.headers["content-type"], "application/json");
    assert.equal(result.headers["content-length"], "11");
    assert.equal(result.headers["x-backend"], "real");
    assert.deepEqual(result.headers["set-cookie"], ["a=1; Path=/", "b=2; HttpOnly"]);
  });
}

test("Hop-by-hop headers and Connection-nominated headers are removed both ways", limits, async (t) => {
  const url = await backend(t, (req, res) => {
    assert.equal(req.headers["x-remove"], undefined);
    assert.equal(req.headers["keep-alive"], undefined);
    assert.equal(req.headers["proxy-connection"], undefined);
    assert.equal(req.headers["proxy-authorization"], undefined);
    assert.equal(req.headers.te, undefined);
    assert.equal(req.headers.trailer, undefined);
    assert.equal(req.headers.expect, undefined);
    res.writeHead(200, { "connection": "close, x-remove", "x-remove": "secret",
      "keep-alive": "timeout=77", "proxy-connection": "keep-alive", "trailer": "x-trailer",
      "te": "trailers", "upgrade": "websocket", "x-keep": "end-to-end" });
    res.end("body");
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  const result = await exchange(pilot, "/", { headers: {
    "connection": "keep-alive, x-remove", "x-remove": "secret", "keep-alive": "timeout=99",
    "proxy-connection": "keep-alive", "proxy-authorization": "secret", "te": "trailers", "expect": "100-continue",
  } });
  for (const name of ["x-remove", "proxy-connection", "trailer", "te", "upgrade"]) {
    assert.equal(result.headers[name], undefined);
  }
  // Node may generate keep-alive parameters for the new downstream connection.
  assert.notEqual(result.headers["keep-alive"], "timeout=77");
  assert.equal(result.headers["x-keep"], "end-to-end");
  assert.equal(result.body, "body");
});

test("Connection-nominated Content-Length is safely reframed without losing a body", limits, async (t) => {
  const url = await backend(t, (req, res) => {
    assert.equal(req.headers["content-length"], undefined);
    assert.equal(req.headers["transfer-encoding"], "chunked");
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => res.end(body));
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  const result = await exchange(pilot, "/", { method: "GET", body: "test", headers: {
    connection: "close, content-length", "content-length": 4,
  } });
  assert.equal(result.body, "test");
});

test("Content-Encoding and compressed payload bytes are preserved both ways", limits, async (t) => {
  const payload = gzipSync("compressed payload ✓");
  const url = await backend(t, (req, res) => {
    assert.equal(req.headers["content-encoding"], "gzip");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      assert.deepEqual(Buffer.concat(chunks), payload);
      res.writeHead(200, { "content-encoding": "gzip", "content-length": payload.length });
      res.end(payload);
    });
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: pilot.port ?? 0, method: "POST", agent: false,
      headers: { "content-encoding": "gzip", "content-length": payload.length } }, (res) => {
      assert.equal(res.headers["content-encoding"], "gzip");
      assert.equal(res.headers["content-length"], String(payload.length));
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => { assert.deepEqual(Buffer.concat(chunks), payload); resolve(); });
    });
    req.on("error", reject);
    req.end(payload);
  });
});

for (const status of [401, 404, 500]) {
  test(`Backend application status ${status} is preserved`, limits, async (t) => {
    const url = await backend(t, (_req, res) => { res.writeHead(status); res.end("application response"); });
    const pilot = await start(t, { pools: [pool("/", url)] });
    const result = await exchange(pilot, "/");
    assert.equal(result.status, status);
    assert.equal(result.body, "application response");
  });
}

test("Round Robin over HTTP is independent across pools and works concurrently", limits, async (t) => {
  const a = await backend(t, (_req, res) => res.end("a"));
  const b = await backend(t, (_req, res) => res.end("b"));
  const c = await backend(t, (_req, res) => res.end("c"));
  const d = await backend(t, (_req, res) => res.end("d"));
  const pilot = await start(t, { pools: [pool("/auth", a, b), pool("/cart", c, d)] });
  const sequence: string[] = [];
  for (const path of ["/auth", "/auth", "/cart", "/auth", "/cart", "/cart"]) {
    sequence.push((await exchange(pilot, path)).body);
  }
  assert.deepEqual(sequence, ["a", "b", "c", "a", "d", "c"]);
  const replies = await Promise.all(Array.from({ length: 20 }, () => exchange(pilot, "/auth")));
  assert.equal(replies.filter((reply) => reply.body === "a").length, 10);
  assert.equal(replies.filter((reply) => reply.body === "b").length, 10);
});

test("Independent listeners forward to their own registries", limits, async (t) => {
  const a = await backend(t, (_req, res) => res.end("a"));
  const b = await backend(t, (_req, res) => res.end("b"));
  const first = await start(t, { pools: [pool("/auth", a)] });
  const second = await start(t, { pools: [pool("/auth", b)] });
  assert.notEqual(first.port, second.port);
  assert.equal((await exchange(first, "/auth")).body, "a");
  assert.equal((await exchange(second, "/auth")).body, "b");
});

test("Dynamic pools/backends, empty pools, fallback routes and longest prefix", limits, async (t) => {
  const a = await backend(t, (req, res) => res.end(`a:${req.url}`));
  const b = await backend(t, (req, res) => res.end(`b:${req.url}`));
  const auth = pool("/auth");
  const pilot = await start(t, { route: "/gateway", pools: [auth] });
  assert.equal((await exchange(pilot, "/gateway/auth")).status, 503);
  assert.equal((await exchange(pilot, "/gateway/cart")).status, 404);
  auth.add(new Server(a));
  assert.equal((await exchange(pilot, "/gateway/auth")).body, "a:/auth");
  pilot.addPool(pool("/auth/admin", b));
  pilot.addPool(pool("/", a));
  assert.equal((await exchange(pilot, "/gateway/auth/admin/users")).body, "b:/auth/admin/users");
  assert.equal((await exchange(pilot, "/gateway/authentication")).body, "a:/authentication");
  assert.equal((await exchange(pilot, "/gateway")).body, "a:/");
  assert.equal((await exchange(pilot, "/gatewayXYZ/auth")).status, 404);
  assert.throws(() => pilot.addPool(pool("/auth/")), /already registered/);
});

test("Refused connection returns generic 502 without retrying another backend", limits, async (t) => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  let calls = 0;
  const good = await backend(t, (_req, res) => { calls++; res.end("good"); });
  const pilot = await start(t, { pools: [pool("/auth", `http://127.0.0.1:${address.port}`, good)] });
  const result = await exchange(pilot, "/auth", { method: "POST", body: "payment" });
  assert.equal(result.status, 502);
  assert.equal(result.body, "Bad Gateway\n");
  assert.equal(calls, 0);
  assert.equal((await exchange(pilot, "/auth")).body, "good");
});

test("DNS failures return 502", limits, async (t) => {
  const pilot = await start(t, { upstreamTimeoutMs: 4_000, pools: [pool("/", "http://backend.loadpilot.invalid")] });
  const result = await exchange(pilot, "/");
  assert.equal(result.status, 502);
  assert.equal(result.body, "Bad Gateway\n");
});

test("Nonresponsive upstream returns 504 and closes its operation", limits, async (t) => {
  const closed = signal();
  const url = await backend(t, (_req, res) => { res.on("close", closed.resolve); });
  const pilot = await start(t, { upstreamTimeoutMs: 100, pools: [pool("/", url)] });
  const result = await exchange(pilot, "/");
  assert.equal(result.status, 504);
  assert.equal(result.body, "Gateway Timeout\n");
  await closed.promise;
});

test("Upstream closes before valid response headers: 502", limits, async (t) => {
  const url = await backend(t, (req) => req.socket.destroy());
  const pilot = await start(t, { pools: [pool("/", url)] });
  assert.equal((await exchange(pilot, "/")).status, 502);
});

test("Invalid upstream HTTP framing returns 502", limits, async (t) => {
  const url = await backend(t, (req) => {
    req.socket.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  assert.equal((await exchange(pilot, "/")).status, 502);
});

test("An unexpected upstream protocol upgrade returns 502 and closes its socket", limits, async (t) => {
  const closed = signal();
  const url = await backend(t, (req) => {
    req.socket.once("close", closed.resolve);
    req.socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  assert.equal((await exchange(pilot, "/")).status, 502);
  await closed.promise;
});

test("Early backend rejection stops an unfinished client upload", limits, async (t) => {
  const closed = signal();
  const url = await backend(t, (req, res) => {
    req.on("error", closed.resolve);
    req.socket.once("close", closed.resolve);
    res.writeHead(413); res.end("too large");
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: pilot.port ?? 0, method: "POST", agent: false }, (res) => {
      assert.equal(res.statusCode, 413);
      assert.equal(res.headers.connection, "close");
      res.resume();
      res.on("end", resolve);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write("unfinished");
  });
  await closed.promise;
});

for (const target of ["http://attacker.invalid/auth", "//attacker.invalid/auth", "/auth/%ZZ", "/auth/#fragment", "/auth\\login", "*"]) {
  test(`Malformed request target is 400: ${target}`, limits, async (t) => {
    const pilot = await start(t, { pools: [pool("/")] });
    assert.equal((await exchange(pilot, target)).status, 400);
  });
}

test("Incremental response delivery arrives before backend completion", limits, async (t) => {
  const release = signal();
  const url = await backend(t, (_req, res) => {
    res.write("first");
    void release.promise.then(() => res.end("second"));
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: pilot.port ?? 0, agent: false }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
          if (body === "first") release.resolve();
        });
        res.on("end", () => resolve(body));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(body, "firstsecond");
  } finally { release.resolve(); }
});

test("Incremental chunked GET request body reaches backend before upload completion", limits, async (t) => {
  const first = signal();
  const url = await backend(t, (req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); first.resolve(); });
    req.on("end", () => res.end(body));
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  const result = new Promise<string>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: pilot.port ?? 0, method: "GET", agent: false,
      headers: { "transfer-encoding": "chunked" } }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write("first");
    void first.promise.then(() => req.end("second"));
  });
  assert.equal(await result, "firstsecond");
});

test("Large upload respects backpressure and preserves bytes without a whole-body fixture", limits, async (t) => {
  const url = await backend(t, (req, res) => {
    let bytes = 0;
    let valid = true;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      valid &&= chunk.every((byte) => byte === 97);
    });
    req.on("end", () => res.end(JSON.stringify({ bytes, valid })));
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  const req = request({ hostname: "127.0.0.1", port: pilot.port ?? 0, method: "POST", agent: false });
  const result = new Promise<string>((resolve, reject) => {
    req.on("error", reject);
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("error", reject);
      res.on("end", () => resolve(body));
    });
  });
  const chunk = Buffer.alloc(64 * 1024, 97);
  for (let index = 0; index < 128; index++) {
    if (!req.write(chunk)) await once(req, "drain");
  }
  req.end();
  assert.deepEqual(JSON.parse(await result), { bytes: 8 * 1024 * 1024, valid: true });
});

test("Partial upstream response failure terminates the client without a second response", limits, async (t) => {
  const release = signal();
  const url = await backend(t, (_req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write("partial");
    void release.promise.then(() => res.destroy());
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  try {
    await new Promise<void>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: pilot.port ?? 0, agent: false }, (res) => {
        assert.equal(res.statusCode, 200);
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); release.resolve(); });
        res.on("error", () => { assert.equal(body, "partial"); resolve(); });
        res.on("end", () => reject(new Error("Truncated response ended successfully")));
      });
      req.on("error", reject);
      req.end();
    });
  } finally { release.resolve(); }
});

test("Total deadline terminates an active streaming response after headers", limits, async (t) => {
  const closed = signal();
  const url = await backend(t, (_req, res) => {
    res.write("first");
    const timer = setInterval(() => res.write("."), 10);
    res.once("close", () => { clearInterval(timer); closed.resolve(); });
  });
  const pilot = await start(t, { upstreamTimeoutMs: 150, pools: [pool("/", url)] });
  await assert.rejects(exchange(pilot, "/"));
  await closed.promise;
});

test("Client response disconnect cancels upstream and leaves the listener usable", limits, async (t) => {
  const closed = signal();
  const url = await backend(t, (req, res) => {
    if (req.url === "/ok") { res.end("ok"); return; }
    res.on("close", closed.resolve);
    res.write("first");
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: pilot.port ?? 0, agent: false }, (res) => {
      res.once("data", () => { res.destroy(); resolve(); });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
  await closed.promise;
  assert.equal((await exchange(pilot, "/ok")).body, "ok");
});

test("Client upload disconnect cancels backend upload", limits, async (t) => {
  const received = signal();
  const closed = signal();
  const url = await backend(t, (req) => {
    req.on("data", received.resolve);
    req.on("error", closed.resolve);
    req.on("close", closed.resolve);
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  const req = request({ hostname: "127.0.0.1", port: pilot.port ?? 0, method: "POST", agent: false });
  const clientClosed = new Promise<void>((resolve) => { req.on("error", () => resolve()); });
  req.write("first");
  await received.promise;
  req.destroy();
  await Promise.all([clientClosed, closed.promise]);
});

test("stop cancels in-flight exchanges and instances can restart", limits, async (t) => {
  const received = signal();
  const closed = signal();
  const url = await backend(t, (req, res) => {
    if (req.url === "/ok") { res.end("ok"); return; }
    res.once("close", closed.resolve);
    received.resolve();
  });
  const pilot = await start(t, { pools: [pool("/", url)] });
  const failed = exchange(pilot, "/pending").then(() => false, () => true);
  await received.promise;
  await pilot.stop();
  assert.equal(await failed, true);
  await closed.promise;
  assert.equal(pilot.port, null);
  await pilot.start();
  assert.equal((await exchange(pilot, "/ok")).body, "ok");
});

test("A failed bind can be retried after the port is released", limits, async (t) => {
  const first = await start(t);
  assert.ok(first.port);
  const second = new LoadPilot({ name: "RetryBind", port: first.port });
  t.after(() => second.stop());
  await assert.rejects(second.start(), { code: "EADDRINUSE" });
  await first.stop();
  await second.start();
  assert.equal((await exchange(second, "/")).status, 404);
});

test("Redirects map backend origins and prefixes without trusting incoming Host", limits, async (t) => {
  let location = "";
  const url = await backend(t, (_req, res) => {
    res.writeHead(302, { location }); res.end();
  });
  const pilot = await start(t, { route: "/gateway", pools: [pool("/auth", url + "/internal")] });
  for (const [upstreamLocation, expected] of [
    [url + "/internal/auth/login?next=1#form", "/gateway/auth/login?next=1#form"],
    ["//" + new URL(url).host + "/internal/auth/", "/gateway/auth/"],
    ["/internal/auth/login", "/gateway/auth/login"],
    ["next?x=1", "/gateway/auth/next?x=1"],
    ["https://external.example/login", "https://external.example/login"],
    [url + "/outside", undefined],
  ]) {
    location = upstreamLocation ?? "";
    const result = await exchange(pilot, "/gateway/auth/current", { headers: { host: "attacker.example" } });
    assert.equal(result.status, 302);
    assert.equal(result.headers.location, expected);
  }
});

test("Root redirect rewriting cannot create a network-path open redirect", limits, async (t) => {
  let location = "";
  const url = await backend(t, (_req, res) => { res.writeHead(302, { location }); res.end(); });
  const pilot = await start(t, { pools: [pool("/", url)] });
  location = url + "//attacker.example/path";
  assert.equal((await exchange(pilot, "/")).headers.location, undefined);
});

test("HTTP Upgrade and CONNECT are explicitly rejected", limits, async (t) => {
  const pilot = await start(t);
  for (const raw of [
    "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost\r\n\r\n",
  ]) {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(pilot.port ?? 0, "127.0.0.1", () => socket.write(raw));
      let body = "";
      socket.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      socket.on("end", () => resolve(body));
      socket.on("error", reject);
    });
    assert.match(response, /^HTTP\/1\.1 501 /);
  }
});

test("HTTPS upstream verifies certificates and forwards with a trusted CA", limits, async (t) => {
  const url = await backend(t, (req, res) => res.end(`tls:${req.url}`), true);
  const untrusted = await start(t, { pools: [pool("/", url)] });
  assert.equal((await exchange(untrusted, "/auth")).status, 502);
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url), "utf8")]);
  try {
    const trusted = await start(t, { pools: [pool("/auth", url + "/internal")] });
    const result = await exchange(trusted, "/auth/login");
    assert.equal(result.status, 200);
    assert.equal(result.body, "tls:/internal/auth/login");
  } finally { setDefaultCACertificates(previous); }
});

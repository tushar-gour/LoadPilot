import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type RequestListener, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { spawn } from "node:child_process";
import {
  LoadPilot, Server, ServerPool, HealthState, type HealthCheckOptions,
} from "../src/index.js";

const limits = { timeout: 10_000 };
const configuration = (overrides: HealthCheckOptions = {}): HealthCheckOptions => ({
  enabled: true, path: "/health", intervalMs: 1000, timeoutMs: 200,
  unhealthyThreshold: 2, healthyThreshold: 2, ...overrides,
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Expected health condition did not occur");
    await nextTurn();
  }
}

async function backend(t: TestContext, handler: RequestListener, secure = false): Promise<string> {
  const server = secure ? createHttpsServer({
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
  return `${secure ? "https" : "http"}://127.0.0.1:${address.port}`;
}

async function pilot(t: TestContext, ...pools: ServerPool[]): Promise<LoadPilot> {
  const instance = new LoadPilot({ name: t.name, port: 0, pools });
  t.after(() => instance.stop());
  await instance.start();
  return instance;
}

function exchange(instance: LoadPilot, path = "/app", headers = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, path, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function monitored(urls: string[], healthCheck = configuration(), route = "/"): ServerPool {
  return new ServerPool({ route, servers: urls.map((url) => new Server(url)), healthCheck });
}

test("Health options default to disabled and validate every provided value", () => {
  const defaults = new ServerPool({ route: "/" }).healthCheck;
  assert.deepEqual(defaults, { enabled: false, path: "/health", intervalMs: 5000, timeoutMs: 1000,
    unhealthyThreshold: 2, healthyThreshold: 2 });
  assert.ok(Object.isFrozen(defaults));
  for (const value of [null, true, "enabled", []]) {
    assert.throws(() => Reflect.construct(ServerPool, [{ route: "/", healthCheck: value }]), /healthCheck/);
  }
  for (const enabled of [null, "true", 1]) {
    assert.throws(() => Reflect.construct(ServerPool, [{ route: "/", healthCheck: { enabled } }]), /enabled/);
  }
  for (const name of ["intervalMs", "timeoutMs", "unhealthyThreshold", "healthyThreshold"]) {
    for (const value of [0, -1, 1.5, NaN, Infinity, null, "100", Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => Reflect.construct(ServerPool, [{ route: "/", healthCheck: { [name]: value } }]), /healthCheck/);
    }
  }
  for (const name of ["intervalMs", "timeoutMs"]) {
    assert.throws(() => Reflect.construct(ServerPool, [{ route: "/", healthCheck: { [name]: 2_147_483_648 } }]), /healthCheck/);
  }
  for (const path of [null, "health", "http://localhost/health", "//localhost/health", "/x//y", "/x?y=1", "/x#y",
    "/x\\y", "/x y", "/%ZZ", "/../health", "/%2e%2e/health", "/.%2e/health"]) {
    assert.throws(() => Reflect.construct(ServerPool, [{ route: "/", healthCheck: { path } }]), /path/);
  }
  assert.equal(new ServerPool({ route: "/", healthCheck: { path: "/ready/" } }).healthCheck.path, "/ready/");
});

test("Disabled monitoring sends no probes and preserves Round Robin", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  const a = await backend(t, (req, res) => { if (req.url === "/health") probes++; res.end("a"); });
  const b = await backend(t, (req, res) => { if (req.url === "/health") probes++; res.end("b"); });
  for (const healthCheck of [undefined, { enabled: false }]) {
    const pool = new ServerPool({ route: "/", servers: [new Server(a), new Server(b)], healthCheck });
    const instance = await pilot(t, pool);
    t.mock.timers.tick(100_000);
    assert.equal(probes, 0);
    assert.deepEqual(pool.getHealthStatus().map((item) => item.state), [HealthState.UNKNOWN, HealthState.UNKNOWN]);
    assert.deepEqual([(await exchange(instance)).body, (await exchange(instance)).body, (await exchange(instance)).body], ["a", "b", "a"]);
    await instance.stop();
  }
});

test("UNKNOWN is selectable, initial checks do not block startup, and snapshots are independent", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const responses: ServerResponse[] = [];
  const url = await backend(t, (req, res) => {
    if (req.url === "/health") responses.push(res);
    else res.end("app");
  });
  const pool = monitored([url]);
  const instance = await pilot(t, pool);
  const snapshot = pool.getHealthStatus();
  assert.equal(snapshot[0].state, HealthState.UNKNOWN);
  assert.equal(responses.length, 0);
  t.mock.timers.tick(0);
  await until(() => responses.length === 1);
  assert.equal((await exchange(instance)).body, "app");
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNKNOWN);
  responses[0].end();
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  assert.equal(snapshot[0].state, HealthState.UNKNOWN);
  assert.equal(pool.getHealthStatus()[0].consecutiveSuccesses, 1);
});

test("Healthy real backends alternate and probes never advance the selection cursor", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = await backend(t, (req, res) => { res.statusCode = req.url === "/health" ? 204 : 200; res.end("a"); });
  const b = await backend(t, (req, res) => { res.statusCode = req.url === "/health" ? 202 : 200; res.end("b"); });
  const pool = monitored([a, b]);
  const instance = await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus().every((item) => item.state === HealthState.HEALTHY));
  const bodies: string[] = [];
  for (let index = 0; index < 4; index++) bodies.push((await exchange(instance)).body);
  assert.deepEqual(bodies, ["a", "b", "a", "b"]);
});

test("Failure and recovery thresholds skip unhealthy backends and restore registration-order rotation", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let status = 503;
  const a = await backend(t, (req, res) => { res.statusCode = req.url === "/health" ? status : 200; res.end("a"); });
  const b = await backend(t, (_req, res) => res.end("b"));
  const pool = monitored([a, b]);
  const instance = await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].consecutiveFailures === 1 && pool.getHealthStatus()[1].state === HealthState.HEALTHY);
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNKNOWN);
  assert.deepEqual([(await exchange(instance)).body, (await exchange(instance)).body], ["a", "b"]);
  t.mock.timers.tick(1000);
  await until(() => pool.getHealthStatus()[0].state === HealthState.UNHEALTHY);
  for (let index = 0; index < 3; index++) assert.equal((await exchange(instance)).body, "b");
  status = 200;
  t.mock.timers.tick(1000);
  await until(() => pool.getHealthStatus()[0].consecutiveSuccesses === 1);
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNHEALTHY);
  assert.equal((await exchange(instance)).body, "b");
  t.mock.timers.tick(1000);
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  const bodies: string[] = [];
  for (let index = 0; index < 4; index++) bodies.push((await exchange(instance)).body);
  assert.deepEqual(bodies, ["a", "b", "a", "b"]);
});

test("Consecutive counters reset when outcomes change during failure and recovery", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let status = 503;
  const url = await backend(t, (_req, res) => { res.statusCode = status; res.end(); });
  const pool = monitored([url]);
  await pilot(t, pool);
  const outcomes: [number, HealthState, number, number][] = [
    [503, HealthState.UNKNOWN, 0, 1], [200, HealthState.HEALTHY, 1, 0],
    [503, HealthState.HEALTHY, 0, 1], [503, HealthState.UNHEALTHY, 0, 2],
    [200, HealthState.UNHEALTHY, 1, 0], [503, HealthState.UNHEALTHY, 0, 1],
    [200, HealthState.UNHEALTHY, 1, 0], [200, HealthState.HEALTHY, 2, 0],
  ];
  for (const [index, [code, state, successes, failures]] of outcomes.entries()) {
    status = code;
    t.mock.timers.tick(index === 0 ? 0 : 1000);
    await until(() => {
      const current = pool.getHealthStatus()[0];
      return current.state === state && current.consecutiveSuccesses === successes && current.consecutiveFailures === failures;
    });
  }
});

test("All unhealthy returns clean generic 503 without forwarding or falling back to the root pool", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let applications = 0;
  const bad = await backend(t, (req, res) => {
    if (req.url !== "/health") applications++;
    res.writeHead(500); res.end();
  });
  const good = await backend(t, (_req, res) => { res.end("fallback"); });
  const otherBad = await backend(t, (req, res) => {
    if (req.url !== "/health") applications++;
    res.writeHead(404); res.end();
  });
  const pool = monitored([bad, otherBad], configuration({ unhealthyThreshold: 1 }), "/auth");
  const instance = await pilot(t, pool, new ServerPool({ route: "/", servers: [new Server(good)] }));
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus().every((status) => status.state === HealthState.UNHEALTHY));
  assert.deepEqual(await exchange(instance, "/auth/login"), { status: 503, body: "Service Unavailable\n" });
  assert.equal(applications, 0);
  assert.equal(pool.getNextServer(), null);
});

for (const code of [301, 302, 401, 404, 500]) {
  test(`Probe HTTP ${code} fails without following redirects`, limits, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let redirected = 0;
    const url = await backend(t, (req, res) => {
      if (req.url === "/redirected") redirected++;
      res.writeHead(code, { location: "/redirected" }); res.end();
    });
    const pool = monitored([url], configuration({ unhealthyThreshold: 1 }));
    await pilot(t, pool);
    t.mock.timers.tick(0);
    await until(() => pool.getHealthStatus()[0].state === HealthState.UNHEALTHY);
    assert.equal(redirected, 0);
  });
}

test("Probe total timeout cancels a nonresponsive backend independently of upstreamTimeoutMs", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let pending: ServerResponse | undefined;
  let closed = false;
  const url = await backend(t, (_req, res) => { pending = res; res.once("close", () => { closed = true; }); });
  const pool = monitored([url], configuration({ unhealthyThreshold: 1 }));
  await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => pending !== undefined);
  t.mock.timers.tick(199);
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNKNOWN);
  t.mock.timers.tick(1);
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNHEALTHY);
  await until(() => closed);
});

test("A stalled 2xx body is bounded by the same probe deadline", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let pending = false;
  const url = await backend(t, (_req, res) => { res.write("partial"); pending = true; });
  const pool = monitored([url], configuration({ unhealthyThreshold: 1 }));
  await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => pending);
  t.mock.timers.tick(200);
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNHEALTHY);
});

for (const stage of ["before headers", "during a 2xx body"]) {
  test(`Premature health connection close ${stage} is a failed probe`, limits, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const url = await backend(t, (req, res) => {
      if (stage === "before headers") req.socket.destroy();
      else { res.writeHead(200, { "content-length": "100" }); res.end("short"); }
    });
    const pool = monitored([url], configuration({ unhealthyThreshold: 1 }));
    await pilot(t, pool);
    t.mock.timers.tick(0);
    await until(() => pool.getHealthStatus()[0].state === HealthState.UNHEALTHY);
    assert.equal(pool.getHealthStatus()[0].consecutiveFailures, 1);
  });
}

test("A backend has no overlapping probes or duplicate initialization and intervals start after completion", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const responses: ServerResponse[] = [];
  let active = 0;
  let maximum = 0;
  const url = await backend(t, (_req, res) => {
    active++; maximum = Math.max(maximum, active);
    res.once("close", () => { active--; });
    responses.push(res);
  });
  const pool = monitored([url], configuration({ timeoutMs: 10_000 }));
  const instance = await pilot(t, pool);
  pool.startHealthChecks(instance);
  pool.startHealthChecks(instance);
  t.mock.timers.tick(0);
  await until(() => responses.length === 1);
  t.mock.timers.tick(3000);
  await nextTurn();
  assert.equal(responses.length, 1);
  responses[0].end();
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY && active === 0);
  t.mock.timers.tick(999);
  await nextTurn();
  assert.equal(responses.length, 1);
  t.mock.timers.tick(1);
  await until(() => responses.length === 2);
  assert.equal(maximum, 1);
  responses[1].end();
});

test("Probe paths preserve backend prefixes, escapes and trailing slashes without client credentials", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  const url = await backend(t, (req, res) => {
    if (req.url === "/internal/check%2Fready/") {
      probes++;
      assert.equal(req.method, "GET");
      assert.equal(req.headers.host, new URL(url).host);
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers.cookie, undefined);
      assert.equal(req.headers["x-application"], undefined);
      assert.equal(req.headers["x-forwarded-for"], undefined);
    }
    res.end("ok");
  });
  const pool = monitored([url + "/internal/"], configuration({ path: "/check%2Fready/" }), "/auth");
  const instance = await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  await exchange(instance, "/auth", { authorization: "Bearer test", cookie: "secret=1", "x-application": "client" });
  t.mock.timers.tick(1000);
  await until(() => pool.getHealthStatus()[0].consecutiveSuccesses === 2);
  assert.equal(probes, 2);
});

test("Independent pools can monitor the same Server object with different health endpoints", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const url = await backend(t, (req, res) => {
    res.statusCode = req.url === "/auth-health" ? 503 : 200; res.end("cart");
  });
  const server = new Server(url);
  const auth = new ServerPool({ route: "/auth", servers: [server], healthCheck: configuration({ path: "/auth-health", unhealthyThreshold: 1 }) });
  const cart = new ServerPool({ route: "/cart", servers: [server], healthCheck: configuration({ path: "/cart-health" }) });
  const instance = await pilot(t, auth, cart);
  t.mock.timers.tick(0);
  await until(() => auth.getHealthStatus()[0].state === HealthState.UNHEALTHY && cart.getHealthStatus()[0].state === HealthState.HEALTHY);
  assert.equal((await exchange(instance, "/auth")).status, 503);
  assert.equal((await exchange(instance, "/cart")).body, "cart");
});

test("Independent LoadPilot listeners keep health isolated even for the same Server object", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const url = await backend(t, (req, res) => { res.statusCode = req.url === "/first" ? 500 : 200; res.end(); });
  const server = new Server(url);
  const a = new ServerPool({ route: "/", servers: [server], healthCheck: configuration({ path: "/first", unhealthyThreshold: 1 }) });
  const b = new ServerPool({ route: "/", servers: [server], healthCheck: configuration({ path: "/second" }) });
  const first = await pilot(t, a);
  const second = await pilot(t, b);
  t.mock.timers.tick(0);
  await until(() => a.getHealthStatus()[0].state === HealthState.UNHEALTHY && b.getHealthStatus()[0].state === HealthState.HEALTHY);
  await first.stop();
  t.mock.timers.tick(1000);
  await until(() => b.getHealthStatus()[0].consecutiveSuccesses === 2);
  assert.equal((await exchange(second)).status, 200);
  assert.equal(a.getHealthStatus()[0].state, HealthState.UNHEALTHY);
});

test("Shared pools have one monitor and keep probing until the last listener stops", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  const url = await backend(t, (_req, res) => { probes++; res.end(); });
  const pool = monitored([url]);
  const first = await pilot(t, pool);
  const second = await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  assert.equal(probes, 1);
  await first.stop();
  t.mock.timers.tick(1000);
  await until(() => pool.getHealthStatus()[0].consecutiveSuccesses === 2);
  assert.equal(probes, 2);
  await second.stop();
  t.mock.timers.tick(100_000);
  await nextTurn();
  assert.equal(probes, 2);
  await first.start();
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNKNOWN);
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  assert.equal(probes, 3);
});

test("A failed listener bind starts no monitor and health checks begin after a successful retry", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  const url = await backend(t, (_req, res) => { probes++; res.end(); });
  const blocker = await pilot(t);
  assert.ok(blocker.port);
  const pool = monitored([url]);
  const retry = new LoadPilot({ name: "HealthBindRetry", port: blocker.port, pools: [pool] });
  t.after(() => retry.stop());
  await assert.rejects(retry.start(), { code: "EADDRINUSE" });
  t.mock.timers.tick(100_000);
  await nextTurn();
  assert.equal(probes, 0);
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNKNOWN);
  await blocker.stop();
  await retry.start();
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  assert.equal(probes, 1);
});

test("Dynamic pools and added backends begin UNKNOWN and receive initial probes", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const url = await backend(t, (_req, res) => res.end());
  const instance = await pilot(t);
  const pool = monitored([]);
  instance.addPool(pool);
  assert.equal(pool.getNextServer(), null);
  const server = new Server(url);
  pool.add(server);
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNKNOWN);
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  assert.equal((await exchange(instance)).status, 200);
});

test("Removing and re-adding a backend cancels old probes and ignores stale results", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const responses: ServerResponse[] = [];
  const url = await backend(t, (_req, res) => { responses.push(res); });
  const server = new Server(url);
  const pool = new ServerPool({ route: "/", servers: [server], healthCheck: configuration({ unhealthyThreshold: 1 }) });
  await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => responses.length === 1);
  assert.equal(pool.remove(server), true);
  assert.equal(pool.remove(server), false);
  assert.deepEqual(pool.getHealthStatus(), []);
  assert.equal(pool.getNextServer(), null);
  pool.add(server);
  t.mock.timers.tick(0);
  await until(() => responses.length === 2);
  responses[0].writeHead(503); responses[0].end();
  await nextTurn();
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNKNOWN);
  responses[1].end();
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
});

test("Backend removal preserves the next registration-order selection", () => {
  const a = new Server("http://localhost:3001");
  const b = new Server("http://localhost:3002");
  const c = new Server("http://localhost:3003");
  const pool = new ServerPool({ route: "/", servers: [a, b, c] });
  assert.equal(pool.getNextServer(), a);
  pool.remove(a);
  assert.equal(pool.getNextServer(), b);
  pool.remove(c);
  assert.equal(pool.getNextServer(), b);
  pool.remove(b);
  assert.equal(pool.getNextServer(), null);
});

test("Health changes affect new selections without cancelling an active streamed response", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let status = 200;
  let activeResponse: ServerResponse | undefined;
  const url = await backend(t, (req, res) => {
    if (req.url === "/health") { res.writeHead(status); res.end(); return; }
    activeResponse = res; res.write("first");
  });
  const pool = monitored([url], configuration({ unhealthyThreshold: 1 }));
  const instance = await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  let firstChunk = false;
  const streamed = new Promise<string>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, path: "/stream", agent: false }, (res) => {
      assert.equal(res.statusCode, 200);
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); firstChunk = true; });
      res.on("error", reject);
      res.on("end", () => resolve(body));
    });
    req.on("error", reject); req.end();
  });
  await until(() => firstChunk);
  status = 503;
  t.mock.timers.tick(1000);
  await until(() => pool.getHealthStatus()[0].state === HealthState.UNHEALTHY);
  assert.equal((await exchange(instance)).status, 503);
  assert.ok(activeResponse && !activeResponse.destroyed);
  activeResponse.end("second");
  assert.equal(await streamed, "firstsecond");
});

test("Shutdown cancels pending probes, clears future timers, and ignores late failures", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let pending: ServerResponse | undefined;
  let probes = 0;
  let closed = false;
  const url = await backend(t, (_req, res) => {
    probes++; pending = res;
    res.once("close", () => { closed = true; });
  });
  const pool = monitored([url], configuration({ unhealthyThreshold: 1 }));
  const instance = await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => pending !== undefined);
  await instance.stop();
  await until(() => closed);
  assert.ok(pending);
  pending.writeHead(503); pending.end();
  t.mock.timers.tick(100_000);
  await nextTurn();
  assert.equal(pool.getHealthStatus()[0].state, HealthState.UNKNOWN);
  assert.equal(pool.getHealthStatus()[0].consecutiveFailures, 0);
  assert.equal(probes, 1);
});

test("Health timers and pending sockets do not keep a standalone process alive", limits, async (t) => {
  let received = false;
  const url = await backend(t, () => { received = true; });
  const source = `import {ServerPool, Server} from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
    const pool = new ServerPool({route: '/', servers: [new Server(${JSON.stringify(url)})],
      healthCheck: {enabled: true, intervalMs: 10000, timeoutMs: 10000}});
    process.stdin.once('data', () => process.stdin.destroy());
    pool.startHealthChecks({});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    stdio: ["pipe", "ignore", "pipe"], timeout: 5000, windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = once(child, "exit");
  await until(() => received);
  child.stdin.end("release");
  const [code, terminationSignal] = await exited;
  assert.equal(terminationSignal, null, stderr);
  assert.equal(code, 0, stderr);
});

test("Transport failures prompt a confirmation probe without replaying a request", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let status = 200;
  let probes = 0;
  let applications = 0;
  const url = await backend(t, (req, res) => {
    if (req.url === "/health") { probes++; res.writeHead(status); res.end(); }
    else { applications++; req.socket.destroy(); }
  });
  const pool = monitored([url], configuration({ unhealthyThreshold: 1 }));
  const instance = await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  status = 503;
  assert.equal((await exchange(instance)).status, 502);
  assert.equal(probes, 1);
  assert.equal(applications, 1);
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].state === HealthState.UNHEALTHY);
  assert.equal(probes, 2);
  assert.equal((await exchange(instance)).status, 503);
  assert.equal(applications, 1);
});

test("Ordinary application 4xx/5xx and client disconnects do not become passive health failures", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  const url = await backend(t, (req, res) => {
    if (req.url === "/health") { probes++; res.end(); }
    else if (req.url === "/stream") res.write("first");
    else { res.writeHead(req.url === "/unauthorized" ? 401 : 500); res.end("application"); }
  });
  const pool = monitored([url], configuration({ unhealthyThreshold: 1 }));
  const instance = await pilot(t, pool);
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  assert.equal((await exchange(instance, "/unauthorized")).status, 401);
  assert.equal((await exchange(instance, "/error")).status, 500);
  await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, path: "/stream", agent: false }, (res) => {
      res.once("data", () => { res.destroy(); resolve(); });
      res.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
  await nextTurn();
  t.mock.timers.tick(0);
  await nextTurn();
  assert.equal(probes, 1);
  assert.equal(pool.getHealthStatus()[0].state, HealthState.HEALTHY);
});

test("The application total deadline does not infer backend unhealthiness", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  let pending = false;
  const url = await backend(t, (req, res) => {
    if (req.url === "/health") { probes++; res.end(); }
    else pending = true;
  });
  const pool = monitored([url], configuration({ unhealthyThreshold: 1 }));
  const instance = new LoadPilot({ name: t.name, port: 0, pools: [pool], upstreamTimeoutMs: 100 });
  t.after(() => instance.stop());
  await instance.start();
  t.mock.timers.tick(0);
  await until(() => pool.getHealthStatus()[0].state === HealthState.HEALTHY);
  const result = exchange(instance);
  await until(() => pending);
  t.mock.timers.tick(100);
  assert.equal((await result).status, 504);
  t.mock.timers.tick(0);
  await nextTurn();
  assert.equal(probes, 1);
  assert.equal(pool.getHealthStatus()[0].state, HealthState.HEALTHY);
});

test("HTTPS probes verify certificates and use the configured backend pathname prefix", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  const url = await backend(t, (req, res) => {
    if (req.url === "/internal/health") probes++;
    res.end("tls");
  }, true);
  const untrusted = monitored([url + "/internal"], configuration({ unhealthyThreshold: 1 }));
  const first = await pilot(t, untrusted);
  t.mock.timers.tick(0);
  await until(() => untrusted.getHealthStatus()[0].state === HealthState.UNHEALTHY);
  assert.equal(probes, 0);
  assert.equal((await exchange(first)).status, 503);
  await first.stop();
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url), "utf8")]);
  try {
    const trusted = monitored([url + "/internal"]);
    const second = await pilot(t, trusted);
    t.mock.timers.tick(0);
    await until(() => trusted.getHealthStatus()[0].state === HealthState.HEALTHY);
    assert.equal(probes, 1);
    assert.equal((await exchange(second)).body, "tls");
  } finally { setDefaultCACertificates(previous); }
});

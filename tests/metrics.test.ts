import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type RequestListener, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { spawn } from "node:child_process";
import {
  LoadPilot, ServerPool, Server, HealthState, type LoadPilotOptions,
  type HealthCheckOptions, type LoadPilotMetrics, type AggregateMetrics,
} from "../src/index.js";
import { LatencyHistogram, MetricsCollector } from "../src/metrics/MetricsCollector.js";
import { HttpProxy, type ProxyEvent } from "../src/proxy/HttpProxy.js";

const limits = { timeout: 10_000 };
const realNow = performance.now.bind(performance);

async function until(predicate: () => boolean) {
  const deadline = realNow() + 5_000;
  while (!predicate()) {
    if (realNow() > deadline) throw new Error("Expected metrics condition did not occur");
    await nextTurn();
  }
}

async function backend(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function start(t: TestContext, options: Partial<LoadPilotOptions> = {}) {
  const instance = new LoadPilot({ name: t.name, port: 0, metrics: { enabled: true }, ...options });
  t.after(() => instance.stop());
  await instance.start();
  return instance;
}

function pool(route: string, ...urls: string[]) {
  return new ServerPool({ route, servers: urls.map((url) => new Server(url)) });
}

function exchange(instance: LoadPilot, path = "/", headers = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, path, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject); req.end();
  });
}

function assertSettled(group: AggregateMetrics, total: number) {
  const requests = group.requests;
  assert.equal(requests.total, total);
  assert.equal(requests.active, 0);
  assert.equal(requests.total, requests.completed + requests.failed + requests.cancelled);
  assert.equal(requests.cancelled, requests.clientCancelled + requests.shutdownCancelled);
  assert.equal(group.latency.count, total);
  assert.equal(group.responses.completed + group.responses.incomplete, total);
}

function healthOptions(overrides: HealthCheckOptions = {}): HealthCheckOptions {
  return { enabled: true, intervalMs: 1000, timeoutMs: 200,
    unhealthyThreshold: 2, healthyThreshold: 2, ...overrides };
}

function backendHealth(instance: LoadPilot, index = 0) {
  const health = instance.getMetrics().pools[0].backends[index].health;
  assert.ok(health);
  return health;
}

test("Metrics options are opt-in, validated and backward compatible", () => {
  for (const metrics of [undefined, {}, { enabled: false }, { enabled: true }]) {
    const instance = new LoadPilot({ name: "Configuration", port: 0, metrics });
    assert.equal(instance.getMetrics().enabled, metrics?.enabled === true);
    assert.equal(instance.getMetrics().requests.total, 0);
  }
  for (const metrics of [null, true, [], "enabled", { enabled: null }, { enabled: 1 }, { enabled: "true" }]) {
    assert.throws(() => Reflect.construct(LoadPilot, [{ name: "Invalid", port: 0, metrics }]), /metrics/);
  }
});

test("Zero snapshots include registered pools/backends with UNKNOWN eligibility", () => {
  const instance = new LoadPilot({ name: "Empty", port: 0, metrics: { enabled: true },
    pools: [pool("/auth", "http://localhost:3001", "http://localhost:3002"), pool("/empty")] });
  const snapshot = instance.getMetrics();
  assert.equal(snapshot.name, "Empty");
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.uptimeMs, 0);
  assert.equal(snapshot.instrumentationErrors, 0);
  assertSettled(snapshot, 0);
  assert.equal(snapshot.latency.minMs, 0);
  assert.equal(snapshot.latency.maxMs, 0);
  assert.equal(snapshot.latency.averageMs, 0);
  assert.equal(snapshot.latency.p99Ms, 0);
  assert.deepEqual(snapshot.pools[0].eligibility, { registered: 2, registrations: 2, unknown: 2, healthy: 0, unhealthy: 0, eligible: 2 });
  assert.equal(snapshot.pools[0].backends[0].health?.state, HealthState.UNKNOWN);
  assert.equal(snapshot.pools[0].backends[0].health?.successfulProbes, 0);
  assert.equal(snapshot.pools[1].backends.length, 0);
  assertSettled(snapshot.pools[0].backends[0], 0);
});

test("Disabled metrics capture no requests, clocks or proxy observers and preserve rotation", limits, async (t) => {
  const a = await backend(t, (_req, res) => res.end("a"));
  const b = await backend(t, (_req, res) => res.end("b"));
  const instance = await start(t, { metrics: undefined, pools: [pool("/", a, b)] });
  // Uptime only uses timing at lifecycle/snapshot boundaries. The disabled
  // request path must never enter metrics setup or capture durations.
  const setup = t.mock.method(MetricsCollector.prototype, "begin", () => { throw new Error("disabled metrics setup"); });
  const timer = t.mock.method(performance, "now", () => { throw new Error("disabled metrics timing"); });
  try {
    assert.deepEqual([(await exchange(instance)).body, (await exchange(instance)).body, (await exchange(instance)).body], ["a", "b", "a"]);
    assert.equal(setup.mock.callCount(), 0);
    assert.equal(timer.mock.callCount(), 0);
  } finally { timer.mock.restore(); setup.mock.restore(); }
  assert.equal(instance.getMetrics().enabled, false);
  assertSettled(instance.getMetrics(), 0);
  assert.ok(instance.getMetrics().pools[0].backends.every((item) => item.requests.total === 0));
});

for (const status of [200, 301, 302, 400, 404, 500, 503]) {
  test(`Complete backend HTTP ${status} is a completed application response`, limits, async (t) => {
    const url = await backend(t, (_req, res) => { res.writeHead(status); res.end("application"); });
    const instance = await start(t, { pools: [pool("/", url)] });
    assert.deepEqual(await exchange(instance), { status, body: "application" });
    const snapshot = instance.getMetrics();
    const category = status < 300 ? "status2xx" : status < 400 ? "status3xx" : status < 500 ? "status4xx" : "status5xx";
    for (const group of [snapshot, snapshot.pools[0], snapshot.pools[0].backends[0]]) {
      assertSettled(group, 1);
      assert.equal(group.requests.completed, 1);
      assert.equal(group.requests.failed, 0);
      assert.equal(group.requests.upstreamFailures, 0);
      assert.equal(group.responses[category], 1);
      assert.equal(group.responses.backend[category], 1);
      assert.equal(group.responses.loadPilot[category], 0);
      assert.equal(group.upstreamHeadersLatency.count, 1);
    }
  });
}

test("Routing rejections and malformed targets have local statuses and no backend selection", limits, async (t) => {
  const instance = await start(t, { pools: [pool("/auth")] });
  assert.equal((await exchange(instance, "/unknown")).status, 404);
  assert.equal((await exchange(instance, "/auth/login")).status, 503);
  assert.equal((await exchange(instance, "/auth/%ZZ")).status, 400);
  const snapshot = instance.getMetrics();
  assertSettled(snapshot, 3);
  assert.equal(snapshot.requests.completed, 3);
  assert.equal(snapshot.requests.routeNotFound, 1);
  assert.equal(snapshot.requests.noEligibleBackend, 1);
  assert.equal(snapshot.requests.invalidTarget, 1);
  assert.equal(snapshot.responses.loadPilot.status4xx, 2);
  assert.equal(snapshot.responses.loadPilot.status5xx, 1);
  assert.equal(snapshot.responses.backend.status5xx, 0);
  assertSettled(snapshot.pools[0], 1);
  assert.equal(snapshot.pools[0].requests.noEligibleBackend, 1);
  assert.deepEqual(snapshot.pools[0].backends, []);
});

test("Root, normalized and overlapping pool routes use the actual matcher result", limits, async (t) => {
  const url = await backend(t, (req, res) => res.end(req.url));
  const instance = await start(t, { route: "/gateway", pools: [pool("/", url), pool("/auth/", url), pool("/auth/admin", url)] });
  for (const path of ["/gateway/other", "/gateway/auth/users/123?token=private", "/gateway/auth/admin/users", "/outside"]) {
    await exchange(instance, path);
  }
  const snapshot = instance.getMetrics();
  assertSettled(snapshot, 4);
  assert.deepEqual(snapshot.pools.map((item) => [item.route, item.requests.total]), [["/", 1], ["/auth", 1], ["/auth/admin", 1]]);
  assert.equal(snapshot.requests.routeNotFound, 1);
  assert.ok(snapshot.pools.every((item) => item.backends[0].requests.total === 1));
  assert.ok(!JSON.stringify(snapshot).includes("private"));
});

test("Unexpected orchestration failures are local failed exchanges, not transport failures", limits, async (t) => {
  const auth = pool("/auth", "http://localhost:3001");
  t.mock.method(auth, "getNextServer", () => { throw new Error("private internal detail"); });
  const instance = await start(t, { pools: [auth] });
  assert.deepEqual(await exchange(instance, "/auth"), { status: 500, body: "Internal Server Error\n" });
  const snapshot = instance.getMetrics();
  assertSettled(snapshot, 1);
  assert.equal(snapshot.requests.failed, 1);
  assert.equal(snapshot.requests.internalErrors, 1);
  assert.equal(snapshot.requests.upstreamFailures, 0);
  assert.equal(snapshot.responses.loadPilot.status5xx, 1);
  assert.equal(snapshot.pools[0].backends[0].requests.total, 0);
});

test("Sequential and concurrent requests maintain all active gauges and exactly-once totals", limits, async (t) => {
  const pending: ServerResponse[] = [];
  const url = await backend(t, (req, res) => {
    if (req.url === "/hold") pending.push(res);
    else res.end("ok");
  });
  const instance = await start(t, { pools: [pool("/", url, url)] });
  await exchange(instance, "/ok");
  await exchange(instance, "/ok");
  const results = Promise.allSettled(Array.from({ length: 20 }, () => exchange(instance, "/hold")));
  await until(() => pending.length === 20);
  const active = instance.getMetrics();
  assert.equal(active.requests.total, 22);
  assert.equal(active.requests.active, 20);
  assert.equal(active.requests.completed, 2);
  assert.equal(active.pools[0].requests.active, 20);
  assert.deepEqual(active.pools[0].backends.map((item) => item.requests.active), [10, 10]);
  pending.forEach((res) => res.end("done"));
  assert.ok((await results).every((result) => result.status === "fulfilled"));
  const snapshot = instance.getMetrics();
  assertSettled(snapshot, 22);
  assertSettled(snapshot.pools[0], 22);
  snapshot.pools[0].backends.forEach((item) => assertSettled(item, 11));
  assert.equal(snapshot.requests.completed, 22);
  assert.equal(snapshot.instrumentationErrors, 0);
});

test("Distinct Server objects at the same URL keep separate IDs and Round Robin counts", limits, async (t) => {
  const url = await backend(t, (_req, res) => res.end("same address"));
  const instance = await start(t, { pools: [pool("/", url, url)] });
  for (let index = 0; index < 6; index++) await exchange(instance);
  const backends = instance.getMetrics().pools[0].backends;
  assert.equal(backends.length, 2);
  assert.notEqual(backends[0].id, backends[1].id);
  assert.equal(backends[0].baseUrl, backends[1].baseUrl);
  assert.deepEqual(backends.map((item) => item.requests.total), [3, 3]);
});

test("Repeated registrations of one Server retain one identity and registration weighting", limits, async (t) => {
  const url = await backend(t, (_req, res) => res.end());
  const a = new Server(url);
  const b = new Server(url);
  const auth = new ServerPool({ route: "/", servers: [a, a, b] });
  const instance = await start(t, { pools: [auth] });
  for (let index = 0; index < 6; index++) await exchange(instance);
  const snapshot = instance.getMetrics().pools[0];
  assert.deepEqual(snapshot.backends.map((item) => [item.registrations, item.requests.total]), [[2, 4], [1, 2]]);
  assert.equal(snapshot.eligibility.registered, 2);
  assert.equal(snapshot.eligibility.registrations, 3);
  auth.remove(a);
  assert.equal(instance.getMetrics().pools[0].backends[0].registrations, 1);
  assert.equal(instance.getMetrics().pools[0].backends[0].requests.total, 4);
});

test("Dynamic pools and backend removal/re-add keep old active identities separate", limits, async (t) => {
  let held: ServerResponse | undefined;
  const url = await backend(t, (req, res) => {
    if (req.url === "/auth/hold") held = res;
    else res.end("ok");
  });
  const instance = await start(t);
  const server = new Server(url);
  const auth = new ServerPool({ route: "/auth", servers: [server] });
  instance.addPool(auth);
  const pending = exchange(instance, "/auth/hold");
  await until(() => held !== undefined);
  const oldId = instance.getMetrics().pools[0].backends[0].id;
  auth.remove(server);
  let snapshot = instance.getMetrics().pools[0];
  assert.equal(snapshot.eligibility.registered, 0);
  assert.equal(snapshot.backends[0].registered, false);
  assert.equal(snapshot.backends[0].requests.active, 1);
  assert.equal(snapshot.backends[0].health, null);
  auth.add(server);
  snapshot = instance.getMetrics().pools[0];
  assert.equal(snapshot.backends.length, 2);
  const newId = snapshot.backends[0].id;
  assert.notEqual(newId, oldId);
  assert.equal(snapshot.backends[0].requests.active, 0);
  assert.equal(snapshot.backends[0].requests.total, 0);
  await exchange(instance, "/auth/ok");
  assert.ok(held); held.end("old response");
  assert.equal((await pending).body, "old response");
  snapshot = instance.getMetrics().pools[0];
  assertSettled(snapshot, 2);
  assert.equal(snapshot.backends.length, 1);
  assert.equal(snapshot.backends[0].id, newId);
  assertSettled(snapshot.backends[0], 1);
  auth.remove(server);
  assert.equal(instance.getMetrics().pools[0].backends.length, 0);
  // Repeated configuration churn retains no retired rows or stale counters.
  for (let index = 0; index < 100; index++) {
    auth.add(new Server(url));
    const current = auth.getBackendRegistrations()[0].server;
    await exchange(instance, "/auth/ok");
    auth.remove(current);
    assert.equal(instance.getMetrics().pools[0].backends.length, 0);
  }
  assertSettled(instance.getMetrics(), 102);
});

test("Fixed histograms have deterministic bounds, empty values and bounded memory", () => {
  const histogram = new LatencyHistogram();
  const empty = histogram.snapshot();
  assert.equal(empty.count, 0);
  assert.equal(empty.averageMs, 0);
  assert.equal(empty.minMs, 0);
  assert.equal(empty.maxMs, 0);
  assert.equal(empty.p99Ms, 0);
  assert.equal(empty.buckets.length, 21);
  for (const value of [0, 1, 2, 4, 8, 11, 26, 101, 1_000_000_000]) histogram.record(value);
  const snapshot = histogram.snapshot();
  assert.equal(snapshot.count, 9);
  assert.equal(snapshot.p50Ms, 10);
  assert.equal(snapshot.p95Ms, 1_000_000_000);
  assert.equal(snapshot.p99Ms, 1_000_000_000);
  for (let index = 0; index < 100_000; index++) histogram.record(index % 100);
  assert.equal(histogram.snapshot().count, 100_009);
  assert.equal(histogram.snapshot().buckets.length, 21);
  assert.equal(histogram.snapshot().buckets.reduce((sum, bucket) => sum + bucket.count, 0), 100_009);
  assert.equal(empty.count, 0);
  const extreme = new LatencyHistogram();
  extreme.record(Infinity); extreme.record(Number.MAX_VALUE); extreme.record(-1); extreme.record(NaN);
  assert.equal(extreme.snapshot().maxMs, Number.MAX_SAFE_INTEGER);
  assert.equal(extreme.snapshot().minMs, 0);
  assert.equal(extreme.snapshot().count, 3);
  assert.ok(Number.isFinite(extreme.snapshot().averageMs));
  assert.equal(extreme.snapshot().buckets[20].upperBoundMs, null);
});

test("Monotonic end-to-end latency includes streaming; upstream headers have a separate duration", limits, async (t) => {
  let now = 10;
  t.mock.method(performance, "now", () => now);
  t.mock.method(Date, "now", () => -1000);
  let pending: ServerResponse | undefined;
  let first = false;
  const url = await backend(t, (_req, res) => { pending = res; });
  const instance = await start(t, { pools: [pool("/", url)] });
  const result = new Promise<string>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); first = true; });
      res.on("error", reject); res.on("end", () => resolve(body));
    });
    req.on("error", reject); req.end();
  });
  await until(() => pending !== undefined);
  assert.ok(pending);
  now = 40; pending.write("first");
  await until(() => first);
  assert.equal(instance.getMetrics().requests.active, 1);
  assert.equal(instance.getMetrics().latency.count, 0);
  now = 160; pending.end("second");
  assert.equal(await result, "firstsecond");
  const snapshot = instance.getMetrics();
  for (const group of [snapshot, snapshot.pools[0], snapshot.pools[0].backends[0]]) {
    assert.equal(group.latency.averageMs, 150);
    assert.equal(group.latency.minMs, 150);
    assert.equal(group.latency.maxMs, 150);
    assert.equal(group.upstreamHeadersLatency.averageMs, 30);
    assert.ok(group.latency.minMs <= group.latency.p50Ms);
    assert.ok(group.latency.p50Ms <= group.latency.p95Ms);
    assert.ok(group.latency.p95Ms <= group.latency.p99Ms);
    assert.ok(group.latency.p99Ms <= group.latency.maxMs);
  }
});

for (const failure of ["connection", "protocol"]) {
  test(`Upstream ${failure} failure is counted once with a completed local 502`, limits, async (t) => {
    const url = await backend(t, (req) => {
      if (failure === "connection") req.socket.destroy();
      else req.socket.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
    });
    const instance = await start(t, { pools: [pool("/", url)] });
    assert.equal((await exchange(instance)).status, 502);
    await nextTurn();
    const snapshot = instance.getMetrics();
    for (const group of [snapshot, snapshot.pools[0], snapshot.pools[0].backends[0]]) {
      assertSettled(group, 1);
      assert.equal(group.requests.completed, 0);
      assert.equal(group.requests.failed, 1);
      assert.equal(group.requests.upstreamFailures, 1);
      assert.equal(group.requests.upstreamTimeouts, 0);
      assert.equal(group.responses.loadPilot.status5xx, 1);
      assert.equal(group.responses.backend.status5xx, 0);
      assert.equal(group.responses.completed, 1);
    }
  });
}

test("Upstream timeout produces one failed exchange and local 504 despite subsequent errors", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let received = false;
  const url = await backend(t, () => { received = true; });
  const instance = await start(t, { upstreamTimeoutMs: 100, pools: [pool("/", url)] });
  const result = exchange(instance);
  await until(() => received);
  t.mock.timers.tick(100);
  assert.equal((await result).status, 504);
  await nextTurn(); await nextTurn();
  const snapshot = instance.getMetrics();
  for (const group of [snapshot, snapshot.pools[0], snapshot.pools[0].backends[0]]) {
    assertSettled(group, 1);
    assert.equal(group.requests.failed, 1);
    assert.equal(group.requests.upstreamTimeouts, 1);
    assert.equal(group.requests.upstreamFailures, 0);
    assert.equal(group.requests.cancelled, 0);
    assert.equal(group.responses.loadPilot.status5xx, 1);
  }
});

for (const failure of ["truncated", "timeout"]) {
  test(`A ${failure} response after headers is incomplete, without a fabricated final status`, limits, async (t) => {
    if (failure === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    let pending: ServerResponse | undefined;
    let first = false;
    const url = await backend(t, (_req, res) => {
      pending = res;
      res.writeHead(200, { "content-length": "100" }); res.write("partial");
    });
    const instance = await start(t, { upstreamTimeoutMs: 100, pools: [pool("/", url)] });
    const result = new Promise<void>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, agent: false }, (res) => {
        assert.equal(res.statusCode, 200);
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); first = true; });
        res.on("error", () => { assert.equal(body, "partial"); resolve(); });
        res.on("end", () => reject(new Error("Incomplete response ended successfully")));
      });
      req.on("error", reject); req.end();
    });
    await until(() => first);
    assert.ok(pending);
    if (failure === "timeout") t.mock.timers.tick(100);
    else pending.destroy();
    await result;
    await until(() => instance.getMetrics().requests.active === 0);
    const snapshot = instance.getMetrics();
    for (const group of [snapshot, snapshot.pools[0], snapshot.pools[0].backends[0]]) {
      assertSettled(group, 1);
      assert.equal(group.requests.failed, 1);
      assert.equal(group.requests.upstreamFailures, failure === "truncated" ? 1 : 0);
      assert.equal(group.requests.upstreamTimeouts, failure === "timeout" ? 1 : 0);
      assert.equal(group.responses.completed, 0);
      assert.equal(group.responses.incomplete, 1);
      assert.equal(group.responses.status2xx, 0);
      assert.equal(group.responses.status5xx, 0);
      assert.equal(group.responses.backend.status2xx, 0);
      assert.equal(group.upstreamHeadersLatency.count, 1);
    }
  });
}

for (const cancellation of ["response", "upload"]) {
  test(`Client ${cancellation} cancellation settles all gauges once without transport failure`, limits, async (t) => {
    let received = false;
    let closed = false;
    const url = await backend(t, (req, res) => {
      res.once("close", () => { closed = true; });
      if (cancellation === "response") res.write("first");
      else { req.on("data", () => { received = true; }); req.on("error", () => { closed = true; }); }
    });
    const instance = await start(t, { pools: [pool("/", url)] });
    if (cancellation === "response") {
      await new Promise<void>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, agent: false }, (res) => {
          res.once("data", () => { res.destroy(); resolve(); }); res.on("error", reject);
        });
        req.on("error", reject); req.end();
      });
    } else {
      const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, method: "POST", agent: false });
      const failed = once(req, "error");
      req.write("unfinished upload");
      await until(() => received);
      req.destroy();
      await failed;
    }
    await until(() => closed && instance.getMetrics().requests.active === 0);
    await nextTurn();
    const snapshot = instance.getMetrics();
    for (const group of [snapshot, snapshot.pools[0], snapshot.pools[0].backends[0]]) {
      assertSettled(group, 1);
      assert.equal(group.requests.cancelled, 1);
      assert.equal(group.requests.clientCancelled, 1);
      assert.equal(group.requests.shutdownCancelled, 0);
      assert.equal(group.requests.failed, 0);
      assert.equal(group.requests.upstreamFailures, 0);
      assert.equal(group.responses.incomplete, 1);
    }
  });
}

test("Shutdown cancels active requests once; stop/start retains metrics and cumulative uptime", limits, async (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  let received = 0;
  const url = await backend(t, (req, res) => {
    if (req.url === "/ok") res.end("ok");
    else received++;
  });
  const instance = await start(t, { pools: [pool("/", url)] });
  const results = Promise.allSettled(Array.from({ length: 5 }, () => exchange(instance)));
  await until(() => received === 5);
  now = 200;
  await instance.stop();
  assert.ok((await results).every((result) => result.status === "rejected"));
  let snapshot = instance.getMetrics();
  assertSettled(snapshot, 5);
  assert.equal(snapshot.requests.shutdownCancelled, 5);
  assert.equal(snapshot.requests.clientCancelled, 0);
  assert.equal(snapshot.requests.failed, 0);
  assert.equal(snapshot.uptimeMs, 100);
  assertSettled(snapshot.pools[0].backends[0], 5);
  now = 900;
  assert.equal(instance.getMetrics().uptimeMs, 100);
  now = 1000;
  await instance.start();
  now = 1200;
  assert.equal((await exchange(instance, "/ok")).body, "ok");
  snapshot = instance.getMetrics();
  assertSettled(snapshot, 6);
  assert.equal(snapshot.requests.completed, 1);
  assert.equal(snapshot.requests.shutdownCancelled, 5);
  assert.equal(snapshot.uptimeMs, 300);
  now = 1300;
  await instance.stop();
  assert.equal(instance.getMetrics().uptimeMs, 400);
});

test("Instrumentation callback errors cannot change proxy completion or failure responses", limits, async (t) => {
  const upstream = await backend(t, (req, res) => {
    if (req.url === "/fail") req.socket.destroy();
    else res.end("unaltered");
  });
  const proxy = new HttpProxy(1000);
  t.after(() => proxy.close());
  const events: ProxyEvent["type"][] = [];
  const frontend = await backend(t, (req, res) => {
    proxy.forward(req, res, new Server(upstream), req.url ?? "/", "/", undefined, (event) => {
      events.push(event.type); throw new Error("instrumentation failed");
    });
  });
  const ok = await fetch(frontend);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "unaltered");
  const failure = await fetch(frontend + "/fail");
  assert.equal(failure.status, 502);
  assert.equal(await failure.text(), "Bad Gateway\n");
  assert.deepEqual(events, ["response", "completed", "failure"]);
});

test("Metrics setup failure is isolated from forwarding and diagnosed", limits, async (t) => {
  let snapshot: LoadPilotMetrics | undefined;
  const url = await backend(t, (_req, res) => {
    const collector = new MetricsCollector("Fault", true);
    const observer = t.mock.method(res, "once", () => { throw new Error("telemetry listener setup failure"); });
    assert.equal(collector.begin(res), undefined);
    observer.mock.restore();
    snapshot = collector.snapshot();
    res.end("ok");
  });
  assert.equal(await (await fetch(url)).text(), "ok");
  assert.ok(snapshot);
  assert.equal(snapshot.instrumentationErrors, 1);
  assertSettled(snapshot, 0);
});

for (const enabled of [false, true]) {
  test(`Bidirectional incremental streaming preserves bytes with metrics ${enabled ? "enabled" : "disabled"}`, limits, async (t) => {
    const url = await backend(t, (req, res) => { res.setHeader("content-type", "application/octet-stream"); req.pipe(res); });
    const instance = await start(t, { metrics: { enabled }, pools: [pool("/", url)] });
    let first = false;
    const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, method: "POST", agent: false });
    const result = new Promise<string>((resolve, reject) => {
      req.on("error", reject);
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => { chunks.push(chunk); first = true; });
        res.on("error", reject); res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      });
    });
    req.write("first ✓ ");
    await until(() => first);
    assert.equal(instance.getMetrics().requests.active, enabled ? 1 : 0);
    req.end("second 🚀");
    assert.equal(await result, "first ✓ second 🚀");
    assertSettled(instance.getMetrics(), enabled ? 1 : 0);
  });
}

test("Snapshots are deeply immutable and configured identities bound cardinality without private request data", limits, async (t) => {
  const url = await backend(t, (_req, res) => res.end("ok"));
  const instance = await start(t, { name: "Privacy", pools: [pool("/auth", url)] });
  const initial = instance.getMetrics();
  assert.equal(Reflect.set(initial.requests, "total", 999), false);
  assert.equal(Reflect.set(initial.pools[0].backends[0].requests, "active", 999), false);
  assert.equal(Reflect.set(initial.latency.buckets[0], "count", 999), false);
  assert.equal(Reflect.set(initial.pools[0].health, "successfulProbes", 999), false);
  assert.throws(() => Reflect.apply(Array.prototype.push, initial.pools, [{}]), TypeError);
  for (let index = 0; index < 50; index++) {
    await exchange(instance, `/auth/user-private-${index}?token=query-private-${index}`, {
      host: `host-private-${index}.example`, authorization: "Bearer header-private", cookie: "session=cookie-private",
    });
  }
  const snapshot = instance.getMetrics();
  assertSettled(snapshot, 50);
  assert.equal(initial.requests.total, 0);
  assert.equal(snapshot.pools.length, 1);
  assert.equal(snapshot.pools[0].backends.length, 1);
  assert.equal(snapshot.latency.buckets.length, 21);
  assert.equal(snapshot.responses.status1xx, 0);
  assert.ok(!JSON.stringify(snapshot).includes("private"));
});

test("Independent instances and a shared pool isolate request metrics without resetting selection", limits, async (t) => {
  const a = await backend(t, (_req, res) => res.end("a"));
  const b = await backend(t, (_req, res) => res.end("b"));
  const auth = pool("/auth", a, b);
  const first = await start(t, { pools: [auth] });
  const second = await start(t, { pools: [auth] });
  assert.equal((await exchange(first, "/auth")).body, "a");
  assert.equal((await exchange(second, "/auth")).body, "b");
  assert.equal((await exchange(first, "/auth")).body, "a");
  assertSettled(first.getMetrics(), 2);
  assertSettled(second.getMetrics(), 1);
  assert.deepEqual(first.getMetrics().pools[0].backends.map((item) => item.requests.total), [2, 0]);
  assert.deepEqual(second.getMetrics().pools[0].backends.map((item) => item.requests.total), [0, 1]);
  const independent = await start(t, { pools: [pool("/auth", a, b)] });
  assert.equal((await exchange(independent, "/auth")).body, "a");
  assertSettled(independent.getMetrics(), 1);
});

test("Health outcomes, timeout subsets and state transitions reflect actual threshold changes", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let status = 200;
  let probes = 0;
  const url = await backend(t, (req, res) => {
    if (req.url === "/health") { probes++; res.writeHead(status); res.end(); }
    else res.end("application");
  });
  const auth = new ServerPool({ route: "/", servers: [new Server(url)], healthCheck: healthOptions() });
  const instance = await start(t, { pools: [auth] });
  assert.equal(backendHealth(instance).state, HealthState.UNKNOWN);
  assert.equal(backendHealth(instance).successfulProbes, 0);
  assert.equal(backendHealth(instance).lastProbeAt, null);
  t.mock.timers.tick(0);
  await until(() => backendHealth(instance).successfulProbes === 1);
  assert.equal(backendHealth(instance).healthyTransitions, 1);
  assert.equal(backendHealth(instance).unhealthyTransitions, 0);
  assert.ok(backendHealth(instance).lastProbeAt !== null);
  assert.ok(backendHealth(instance).lastStateChangeAt !== null);
  t.mock.timers.tick(1000);
  await until(() => backendHealth(instance).successfulProbes === 2);
  assert.equal(backendHealth(instance).healthyTransitions, 1);
  status = 503;
  t.mock.timers.tick(1000);
  await until(() => backendHealth(instance).failedProbes === 1);
  assert.equal(backendHealth(instance).state, HealthState.HEALTHY);
  assert.equal(backendHealth(instance).unhealthyTransitions, 0);
  t.mock.timers.tick(1000);
  await until(() => backendHealth(instance).failedProbes === 2);
  assert.equal(backendHealth(instance).state, HealthState.UNHEALTHY);
  assert.equal(backendHealth(instance).unhealthyTransitions, 1);
  assert.deepEqual(instance.getMetrics().pools[0].eligibility, {
    registered: 1, registrations: 1, healthy: 0, unhealthy: 1, unknown: 0, eligible: 0,
  });
  assert.equal((await exchange(instance)).status, 503);
  assert.equal(instance.getMetrics().requests.noEligibleBackend, 1);
  assert.equal(instance.getMetrics().pools[0].backends[0].requests.total, 0);
  t.mock.timers.tick(1000);
  await until(() => backendHealth(instance).failedProbes === 3);
  assert.equal(backendHealth(instance).unhealthyTransitions, 1);
  status = 200;
  t.mock.timers.tick(1000);
  await until(() => backendHealth(instance).successfulProbes === 3);
  assert.equal(backendHealth(instance).state, HealthState.UNHEALTHY);
  t.mock.timers.tick(1000);
  await until(() => backendHealth(instance).successfulProbes === 4);
  assert.equal(backendHealth(instance).state, HealthState.HEALTHY);
  assert.equal(backendHealth(instance).healthyTransitions, 2);
  assert.equal(backendHealth(instance).timeoutProbes, 0);
  assert.equal(probes, 7);
  const totals = instance.getMetrics().pools[0].health;
  assert.equal(totals.successfulProbes, 4);
  assert.equal(totals.failedProbes, 3);
  assert.equal(totals.healthyTransitions, 2);
  assert.equal(instance.getMetrics().requests.total, 1); // Probes are not client requests.
  await instance.stop();
  await instance.start();
  assert.equal(backendHealth(instance).state, HealthState.UNKNOWN);
  assert.equal(backendHealth(instance).unknownTransitions, 1);
  assert.equal(backendHealth(instance).successfulProbes, 4);
});

test("Health probe timeouts count once as failures and cancellations have no outcome", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending: ServerResponse[] = [];
  const url = await backend(t, (_req, res) => { pending.push(res); });
  const auth = new ServerPool({ route: "/", servers: [new Server(url)], healthCheck: healthOptions({ unhealthyThreshold: 1 }) });
  const instance = await start(t, { pools: [auth] });
  t.mock.timers.tick(0);
  await until(() => pending.length === 1);
  t.mock.timers.tick(200);
  assert.equal(backendHealth(instance).failedProbes, 1);
  assert.equal(backendHealth(instance).timeoutProbes, 1);
  assert.equal(backendHealth(instance).unhealthyTransitions, 1);
  await nextTurn();
  assert.equal(instance.getMetrics().pools[0].health.failedProbes, 1);
  t.mock.timers.tick(1000);
  await until(() => pending.length === 2);
  await instance.stop();
  pending[1].writeHead(503); pending[1].end();
  t.mock.timers.tick(100_000);
  await nextTurn();
  assert.equal(backendHealth(instance).failedProbes, 1);
  assert.equal(backendHealth(instance).timeoutProbes, 1);
  assertSettled(instance.getMetrics(), 0);
});

test("Removed health records reject stale outcomes while pool health totals remain bounded lifetime counters", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending: ServerResponse[] = [];
  const url = await backend(t, (_req, res) => { pending.push(res); });
  const server = new Server(url);
  const auth = new ServerPool({ route: "/", servers: [server], healthCheck: healthOptions({ unhealthyThreshold: 1 }) });
  const instance = await start(t, { pools: [auth] });
  t.mock.timers.tick(0);
  await until(() => pending.length === 1);
  pending[0].end();
  await until(() => backendHealth(instance).successfulProbes === 1);
  const oldId = instance.getMetrics().pools[0].backends[0].id;
  t.mock.timers.tick(1000);
  await until(() => pending.length === 2);
  auth.remove(server);
  pending[1].writeHead(503); pending[1].end();
  await nextTurn();
  assert.equal(instance.getMetrics().pools[0].health.successfulProbes, 1);
  assert.equal(instance.getMetrics().pools[0].health.failedProbes, 0);
  assert.equal(instance.getMetrics().pools[0].backends.length, 0);
  auth.add(server);
  assert.notEqual(instance.getMetrics().pools[0].backends[0].id, oldId);
  assert.equal(backendHealth(instance).successfulProbes, 0);
  assert.equal(backendHealth(instance).state, HealthState.UNKNOWN);
  t.mock.timers.tick(0);
  await until(() => pending.length === 3);
  pending[2].end();
  await until(() => backendHealth(instance).successfulProbes === 1);
  assert.equal(instance.getMetrics().pools[0].health.successfulProbes, 2);
  assert.equal(instance.getMetrics().pools[0].health.healthyTransitions, 2);
});

test("Metrics snapshots do not start probes and disabled health has no artificial outcomes", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  const url = await backend(t, (_req, res) => { probes++; res.end(); });
  const monitored = new ServerPool({ route: "/", servers: [new Server(url)], healthCheck: healthOptions() });
  const notStarted = new LoadPilot({ name: "NotStarted", port: 0, pools: [monitored], metrics: { enabled: true } });
  for (let index = 0; index < 10; index++) assert.equal(notStarted.getMetrics().pools[0].health.successfulProbes, 0);
  t.mock.timers.tick(10_000);
  await nextTurn();
  assert.equal(probes, 0);
  const instance = await start(t, { pools: [pool("/", url)] });
  t.mock.timers.tick(10_000);
  await nextTurn();
  const snapshot = instance.getMetrics();
  assert.equal(snapshot.pools[0].health.enabled, false);
  assert.equal(snapshot.pools[0].health.successfulProbes, 0);
  assert.equal(snapshot.pools[0].health.failedProbes, 0);
  assert.equal(snapshot.pools[0].eligibility.unknown, 1);
  assert.equal(snapshot.pools[0].eligibility.healthy, 0);
  assert.equal(snapshot.pools[0].eligibility.eligible, 1);
  assert.equal(probes, 0);
});

test("Health collection begins at the first opt-in without manufacturing historical probes", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  const url = await backend(t, (req, res) => { if (req.url === "/health") probes++; res.end(); });
  const auth = new ServerPool({ route: "/", servers: [new Server(url)], healthCheck: healthOptions() });
  const disabled = await start(t, { pools: [auth], metrics: { enabled: false } });
  t.mock.timers.tick(0);
  await until(() => auth.getHealthStatus()[0].state === HealthState.HEALTHY);
  assert.equal(backendHealth(disabled).successfulProbes, 0);
  assert.equal(disabled.getMetrics().pools[0].health.collecting, false);
  const enabled = await start(t, { pools: [auth] });
  assert.equal(backendHealth(enabled).successfulProbes, 0);
  assert.equal(backendHealth(enabled).healthyTransitions, 0);
  t.mock.timers.tick(1000);
  await until(() => backendHealth(enabled).successfulProbes === 1);
  assert.equal(probes, 2);
  assert.equal(backendHealth(enabled).healthyTransitions, 0);
  assert.equal(backendHealth(disabled).successfulProbes, 1); // Shared monitor view.
  assert.equal(disabled.getMetrics().requests.total, 0);
});

test("Shared health statistics count actual probes once while per-instance traffic remains independent", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probes = 0;
  const url = await backend(t, (req, res) => { if (req.url === "/health") probes++; res.end("ok"); });
  const auth = new ServerPool({ route: "/", servers: [new Server(url)], healthCheck: healthOptions() });
  const first = await start(t, { pools: [auth] });
  const second = await start(t, { pools: [auth] });
  t.mock.timers.tick(0);
  await until(() => backendHealth(first).successfulProbes === 1);
  await exchange(first); await exchange(first); await exchange(second);
  assert.equal(probes, 1);
  assert.equal(backendHealth(first).successfulProbes, 1);
  assert.equal(backendHealth(second).successfulProbes, 1);
  assertSettled(first.getMetrics(), 2);
  assertSettled(second.getMetrics(), 1);
  await first.stop();
  t.mock.timers.tick(1000);
  await until(() => backendHealth(second).successfulProbes === 2);
  assert.equal(probes, 2);
  assert.equal(backendHealth(first).successfulProbes, 2);
  assert.equal(first.getMetrics().requests.total, 2);
  await second.stop();
  t.mock.timers.tick(100_000);
  await nextTurn();
  assert.equal(probes, 2);
});

test("Separate pool monitors keep health counters independent for the same Server object", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const url = await backend(t, (req, res) => { res.writeHead(req.url === "/bad" ? 503 : 200); res.end(); });
  const server = new Server(url);
  const a = new ServerPool({ route: "/a", servers: [server], healthCheck: healthOptions({ path: "/good" }) });
  const b = new ServerPool({ route: "/b", servers: [server], healthCheck: healthOptions({ path: "/bad", unhealthyThreshold: 1 }) });
  const instance = await start(t, { pools: [a, b] });
  t.mock.timers.tick(0);
  await until(() => a.getHealthStatus()[0].state === HealthState.HEALTHY && b.getHealthStatus()[0].state === HealthState.UNHEALTHY);
  const snapshot = instance.getMetrics();
  assert.equal(snapshot.pools[0].health.successfulProbes, 1);
  assert.equal(snapshot.pools[0].health.failedProbes, 0);
  assert.equal(snapshot.pools[1].health.successfulProbes, 0);
  assert.equal(snapshot.pools[1].health.failedProbes, 1);
  assertSettled(snapshot, 0);
});

test("A failed histogram update cannot fail forwarding or strand active gauges", limits, async (t) => {
  const url = await backend(t, (_req, res) => res.end("unchanged"));
  const instance = await start(t, { pools: [pool("/", url)] });
  t.mock.method(LatencyHistogram.prototype, "record", () => { throw new Error("instrumentation fault"); });
  assert.equal((await exchange(instance)).body, "unchanged");
  const snapshot = instance.getMetrics();
  assert.ok(snapshot.instrumentationErrors > 0);
  for (const group of [snapshot, snapshot.pools[0], snapshot.pools[0].backends[0]]) {
    assert.equal(group.requests.active, 0);
    assert.equal(group.requests.total, 1);
    assert.equal(group.requests.completed, 1);
    assert.equal(group.responses.completed, 1);
  }
});

test("Metrics introduce no periodic work that keeps a stopped process alive", limits, async (t) => {
  const source = `import {LoadPilot} from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
    const pilot = new LoadPilot({name:'ProcessExit',port:0,metrics:{enabled:true}});
    await pilot.start(); const res = await fetch('http://127.0.0.1:'+pilot.port+'/missing');
    await res.text(); await pilot.stop();
    if(pilot.getMetrics().requests.active!==0) throw new Error('active leak');`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "pipe"], timeout: 5000, windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
});

test("Enabled metrics preserve a large streamed payload and native backpressure", limits, async (t) => {
  const url = await backend(t, (req, res) => req.pipe(res));
  const instance = await start(t, { pools: [pool("/", url)] });
  const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, method: "POST", agent: false });
  const result = new Promise<number>((resolve, reject) => {
    req.on("error", reject);
    req.on("response", (res) => {
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        assert.ok(chunk.every((byte) => byte === 97));
      });
      res.on("error", reject); res.on("end", () => resolve(bytes));
    });
  });
  const chunk = Buffer.alloc(64 * 1024, 97);
  for (let index = 0; index < 64; index++) {
    if (!req.write(chunk)) await once(req, "drain");
  }
  req.end();
  assert.equal(await result, 4 * 1024 * 1024);
  assertSettled(instance.getMetrics(), 1);
  assertSettled(instance.getMetrics().pools[0].backends[0], 1);
});

test("Health transitions are observable without cancelling an active measured stream", limits, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let healthy = true;
  let pending: ServerResponse | undefined;
  let first = false;
  const url = await backend(t, (req, res) => {
    if (req.url === "/health") { res.writeHead(healthy ? 204 : 503); res.end(); }
    else { pending = res; res.write("first"); }
  });
  const auth = new ServerPool({ route: "/", servers: [new Server(url)], healthCheck: healthOptions({ unhealthyThreshold: 1 }) });
  const instance = await start(t, { pools: [auth] });
  t.mock.timers.tick(0);
  await until(() => backendHealth(instance).state === HealthState.HEALTHY);
  const result = new Promise<string>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: instance.port ?? 0, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); first = true; });
      res.on("error", reject); res.on("end", () => resolve(body));
    });
    req.on("error", reject); req.end();
  });
  await until(() => first);
  healthy = false;
  t.mock.timers.tick(1000);
  await until(() => backendHealth(instance).state === HealthState.UNHEALTHY);
  assert.equal(instance.getMetrics().requests.active, 1);
  assert.equal(backendHealth(instance).unhealthyTransitions, 1);
  assert.equal((await exchange(instance)).status, 503);
  assert.ok(pending && !pending.destroyed);
  pending.end("second");
  assert.equal(await result, "firstsecond");
  const snapshot = instance.getMetrics();
  assertSettled(snapshot, 2);
  assert.equal(snapshot.requests.completed, 2);
  assert.equal(snapshot.requests.noEligibleBackend, 1);
  assert.equal(snapshot.requests.cancelled, 0);
  assertSettled(snapshot.pools[0].backends[0], 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { LoadPilot, Server, ServerPool, type StopOptions } from "../src/index.js";
import { HttpProxy } from "../src/proxy/HttpProxy.js";
import { backend, exchange, open, pool, start, signal, until, settled, limits } from "./helpers/network.js";

test("Stop validates options even when stopped; default remains immediate", async () => {
  const pilot = new LoadPilot({ name: "Validation", port: 0 });
  for (const options of [null, false, 1, [], {}, { mode: "bad" }, { mode: "immediate", timeoutMs: 1 },
    { mode: "graceful", extra: true }, ...[0, -1, 0.5, NaN, Infinity, 300001, "100"].map((timeoutMs) => ({ mode: "graceful", timeoutMs }))]) {
    await assert.rejects(pilot.stop(options as StopOptions), /stop|mode|timeoutMs/);
  }
  await pilot.stop(); await pilot.stop({ mode: "graceful" });
  assert.equal(pilot.getStatus().state, "stopped"); assert.ok(Object.isFrozen(pilot.getStatus()));
});

for (const enabled of [false, true]) test(`Empty graceful stop and restart work with metrics ${enabled}`, limits, async (t) => {
  const upstream = await backend(t, (_req, res) => res.end("ok"));
  const pilot = await start(t, { pools: [pool(upstream.url)], metrics: { enabled } });
  assert.equal((await exchange(pilot)).status, 200);
  await pilot.stop({ mode: "graceful" });
  assert.deepEqual({ active: pilot.getStatus().activeRequests, sockets: pilot.getStatus().connections }, { active: 0, sockets: 0 });
  await pilot.start(); assert.equal((await exchange(pilot)).body.toString(), "ok"); await pilot.stop();
});

test("Graceful stop preserves multiple admitted requests and shares one immutable shutdown", limits, async (t) => {
  const admitted = signal(), release = signal(); let requests = 0;
  const upstream = await backend(t, (_req, res) => { if (++requests === 3) admitted.resolve(); void release.promise.then(() => res.end("done")); });
  const pilot = await start(t, { pools: [pool(upstream.url)] });
  const pending = Promise.all(Array.from({ length: 3 }, () => exchange(pilot)));
  await admitted.promise;
  const first = pilot.stop({ mode: "graceful", timeoutMs: 2000 });
  assert.equal(pilot.getStatus().state, "draining");
  assert.equal(pilot.stop({ mode: "graceful", timeoutMs: 5000 }), first);
  await assert.rejects(pilot.start(), /draining/);
  assert.throws(() => pilot.addPool(new ServerPool({ route: "/new" })), /draining/);
  release.resolve(); const replies = await pending; assert.ok(replies.every((reply) => reply.body.toString() === "done")); await first;
  const metrics = pilot.getMetrics(); settled(metrics, 3); assert.equal(metrics.requests.completed, 3); assert.equal(metrics.requests.shutdownCancelled, 0);
});

test("Pipelined request observed during drain returns local 503 without selecting a backend", limits, async (t) => {
  const admitted = signal(), release = signal(); let backendRequests = 0;
  const a = await backend(t, (_req, res) => { backendRequests++; admitted.resolve(); void release.promise.then(() => res.end("first")); });
  const b = await backend(t, (_req, res) => { backendRequests++; res.end("second"); });
  const pilot = await start(t, { pools: [pool(a.url, b.url)] });
  const port = pilot.port!;
  const socket = connect(port, "127.0.0.1"); t.after(() => socket.destroy());
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  let response = ""; socket.on("data", (chunk) => { response += chunk.toString(); }); socket.on("error", () => {});
  await once(socket, "connect"); socket.write("GET /first HTTP/1.1\r\nHost: public.example\r\n\r\n"); await admitted.promise;
  const stopping = pilot.stop({ mode: "graceful", timeoutMs: 2000 });
  socket.write("GET /after HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n");
  await until(() => pilot.getMetrics().requests.total === 2);
  assert.equal(backendRequests, 1); release.resolve(); await closed; await stopping;
  assert.match(response, /first/); assert.match(response, /503 Service Unavailable/); assert.match(response, /connection: close/i);
  const metrics = pilot.getMetrics(); settled(metrics, 2); assert.equal(metrics.requests.drainingRejections, 1);
  assert.equal(metrics.requests.noEligibleBackend, 0); assert.equal(metrics.pools[0].requests.total, 1);
  await pilot.start(); assert.equal((await exchange(pilot)).body.toString(), "second");
});

test("Graceful drain allows an incremental upload to finish", limits, async (t) => {
  const received = signal(); let bytes = 0;
  const upstream = await backend(t, (req, res) => { req.on("data", (chunk: Buffer) => { bytes += chunk.length; received.resolve(); }); req.on("end", () => res.end(String(bytes))); });
  const pilot = await start(t, { pools: [pool(upstream.url)] });
  const client = open(pilot, { method: "POST", headers: { "content-length": 1048576 } });
  client.request.write(Buffer.alloc(65536, 97)); await received.promise;
  const stopping = pilot.stop({ mode: "graceful", timeoutMs: 5000 });
  for (let index = 1; index < 16; index++) if (!client.request.write(Buffer.alloc(65536, 97))) await once(client.request, "drain");
  client.request.end(); assert.equal((await client.promise).body.toString(), "1048576"); await stopping;
  assert.equal(pilot.getMetrics().requests.completed, 1); assert.equal(pilot.getMetrics().requests.shutdownCancelled, 0);
});

for (const chunked of [false, true]) test(`Graceful drain preserves paused ${chunked ? "chunked" : "fixed-length"} downloads`, limits, async (t) => {
  const paused = signal(), release = signal(); let resumed = false;
  const upstream = await backend(t, async (_req, res) => {
    if (!chunked) res.setHeader("content-length", 1048576);
    for (let index = 0; index < 16; index++) { if (!res.write(Buffer.alloc(65536, 97))) await once(res, "drain"); }
    res.end();
  });
  const pilot = await start(t, { pools: [pool(upstream.url)] });
  const pending = exchange(pilot, { onData: (_chunk, res) => {
    if (!resumed) { resumed = true; res.pause(); paused.resolve(); void release.promise.then(() => res.resume()); }
  } });
  await paused.promise; const stopping = pilot.stop({ mode: "graceful", timeoutMs: 5000 }); release.resolve();
  const result = await pending; assert.equal(result.body.length, 1048576); assert.ok(result.body.every((byte) => byte === 97)); await stopping;
  assert.equal(pilot.getMetrics().requests.shutdownCancelled, 0);
});

test("Upstream total deadline remains independent of a longer shutdown grace", limits, async (t) => {
  const admitted = signal(); const upstream = await backend(t, () => admitted.resolve());
  const pilot = await start(t, { upstreamTimeoutMs: 80, pools: [pool(upstream.url)] });
  const pending = exchange(pilot); await admitted.promise; const stopping = pilot.stop({ mode: "graceful", timeoutMs: 2000 });
  assert.equal((await pending).status, 504); await stopping;
  const metrics = pilot.getMetrics(); settled(metrics, 1); assert.equal(metrics.requests.upstreamTimeouts, 1); assert.equal(metrics.requests.shutdownCancelled, 0);
});

for (const mode of ["graceful", "immediate", "default"] as const) test(`${mode} shutdown cancels stalled requests once and permits real forwarding after restart`, limits, async (t) => {
  const admitted = signal(); let hold = true;
  const upstream = await backend(t, (_req, res) => { if (hold) admitted.resolve(); else res.end("restarted"); });
  const pilot = await start(t, { pools: [pool(upstream.url)] });
  const pending = exchange(pilot).then(() => false, () => true); await admitted.promise;
  const stopping = mode === "default" ? pilot.stop() : pilot.stop(mode === "graceful" ? { mode, timeoutMs: 40 } : { mode });
  if (mode === "graceful") assert.equal(pilot.stop({ mode: "graceful", timeoutMs: 300000 }), stopping);
  await stopping;
  assert.equal(await pending, true);
  const metrics = pilot.getMetrics(); settled(metrics, 1); assert.equal(metrics.requests.shutdownCancelled, 1); assert.equal(metrics.requests.failed, 0);
  assert.equal(pilot.getStatus().connections, 0); hold = false; await pilot.start(); assert.equal((await exchange(pilot)).body.toString(), "restarted");
});

test("Immediate escalation shares the pending graceful promise and does not double cancel", limits, async (t) => {
  const admitted = signal(); const upstream = await backend(t, () => admitted.resolve());
  const pilot = await start(t, { pools: [pool(upstream.url)] });
  const pending = exchange(pilot).then(() => false, () => true); await admitted.promise;
  const first = pilot.stop({ mode: "graceful", timeoutMs: 300000 });
  assert.equal(pilot.stop({ mode: "immediate" }), first); assert.equal(pilot.stop(), first);
  await first; assert.equal(await pending, true); await pilot.stop(); settled(pilot.getMetrics(), 1);
  assert.equal(pilot.getMetrics().requests.shutdownCancelled, 1);
});

test("Idle keep-alive and incomplete HTTP header connections cannot strand shutdown", limits, async (t) => {
  const upstream = await backend(t, (_req, res) => res.end("ok")); const pilot = await start(t, { pools: [pool(upstream.url)] });
  const agent = new Agent({ keepAlive: true }); t.after(() => agent.destroy()); await exchange(pilot, { agent });
  const socket = connect(pilot.port!, "127.0.0.1"); t.after(() => socket.destroy()); socket.on("error", () => {});
  await once(socket, "connect"); socket.write("GET / HTTP/1.1\r\nHost:"); await until(() => pilot.getStatus().connections >= 2);
  await pilot.stop({ mode: "graceful", timeoutMs: 1000 });
  assert.equal(pilot.getStatus().connections, 0); assert.equal(pilot.getStatus().activeRequests, 0);
});

test("Client cancellation during drain is not a shutdown cancellation", limits, async (t) => {
  const admitted = signal(); const upstream = await backend(t, () => admitted.resolve()); const pilot = await start(t, { pools: [pool(upstream.url)] });
  const client = open(pilot); const result = client.promise.catch(() => undefined); client.request.end(); await admitted.promise;
  const stopping = pilot.stop({ mode: "graceful", timeoutMs: 2000 }); client.request.destroy(); await result; await stopping;
  settled(pilot.getMetrics(), 1); assert.equal(pilot.getMetrics().requests.clientCancelled, 1); assert.equal(pilot.getMetrics().requests.shutdownCancelled, 0);
});

test("Backend removal during draining retains the selected stream and drops retired metrics", limits, async (t) => {
  const admitted = signal(), release = signal();
  const upstream = await backend(t, (_req, res) => { admitted.resolve(); void release.promise.then(() => res.end("original")); });
  const selected = new Server(upstream.url), servers = new ServerPool({ route: "/", servers: [selected] });
  const pilot = await start(t, { pools: [servers] }); const pending = exchange(pilot); await admitted.promise;
  const stopping = pilot.stop({ mode: "graceful", timeoutMs: 2000 }); assert.equal(servers.remove(selected), true);
  assert.equal(pilot.getMetrics().pools[0].backends[0].registered, false); release.resolve();
  assert.equal((await pending).body.toString(), "original"); await stopping; assert.equal(pilot.getMetrics().pools[0].backends.length, 0);
});

test("Listener bind failure releases lifecycle state and can be retried", limits, async (t) => {
  const blocker = createTcpServer(); blocker.listen(0, "127.0.0.1"); await once(blocker, "listening");
  const address = blocker.address(); assert.ok(address && typeof address !== "string");
  t.after(() => blocker.close());
  const upstream = await backend(t, (_req, res) => res.end("ok"));
  const pilot = new LoadPilot({ name: "Retry", host: "127.0.0.1", port: address.port, pools: [pool(upstream.url)] }); t.after(() => pilot.stop());
  await assert.rejects(pilot.start(), { code: "EADDRINUSE" }); assert.equal(pilot.getStatus().state, "stopped");
  await new Promise<void>((resolve) => blocker.close(() => resolve())); await pilot.start(); assert.equal((await exchange(pilot)).status, 200);
});

test("Grace expiration cancels an unfinished upload and a partial response without a second status", limits, async (t) => {
  for (const uploading of [false, true]) {
    const admitted = signal();
    const upstream = await backend(t, (req, res) => {
      if (uploading) req.on("data", () => admitted.resolve());
      else { res.writeHead(200, { "content-length": 1048576 }); res.write("partial"); admitted.resolve(); }
    });
    const pilot = await start(t, { pools: [pool(upstream.url)] }); let statuses = 0;
    const client = open(pilot, { method: uploading ? "POST" : "GET", headers: uploading ? { "content-length": 1048576 } : undefined,
      onResponse: (res) => { statuses++; assert.equal(res.statusCode, 200); } });
    const outcome = client.promise.then(() => false, () => true);
    if (uploading) client.request.write("partial"); else client.request.end();
    await admitted.promise;
    if (!uploading) await until(() => statuses === 1);
    await pilot.stop({ mode: "graceful", timeoutMs: 40 }); assert.equal(await outcome, true);
    assert.equal(statuses, uploading ? 0 : 1); settled(pilot.getMetrics(), 1);
    assert.equal(pilot.getMetrics().requests.shutdownCancelled, 1); assert.equal(pilot.getMetrics().responses.incomplete, 1);
  }
});

test("Queued upstream requests are cancelled and Agent queues release during forced drain", limits, async (t) => {
  const admitted = signal(); const upstream = await backend(t, () => admitted.resolve()); let connections = 0;
  upstream.server.on("connection", () => connections++);
  const pilot = await start(t, { pools: [pool(upstream.url)] });
  const proxy: unknown = Reflect.get(pilot, "proxy"); assert.ok(proxy instanceof HttpProxy);
  const agent: unknown = Reflect.get(proxy, "httpAgent"); assert.ok(agent instanceof Agent); agent.maxSockets = 1;
  const pending = Promise.allSettled(Array.from({ length: 3 }, () => exchange(pilot))); await admitted.promise;
  await until(() => Object.values(agent.requests).reduce((sum, requests) => sum + (requests?.length ?? 0), 0) === 2);
  await pilot.stop({ mode: "graceful", timeoutMs: 40 }); await pending;
  assert.equal(proxy.activeCount, 0); assert.equal(Object.values(agent.requests).reduce((sum, requests) => sum + (requests?.length ?? 0), 0), 0);
  assert.equal(pilot.getMetrics().requests.shutdownCancelled, 3); settled(pilot.getMetrics(), 3);
  assert.equal(connections, 1, "Cancelled queued work must not open replacement upstream TCP connections");
});

test("Backend failure during drain retains upstream-failure classification", limits, async (t) => {
  const admitted = signal(), release = signal(); const upstream = await backend(t, (req) => { admitted.resolve(); void release.promise.then(() => req.socket.destroy()); });
  const pilot = await start(t, { pools: [pool(upstream.url)] }); const pending = exchange(pilot); await admitted.promise;
  const stopping = pilot.stop({ mode: "graceful", timeoutMs: 2000 }); release.resolve(); assert.equal((await pending).status, 502); await stopping;
  const metrics = pilot.getMetrics(); settled(metrics, 1); assert.equal(metrics.requests.upstreamFailures, 1); assert.equal(metrics.requests.shutdownCancelled, 0);
});

test("Shutdown also releases Agent entries cancelled by a client before draining", limits, async (t) => {
  const admitted = signal(); const upstream = await backend(t, () => admitted.resolve());
  const pilot = await start(t, { pools: [pool(upstream.url)] });
  const proxy: unknown = Reflect.get(pilot, "proxy"); assert.ok(proxy instanceof HttpProxy);
  const agent: unknown = Reflect.get(proxy, "httpAgent"); assert.ok(agent instanceof Agent); agent.maxSockets = 1;
  const clients = Array.from({ length: 3 }, () => open(pilot));
  const pending = Promise.allSettled(clients.map((client) => client.promise)); clients.forEach((client) => client.request.end());
  await admitted.promise; await until(() => Object.values(agent.requests).reduce((sum, requests) => sum + (requests?.length ?? 0), 0) === 2);
  clients[1].request.destroy(); await until(() => pilot.getMetrics().requests.clientCancelled === 1);
  await pilot.stop({ mode: "graceful", timeoutMs: 40 }); await pending;
  assert.equal(Object.values(agent.requests).reduce((sum, requests) => sum + (requests?.length ?? 0), 0), 0);
  settled(pilot.getMetrics(), 3); assert.equal(pilot.getMetrics().requests.clientCancelled, 1); assert.equal(pilot.getMetrics().requests.shutdownCancelled, 2);
});

test("Response completion at a grace boundary settles exactly once", limits, async (t) => {
  const admitted = signal(); let complete = () => {};
  const upstream = await backend(t, (_req, res) => { complete = () => res.end("boundary"); admitted.resolve(); });
  const pilot = await start(t, { pools: [pool(upstream.url)] }); const pending = exchange(pilot).catch(() => undefined); await admitted.promise;
  const stopping = pilot.stop({ mode: "graceful", timeoutMs: 1 }); const timer = setTimeout(complete, 1); t.after(() => clearTimeout(timer));
  await pending; await stopping; const metrics = pilot.getMetrics(); settled(metrics, 1);
  assert.equal(metrics.requests.completed + metrics.requests.shutdownCancelled, 1); assert.equal(metrics.requests.failed, 0);
});

test("Repeated graceful cycles do not accumulate listener or exchange resources", limits, async (t) => {
  const upstream = await backend(t, (_req, res) => res.end("ok")); const pilot = await start(t, { pools: [pool(upstream.url)] });
  const listener: unknown = Reflect.get(pilot, "httpServer"); assert.ok(listener && typeof listener === "object" && "eventNames" in listener);
  const native = Reflect.get(pilot, "httpServer") as import("node:http").Server;
  const counts = () => Object.fromEntries(native.eventNames().map((name) => [String(name), native.listenerCount(name)]));
  const baseline = counts();
  for (let cycle = 0; cycle < 5; cycle++) {
    assert.equal((await exchange(pilot)).status, 200); await pilot.stop({ mode: "graceful", timeoutMs: 1000 });
    assert.equal(pilot.getStatus().activeRequests, 0); assert.equal(pilot.getStatus().connections, 0); assert.deepEqual(counts(), baseline);
    if (cycle < 4) await pilot.start();
  }
  settled(pilot.getMetrics(), 5);
});

test("Shared health leases survive one owner's drain; final shutdown cancels probes without failure", limits, async (t) => {
  const admitted = signal(), release = signal(), probeStarted = signal(), probeClosed = signal(); let stallProbe = false;
  const upstream = await backend(t, (req, res) => {
    if (req.url === "/health") {
      if (!stallProbe) res.end("ok"); else { probeStarted.resolve(); res.once("close", probeClosed.resolve); }
    } else if (req.url === "/hold") { admitted.resolve(); void release.promise.then(() => res.end("done")); }
    else res.end("ok");
  });
  const servers = new ServerPool({ route: "/", servers: [new Server(upstream.url)], healthCheck: { enabled: true, intervalMs: 20, timeoutMs: 2000, healthyThreshold: 1 } });
  const first = await start(t, { pools: [servers] }), second = await start(t, { pools: [servers] });
  await until(() => first.getMetrics().pools[0].eligibility.healthy === 1);
  const pending = exchange(first, { path: "/hold" }); await admitted.promise;
  const count = second.getMetrics().pools[0].health.successfulProbes;
  const stopping = first.stop({ mode: "graceful", timeoutMs: 2000 });
  await until(() => second.getMetrics().pools[0].health.successfulProbes > count);
  assert.equal((await exchange(second)).status, 200); release.resolve(); await pending; await stopping;
  assert.equal(servers.getHealthStatus()[0].state, "HEALTHY");
  stallProbe = true; await probeStarted.promise; const failures = second.getMetrics().pools[0].health.failedProbes;
  await second.stop({ mode: "graceful", timeoutMs: 1000 }); await probeClosed.promise;
  assert.equal(second.getMetrics().pools[0].health.failedProbes, failures); assert.equal(servers.getHealthStatus()[0].state, "HEALTHY");
  settled(first.getMetrics(), 1); settled(second.getMetrics(), 1);
});

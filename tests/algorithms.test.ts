import { test } from "node:test";
import assert from "node:assert/strict";
import { Algorithm, HealthState, Server, ServerPool } from "../src/index.js";
import { backend, exchange, limits, open, signal, start, until } from "./helpers/network.js";

const server = (port: number, weight = 1) => new Server(`http://127.0.0.1:${port}`, { weight });
const createPool = (algorithm: Algorithm, servers: Server[]) => new ServerPool({ route: "/", algorithm, servers });

test("All six algorithms are exported; invalid weight and algorithm configurations fail", () => {
  assert.equal(Object.values(Algorithm).length, 6);
  assert.equal(new Server("http://127.0.0.1:3001").weight, 1);
  for (const weight of [0, -1, 1.5, Infinity, NaN, 1_000_001]) assert.throws(() => server(3001, weight), /weight/);
  assert.throws(() => createPool("invalid" as Algorithm, []), /Unsupported/);
  for (const algorithm of Object.values(Algorithm)) {
    const empty = createPool(algorithm, []);
    assert.equal(empty.getNextServer(), null);
    const a = server(3001); empty.add(a);
    assert.equal(empty.getNextServer(), a);
    assert.equal(empty.remove(a), true);
    assert.equal(empty.getNextServer(), null);
  }
});

test("Smooth weighted round robin distributes 5:3:2 without an expanded array", () => {
  const [a, b, c] = [server(3001, 5), server(3002, 3), server(3003, 2)];
  const p = createPool(Algorithm.WEIGHTED_ROUND_ROBIN, [a, b, c]);
  const sequence = Array.from({ length: 100 }, () => p.getNextServer());
  assert.equal(sequence.filter(x => x === a).length, 50);
  assert.equal(sequence.filter(x => x === b).length, 30);
  assert.equal(sequence.filter(x => x === c).length, 20);
  for (let i = 0; i < 100; i += 10) assert.equal(sequence.slice(i, i + 10).filter(x => x === a).length, 5);
  assert.equal(p.remove(b), true);
  const remaining = Array.from({ length: 70 }, () => p.getNextServer());
  assert.equal(remaining.filter(x => x === a).length, 50);
  assert.equal(remaining.filter(x => x === c).length, 20);
  assert.equal(remaining.includes(b), false);
});

test("Weighted slot semantics and independent pool credits", () => {
  const [a, b] = [server(3001, 2), server(3002, 1)];
  const p = createPool(Algorithm.WEIGHTED_ROUND_ROBIN, [a, a, b]);
  const q = createPool(Algorithm.WEIGHTED_ROUND_ROBIN, [a, a, b]);
  const selections = Array.from({ length: 50 }, () => p.getNextServer());
  assert.equal(selections.filter(x => x === a).length, 40);
  assert.deepEqual(Array.from({ length: 50 }, () => q.getNextServer()), selections);
});

test("Random selects only eligible registration slots using deterministic random inputs", t => {
  const [a, b, c] = [server(3001), server(3002), server(3003)];
  const p = createPool(Algorithm.RANDOM, [a, b, c]);
  const random = t.mock.method(Math, "random", () => 0);
  assert.equal(p.getNextServer(), a);
  random.mock.mockImplementation(() => 0.99999);
  assert.equal(p.getNextServer(), a); // rotated candidate order: b, c, a
  random.mock.mockImplementation(() => 0.5);
  assert.equal(p.getNextServer(), c);
  p.remove(c);
  assert.notEqual(p.getNextServer(), c);
});

for (const algorithm of [Algorithm.LEAST_CONNECTIONS, Algorithm.WEIGHTED_LEAST_CONNECTIONS]) {
  test(`${algorithm}: reservations, idempotent completion and independent registration lifetime`, () => {
    const [a, b] = [server(3001), server(3002)];
    const p = createPool(algorithm, [a, b]);
    const q = createPool(algorithm, [a, b]);
    assert.equal(p.getNextServer(), a);
    const done = p.beginRequest(a)!;
    assert.equal(p.getNextServer(), b);
    assert.equal(p.getNextServer(), b);
    assert.equal(q.getNextServer(), a);
    assert.equal(p.remove(a), true); p.add(a);
    const fresh = p.beginRequest(a)!;
    done(); done(); // retired lifetime must not decrement the fresh reservation
    assert.equal(p.getNextServer(), b);
    fresh(); fresh();
    assert.equal(p.getNextServer(), a);
  });
}

test("Weighted Least Connections compares active load against capacity", () => {
  const [a, b] = [server(3001, 4), server(3002, 1)];
  const p = createPool(Algorithm.WEIGHTED_LEAST_CONNECTIONS, [a, b]);
  const releases = [p.beginRequest(a)!, p.beginRequest(a)!, p.beginRequest(b)!];
  assert.equal(p.getNextServer(), a); // 2/4 < 1/1
  releases.forEach(release => release());
});

test("Least Response Time learns cold backends, smooths samples, explores and ignores failed samples", () => {
  const [a, b] = [server(3001), server(3002)];
  const p = createPool(Algorithm.LEAST_RESPONSE_TIME, [a, b]);
  assert.equal(p.getNextServer(), a);
  p.beginRequest(a)!(100);
  assert.equal(p.getNextServer(), b);
  p.beginRequest(b)!(10);
  assert.equal(p.getNextServer(), b);
  p.beginRequest(b)!(400); // 0.2 * 400 + 0.8 * 10 = 88
  assert.equal(p.getNextServer(), b);
  p.beginRequest(b)!(400); // 150.4, now a is faster
  assert.equal(p.getNextServer(), a);
  p.beginRequest(a)!(); // failure: no latency update
  assert.equal(p.getNextServer(), a);
  const sequence = Array.from({ length: 32 }, () => p.getNextServer());
  assert.ok(sequence.includes(b), "periodic exploration must refresh old samples");
  p.remove(b); p.add(b);
  assert.equal(p.getNextServer(), b, "new registration must relearn its latency");
});

for (const algorithm of Object.values(Algorithm)) {
  test(`${algorithm}: live forwarding excludes unhealthy backends and handles empty eligibility`, limits, async t => {
    let healthyA = false, healthyB = true;
    const a = await backend(t, (req, res) => {
      if (req.url === "/health") { res.statusCode = healthyA ? 200 : 503; res.end(); }
      else res.end("a");
    });
    const b = await backend(t, (req, res) => {
      if (req.url === "/health") { res.statusCode = healthyB ? 200 : 503; res.end(); }
      else res.end("b");
    });
    const p = new ServerPool({ route: "/", algorithm, servers: [new Server(a.url, { weight: 2 }), new Server(b.url)],
      healthCheck: { enabled: true, intervalMs: 10, timeoutMs: 1000, unhealthyThreshold: 1, healthyThreshold: 1 } });
    const pilot = await start(t, { pools: [p], metrics: { enabled: false } });
    await until(() => p.getHealthStatus().some(item => item.state === HealthState.UNHEALTHY) &&
      p.getHealthStatus().some(item => item.state === HealthState.HEALTHY));
    for (let i = 0; i < 8; i++) assert.equal((await exchange(pilot)).body.toString(), "b");
    healthyB = false;
    await until(() => p.getHealthStatus().every(item => item.state === HealthState.UNHEALTHY));
    assert.equal((await exchange(pilot)).status, 503);
    healthyA = healthyB = true;
    await until(() => p.getHealthStatus().every(item => item.state === HealthState.HEALTHY));
    for (let i = 0; i < 8; i++) assert.equal((await exchange(pilot)).status, 200);
  });
}

for (const algorithm of [Algorithm.LEAST_CONNECTIONS, Algorithm.WEIGHTED_LEAST_CONNECTIONS]) {
  test(`${algorithm}: real exchanges count without metrics and release on client abort and shutdown`, limits, async t => {
    const entered = signal(), release = signal();
    const a = await backend(t, async (req, res) => {
      if (req.url === "/hold") { entered.resolve(); await release.promise; }
      if (!res.destroyed) res.end("a");
    });
    const b = await backend(t, (_req, res) => res.end("b"));
    const first = new Server(a.url), second = new Server(b.url);
    const p = createPool(algorithm, [first, second]);
    const pilot = await start(t, { pools: [p], metrics: { enabled: false } });
    const held = open(pilot, { path: "/hold" });
    const rejected = assert.rejects(held.promise); held.request.end();
    await entered.promise;
    assert.equal((await exchange(pilot)).body.toString(), "b");
    assert.equal((await exchange(pilot)).body.toString(), "b");
    held.request.destroy(); await rejected;
    await until(() => pilot.getStatus().activeRequests === 0);
    release.resolve();
    const seen = [p.getNextServer(), p.getNextServer()];
    assert.ok(seen.includes(first) && seen.includes(second), "cancelled reservation must release");
    await pilot.stop();
  });
}

test("Least Response Time uses real upstream headers and not optional metrics", limits, async t => {
  const a = await backend(t, (_req, res) => { setTimeout(() => res.end("slow"), 100); });
  const b = await backend(t, (_req, res) => res.end("fast"));
  const p = createPool(Algorithm.LEAST_RESPONSE_TIME, [new Server(a.url), new Server(b.url)]);
  const pilot = await start(t, { pools: [p], metrics: { enabled: false } });
  assert.equal((await exchange(pilot)).body.toString(), "slow");
  assert.equal((await exchange(pilot)).body.toString(), "fast");
  for (let i = 0; i < 5; i++) assert.equal((await exchange(pilot)).body.toString(), "fast");
});

test("Least Response Time does not continuously select a backend whose first exchange failed", () => {
  const [a, b] = [server(3001), server(3002)];
  const p = createPool(Algorithm.LEAST_RESPONSE_TIME, [a, b]);
  assert.equal(p.getNextServer(), a);
  p.beginRequest(a)!();
  assert.equal(p.getNextServer(), b);
  p.beginRequest(b)!(20);
  for (let i = 0; i < 10; i++) assert.equal(p.getNextServer(), b);
});

test("Least Connections releases failed, timed-out and forced-shutdown exchanges before restart", limits, async t => {
  const entered = signal();
  const a = await backend(t, (req, res) => {
    if (req.url === "/fail") { req.socket.destroy(); return; }
    if (req.url === "/timeout") return;
    if (req.url === "/hold") { entered.resolve(); return; }
    res.end("a");
  });
  const b = await backend(t, (_req, res) => res.end("b"));
  const p = createPool(Algorithm.LEAST_CONNECTIONS, [new Server(a.url), new Server(b.url)]);
  const pilot = await start(t, { pools: [p], metrics: { enabled: false }, upstreamTimeoutMs: 500 });
  assert.equal((await exchange(pilot, { path: "/fail" })).status, 502);
  assert.equal((await exchange(pilot)).body.toString(), "b");
  assert.equal((await exchange(pilot, { path: "/timeout" })).status, 504);
  assert.equal((await exchange(pilot)).body.toString(), "b");
  const held = open(pilot, { path: "/hold" });
  const rejected = assert.rejects(held.promise); held.request.end();
  await entered.promise;
  await pilot.stop(); await rejected;
  await pilot.start();
  assert.equal((await exchange(pilot)).body.toString(), "b");
  assert.equal((await exchange(pilot)).body.toString(), "a");
});

for (const algorithm of Object.values(Algorithm)) {
  test(`${algorithm}: empty pool and membership edits retain independent cursors`, () => {
    const a = server(3001), b = server(3002);
    const p = createPool(algorithm, [a, b]);
    const q = createPool(algorithm, [a, b]);
    p.getNextServer(); p.remove(a); p.remove(b);
    assert.equal(p.getNextServer(), null);
    p.add(a); assert.equal(p.getNextServer(), a);
    assert.ok([a, b].includes(q.getNextServer()!));
  });
}

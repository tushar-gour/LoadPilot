import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import { Agent as HttpsAgent } from "node:https";
import { generateKeyPairSync } from "node:crypto";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { LoadPilot, ServerPool, Server, type ListenerTlsOptions } from "../src/index.js";
import { HttpProxy } from "../src/proxy/HttpProxy.js";
import { backend, exchange, open, pool, start, signal, until, settled, fixtureTls, limits } from "./helpers/network.js";

for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "::1"]) test(`Explicit binding supports ${host} with dynamic ports`, limits, async (t) => {
  const upstream = await backend(t, (_req, res) => res.end("bound"));
  const pilot = new LoadPilot({ name: "Binding", host, port: 0, pools: [pool(upstream.url)] }); t.after(() => pilot.stop());
  try { await pilot.start(); } catch (error) {
    if (host === "::1" && error && typeof error === "object" && "code" in error && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(String(error.code))) { t.skip("IPv6 unavailable on this platform"); return; }
    throw error;
  }
  assert.ok(pilot.port); assert.equal(pilot.options.host, host);
  assert.equal((await exchange(pilot, { hostname: host === "0.0.0.0" ? "127.0.0.1" : host })).body.toString(), "bound");
});

for (const host of ["", "http://localhost", "127.0.0.1:80", "bad host", "bad/host", "[::1]", 1, null]) test(`Invalid bind configuration is rejected: ${String(host)}`, () => {
  assert.throws(() => new LoadPilot({ name: "Bind", port: 0, host: host as string }), /host/);
});

for (const value of [null, true, {}, { key: fixtureTls.key }, { cert: fixtureTls.cert }, { ...fixtureTls, rejectUnauthorized: false },
  { key: "", cert: fixtureTls.cert }, { key: fixtureTls.key, cert: "" }, { key: [], cert: fixtureTls.cert }, { key: fixtureTls.key, cert: [] },
  { key: Buffer.alloc(0), cert: fixtureTls.cert }, { key: fixtureTls.key, cert: [Buffer.alloc(0)] },
  { ...fixtureTls, minVersion: "TLSv1" }, { ...fixtureTls, maxVersion: "TLSv1.1" }, { ...fixtureTls, minVersion: "TLSv1.3", maxVersion: "TLSv1.2" },
  { key: "PRIVATE_SECRET_MARKER", cert: fixtureTls.cert, passphrase: "PASSPHRASE_SECRET_MARKER" }]) test("Invalid TLS configuration fails without serializing secret inputs", () => {
  assert.throws(() => new LoadPilot({ name: "TLS validation", port: 0, tls: value as ListenerTlsOptions }), (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, /tls/i); assert.doesNotMatch(String(error), /PRIVATE_SECRET_MARKER|PASSPHRASE_SECRET_MARKER|BEGIN.*PRIVATE KEY/); return true;
  });
});

test("Mismatched key and certificate are rejected with a sanitized error", () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey;
  assert.throws(() => new LoadPilot({ name: "Mismatched", port: 0, tls: { key, cert: fixtureTls.cert } }), /Invalid tls key\/certificate/);
});

test("HTTPS listener forwards GET and POST to HTTP, filters spoofing, and rewrites redirects", limits, async (t) => {
  const upstream = await backend(t, (req, res) => {
    if (req.url === "/internal/redirect") { res.writeHead(302, { location: "/internal/next" }); res.end(); return; }
    let body = ""; req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => res.end(JSON.stringify({ body, proto: req.headers["x-forwarded-proto"], host: req.headers.host, forwarded: req.headers.forwarded })));
  });
  const pilot = await start(t, { tls: fixtureTls, pools: [pool(upstream.url + "/internal")] });
  for (const method of ["GET", "POST"]) {
    const result = await exchange(pilot, { method, body: method === "POST" ? "secure-body" : undefined, headers: { "x-forwarded-proto": "http", forwarded: "for=spoofed" } });
    const value = JSON.parse(result.body.toString()); assert.equal(value.proto, "https"); assert.equal(value.body, method === "POST" ? "secure-body" : "");
    assert.equal(value.host, new URL(upstream.url).host); assert.equal(value.forwarded, undefined);
  }
  assert.equal((await exchange(pilot, { path: "/redirect" })).headers.location, "/next");
  assert.equal(pilot.getStatus().protocol, "https"); assert.equal("tls" in pilot.options, false);
  const diagnostics = JSON.stringify([pilot.options, pilot.getStatus(), pilot.getMetrics()]);
  assert.doesNotMatch(diagnostics, /BEGIN.*PRIVATE KEY|BEGIN CERTIFICATE/); assert.ok(Object.isFrozen(pilot.options));
});

test("HTTPS-to-HTTPS validates upstream certificates and retains health/metrics", limits, async (t) => {
  const upstream = await backend(t, (_req, res) => res.end("secure-upstream"), true);
  const untrusted = await start(t, { tls: fixtureTls, pools: [pool(upstream.url)] });
  assert.equal((await exchange(untrusted)).status, 502); await untrusted.stop();
  const original = getCACertificates("default"); setDefaultCACertificates([...original, fixtureTls.cert.toString()]); t.after(() => setDefaultCACertificates(original));
  const servers = new ServerPool({ route: "/", servers: [new Server(upstream.url)], healthCheck: { enabled: true, intervalMs: 20, timeoutMs: 500, healthyThreshold: 1 } });
  const pilot = await start(t, { tls: fixtureTls, pools: [servers] });
  await until(() => pilot.getMetrics().pools[0].eligibility.healthy === 1);
  assert.equal((await exchange(pilot)).body.toString(), "secure-upstream");
  await pilot.stop({ mode: "graceful" }); await pilot.start(); await until(() => pilot.getMetrics().pools[0].eligibility.healthy === 1); assert.equal((await exchange(pilot)).status, 200);
  settled(pilot.getMetrics(), 2); assert.equal(pilot.getMetrics().requests.shutdownCancelled, 0);
});

for (const version of ["TLSv1.2", "TLSv1.3"] as const) test(`HTTPS listener negotiates ${version}`, limits, async (t) => {
  const upstream = await backend(t, (_req, res) => res.end("ok")); const pilot = await start(t, { tls: fixtureTls, pools: [pool(upstream.url)] });
  assert.equal((await exchange(pilot, { minVersion: version, maxVersion: version })).status, 200);
});

test("HTTPS graceful drain preserves an active response and supports restart", limits, async (t) => {
  const admitted = signal(), release = signal(); let hold = true;
  const upstream = await backend(t, (_req, res) => { res.write("first"); admitted.resolve(); if (hold) void release.promise.then(() => res.end("last")); else res.end("last"); });
  const pilot = await start(t, { tls: fixtureTls, pools: [pool(upstream.url)] });
  const pending = exchange(pilot); await admitted.promise;
  const stopping = pilot.stop({ mode: "graceful", timeoutMs: 2000 }); release.resolve(); assert.equal((await pending).body.toString(), "firstlast"); await stopping;
  hold = false; await pilot.start(); assert.equal((await exchange(pilot)).body.toString(), "firstlast"); await pilot.stop();
  settled(pilot.getMetrics(), 2); assert.equal(pilot.getStatus().connections, 0);
});

test("Raw TLS handshake sockets do not escape graceful or immediate cleanup", limits, async (t) => {
  const pilot = await start(t, { tls: fixtureTls });
  for (const mode of ["graceful", "immediate"] as const) {
    const socket = connect(pilot.port!, "127.0.0.1"); t.after(() => socket.destroy()); socket.on("error", () => {});
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await once(socket, "connect"); await until(() => pilot.getStatus().connections === 1);
    await pilot.stop(mode === "graceful" ? { mode, timeoutMs: 1000 } : { mode }); await closed;
    assert.equal(pilot.getStatus().connections, 0); assert.equal(pilot.getStatus().activeRequests, 0);
    await pilot.start();
  }
});

test("HTTPS client verification rejects an incorrect listener identity", limits, async (t) => {
  const pilot = await start(t, { tls: fixtureTls });
  await assert.rejects(exchange(pilot, { servername: "wrong.example" }), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  assert.equal(pilot.getMetrics().requests.total, 0);
});

test("HTTPS partial response is cancelled only at grace expiry, with no replacement status", limits, async (t) => {
  const headers = signal(); let statuses = 0;
  const upstream = await backend(t, (_req, res) => { res.writeHead(200, { "content-length": 1048576 }); res.write("partial"); });
  const pilot = await start(t, { tls: fixtureTls, pools: [pool(upstream.url)] });
  const client = open(pilot, { onResponse: (res) => { assert.equal(res.statusCode, 200); statuses++; headers.resolve(); } });
  const result = client.promise.then(() => false, () => true); client.request.end(); await headers.promise;
  await pilot.stop({ mode: "graceful", timeoutMs: 40 }); assert.equal(await result, true); assert.equal(statuses, 1);
  settled(pilot.getMetrics(), 1); assert.equal(pilot.getMetrics().requests.shutdownCancelled, 1); assert.equal(pilot.getMetrics().responses.incomplete, 1);
});

test("HTTPS Agent queued requests close without new upstream connections after cancellation", limits, async (t) => {
  const original = getCACertificates("default"); setDefaultCACertificates([...original, fixtureTls.cert.toString()]); t.after(() => setDefaultCACertificates(original));
  const admitted = signal(); let connections = 0;
  const upstream = await backend(t, () => admitted.resolve(), true); upstream.server.on("connection", () => connections++);
  const pilot = await start(t, { tls: fixtureTls, pools: [pool(upstream.url)] });
  const proxy: unknown = Reflect.get(pilot, "proxy"); assert.ok(proxy instanceof HttpProxy);
  const agent: unknown = Reflect.get(proxy, "httpsAgent"); assert.ok(agent instanceof HttpsAgent); agent.maxSockets = 1;
  const pending = Promise.allSettled(Array.from({ length: 3 }, () => exchange(pilot))); await admitted.promise;
  await until(() => Object.values(agent.requests).reduce((sum, requests) => sum + (requests?.length ?? 0), 0) === 2);
  await pilot.stop({ mode: "graceful", timeoutMs: 40 }); await pending;
  assert.equal(Object.values(agent.requests).reduce((sum, requests) => sum + (requests?.length ?? 0), 0), 0);
  assert.equal(connections, 1); settled(pilot.getMetrics(), 3); assert.equal(pilot.getMetrics().requests.shutdownCancelled, 3);
});

test("HTTPS failed bind can be retried with real forwarding", limits, async (t) => {
  const occupied = await start(t, { tls: fixtureTls }); const port = occupied.port!;
  const upstream = await backend(t, (_req, res) => res.end("retry-ok"));
  const pilot = new LoadPilot({ name: "TLS bind retry", host: "127.0.0.1", port, tls: fixtureTls, pools: [pool(upstream.url)] });
  t.after(() => pilot.stop()); await assert.rejects(pilot.start(), { code: "EADDRINUSE" });
  assert.equal(pilot.getStatus().state, "stopped"); await occupied.stop();
  await pilot.start(); assert.equal((await exchange(pilot)).body.toString(), "retry-ok");
});

test("HTTPS client disconnect during drain remains a client cancellation", limits, async (t) => {
  const admitted = signal(); const upstream = await backend(t, () => admitted.resolve());
  const pilot = await start(t, { tls: fixtureTls, pools: [pool(upstream.url)] });
  const client = open(pilot); const result = client.promise.then(() => false, () => true); client.request.end(); await admitted.promise;
  const stopping = pilot.stop({ mode: "graceful", timeoutMs: 2000 }); client.request.destroy();
  assert.equal(await result, true); await stopping; settled(pilot.getMetrics(), 1);
  assert.equal(pilot.getMetrics().requests.clientCancelled, 1); assert.equal(pilot.getMetrics().requests.shutdownCancelled, 0);
});

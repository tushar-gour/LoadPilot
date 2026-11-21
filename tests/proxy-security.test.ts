import { test } from "node:test";
import assert from "node:assert/strict";
import { LoadPilot } from "../src/index.js";
import { ForwardedHeaders, validForwardedHost } from "../src/proxy/ForwardedHeaders.js";
import { backend, exchange, pool, start, limits, fixtureTls } from "./helpers/network.js";

for (const input of [null, true, "127.0.0.1", ["localhost"], ["*"], ["0.0.0.0/0"], ["::/0"], ["127.0.0.1/33"],
  ["::1/129"], ["127.0.0.1/1.5"], ["127.0.0.1/24/2"], ["127.0.0.1 "], ["fe80::1%lo"], Array(257).fill("127.0.0.1")]) {
  test(`Trust configuration rejects unsupported input ${JSON.stringify(input).slice(0, 65)}`, () => {
    assert.throws(() => new LoadPilot({ name: "Invalid trust", port: 0, trustedProxies: input as readonly string[] }), /trustedProxies/);
  });
}

test("Native trust matching covers IPv4, IPv6, CIDRs and mapped IPv4", () => {
  const policy = new ForwardedHeaders(["192.0.2.0/24", "2001:db8::/32", "::1"]);
  for (const address of ["192.0.2.42", "::ffff:192.0.2.42", "::ffff:c000:22a", "2001:db8::7", "::1"]) assert.equal(policy.isTrusted(address), true, address);
  for (const address of ["192.0.3.42", "2001:db9::7", "127.0.0.1", "bad", "fe80::1%lo"]) assert.equal(policy.isTrusted(address), false, address);
  const configured = ["127.0.0.1"]; const pilot = new LoadPilot({ name: "Frozen policy", port: 0, trustedProxies: configured });
  configured.push("10.0.0.1"); assert.deepEqual(pilot.options.trustedProxies, ["127.0.0.1"]); assert.ok(Object.isFrozen(pilot.options.trustedProxies));
});

test("Host metadata validation accepts authorities and discards injection/URL forms", () => {
  for (const host of ["public.example", "public.example:443", "localhost", "127.0.0.1:8080", "[::1]:443", "public.example."]) assert.equal(validForwardedHost(host), true, host);
  for (const host of ["", "bad host", "evil/a", "user@public.example", "https://public.example", "evil\\host", "evil,good", "public:65536", "public:0", "public\r\nx-injected: true", "bad..host", "[fe80::1%lo]", "a".repeat(261)]) assert.equal(validForwardedHost(host), false, host);
});

for (const secure of [false, true]) test(`Direct ${secure ? "HTTPS" : "HTTP"} discards supplied forwarding metadata`, limits, async (t) => {
  let seen: Record<string, unknown> = {};
  const upstream = await backend(t, (req, res) => { seen = req.headers; res.end("ok"); });
  const pilot = await start(t, { tls: secure ? fixtureTls : undefined, pools: [pool(upstream.url)] });
  await exchange(pilot, { headers: { host: "public.example:443", forwarded: "for=203.0.113.99;proto=https",
    "x-forwarded-for": "203.0.113.99", "x-forwarded-proto": secure ? "http" : "https", "x-forwarded-host": "attacker.invalid", "x-forwarded-port": "evil" } });
  assert.equal(seen["x-forwarded-proto"], secure ? "https" : "http"); assert.equal(seen["x-forwarded-for"], "127.0.0.1");
  assert.equal(seen["x-forwarded-host"], "public.example:443"); assert.equal(seen.forwarded, undefined); assert.equal(seen["x-forwarded-port"], undefined);
  assert.equal(seen.host, new URL(upstream.url).host);
});

test("Configured ranges do not trust an unrelated directly connected peer", limits, async (t) => {
  const upstream = await backend(t, (req, res) => res.end(JSON.stringify(req.headers)));
  const pilot = await start(t, { trustedProxies: ["192.0.2.0/24"], pools: [pool(upstream.url)] });
  const value = JSON.parse((await exchange(pilot, { headers: { "x-forwarded-for": "192.0.2.1", "x-forwarded-proto": "https", "x-forwarded-host": "evil.example" } })).body.toString());
  assert.equal(value["x-forwarded-for"], "127.0.0.1"); assert.equal(value["x-forwarded-proto"], "http"); assert.notEqual(value["x-forwarded-host"], "evil.example");
});

test("Explicit trusted ingress supplies validated protocol/host and right-bound client identity", limits, async (t) => {
  const upstream = await backend(t, (req, res) => res.end(JSON.stringify(req.headers)));
  const pilot = await start(t, { trustedProxies: ["127.0.0.1", "10.0.0.0/8"], pools: [pool(upstream.url)] });
  const value = JSON.parse((await exchange(pilot, { headers: { host: "internal.example", "x-forwarded-host": "public.example:443",
    "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.99, 198.51.100.8, 10.0.0.2", forwarded: "for=spoofed" } })).body.toString());
  assert.equal(value["x-forwarded-for"], "198.51.100.8"); assert.equal(value["x-forwarded-proto"], "https");
  assert.equal(value["x-forwarded-host"], "public.example:443"); assert.equal(value.host, new URL(upstream.url).host); assert.equal(value.forwarded, undefined);
});

for (const chain of ["garbage", "203.0.113.1,", "203.0.113.1:1234", '"203.0.113.1"', "fe80::1%lo", Array(17).fill("203.0.113.1").join(","), "1".repeat(1025)]) {
  test(`Trusted ingress discards malformed or oversized XFF (${chain.length} characters)`, limits, async (t) => {
    const upstream = await backend(t, (req, res) => res.end(String(req.headers["x-forwarded-for"])));
    const pilot = await start(t, { trustedProxies: ["127.0.0.1"], pools: [pool(upstream.url)] });
    assert.equal((await exchange(pilot, { headers: { "x-forwarded-for": chain } })).body.toString(), "127.0.0.1");
  });
}

for (const protocol of ["HTTPS", "ftp", "https,http", "javascript:alert(1)"]) {
  test(`Trusted ingress discards unsupported forwarded protocol ${protocol}`, limits, async (t) => {
    const upstream = await backend(t, (req, res) => res.end(String(req.headers["x-forwarded-proto"])));
    const pilot = await start(t, { trustedProxies: ["127.0.0.1"], pools: [pool(upstream.url)] });
    assert.equal((await exchange(pilot, { headers: { "x-forwarded-proto": protocol } })).body.toString(), "http");
  });
}

test("Malformed observed/forwarded hosts cannot inject upstream host or change redirect destinations", limits, async (t) => {
  let selectedHost: string | undefined, forwardedHost: unknown;
  const upstream = await backend(t, (req, res) => { selectedHost = req.headers.host; forwardedHost = req.headers["x-forwarded-host"]; res.writeHead(302, { location: "/internal/next" }); res.end(); });
  const pilot = await start(t, { route: "/gateway", trustedProxies: ["127.0.0.1"], pools: [pool(upstream.url + "/internal")] });
  for (const host of ["evil.example/path", "evil.example@other", "evil.example,other", "[::1]:70000"]) {
    const result = await exchange(pilot, { path: "/gateway/", headers: { host, "x-forwarded-host": host, "x-forwarded-proto": "https" } });
    assert.equal(result.headers.location, "/gateway/next"); assert.equal(selectedHost, new URL(upstream.url).host); assert.equal(forwardedHost, undefined);
  }
});

for (const host of [undefined, "::1"]) test(`Trusted forwarding works for ${host ? "IPv6" : "default/mapped IPv4"} peers`, limits, async (t) => {
  const upstream = await backend(t, (req, res) => res.end(String(req.headers["x-forwarded-for"])));
  let pilot: LoadPilot;
  try { pilot = await start(t, { host, trustedProxies: ["127.0.0.1", "::1"], pools: [pool(upstream.url)] }); }
  catch (error) {
    if (host && error && typeof error === "object" && "code" in error && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(String(error.code))) { t.skip("IPv6 unavailable"); return; }
    throw error;
  }
  assert.equal((await exchange(pilot, { hostname: host ?? "127.0.0.1", headers: { "x-forwarded-for": "2001:db8::7" } })).body.toString(), "2001:db8::7");
});

test("Malformed trusted forwarding on HTTPS falls back to encrypted connection metadata", limits, async (t) => {
  const upstream = await backend(t, (req, res) => res.end(JSON.stringify(req.headers)));
  const pilot = await start(t, { tls: fixtureTls, trustedProxies: ["127.0.0.1"], pools: [pool(upstream.url)] });
  const headers = JSON.parse((await exchange(pilot, { headers: { host: "public.example", "x-forwarded-proto": "ftp", "x-forwarded-host": "bad/host", "x-forwarded-for": "203.0.113.1:123" } })).body.toString());
  assert.equal(headers["x-forwarded-proto"], "https"); assert.equal(headers["x-forwarded-for"], "127.0.0.1"); assert.equal(headers["x-forwarded-host"], "public.example");
});

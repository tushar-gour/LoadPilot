// Run after build: imports package exports and generated declarations, not src.
import assert from "node:assert/strict";
import { createServer, get, Server as HttpServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { LoadPilot, ServerPool, Server, Algorithm, HealthState } from "loadpilot";
import type { LoadPilotOptions, HealthCheckOptions, LoadPilotMetrics } from "loadpilot";

const cert = await readFile(new URL("./fixtures/localhost-cert.pem", import.meta.url), "utf8");
const key = await readFile(new URL("./fixtures/localhost-key.pem", import.meta.url), "utf8");
const originalTrust = getCACertificates("default"); setDefaultCACertificates([...originalTrust, cert]);
const plain = createServer((_req, res) => res.end("consumer-ok"));
const secure = createSecureServer({ key, cert }, (_req, res) => res.end("consumer-ok"));
let pilot: LoadPilot | undefined;
try {
  plain.listen(0, "127.0.0.1"); await once(plain, "listening");
  secure.listen(0, "127.0.0.1"); await once(secure, "listening");
  const a = plain.address(), b = secure.address(); assert.ok(a && b && typeof a !== "string" && typeof b !== "string");
  const health: HealthCheckOptions = { enabled: true, intervalMs: 20, timeoutMs: 1000, healthyThreshold: 1 };
  const options: LoadPilotOptions = { name: "built-package", port: 0, metrics: { enabled: true }, pools: [
    new ServerPool({ route: "/http", algorithm: Algorithm.ROUND_ROBIN, servers: [new Server(`http://127.0.0.1:${a.port}`)], healthCheck: health }),
    new ServerPool({ route: "/tls", servers: [new Server(`https://localhost:${b.port}`)], healthCheck: health }),
  ] };
  pilot = new LoadPilot(options);
  const listener: unknown = Reflect.get(pilot, "httpServer"); assert.ok(listener instanceof HttpServer);
  const listen = listener.listen.bind(listener);
  listener.listen = function (...args: unknown[]) { assert.equal(typeof args[0], "number"); listen({ port: args[0] as number, host: "127.0.0.1" }); return this; };
  for (let cycle = 0; cycle < 2; cycle++) {
    await pilot.start(); const deadline = performance.now() + 5000;
    while (!pilot.getMetrics().pools.every((pool) => pool.eligibility.healthy === 1)) { assert.ok(performance.now() < deadline, "Health readiness deadline"); await sleep(10); }
    for (const route of ["http", "tls"]) await new Promise<void>((resolve, reject) => {
      const req = get(`http://127.0.0.1:${pilot!.port}/${route}/get`, (res) => {
        let body = ""; res.on("data", (chunk: Buffer) => { body += chunk; }); res.on("error", reject);
        res.on("end", () => { try { assert.equal(res.statusCode, 200); assert.equal(body, "consumer-ok"); resolve(); } catch (error) { reject(error); } });
      }); req.on("error", reject); req.setTimeout(5000, () => req.destroy(new Error("Consumer deadline")));
    });
    await pilot.stop(); const snapshot: LoadPilotMetrics = pilot.getMetrics();
    assert.equal(snapshot.requests.completed, (cycle + 1) * 2); assert.equal(snapshot.requests.active, 0);
    assert.equal(snapshot.instrumentationErrors, 0); assert.equal(HealthState.HEALTHY, "HEALTHY");
  }
  console.log(`Built ESM/types, HTTP/HTTPS, health, metrics and restart PASS: ${process.version} ${process.platform}`);
} finally {
  await pilot?.stop();
  await Promise.all([plain, secure].map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  setDefaultCACertificates(originalTrust);
}

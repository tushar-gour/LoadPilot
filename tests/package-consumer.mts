// Run after build: imports package exports and generated declarations, not src.
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { createServer as createSecureServer, get as secureGet } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { LoadPilot, ServerPool, Server, Algorithm, HealthState } from "loadpilot";
import type { LoadPilotOptions, HealthCheckOptions, LoadPilotMetrics, ListenerTlsOptions, StopOptions, LoadPilotStatus, ServerOptions } from "loadpilot";
const weight: ServerOptions = { weight: 2 };
for (const algorithm of Object.values(Algorithm)) {
  const server = new Server("http://127.0.0.1:3001", weight);
  assert.equal(new ServerPool({ route: "/", algorithm, servers: [server] }).getNextServer(), server);
}

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
  const tls: ListenerTlsOptions = { key, cert, minVersion: "TLSv1.2" };
  for (const protocol of ["http", "https"] as const) {
    const options: LoadPilotOptions = { name: "built-package", host: "127.0.0.1", port: 0, tls: protocol === "https" ? tls : undefined,
      trustedProxies: ["127.0.0.1/32"], metrics: { enabled: true }, pools: [
      new ServerPool({ route: "/http", algorithm: Algorithm.ROUND_ROBIN, servers: [new Server(`http://127.0.0.1:${a.port}`)], healthCheck: health }),
      new ServerPool({ route: "/tls", servers: [new Server(`https://localhost:${b.port}`)], healthCheck: health }),
    ] };
    pilot = new LoadPilot(options);
    for (let cycle = 0; cycle < 2; cycle++) {
      await pilot.start(); const deadline = performance.now() + 5000;
      const status: LoadPilotStatus = pilot.getStatus(); assert.equal(status.protocol, protocol); assert.equal(status.state, "started");
      assert.equal("tls" in pilot.options, false);
      while (!pilot.getMetrics().pools.every((pool) => pool.eligibility.healthy === 1)) { assert.ok(performance.now() < deadline, "Health readiness deadline"); await sleep(10); }
      for (const route of ["http", "tls"]) await new Promise<void>((resolve, reject) => {
        const request = protocol === "https" ? secureGet : get;
        const req = request(`${protocol}://localhost:${pilot!.port}/${route}/get`, { ca: cert }, (res) => {
          let body = ""; res.on("data", (chunk: Buffer) => { body += chunk; }); res.on("error", reject);
          res.on("end", () => { try { assert.equal(res.statusCode, 200); assert.equal(body, "consumer-ok"); resolve(); } catch (error) { reject(error); } });
        }); req.on("error", reject); req.setTimeout(5000, () => req.destroy(new Error("Consumer deadline")));
      });
      const stop: StopOptions = cycle === 0 ? { mode: "graceful", timeoutMs: 1000 } : { mode: "immediate" };
      await pilot.stop(stop); const snapshot: LoadPilotMetrics = pilot.getMetrics();
      assert.equal(snapshot.requests.completed, (cycle + 1) * 2); assert.equal(snapshot.requests.active, 0);
      assert.equal(snapshot.instrumentationErrors, 0); assert.equal(HealthState.HEALTHY, "HEALTHY");
      assert.equal(snapshot.requests.drainingRejections, 0); assert.equal(pilot.getStatus().connections, 0);
    }
  }
  console.log(`Built ESM/types, HTTP/HTTPS listeners and upstreams, health, metrics, both shutdown modes and restart PASS: ${process.version} ${process.platform}`);
} finally {
  await pilot?.stop();
  await Promise.all([plain, secure].map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  setDefaultCACertificates(originalTrust);
}

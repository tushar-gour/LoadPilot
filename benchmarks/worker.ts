import { Agent, Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { LoadPilot, ServerPool, Server, type StopOptions } from "../src/index.js";
import { BackendFixture } from "./fixtures/backend.js";
import { ResourceMonitor, unavailableState, heapDiagnostics } from "./helpers/resourceMonitor.js";
import { writeHeapSnapshot } from "node:v8";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { localTarget, runLoad } from "./helpers/loadGenerator.js";
import type { LoadOptions, ResourceState, WorkerConfig, WorkerInfo } from "./types.js";

const config: WorkerConfig = JSON.parse(process.argv[2] ?? "{}");
if (!["backend", "proxy", "client"].includes(config.role)) throw new Error("Invalid worker role");
const sockets = new Set<Socket>();
const exchanges = new Set<{ req: IncomingMessage; res: ServerResponse }>();
let acceptedConnections = 0, upstreamConnectionsCreated = 0, snapshots = 0;
const fixture = config.role === "backend" ? new BackendFixture(config.id ?? "backend-0") : undefined;
const pools = (config.pools ?? []).map((entry) => new ServerPool({ route: entry.route,
  servers: entry.urls.map((url) => { localTarget(url); return new Server(url); }),
  healthCheck: { enabled: config.health ?? false, intervalMs: 50, timeoutMs: 100, unhealthyThreshold: 2, healthyThreshold: 2 } }));
const pilot = config.role === "proxy" ? new LoadPilot({ name: "Benchmark", host: "127.0.0.1", port: 0, pools,
  metrics: { enabled: config.metrics ?? false }, upstreamTimeoutMs: config.upstreamTimeoutMs ?? 30_000 }) : undefined;

function property(object: unknown, name: string): unknown {
  return object && typeof object === "object" ? Reflect.get(object, name) : undefined;
}

const instrumentedAgents = new WeakSet<Agent>();
function instrumentAgents(): void {
  for (const name of ["httpAgent", "httpsAgent"]) {
    const agent = property(property(pilot, "proxy"), name);
    if (!(agent instanceof Agent)) throw new Error("Benchmark agent adapter needs updating");
    if (instrumentedAgents.has(agent)) continue;
    instrumentedAgents.add(agent);
    const create = agent.createConnection.bind(agent);
    agent.createConnection = function (...args) { upstreamConnectionsCreated++; return create(...args); };
    // Diagnostic-only control; production continues to use its configured Agent.
    if (config.upstreamKeepAlive !== undefined) Reflect.set(agent, "keepAlive", config.upstreamKeepAlive);
  }
}

if (pilot) {
  const listener: unknown = property(pilot, "httpServer");
  if (!(listener instanceof HttpServer)) throw new Error("Benchmark listener adapter needs updating");
  listener.on("connection", (socket) => { acceptedConnections++; sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  instrumentAgents();
  listener.on("request", (req, res) => {
    const exchange = { req, res }; exchanges.add(exchange);
    const done = () => exchanges.delete(exchange);
    res.once("finish", done); res.once("close", done);
  });
}

function state(): ResourceState {
  if (fixture) return { ...unavailableState(), activeRequests: fixture.responses.size,
    incomingSockets: Array.from(fixture.sockets).filter((socket) => !socket.destroyed).length };
  if (!pilot) return unavailableState();
  const proxy = property(pilot, "proxy"), active = property(proxy, "active");
  const agents = [property(proxy, "httpAgent"), property(proxy, "httpsAgent")];
  let busy = 0, idle = 0, pending = 0;
  for (const agent of agents) {
    if (!(agent instanceof Agent)) throw new Error("Benchmark agent adapter needs updating");
    busy += Object.values(agent.sockets).reduce((sum, list) => sum + (list?.filter((socket) => !socket.destroyed).length ?? 0), 0);
    idle += Object.values(agent.freeSockets).reduce((sum, list) => sum + (list?.filter((socket) => !socket.destroyed).length ?? 0), 0);
    pending += Object.values(agent.requests).reduce((sum, list) => sum + (list?.length ?? 0), 0);
  }
  const current = Array.from(exchanges).filter(({ res }) => !res.destroyed && !res.writableFinished);
  return { activeRequests: current.length, activeUpstreamExchanges: active instanceof Set ? active.size : null,
    incomingSockets: Array.from(sockets).filter((socket) => !socket.destroyed).length,
    upstreamBusySockets: busy, upstreamIdleSockets: idle,
    agentPendingRequests: pending, acceptedConnections, upstreamConnectionsCreated,
    bufferedRequestBytes: current.reduce((sum, item) => sum + item.req.readableLength, 0),
    bufferedResponseBytes: current.reduce((sum, item) => sum + item.res.writableLength, 0) };
}

let info: WorkerInfo = { role: config.role };
const initialized = (async () => {
  if (fixture) { info.url = await fixture.start(config.port); info.port = Number(new URL(info.url).port); }
  if (pilot) { await pilot.start(); info.port = pilot.port ?? undefined; info.url = `http://127.0.0.1:${pilot.port}`; }
})();
const monitor = new ResourceMonitor(state, config.sampleMs ?? 200);
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  closing ??= (async () => { await initialized; await pilot?.stop(); await fixture?.stop(); monitor.close(); })();
  return closing;
}

process.on("disconnect", () => { void close().catch((error: unknown) => { console.error(error); process.exitCode = 1; }); });
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || !("id" in message) || typeof message.id !== "number" ||
      !("command" in message) || typeof message.command !== "string") return;
  const { id, command } = message;
  const payload: unknown = "payload" in message ? message.payload : undefined;
  const execute = async (): Promise<unknown> => {
    await initialized;
    switch (command) {
      case "ready": return info;
      case "load": return runLoad(payload as LoadOptions);
      case "resources": return monitor.snapshot();
      case "resetResources": monitor.reset(); return true;
      case "state": return state();
      case "status": return pilot?.getStatus();
      case "diagnostics": {
        const resources = monitor.snapshot(), sample = resources.samples.at(-1)!;
        const listener = property(pilot, "httpServer"), collector = property(pilot, "metricsCollector");
        const active = property(collector, "active"), metrics = pilot?.getMetrics();
        return { sample, heap: heapDiagnostics(), rssMinusHeapTotal: sample.rss - sample.heapTotal,
          healthStates: metrics?.pools.flatMap((pool) => pool.backends.map((backend) => backend.health?.state ?? "UNKNOWN")) ?? [],
          resources: resources.activeResourceTypes,
          listeners: listener instanceof HttpServer ? Object.fromEntries(listener.eventNames().map((name) => [String(name), listener.listenerCount(name)])) : {},
          metricScopes: metrics ? { active: active instanceof Set ? active.size : -1,
            retiredActive: metrics.pools.flatMap((pool) => pool.backends).filter((backend) => !backend.registered).length,
            currentBackends: metrics.pools.reduce((sum, pool) => sum + pool.eligibility.registered, 0) } : null };
      }
      case "heapSnapshot": {
        if (config.role !== "proxy" || snapshots >= 2) throw new Error("At most two proxy-only snapshots per worker");
        const directory = resolve("benchmarks/results/heaps"); mkdirSync(directory, { recursive: true });
        return writeHeapSnapshot(resolve(directory, `synthetic-${process.pid}-${snapshots++}.heapsnapshot`));
      }
      case "metrics": return pilot?.getMetrics();
      case "stats": return fixture?.stats();
      case "resetStats": fixture?.reset(); return true;
      case "release": fixture?.release(); return true;
      case "health": fixture?.configure(payload as { status?: number; delayMs?: number; sequence?: number[] }); return true;
      case "stop": await pilot?.stop(payload as StopOptions | undefined); await fixture?.stop(); return state();
      case "start":
        if (pilot) { await pilot.start(); instrumentAgents(); info.url = `http://127.0.0.1:${pilot.port}`; info.port = pilot.port ?? undefined; }
        if (fixture) info.url = await fixture.start();
        return info;
      case "remove": {
        const server = pools[0]?.getBackendRegistrations()[0]?.server;
        return server ? pools[0].remove(server) : false;
      }
      case "add": {
        if (typeof payload !== "string") throw new Error("Expected local backend URL");
        localTarget(payload);
        pools[0]?.add(new Server(payload)); return true;
      }
      case "gc": if (typeof global.gc === "function") { global.gc(); return true; } return false;
      case "shutdown": await close(); return true;
      default: throw new Error(`Unknown fixture command: ${command}`);
    }
  };
  void execute().then((value) => {
    if (process.connected) process.send?.({ kind: "reply", id, ok: true, value });
  }, (error: unknown) => {
    if (process.connected) process.send?.({ kind: "reply", id, ok: false, error: error instanceof Error ? error.message : "Worker failure" });
  });
});

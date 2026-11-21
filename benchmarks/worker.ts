import { Agent, Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { LoadPilot, ServerPool, Server } from "../src/index.js";
import { BackendFixture } from "./fixtures/backend.js";
import { ResourceMonitor, unavailableState } from "./helpers/resourceMonitor.js";
import { localTarget, runLoad } from "./helpers/loadGenerator.js";
import type { LoadOptions, ResourceState, WorkerConfig, WorkerInfo } from "./types.js";

const config: WorkerConfig = JSON.parse(process.argv[2] ?? "{}");
if (!["backend", "proxy", "client"].includes(config.role)) throw new Error("Invalid worker role");
const sockets = new Set<Socket>();
const exchanges = new Set<{ req: IncomingMessage; res: ServerResponse }>();
const fixture = config.role === "backend" ? new BackendFixture(config.id ?? "backend-0") : undefined;
const pools = (config.pools ?? []).map((entry) => new ServerPool({ route: entry.route,
  servers: entry.urls.map((url) => { localTarget(url); return new Server(url); }),
  healthCheck: { enabled: config.health ?? false, intervalMs: 50, timeoutMs: 100, unhealthyThreshold: 2, healthyThreshold: 2 } }));
const pilot = config.role === "proxy" ? new LoadPilot({ name: "Benchmark", port: 0, pools,
  metrics: { enabled: config.metrics ?? false }, upstreamTimeoutMs: config.upstreamTimeoutMs ?? 30_000 }) : undefined;

function property(object: unknown, name: string): unknown {
  return object && typeof object === "object" ? Reflect.get(object, name) : undefined;
}

// Harness-only adapter: the public API currently has no bind-host option.
// Pin its existing native listener to loopback without changing production code.
if (pilot) {
  const listener: unknown = property(pilot, "httpServer");
  if (!(listener instanceof HttpServer)) throw new Error("Benchmark listener adapter needs updating");
  const listen = listener.listen.bind(listener);
  listener.listen = function (...args: unknown[]) {
    if (typeof args[0] !== "number") throw new Error("Unexpected listener invocation");
    listen({ port: args[0], host: "127.0.0.1" }); return this;
  };
  listener.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
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
  let busy = 0, idle = 0;
  for (const agent of agents) {
    if (!(agent instanceof Agent)) throw new Error("Benchmark agent adapter needs updating");
    busy += Object.values(agent.sockets).reduce((sum, list) => sum + (list?.filter((socket) => !socket.destroyed).length ?? 0), 0);
    idle += Object.values(agent.freeSockets).reduce((sum, list) => sum + (list?.filter((socket) => !socket.destroyed).length ?? 0), 0);
  }
  const current = Array.from(exchanges).filter(({ res }) => !res.destroyed && !res.writableFinished);
  return { activeRequests: current.length, activeUpstreamExchanges: active instanceof Set ? active.size : null,
    incomingSockets: Array.from(sockets).filter((socket) => !socket.destroyed).length,
    upstreamBusySockets: busy, upstreamIdleSockets: idle,
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
      case "metrics": return pilot?.getMetrics();
      case "stats": return fixture?.stats();
      case "resetStats": fixture?.reset(); return true;
      case "release": fixture?.release(); return true;
      case "health": fixture?.configure(payload as { status?: number; delayMs?: number; sequence?: number[] }); return true;
      case "stop": await pilot?.stop(); await fixture?.stop(); return state();
      case "start":
        if (pilot) { await pilot.start(); info.url = `http://127.0.0.1:${pilot.port}`; info.port = pilot.port ?? undefined; }
        if (fixture) info.url = await fixture.start();
        return info;
      case "remove": {
        const server = pools[0]?.getBackendRegistrations()[0]?.server;
        return server ? pools[0].remove(server) : false;
      }
      case "add": {
        if (typeof payload !== "string") throw new Error("Expected local backend URL");
        const url = new URL(payload); if (url.hostname !== "127.0.0.1") throw new Error("Nonlocal backend");
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

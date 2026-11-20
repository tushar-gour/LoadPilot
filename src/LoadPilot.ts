import { Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ServerPool } from "./server/ServerPool.js";
import { normalizeRoute } from "./routing/normalizeRoute.js";
import { routeMatcher } from "./routing/RouteMatcher.js";
import { HttpProxy, sendError } from "./proxy/HttpProxy.js";
import type { Duplex } from "node:stream";
import { MetricsCollector, resolveMetrics } from "./metrics/MetricsCollector.js";
import type { LoadPilotMetrics, MetricsOptions } from "./metrics/MetricsTypes.js";

export interface LoadPilotOptions {
  name: string;
  port: number;
  /** Base path for every pool (defaults to '/'). */
  route?: string;
  /** Initial pools; more can be registered using addPool(). */
  pools?: readonly ServerPool[];
  /** Total proxy exchange deadline in milliseconds (default: 30,000). */
  upstreamTimeoutMs?: number;
  /** Optional in-process observability, disabled by default. */
  metrics?: MetricsOptions;
}

type LifecycleState = "stopped" | "starting" | "started" | "stopping";

class LoadPilot {
  private readonly poolList = new Map<string, ServerPool>();
  private readonly httpServer: HttpServer;
  private readonly proxy: HttpProxy;
  private readonly metricsCollector: MetricsCollector;
  private state: LifecycleState = "stopped";
  readonly options: Readonly<{
    name: string; port: number; route: string; upstreamTimeoutMs: number;
    metrics: Readonly<Required<MetricsOptions>>;
  }>;

  constructor(options: LoadPilotOptions) {
    if (!options.name.trim()) throw new Error("LoadPilot name is required.");
    if (
      !Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535
    ) {
      throw new Error("LoadPilot port must be an integer between 0 and 65535.");
    }
    const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 30_000;
    if (!Number.isInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1 || upstreamTimeoutMs > 2_147_483_647) {
      throw new Error("upstreamTimeoutMs must be an integer between 1 and 2147483647.");
    }
    this.options = Object.freeze({
      name: options.name,
      port: options.port,
      route: normalizeRoute(options.route ?? "/"),
      upstreamTimeoutMs,
      metrics: resolveMetrics(options.metrics),
    });
    this.proxy = new HttpProxy(upstreamTimeoutMs);
    this.metricsCollector = new MetricsCollector(options.name, this.options.metrics.enabled);

    for (const pool of options.pools ?? []) this.addPool(pool);

    this.httpServer = new HttpServer((req, res) => this.handleRequest(req, res));
    // Startup errors are also handled by start(); keep later listener errors handled.
    this.httpServer.on("error", (error: NodeJS.ErrnoException) => {
      if (this.state === "started") {
        console.error(`${this.options.name} listener error: ${error.code ?? "UNKNOWN"}`);
      }
    });
    const rejectTunnel = (_req: IncomingMessage, socket: Duplex) => {
      socket.once("error", () => socket.destroy());
      socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
    };
    this.httpServer.on("upgrade", rejectTunnel);
    this.httpServer.on("connect", rejectTunnel);
  }

  /** Bound port, including the OS-assigned port when configured with port: 0. */
  get port(): number | null {
    const address = this.httpServer.address();
    return address && typeof address !== "string" ? address.port : null;
  }

  /** Frozen operational snapshots for trusted application code. No HTTP endpoint. */
  getMetrics(): LoadPilotMetrics { return this.metricsCollector.snapshot(); }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const observe = this.options.metrics.enabled ? this.metricsCollector.begin(res) : undefined;
    // Only origin-form targets are accepted. Keep raw escapes, slashes and query
    // bytes: WHATWG URL parsing would normalize dot segments before routing.
    const target = req.url ?? "";
    if (!target.startsWith("/") || target.startsWith("//") ||
        /[\s\x00-\x1f\x7f\\#]/.test(target) || /%(?![\da-f]{2})/i.test(target)) {
      req.resume();
      observe?.({ type: "rejected", reason: "invalidTarget" });
      sendError(res, 400);
      return;
    }
    const queryIndex = target.indexOf("?");
    const pathname = queryIndex < 0 ? target : target.slice(0, queryIndex);
    try {
      const pool = routeMatcher.getServerPoolFromRoute(pathname, this.options.route, this.poolList);
      if (!pool) {
        req.resume();
        observe?.({ type: "rejected", reason: "routeNotFound" });
        sendError(res, 404);
        return;
      }
      observe?.({ type: "pool", pool });
      const server = pool.getNextServer();
      if (!server) {
        req.resume();
        observe?.({ type: "rejected", reason: "noEligibleBackend" });
        sendError(res, 503);
        return;
      }
      observe?.({ type: "selected", server });
      const path = this.options.route === "/" ? pathname : pathname.slice(this.options.route.length) || "/";
      const query = queryIndex < 0 ? "" : target.slice(queryIndex);
      this.proxy.forward(req, res, server, path + query, this.options.route,
        () => pool.reportTransportFailure(server), observe);
    } catch {
      req.resume();
      observe?.({ type: "rejected", reason: "internalErrors" });
      sendError(res, 500);
    }
  }

  addPool(pool: ServerPool): void {
    if (this.poolList.has(pool.route)) {
      throw new Error(
        `A pool with route "${pool.route}" is already registered.`,
      );
    }
    this.poolList.set(pool.route, pool);
    this.metricsCollector.registerPool(pool);
    if (this.state === "started") pool.startHealthChecks(this);
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") {
      throw new Error(`${this.options.name} cannot start while ${this.state}.`);
    }
    this.state = "starting";

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.httpServer.off("error", onError);
          resolve();
        };
        this.httpServer.once("error", onError);
        this.httpServer.once("listening", onListening);
        try {
          this.httpServer.listen(this.options.port);
        } catch (error) {
          this.httpServer.off("error", onError);
          this.httpServer.off("listening", onListening);
          reject(error);
        }
      });
      this.state = "started";
      this.metricsCollector.started();
      for (const pool of this.poolList.values()) pool.startHealthChecks(this);
      console.log(`${this.options.name} started`);
    } catch (error) {
      this.state = "stopped";
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state !== "started") {
      throw new Error(`${this.options.name} cannot stop while ${this.state}.`);
    }
    this.state = "stopping";
    this.metricsCollector.shutdown();
    for (const pool of this.poolList.values()) pool.stopHealthChecks(this);
    try {
      await new Promise<void>((resolve, reject) => {
        this.httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        // Shutdown is immediate: cancel active exchanges, DNS/connect attempts,
        // downstream sockets and this instance's idle upstream connections.
        this.proxy.close();
        this.httpServer.closeAllConnections();
      });
      this.state = "stopped";
      this.metricsCollector.stopped();
      console.log(`${this.options.name} stopped`);
    } catch (error) {
      this.state = "started";
      throw error;
    }
  }
}

export { LoadPilot };

import {
  Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Server as HttpsServer } from "node:https";
import type { Socket } from "node:net";
import { ServerPool } from "./server/ServerPool.js";
import { normalizeRoute } from "./routing/normalizeRoute.js";
import { routeMatcher } from "./routing/RouteMatcher.js";
import { HttpProxy, sendError } from "./proxy/HttpProxy.js";
import type { Duplex } from "node:stream";
import {
  MetricsCollector,
  resolveMetrics,
} from "./metrics/MetricsCollector.js";
import type {
  LoadPilotMetrics,
  MetricsOptions,
} from "./metrics/MetricsTypes.js";
import {
  resolveTls,
  validateHost,
  type ListenerTlsOptions,
} from "./listener/ListenerOptions.js";
import { ForwardedHeaders } from "./proxy/ForwardedHeaders.js";

export interface LoadPilotOptions {
  name: string;
  port: number;
  /** Omit to preserve Node's all-interface listener behavior. */
  host?: string;
  /** Optional inbound HTTPS termination; never exposed in operational options. */
  tls?: ListenerTlsOptions;
  /** Explicit IP addresses/CIDRs allowed to supply validated X-Forwarded metadata. */
  trustedProxies?: readonly string[];
  /** Base path for every pool (defaults to '/'). */
  route?: string;
  /** Initial pools; more can be registered using addPool(). */
  pools?: readonly ServerPool[];
  /** Total proxy exchange deadline in milliseconds (default: 30,000). */
  upstreamTimeoutMs?: number;
  /** Optional in-process observability, disabled by default. */
  metrics?: MetricsOptions;
}

type LifecycleState =
  | "stopped"
  | "starting"
  | "started"
  | "draining"
  | "stopping";
export type StopOptions =
  | { mode: "immediate"; timeoutMs?: never }
  | { mode: "graceful"; timeoutMs?: number };
export interface LoadPilotStatus {
  readonly state: LifecycleState;
  readonly listening: boolean;
  readonly address: string | null;
  readonly port: number | null;
  readonly protocol: "http" | "https";
  readonly activeRequests: number;
  readonly connections: number;
}
interface Shutdown {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  closed: boolean;
  forced: boolean;
  agentsClosed: boolean;
  agentsClosing: boolean;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  error?: Error;
}
function stopConfiguration(options?: StopOptions): {
  mode: "immediate" | "graceful";
  timeoutMs: number;
} {
  if (options === undefined) return { mode: "immediate", timeoutMs: 0 };
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !["mode", "timeoutMs"].includes(key))
  )
    throw new Error("stop options must specify immediate or graceful mode.");
  if (options.mode !== "immediate" && options.mode !== "graceful")
    throw new Error("stop mode must be immediate or graceful.");
  if (options.mode === "immediate") {
    if (options.timeoutMs !== undefined)
      throw new Error("timeoutMs applies only to graceful stop.");
    return { mode: "immediate", timeoutMs: 0 };
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new Error(
      "Graceful timeoutMs must be an integer between 1 and 300000.",
    );
  return { mode: "graceful", timeoutMs };
}

class LoadPilot {
  private readonly poolList = new Map<string, ServerPool>();
  private readonly httpServer: HttpServer | HttpsServer;
  private readonly proxy: HttpProxy;
  private readonly metricsCollector: MetricsCollector;
  private state: LifecycleState = "stopped";
  private readonly sockets = new Set<Socket>();
  private readonly activeRequests = new Set<ServerResponse>();
  private shutdown: Shutdown | undefined;
  readonly options: Readonly<{
    name: string;
    port: number;
    route: string;
    upstreamTimeoutMs: number;
    metrics: Readonly<Required<MetricsOptions>>;
    host?: string;
    protocol: "http" | "https";
    trustedProxies: readonly string[];
  }>;

  constructor(options: LoadPilotOptions) {
    if (!options || typeof options.name !== "string" || !options.name.trim())
      throw new Error("LoadPilot name is required.");
    if (
      !Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535
    ) {
      throw new Error("LoadPilot port must be an integer between 0 and 65535.");
    }
    const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 30_000;
    if (
      !Number.isInteger(upstreamTimeoutMs) ||
      upstreamTimeoutMs < 1 ||
      upstreamTimeoutMs > 2_147_483_647
    ) {
      throw new Error(
        "upstreamTimeoutMs must be an integer between 1 and 2147483647.",
      );
    }
    const host = validateHost(options.host);
    const tls = resolveTls(options.tls);
    const forwarding = new ForwardedHeaders(options.trustedProxies);
    this.options = Object.freeze({
      name: options.name,
      port: options.port,
      route: normalizeRoute(options.route ?? "/"),
      upstreamTimeoutMs,
      metrics: resolveMetrics(options.metrics),
      host,
      protocol: tls ? "https" : "http",
      trustedProxies: forwarding.addresses,
    });
    this.proxy = new HttpProxy(upstreamTimeoutMs, forwarding);
    this.metricsCollector = new MetricsCollector(
      options.name,
      this.options.metrics.enabled,
    );

    for (const pool of options.pools ?? []) this.addPool(pool);

    const listener = (req: IncomingMessage, res: ServerResponse) =>
      this.handleRequest(req, res);
    try {
      this.httpServer =
        tls ? new HttpsServer(tls, listener) : new HttpServer(listener);
    } catch (error) {
      // OpenSSL diagnostics can include sensitive inputs. Never attach the raw
      // certificate configuration or native error as an operational cause.
      if (tls) throw new Error("Invalid tls key/certificate configuration.");
      throw error;
    }
    this.httpServer.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("error", () => socket.destroy());
      socket.once("close", () => {
        this.sockets.delete(socket);
        if (this.shutdown) this.checkShutdown(this.shutdown);
      });
    });
    // Startup errors are also handled by start(); keep later listener errors handled.
    this.httpServer.on("error", (error: NodeJS.ErrnoException) => {
      if (this.state === "started") {
        console.error(
          `${this.options.name} listener error: ${error.code ?? "UNKNOWN"}`,
        );
      }
    });
    const rejectTunnel = (_req: IncomingMessage, socket: Duplex) => {
      socket.once("error", () => socket.destroy());
      const status =
        this.state === "started" ?
          "501 Not Implemented"
        : "503 Service Unavailable";
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        () => socket.destroy(),
      );
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
  getMetrics(): LoadPilotMetrics {
    return this.metricsCollector.snapshot();
  }

  getStatus(): Readonly<LoadPilotStatus> {
    const address = this.httpServer.address();
    return Object.freeze({
      state: this.state,
      listening: this.httpServer.listening,
      address: address && typeof address !== "string" ? address.address : null,
      port: this.port,
      protocol: this.options.protocol,
      activeRequests: this.activeRequests.size,
      connections: this.sockets.size,
    });
  }

  private trackResponse(res: ServerResponse): void {
    this.activeRequests.add(res);
    const settled = () => {
      this.activeRequests.delete(res);
      res.off("finish", settled);
      res.off("close", settled);
      const operation = this.shutdown;
      // Let forwarding's existing terminal listeners run before testing idle.
      if (operation) queueMicrotask(() => this.checkShutdown(operation));
    };
    res.once("finish", settled);
    res.once("close", settled);
    res.once("error", () => res.destroy());
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const admitted = this.state === "started";
    this.trackResponse(res);
    const observe =
      this.options.metrics.enabled ?
        this.metricsCollector.begin(res)
      : undefined;
    if (!admitted) {
      req.resume();
      observe?.({ type: "rejected", reason: "drainingRejections" });
      sendError(res, 503);
      return;
    }
    // Only origin-form targets are accepted. Keep raw escapes, slashes and query
    // bytes: WHATWG URL parsing would normalize dot segments before routing.
    const target = req.url ?? "";
    if (
      !target.startsWith("/") ||
      target.startsWith("//") ||
      /[\s\x00-\x1f\x7f\\#]/.test(target) ||
      /%(?![\da-f]{2})/i.test(target)
    ) {
      req.resume();
      observe?.({ type: "rejected", reason: "invalidTarget" });
      sendError(res, 400);
      return;
    }
    const queryIndex = target.indexOf("?");
    const pathname = queryIndex < 0 ? target : target.slice(0, queryIndex);
    let settleSelection: ((headersMs?: number) => void) | undefined;
    try {
      const pool = routeMatcher.getServerPoolFromRoute(
        pathname,
        this.options.route,
        this.poolList,
      );
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
      settleSelection = pool.beginRequest(server);
      observe?.({ type: "selected", server });
      const path =
        this.options.route === "/" ?
          pathname
        : pathname.slice(this.options.route.length) || "/";
      const query = queryIndex < 0 ? "" : target.slice(queryIndex);
      this.proxy.forward(
        req,
        res,
        server,
        path + query,
        this.options.route,
        () => pool.reportTransportFailure(server),
        observe,
        settleSelection,
      );
    } catch {
      settleSelection?.();
      req.resume();
      observe?.({ type: "rejected", reason: "internalErrors" });
      sendError(res, 500);
    }
  }

  addPool(pool: ServerPool): void {
    if (this.state !== "stopped" && this.state !== "started")
      throw new Error(`Cannot add a pool while ${this.state}.`);
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
    this.proxy.open();

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
          if (this.options.host === undefined)
            this.httpServer.listen(this.options.port);
          else this.httpServer.listen(this.options.port, this.options.host);
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

  stop(options?: StopOptions): Promise<void> {
    let configuration: ReturnType<typeof stopConfiguration>;
    try {
      configuration = stopConfiguration(options);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.state === "stopped") return Promise.resolve();
    if (this.shutdown) {
      const operation = this.shutdown;
      if (configuration.mode === "immediate") this.forceShutdown(operation);
      return operation.promise;
    }
    if (this.state !== "started")
      return Promise.reject(
        new Error(`${this.options.name} cannot stop while ${this.state}.`),
      );
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const operation: Shutdown = {
      promise,
      resolve,
      reject,
      closed: false,
      forced: false,
      agentsClosed: false,
      agentsClosing: false,
      deadline: performance.now() + configuration.timeoutMs,
    };
    this.shutdown = operation;
    this.state = configuration.mode === "graceful" ? "draining" : "stopping";
    for (const pool of this.poolList.values()) pool.stopHealthChecks(this);
    if (configuration.mode === "graceful") this.armDeadline(operation);
    try {
      this.httpServer.close((error) => {
        operation.closed = true;
        if (error) {
          operation.error = error;
          this.forceShutdown(operation);
        }
        this.checkShutdown(operation);
      });
      this.httpServer.closeIdleConnections();
      if (configuration.mode === "immediate") this.forceShutdown(operation);
      else {
        this.proxy.closeIdleConnections();
        this.checkShutdown(operation);
      }
    } catch (error) {
      operation.error =
        error instanceof Error ? error : new Error("Listener close failed.");
      operation.closed = true;
      this.forceShutdown(operation);
      this.checkShutdown(operation);
    }
    return promise;
  }

  private armDeadline(operation: Shutdown): void {
    if (this.shutdown !== operation) return;
    const remaining = operation.deadline - performance.now();
    if (remaining <= 0) {
      this.forceShutdown(operation);
      return;
    }
    operation.timer = setTimeout(
      () => this.armDeadline(operation),
      Math.ceil(remaining),
    );
    operation.timer.unref();
  }

  private forceShutdown(operation: Shutdown): void {
    if (this.shutdown !== operation || operation.forced) return;
    operation.forced = true;
    this.state = "stopping";
    clearTimeout(operation.timer);
    this.metricsCollector.shutdown();
    this.closeProxy(operation);
    this.httpServer.closeAllConnections();
    for (const socket of this.sockets) socket.destroy();
    this.checkShutdown(operation);
  }

  private checkShutdown(operation: Shutdown): void {
    if (this.shutdown !== operation) return;
    if (
      !operation.agentsClosing &&
      this.activeRequests.size === 0 &&
      this.proxy.activeCount === 0
    ) {
      this.closeProxy(operation);
      this.httpServer.closeIdleConnections();
      // Includes pre-request connections, incomplete headers and TLS handshakes
      // that native closeAllConnections does not necessarily own.
      for (const socket of this.sockets) socket.destroy();
    }
    if (
      !operation.closed ||
      !operation.agentsClosed ||
      this.activeRequests.size ||
      this.proxy.activeCount ||
      this.sockets.size
    )
      return;
    clearTimeout(operation.timer);
    this.state = "stopped";
    this.shutdown = undefined;
    this.metricsCollector.stopped();
    console.log(`${this.options.name} stopped`);
    if (operation.error) operation.reject(operation.error);
    else operation.resolve();
  }

  private closeProxy(operation: Shutdown): void {
    if (operation.agentsClosing) return;
    operation.agentsClosing = true;
    void this.proxy.close().then(
      () => {
        operation.agentsClosed = true;
        this.checkShutdown(operation);
      },
      (error: unknown) => {
        operation.error =
          error instanceof Error ? error : (
            new Error("Upstream cleanup failed.")
          );
        operation.agentsClosed = true;
        this.forceShutdown(operation);
        this.checkShutdown(operation);
      },
    );
  }
}

export { LoadPilot };

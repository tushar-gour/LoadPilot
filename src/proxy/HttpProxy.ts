import {
  Agent as HttpAgent,
  request as httpRequest,
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Server } from "../server/Server.js";
import { ForwardedHeaders } from "./ForwardedHeaders.js";
import { Socket } from "node:net";
import type { EventEmitter } from "node:events";

interface CloseWatch {
  promise: Promise<void>;
  cleanup: () => void;
}
function watchClose(stream: EventEmitter & { closed: boolean }): CloseWatch {
  let onClose = () => {};
  const promise =
    stream.closed ?
      Promise.resolve()
    : new Promise<void>((resolve) => {
        onClose = resolve;
        stream.once("close", onClose);
      });
  return { promise, cleanup: () => stream.off("close", onClose) };
}

function managedAgent<T extends HttpAgent>(agent: T) {
  const gate = { closed: false },
    create = agent.createConnection.bind(agent);
  agent.createConnection = function (...args) {
    if (!gate.closed) return create(...args);
    // Native Agent can assign cancelled queued requests after socket closure.
    // Give that native cleanup path an unconnected socket, never fresh DNS/TCP.
    const socket = new Socket();
    queueMicrotask(() => socket.destroy());
    return socket;
  };
  return {
    agent,
    closeGate: () => {
      gate.closed = true;
    },
  };
}

export type ProxyEvent =
  | { type: "response"; statusCode: number; headersMs: number }
  | { type: "completed" }
  | { type: "failure"; reason: "upstream" | "timeout" }
  | { type: "cancelled"; reason: "client" | "shutdown" };
export type ProxyObserver = (event: ProxyEvent) => void;

function notify(observer: ProxyObserver | undefined, event: ProxyEvent): void {
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // Only optional instrumentation is isolated; transport errors keep their
    // existing handlers and must never become telemetry callback errors.
    return;
  }
}

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

const transportErrors = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
]);

function endToEndHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const excluded = new Set(hopByHop);
  for (const token of source.connection?.split(",") ?? []) {
    excluded.add(token.trim().toLowerCase());
  }
  const result: IncomingHttpHeaders = Object.create(null);
  for (const [name, value] of Object.entries(source)) {
    if (!excluded.has(name)) result[name] = value;
  }
  return result;
}

/** Internal HTTP error response; never include upstream or exception details. */
export function sendError(res: ServerResponse, status: number): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  const body = `${STATUS_CODES[status] ?? "Internal Server Error"}\n`;
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  res.end(body);
}

function rewriteLocation(
  location: string,
  backend: URL,
  upstreamPath: string,
  baseRoute: string,
): string | undefined {
  let destination: URL;
  try {
    destination = new URL(location, `${backend.origin}${upstreamPath}`);
  } catch {
    return undefined;
  }
  if (destination.origin !== backend.origin) return location;
  const prefix = backend.pathname.replace(/\/+$/, "");
  if (
    prefix &&
    destination.pathname !== prefix &&
    !destination.pathname.startsWith(`${prefix}/`)
  ) {
    // No public mapping exists outside the configured backend path prefix.
    return undefined;
  }
  const path = destination.pathname.slice(prefix.length) || "/";
  const publicPath = `${baseRoute === "/" ? "" : baseRoute}${path}`;
  // Never turn a path into a network-path redirect, even with hostile headers.
  if (publicPath.startsWith("//")) return undefined;
  return publicPath + destination.search + destination.hash;
}

/** Native streaming transport. Routing and backend selection belong to callers. */
export class HttpProxy {
  private httpAgent!: HttpAgent;
  private httpsAgent!: HttpsAgent;
  private closeGates!: () => void;
  private readonly active = new Set<() => CloseWatch>();
  private closing = false;
  private closingPromise: Promise<void> | undefined;

  constructor(
    private readonly timeoutMs: number,
    private readonly forwarding = new ForwardedHeaders(),
  ) {
    this.resetAgents();
  }

  private resetAgents(): void {
    const plain = managedAgent(new HttpAgent({ keepAlive: true })),
      secure = managedAgent(new HttpsAgent({ keepAlive: true }));
    this.httpAgent = plain.agent;
    this.httpsAgent = secure.agent;
    this.closeGates = () => {
      plain.closeGate();
      secure.closeGate();
    };
  }

  open(): void {
    this.closing = false;
    this.closingPromise = undefined;
  }

  get activeCount(): number {
    return this.active.size;
  }

  closeIdleConnections(): void {
    for (const agent of [this.httpAgent, this.httpsAgent]) {
      for (const sockets of Object.values(agent.freeSockets))
        for (const socket of sockets ?? []) socket.destroy();
    }
  }

  /**
   * Starts an exchange and owns its streams until finish/close/error/deadline.
   * Deliberately returns void: every asynchronous event has a managed handler.
   */
  forward(
    req: IncomingMessage,
    res: ServerResponse,
    server: Server,
    path: string,
    baseRoute: string,
    onTransportFailure?: () => void,
    observer?: ProxyObserver,
    onSettled?: (headersMs?: number) => void,
  ): void {
    if (this.closing) {
      onSettled?.();
      sendError(res, 503);
      return;
    }
    const started = observer || onSettled ? performance.now() : 0;
    const backend = new URL(server.baseUrl);
    const upstreamPath = backend.pathname.replace(/\/+$/, "") + path;
    const headers = endToEndHeaders(req.headers);
    for (const name of Object.keys(headers)) {
      if (name === "forwarded" || name.startsWith("x-forwarded-"))
        delete headers[name];
    }
    headers.host = backend.host;
    this.forwarding.apply(headers, req);
    // LoadPilot handles Expect locally (Node's 100 Continue), not upstream.
    delete headers.expect;
    if (
      headers["content-length"] === undefined &&
      (req.headers["transfer-encoding"] !== undefined ||
        req.headers["content-length"] !== undefined)
    ) {
      // Regenerate framing, including for chunked GET/DELETE request bodies.
      headers["transfer-encoding"] = "chunked";
    }

    const secure = backend.protocol === "https:";
    const upstream = (secure ? httpsRequest : httpRequest)(backend, {
      method: req.method,
      path: upstreamPath,
      headers,
      agent: secure ? this.httpsAgent : this.httpAgent,
    });
    let response: IncomingMessage | undefined;
    let settled = false;
    let headersMs: number | undefined;
    const finish = (completedHeadersMs?: number) => {
      if (settled) return;
      settled = true;
      onSettled?.(completedHeadersMs);
      clearTimeout(deadline);
      this.active.delete(shutdownCancel);
      req.unpipe(upstream);
      response?.unpipe(res);
      // A fully parsed message can still have unread buffered data. Destroy it
      // on cancellation so backpressure cannot strand a pooled upstream socket.
      if (!response?.readableEnded || !upstream.writableFinished)
        upstream.destroy();
      if (response && !response.readableEnded) response.destroy();
      if (!req.readableEnded && !req.destroyed) req.resume();
    };
    const cancel = (reason: "client" | "shutdown") => {
      if (settled) return;
      if (observer) notify(observer, { type: "cancelled", reason });
      finish();
      if (!res.destroyed) res.destroy();
    };
    const clientCancel = () => cancel("client");
    const shutdownCancel = () => {
      const closed = watchClose(upstream);
      cancel("shutdown");
      return closed;
    };
    const fail = (status: number, transportFailure = false) => {
      if (settled) return;
      if (observer)
        notify(observer, {
          type: "failure",
          reason: status === 504 ? "timeout" : "upstream",
        });
      finish();
      if (transportFailure) onTransportFailure?.();
      sendError(res, status);
    };
    // A total deadline includes DNS, connect, TLS, upload and response delivery;
    // socket inactivity timeouts alone do not bound all those phases.
    const deadline = setTimeout(() => fail(504), this.timeoutMs);
    deadline.unref();
    this.active.add(shutdownCancel);
    req.once("aborted", clientCancel);
    req.once("error", clientCancel);
    res.once("error", clientCancel);
    res.once("finish", () => {
      if (settled) return;
      if (observer) notify(observer, { type: "completed" });
      finish(headersMs);
    });
    res.once("close", () => {
      if (!res.writableFinished) clientCancel();
    });
    upstream.once("error", (error: NodeJS.ErrnoException) =>
      fail(502, transportErrors.has(error.code ?? "")),
    );
    upstream.once("upgrade", (_message, socket) => {
      socket.destroy();
      fail(502);
    });
    upstream.once("response", (message) => {
      response = message;
      message.once("error", () => fail(502, true));
      message.once("aborted", () => fail(502, true));
      message.once("close", () => {
        if (!message.complete) fail(502, true);
      });
      if (settled) {
        message.destroy();
        return;
      }
      if (observer || onSettled) headersMs = performance.now() - started;
      if (observer)
        notify(observer, {
          type: "response",
          statusCode: message.statusCode ?? 502,
          headersMs: headersMs!,
        });
      try {
        const responseHeaders = endToEndHeaders(message.headers);
        if (responseHeaders.location !== undefined) {
          const location = rewriteLocation(
            responseHeaders.location,
            backend,
            upstreamPath,
            baseRoute,
          );
          if (location === undefined) delete responseHeaders.location;
          else responseHeaders.location = location;
        }
        // An early upstream rejection must not keep an unfinished upload alive.
        if (!req.readableEnded) responseHeaders.connection = "close";
        res.writeHead(message.statusCode ?? 502, responseHeaders);
        message.pipe(res);
      } catch {
        fail(502);
      }
    });
    req.pipe(upstream);
  }

  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    this.closeGates();
    const agents = [this.httpAgent, this.httpsAgent];
    const sockets = new Set(
      agents.flatMap((agent) =>
        [
          ...Object.values(agent.sockets),
          ...Object.values(agent.freeSockets),
        ].flatMap((list) => list ?? []),
      ),
    );
    const watches = [...sockets].map(watchClose);
    // A prior client cancellation may already have removed its exchange from
    // active while the native Agent still retains that destroyed queue entry.
    for (const agent of agents)
      for (const requests of Object.values(agent.requests)) {
        for (const request of requests ?? []) watches.push(watchClose(request));
      }
    for (const cancel of this.active) watches.push(cancel());
    for (const agent of agents) agent.destroy();
    this.closingPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        for (const watch of watches) watch.cleanup();
        // Old generations stay gated even if native callbacks arrive later.
        this.resetAgents();
        if (error) reject(error);
        else resolve();
      };
      const deadline = setTimeout(
        () => finish(new Error("Upstream shutdown cleanup exceeded 1000 ms.")),
        1000,
      );
      deadline.unref();
      void Promise.all(watches.map((watch) => watch.promise)).then(
        () => finish(),
        () => finish(new Error("Upstream shutdown cleanup failed.")),
      );
    });
    return this.closingPromise;
  }
}

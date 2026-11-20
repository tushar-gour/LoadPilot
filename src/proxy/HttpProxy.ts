import {
  Agent as HttpAgent, request as httpRequest, STATUS_CODES,
  type IncomingHttpHeaders, type IncomingMessage, type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Server } from "../server/Server.js";

const hopByHop = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "te",
  "trailer", "upgrade", "proxy-authenticate", "proxy-authorization",
]);

const transportErrors = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH",
  "EHOSTUNREACH", "ETIMEDOUT", "EPIPE", "ECONNABORTED",
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
    "connection": "close",
  });
  res.end(body);
}

function rewriteLocation(location: string, backend: URL, upstreamPath: string, baseRoute: string): string | undefined {
  let destination: URL;
  try {
    destination = new URL(location, `${backend.origin}${upstreamPath}`);
  } catch {
    return undefined;
  }
  if (destination.origin !== backend.origin) return location;
  const prefix = backend.pathname.replace(/\/+$/, "");
  if (prefix && destination.pathname !== prefix && !destination.pathname.startsWith(`${prefix}/`)) {
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
  private readonly httpAgent = new HttpAgent({ keepAlive: true });
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true });
  private readonly active = new Set<() => void>();

  constructor(private readonly timeoutMs: number) {}

  /**
   * Starts an exchange and owns its streams until finish/close/error/deadline.
   * Deliberately returns void: every asynchronous event has a managed handler.
   */
  forward(req: IncomingMessage, res: ServerResponse, server: Server, path: string, baseRoute: string,
    onTransportFailure?: () => void): void {
    const backend = new URL(server.baseUrl);
    const upstreamPath = backend.pathname.replace(/\/+$/, "") + path;
    const headers = endToEndHeaders(req.headers);
    for (const name of Object.keys(headers)) {
      if (name === "forwarded" || name.startsWith("x-forwarded-")) delete headers[name];
    }
    headers.host = backend.host;
    if (req.socket.remoteAddress) headers["x-forwarded-for"] = req.socket.remoteAddress;
    if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;
    headers["x-forwarded-proto"] = "http";
    // LoadPilot handles Expect locally (Node's 100 Continue), not upstream.
    delete headers.expect;
    if (headers["content-length"] === undefined &&
        (req.headers["transfer-encoding"] !== undefined || req.headers["content-length"] !== undefined)) {
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
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      this.active.delete(cancel);
      req.unpipe(upstream);
      response?.unpipe(res);
      // A fully parsed message can still have unread buffered data. Destroy it
      // on cancellation so backpressure cannot strand a pooled upstream socket.
      if (!response?.readableEnded || !upstream.writableFinished) upstream.destroy();
      if (response && !response.readableEnded) response.destroy();
      if (!req.readableEnded && !req.destroyed) req.resume();
    };
    const cancel = () => {
      finish();
      if (!res.destroyed) res.destroy();
    };
    const fail = (status: number, transportFailure = false) => {
      if (settled) return;
      finish();
      if (transportFailure) onTransportFailure?.();
      sendError(res, status);
    };
    // A total deadline includes DNS, connect, TLS, upload and response delivery;
    // socket inactivity timeouts alone do not bound all those phases.
    const deadline = setTimeout(() => fail(504), this.timeoutMs);
    deadline.unref();
    this.active.add(cancel);
    req.once("aborted", cancel);
    req.once("error", cancel);
    res.once("error", cancel);
    res.once("finish", finish);
    res.once("close", () => { if (!res.writableFinished) cancel(); });
    upstream.once("error", (error: NodeJS.ErrnoException) => fail(502, transportErrors.has(error.code ?? "")));
    upstream.once("upgrade", (_message, socket) => {
      socket.destroy();
      fail(502);
    });
    upstream.once("response", (message) => {
      response = message;
      message.once("error", () => fail(502, true));
      message.once("aborted", () => fail(502, true));
      message.once("close", () => { if (!message.complete) fail(502, true); });
      if (settled) {
        message.destroy();
        return;
      }
      try {
        const responseHeaders = endToEndHeaders(message.headers);
        if (responseHeaders.location !== undefined) {
          const location = rewriteLocation(responseHeaders.location, backend, upstreamPath, baseRoute);
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

  close(): void {
    for (const cancel of this.active) cancel();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

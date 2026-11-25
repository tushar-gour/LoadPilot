import { request as httpRequest, type Agent as HttpAgent, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest, type Agent as HttpsAgent } from "node:https";
import type { Server } from "../server/Server.js";
import type { ForwardedHeaders } from "./ForwardedHeaders.js";
import { watchClose, type CloseWatch } from "./closeWatch.js";
import { notify, type ProxyObserver } from "./ProxyEvents.js";
import { endToEndHeaders } from "./endToEndHeaders.js";
import { sendError } from "./sendError.js";
import { rewriteLocation } from "./rewriteLocation.js";

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

/** One streaming exchange; owns event handlers, deadline and terminal cleanup. */
export class ProxyExchange {
  constructor(
    private readonly timeoutMs: number,
    private readonly forwarding: Pick<ForwardedHeaders, "apply">,
    private readonly httpAgent: HttpAgent,
    private readonly httpsAgent: HttpsAgent,
    private readonly onStart: (cancel: () => CloseWatch) => void,
    private readonly onFinish: (cancel: () => CloseWatch) => void,
  ) {}

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
      this.onFinish(shutdownCancel);
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
    this.onStart(shutdownCancel);
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

}

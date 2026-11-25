import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerPool } from "../server/ServerPool.js";
import { routeMatcher } from "./RouteMatcher.js";
import { sendError } from "../proxy/sendError.js";
import type { HttpProxy } from "../proxy/HttpProxy.js";
import type { RequestObserver } from "../metrics/MetricEvents.js";

/** Routes admitted origin-form requests; does not own listener lifecycle. */
export class RequestRouter {
  constructor(
    private readonly baseRoute: string,
    private readonly pools: ReadonlyMap<string, ServerPool>,
    private readonly proxy: Pick<HttpProxy, "forward">,
  ) {}

  forward(req: IncomingMessage, res: ServerResponse, observe?: RequestObserver): void {
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
        this.baseRoute,
        this.pools,
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
        this.baseRoute === "/" ?
          pathname
        : pathname.slice(this.baseRoute.length) || "/";
      const query = queryIndex < 0 ? "" : target.slice(queryIndex);
      this.proxy.forward(
        req,
        res,
        server,
        path + query,
        this.baseRoute,
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

}

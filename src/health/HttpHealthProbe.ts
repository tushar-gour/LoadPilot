import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Server } from "../server/Server.js";
import type { HealthCheckConfiguration } from "./HealthCheck.js";

/** Owns one native health probe, with no health policy or monitoring timers. */
export class HttpHealthProbe {
  run(
    server: Server,
    options: Pick<HealthCheckConfiguration, "timeoutMs" | "path">,
    onCancel: (cancel: () => void) => void,
    onSettled: (success?: boolean, timedOut?: boolean) => void,
  ): void {
    let req: ClientRequest | undefined;
    let res: IncomingMessage | undefined;
    let settled = false;
    const finish = (success?: boolean, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req?.destroy();
      res?.destroy();
      onSettled(success, timedOut);
    };
    onCancel(() => finish());
    const deadline = setTimeout(
      () => finish(false, true),
      options.timeoutMs,
    );
    deadline.unref();
    try {
      const backend = new URL(server.baseUrl);
      req = (backend.protocol === "https:" ? httpsRequest : httpRequest)(
        backend,
        {
          method: "GET",
          agent: false,
          path: backend.pathname.replace(/\/+$/, "") + options.path,
          headers: { host: backend.host, connection: "close" },
        },
      );
      req.once("socket", (socket) => socket.unref());
      req.once("error", () => finish(false));
      req.once("upgrade", (_response, socket) => {
        socket.destroy();
        finish(false);
      });
      req.once("response", (response) => {
        res = response;
        response.once("error", () => finish(false));
        response.once("aborted", () => finish(false));
        if (settled) {
          response.destroy();
          return;
        }
        if (
          !response.statusCode ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          finish(false);
          return;
        }
        response.once("end", () => finish(response.complete));
        // Discard incrementally; the same deadline also bounds a stalled body.
        response.resume();
      });
      req.end();
    } catch {
      finish(false);
    }
  }
}

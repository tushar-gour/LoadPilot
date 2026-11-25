import type { ServerPool } from "../server/ServerPool.js";
import type { Server } from "../server/Server.js";
import type { ProxyEvent } from "../proxy/HttpProxy.js";
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type Outcome = "completed" | "failed" | "cancelled";
export type Reason =
  | "clientCancelled"
  | "shutdownCancelled"
  | "routeNotFound"
  | "noEligibleBackend"
  | "invalidTarget"
  | "upstreamFailures"
  | "upstreamTimeouts"
  | "internalErrors"
  | "drainingRejections";

export type RequestMetricEvent =
  | ProxyEvent
  | { type: "pool"; pool: ServerPool }
  | { type: "selected"; server: Server }
  | {
      type: "rejected";
      reason:
        | "routeNotFound"
        | "noEligibleBackend"
        | "invalidTarget"
        | "internalErrors"
        | "drainingRejections";
    };

export type RequestObserver = (event: RequestMetricEvent) => void;

import type { Server } from "../server/Server.js";

export enum HealthState {
  UNKNOWN = "UNKNOWN",
  HEALTHY = "HEALTHY",
  UNHEALTHY = "UNHEALTHY",
}

export interface HealthCheckOptions {
  /** Opt in explicitly; defaults to false. */
  enabled?: boolean;
  /** Path appended to the backend URL's pathname prefix; defaults to /health. */
  path?: string;
  /** Delay after each completed probe, in milliseconds; defaults to 5000. */
  intervalMs?: number;
  /** Total probe deadline, in milliseconds; defaults to 1000. */
  timeoutMs?: number;
  unhealthyThreshold?: number;
  healthyThreshold?: number;
}

export type HealthCheckConfiguration = Readonly<Required<HealthCheckOptions>>;

/** A local diagnostic snapshot. No diagnostics are included in HTTP errors. */
export interface BackendHealthStatus {
  readonly server: Server;
  readonly state: HealthState;
  readonly consecutiveSuccesses: number;
  readonly consecutiveFailures: number;
}

export function resolveHealthCheck(
  options?: HealthCheckOptions,
): HealthCheckConfiguration {
  if (
    options !== undefined &&
    (typeof options !== "object" || options === null || Array.isArray(options))
  ) {
    throw new Error("healthCheck must be a configuration object.");
  }
  const {
    enabled = false,
    path = "/health",
    intervalMs = 5000,
    timeoutMs = 1000,
    unhealthyThreshold = 2,
    healthyThreshold = 2,
  } = options ?? {};
  if (typeof enabled !== "boolean")
    throw new Error("healthCheck.enabled must be a boolean.");
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("//") ||
    /[\s\x00-\x1f\x7f\\?#]/.test(path) ||
    /%(?![\da-f]{2})/i.test(path) ||
    path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
  ) {
    throw new Error(
      "healthCheck.path must be an origin-relative pathname without query, fragment or dot segments.",
    );
  }
  for (const [name, value] of Object.entries({
    intervalMs,
    timeoutMs,
    unhealthyThreshold,
    healthyThreshold,
  })) {
    const maximum =
      name.endsWith("Ms") ? 2_147_483_647 : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(
        `healthCheck.${name} must be an integer between 1 and ${maximum}.`,
      );
    }
  }
  return Object.freeze({
    enabled,
    path,
    intervalMs,
    timeoutMs,
    unhealthyThreshold,
    healthyThreshold,
  });
}

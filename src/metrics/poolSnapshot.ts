import { HealthState } from "../health/HealthCheck.js";
import type { ServerPool } from "../server/ServerPool.js";
import type { PoolMetricGroup } from "./PoolMetricGroup.js";
import type { BackendMetrics, PoolMetrics } from "./MetricsTypes.js";

/** Assemble a frozen snapshot from current and retired in-flight registrations. */
export function poolSnapshot(pool: ServerPool, group: PoolMetricGroup): PoolMetrics {
  const registrations = pool.getBackendRegistrations();
  const current = new Set(registrations);
  const eligibility = {
    registered: registrations.length,
    registrations: 0,
    unknown: 0,
    healthy: 0,
    unhealthy: 0,
    eligible: 0,
  };
  const backends: BackendMetrics[] = registrations.map((registration) => {
    const health = pool.getBackendHealthMetrics(registration.server);
    eligibility.registrations += registration.registrations;
    if (health?.state === HealthState.HEALTHY) eligibility.healthy++;
    else if (health?.state === HealthState.UNHEALTHY) eligibility.unhealthy++;
    else eligibility.unknown++;
    if (!pool.healthCheck.enabled || health?.state !== HealthState.UNHEALTHY)
      eligibility.eligible++;
    return Object.freeze({
      ...group.backend(registration).snapshot(),
      id: registration.id,
      baseUrl: registration.server.baseUrl,
      registered: true,
      registrations: registration.registrations,
      health: health ?? null,
    });
  });
  for (const backend of group.activeBackends) {
    if (!current.has(backend.registration)) {
      backends.push(
        Object.freeze({
          ...backend.snapshot(),
          id: backend.registration.id,
          baseUrl: backend.registration.server.baseUrl,
          registered: false,
          registrations: 0,
          health: null,
        }),
      );
    }
  }
  return Object.freeze({
    ...group.snapshot(),
    route: pool.route,
    eligibility: Object.freeze(eligibility),
    health: pool.getHealthMetrics(),
    backends: Object.freeze(backends),
  });
}

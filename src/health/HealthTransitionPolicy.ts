import { HealthState, type HealthCheckConfiguration } from "./HealthCheck.js";

export interface HealthTransitionState {
  state: HealthState;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
}

/** Threshold policy only: no timers, networking or telemetry. */
export class HealthTransitionPolicy {
  constructor(private readonly options: Pick<HealthCheckConfiguration, "healthyThreshold" | "unhealthyThreshold">) {}

  reset(record: HealthTransitionState): void {
    record.state = HealthState.UNKNOWN;
    record.consecutiveSuccesses = 0;
    record.consecutiveFailures = 0;
  }

  apply(record: HealthTransitionState, success: boolean): void {
    if (success) {
      record.consecutiveFailures = 0;
      record.consecutiveSuccesses = Math.min(
        record.consecutiveSuccesses + 1,
        this.options.healthyThreshold,
      );
      if (
        record.state !== HealthState.UNHEALTHY ||
        record.consecutiveSuccesses >= this.options.healthyThreshold
      ) {
        record.state = HealthState.HEALTHY;
      }
    } else {
      record.consecutiveSuccesses = 0;
      record.consecutiveFailures = Math.min(
        record.consecutiveFailures + 1,
        this.options.unhealthyThreshold,
      );
      if (record.consecutiveFailures >= this.options.unhealthyThreshold)
        record.state = HealthState.UNHEALTHY;
    }
  }
}

import type { AggregateMetrics, RequestCounters, StatusCounters } from "./MetricsTypes.js";
import type { Mutable, Outcome, Reason } from "./MetricEvents.js";
import { LatencyHistogram } from "./LatencyHistogram.js";
function statusCounters(): Mutable<StatusCounters> {
  return {
    status1xx: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
  };
}

function statusCategory(status: number): keyof StatusCounters | undefined {
  switch (Math.floor(status / 100)) {
    case 1:
      return "status1xx";
    case 2:
      return "status2xx";
    case 3:
      return "status3xx";
    case 4:
      return "status4xx";
    case 5:
      return "status5xx";
    default:
      return undefined;
  }
}

export class MetricGroup {
  readonly requests: Mutable<RequestCounters> = {
    total: 0,
    active: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    clientCancelled: 0,
    shutdownCancelled: 0,
    routeNotFound: 0,
    noEligibleBackend: 0,
    invalidTarget: 0,
    upstreamFailures: 0,
    upstreamTimeouts: 0,
    internalErrors: 0,
    drainingRejections: 0,
  };
  private readonly status = statusCounters();
  private readonly backendStatus = statusCounters();
  private readonly localStatus = statusCounters();
  private responsesCompleted = 0;
  private responsesIncomplete = 0;
  readonly latency = new LatencyHistogram();
  readonly headersLatency = new LatencyHistogram();

  begin(): void {
    this.requests.total++;
    this.requests.active++;
  }

  settle(
    outcome: Outcome,
    reason: Reason | undefined,
    complete: boolean,
    origin: "backend" | "loadPilot",
    status: number,
    duration: number,
  ): void {
    this.requests.active--;
    this.requests[outcome]++;
    if (reason) this.requests[reason]++;
    if (!complete) this.responsesIncomplete++;
    else {
      this.responsesCompleted++;
      const category = statusCategory(status);
      if (category) {
        this.status[category]++;
        (origin === "backend" ? this.backendStatus : this.localStatus)[
          category
        ]++;
      }
    }
    this.latency.record(duration);
  }

  snapshot(): AggregateMetrics {
    return Object.freeze({
      requests: Object.freeze({ ...this.requests }),
      responses: Object.freeze({
        ...this.status,
        completed: this.responsesCompleted,
        incomplete: this.responsesIncomplete,
        backend: Object.freeze({ ...this.backendStatus }),
        loadPilot: Object.freeze({ ...this.localStatus }),
      }),
      latency: this.latency.snapshot(),
      upstreamHeadersLatency: this.headersLatency.snapshot(),
    });
  }
}

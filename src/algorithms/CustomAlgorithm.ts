/** Immutable data for one currently eligible, continuous backend registration. */
export interface CustomAlgorithmCandidate {
  readonly id: number;
  readonly baseUrl: string;
  readonly weight: number;
  readonly registrations: number;
  /** Outstanding proxied HTTP exchanges, independent of optional metrics. */
  readonly activeRequests: number;
  /** EWMA of dispatch-to-response-headers latency for completed exchanges. */
  readonly latencyMs: number | undefined;
}

/** Trusted synchronous application code. Return an eligible candidate ID or undefined to decline. */
export interface CustomAlgorithm {
  select(candidates: readonly CustomAlgorithmCandidate[]): number | undefined;
}

/** Called once per pool. Return a fresh strategy object for independent state. */
export type CustomAlgorithmFactory = () => CustomAlgorithm;

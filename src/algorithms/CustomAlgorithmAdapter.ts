import type { CustomAlgorithm, CustomAlgorithmCandidate, CustomAlgorithmFactory } from "./CustomAlgorithm.js";
import type { AlgorithmStrategy, SelectionContext, SchedulingState, RequestSettlement } from "./SchedulingTypes.js";
import { reserveRequest } from "./reserveRequest.js";

const owned = new WeakSet<CustomAlgorithm>();

/** Adapts public immutable snapshots to internal scheduling and owns no transport resources. */
export class CustomAlgorithmAdapter implements AlgorithmStrategy {
  private readonly algorithm: CustomAlgorithm;
  private selecting = false;

  constructor(factory: CustomAlgorithmFactory) {
    if (typeof factory !== "function") throw new Error("customAlgorithm must be a factory.");
    const algorithm = factory();
    if (!algorithm || typeof algorithm !== "object" || typeof algorithm.select !== "function")
      throw new Error("customAlgorithm factory must return a strategy with select().");
    if (owned.has(algorithm)) throw new Error("customAlgorithm factory must return a fresh strategy per pool.");
    owned.add(algorithm);
    this.algorithm = algorithm;
  }

  select(context: SelectionContext): number | undefined {
    if (this.selecting) throw new Error("Custom algorithm selection is not reentrant.");
    const candidates = context.candidates();
    if (!candidates.length) return undefined;
    const snapshots: readonly CustomAlgorithmCandidate[] = Object.freeze(candidates.map(candidate =>
      Object.freeze({
        id: candidate.backendId,
        baseUrl: candidate.baseUrl,
        weight: candidate.state.weight,
        registrations: candidate.state.registrations,
        activeRequests: candidate.state.activeRequests,
        latencyMs: candidate.state.latencyMs,
      }),
    ));
    this.selecting = true;
    try {
      const id: unknown = this.algorithm.select(snapshots);
      // An accidental async implementation must not create an unhandled rejection.
      if (id instanceof Promise) {
        void id.catch(() => {});
        throw new Error("Custom algorithm select() must be synchronous.");
      }
      if (id === undefined) return undefined;
      const selected = candidates.find(candidate => candidate.backendId === id);
      if (!selected) throw new Error("Custom algorithm must return an eligible backend ID.");
      return selected.index;
    } finally {
      this.selecting = false;
    }
  }

  beginRequest(state: SchedulingState): RequestSettlement {
    return reserveRequest(state, true);
  }
}

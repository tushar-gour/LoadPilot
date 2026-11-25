import RoundRobin from "./RoundRobin.js";

export enum Algorithm {
  ROUND_ROBIN = "round-robin",
  WEIGHTED_ROUND_ROBIN = "weighted-round-robin",
  RANDOM = "random",
  LEAST_CONNECTIONS = "least-connections",
  WEIGHTED_LEAST_CONNECTIONS = "weighted-least-connections",
  LEAST_RESPONSE_TIME = "least-response-time",
}

/** Mutable scheduling state belongs to one continuous pool registration. */
export interface SchedulingState {
  readonly weight: number;
  registrations: number;
  activeRequests: number;
  latencyMs: number | undefined;
  credit: number;
  lastSelected: number;
}
export interface SchedulingCandidate {
  readonly index: number;
  readonly state: SchedulingState;
}

const effectiveWeight = (state: SchedulingState): number =>
  state.weight * state.registrations;

class AlgorithmDispatcher {
  getNextIndex(
    algo: Algorithm,
    currentIndex: number,
    totalItems: number,
  ): number {
    if (algo !== Algorithm.ROUND_ROBIN)
      throw new Error(`Unsupported index-only algorithm: ${String(algo)}`);
    return RoundRobin.getNextIndex(currentIndex, totalItems);
  }

  /** The pool has already filtered health and ordered candidates for tie-breaking. */
  select(
    algo: Algorithm,
    candidates: readonly SchedulingCandidate[],
    selection: number,
  ): SchedulingCandidate | undefined {
    if (candidates.length === 0) return undefined;
    switch (algo) {
      case Algorithm.WEIGHTED_ROUND_ROBIN: {
        // Smooth weighted round robin: one credit per identity, no expanded weight array.
        let total = 0;
        let chosen = candidates[0]!;
        for (const candidate of candidates) {
          const weight = effectiveWeight(candidate.state);
          total += weight;
          candidate.state.credit += weight;
          if (candidate.state.credit > chosen.state.credit) chosen = candidate;
        }
        chosen.state.credit -= total;
        return chosen;
      }
      case Algorithm.RANDOM:
        return candidates[Math.floor(Math.random() * candidates.length)];
      case Algorithm.LEAST_CONNECTIONS:
        return this.minimum(candidates, (state) => state.activeRequests);
      case Algorithm.WEIGHTED_LEAST_CONNECTIONS:
        return this.minimum(
          candidates,
          (state) => state.activeRequests / effectiveWeight(state),
        );
      case Algorithm.LEAST_RESPONSE_TIME: {
        // Give each registration one initial opportunity, not endless priority
        // when a failed/cancelled first request produces no valid latency sample.
        const cold = candidates.find(
          (candidate) =>
            candidate.state.lastSelected === 0 &&
            candidate.state.activeRequests === 0,
        );
        if (cold) return cold;
        // Deterministic exploration prevents permanently starving slower/stale observations.
        if (selection % 32 === 0)
          return this.minimum(candidates, (state) => state.lastSelected);
        const measured = candidates.filter(
          (candidate) => candidate.state.latencyMs !== undefined,
        );
        if (!measured.length)
          return this.minimum(candidates, (state) => state.activeRequests);
        return this.minimum(
          measured,
          (state) => state.latencyMs!,
          (state) => state.activeRequests,
        );
      }
      default:
        throw new Error(
          `Unsupported load balancing algorithm: ${String(algo)}`,
        );
    }
  }

  private minimum(
    candidates: readonly SchedulingCandidate[],
    score: (state: SchedulingState) => number,
    tieScore?: (state: SchedulingState) => number,
  ): SchedulingCandidate {
    let best = candidates[0]!;
    for (let index = 1; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const value = score(candidate.state),
        previous = score(best.state);
      if (
        value < previous ||
        (value === previous &&
          tieScore &&
          tieScore(candidate.state) < tieScore(best.state))
      )
        best = candidate;
    }
    return best;
  }
}

export const Algorithms = new AlgorithmDispatcher();

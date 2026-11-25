import { effectiveWeight } from "./effectiveWeight.js";
import type { AlgorithmStrategy, SelectionContext, SchedulingState } from "./SchedulingTypes.js";
export class WeightedRoundRobin implements AlgorithmStrategy {
  private eligible = new Set<SchedulingState>();

  membershipChanged(states: Iterable<SchedulingState>): void {
    for (const state of states) state.credit = 0;
    this.eligible.clear();
  }

  select(context: SelectionContext): number | undefined {
    const candidates = context.candidates();
    const eligible = new Set(candidates.map(candidate => candidate.state));
    if (eligible.size !== this.eligible.size || [...eligible].some(state => !this.eligible.has(state))) {
      this.membershipChanged(this.eligible);
      for (const state of eligible) state.credit = 0;
      this.eligible = eligible;
    }
    let chosen = candidates[0];
    if (!chosen) return undefined;
    let total = 0;
    for (const candidate of candidates) {
      const weight = effectiveWeight(candidate.state);
      total += weight;
      candidate.state.credit += weight;
      if (candidate.state.credit > chosen.state.credit) chosen = candidate;
    }
    chosen.state.credit -= total;
    return chosen.index;
  }
}

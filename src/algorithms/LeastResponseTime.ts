import { minimumCandidate } from "./minimumCandidate.js";
import { reserveRequest } from "./reserveRequest.js";
import type { AlgorithmStrategy, SelectionContext, SchedulingState, RequestSettlement, SchedulingCandidate } from "./SchedulingTypes.js";
export class LeastResponseTime implements AlgorithmStrategy {
  private selectionCount = 0;

  select(context: SelectionContext): number | undefined {
    const candidates = context.candidates();
    let selected: SchedulingCandidate | undefined = candidates.find(candidate =>
      candidate.state.lastSelected === 0 && candidate.state.activeRequests === 0);
    if (!selected) {
      if ((this.selectionCount + 1) % 32 === 0) {
        selected = minimumCandidate(candidates, state => state.lastSelected);
      } else {
        const measured = candidates.filter(candidate => candidate.state.latencyMs !== undefined);
        selected = measured.length
          ? minimumCandidate(measured, state => state.latencyMs!, state => state.activeRequests)
          : minimumCandidate(candidates, state => state.activeRequests);
      }
    }
    if (!selected) return undefined;
    selected.state.lastSelected = ++this.selectionCount;
    return selected.index;
  }

  beginRequest(state: SchedulingState): RequestSettlement {
    return reserveRequest(state, true);
  }
}

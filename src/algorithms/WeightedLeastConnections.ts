import { effectiveWeight } from "./effectiveWeight.js";
import { minimumCandidate } from "./minimumCandidate.js";
import { reserveRequest } from "./reserveRequest.js";
import type { AlgorithmStrategy, SelectionContext, SchedulingState, RequestSettlement } from "./SchedulingTypes.js";
export class WeightedLeastConnections implements AlgorithmStrategy {
  select(context: SelectionContext): number | undefined {
    return minimumCandidate(context.candidates(), state => state.activeRequests / effectiveWeight(state))?.index;
  }
  beginRequest(state: SchedulingState): RequestSettlement {
    return reserveRequest(state);
  }
}

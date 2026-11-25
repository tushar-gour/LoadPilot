import { minimumCandidate } from "./minimumCandidate.js";
import { reserveRequest } from "./reserveRequest.js";
import type { AlgorithmStrategy, SelectionContext, SchedulingState, RequestSettlement } from "./SchedulingTypes.js";
export class LeastConnections implements AlgorithmStrategy {
  select(context: SelectionContext): number | undefined {
    return minimumCandidate(context.candidates(), state => state.activeRequests)?.index;
  }
  beginRequest(state: SchedulingState): RequestSettlement {
    return reserveRequest(state);
  }
}

import type { RequestSettlement, SchedulingState } from "./SchedulingTypes.js";
/** A reservation captures its registration lifetime, not the server identity. */
export function reserveRequest(state: SchedulingState, trackLatency = false): RequestSettlement {
  state.activeRequests++;
  let settled = false;
  return (headersMs) => {
    if (settled) return;
    settled = true;
    state.activeRequests--;
    if (trackLatency && headersMs !== undefined && Number.isFinite(headersMs) && headersMs >= 0) {
      state.latencyMs = state.latencyMs === undefined ? headersMs : 0.2 * headersMs + 0.8 * state.latencyMs;
    }
  };
}

import type { SchedulingState } from "./SchedulingTypes.js";
export const effectiveWeight = (state: SchedulingState): number => state.weight * state.registrations;

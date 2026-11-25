import type { AlgorithmStrategy, SelectionContext } from "./SchedulingTypes.js";
export class RoundRobin implements AlgorithmStrategy {
  select(context: SelectionContext): number | undefined {
    return context.firstEligible();
  }
}

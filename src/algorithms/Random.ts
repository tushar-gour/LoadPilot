import type { AlgorithmStrategy, SelectionContext } from "./SchedulingTypes.js";
export class Random implements AlgorithmStrategy {
  select(context: SelectionContext): number | undefined {
    const candidates = context.candidates(true);
    return candidates[Math.floor(Math.random() * candidates.length)]?.index;
  }
}

import type { SchedulingCandidate, SchedulingState } from "./SchedulingTypes.js";
export function minimumCandidate(
  candidates: readonly SchedulingCandidate[],
  score: (state: SchedulingState) => number,
  tieScore?: (state: SchedulingState) => number,
): SchedulingCandidate | undefined {
  let best = candidates[0];
  if (!best) return undefined;
  for (let index = 1; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    const value = score(candidate.state), previous = score(best.state);
    if (value < previous || (value === previous && tieScore &&
      tieScore(candidate.state) < tieScore(best.state))) best = candidate;
  }
  return best;
}

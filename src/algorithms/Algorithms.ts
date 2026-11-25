import { Algorithm } from "./Algorithm.js";
import { RoundRobin } from "./RoundRobin.js";
import { WeightedRoundRobin } from "./WeightedRoundRobin.js";
import { Random } from "./Random.js";
import { LeastConnections } from "./LeastConnections.js";
import { WeightedLeastConnections } from "./WeightedLeastConnections.js";
import { LeastResponseTime } from "./LeastResponseTime.js";
import type { AlgorithmStrategy } from "./SchedulingTypes.js";

export { Algorithm } from "./Algorithm.js";

/** Composition root for built-in strategies. Each pool gets its own instance. */
const factories: Readonly<Record<Algorithm, () => AlgorithmStrategy>> = Object.freeze({
  [Algorithm.ROUND_ROBIN]: () => new RoundRobin(),
  [Algorithm.WEIGHTED_ROUND_ROBIN]: () => new WeightedRoundRobin(),
  [Algorithm.RANDOM]: () => new Random(),
  [Algorithm.LEAST_CONNECTIONS]: () => new LeastConnections(),
  [Algorithm.WEIGHTED_LEAST_CONNECTIONS]: () => new WeightedLeastConnections(),
  [Algorithm.LEAST_RESPONSE_TIME]: () => new LeastResponseTime(),
});

export function createAlgorithm(algorithm: Algorithm): AlgorithmStrategy {
  if (!Object.prototype.hasOwnProperty.call(factories, algorithm))
    throw new Error("Unsupported load balancing algorithm.");
  return factories[algorithm]();
}

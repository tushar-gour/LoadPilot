import RoundRobin from "./RoundRobin.js";

export enum Algorithm {
  ROUND_ROBIN = "round-robin",
}

class AlgorithmDispatcher {
  getNextIndex(algo: Algorithm, currentIndex: number, totalItems: number): number {
    switch (algo) {
      case Algorithm.ROUND_ROBIN:
        return RoundRobin.getNextIndex(currentIndex, totalItems);
      default:
        throw new Error(`Unsupported load balancing algorithm: ${String(algo)}`);
    }
  }
}

export const Algorithms = new AlgorithmDispatcher();

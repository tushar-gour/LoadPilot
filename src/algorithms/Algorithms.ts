import RoundRobin from "./RoundRobin.js";

enum algorithm {
  ROUND_ROBIN,
}

class Algorithms {
  getNextIndex(algo: algorithm, currentIndex: number, totalItems: number) {
    switch (algo) {
      case algorithm.ROUND_ROBIN:
        return RoundRobin.getNextIndex(currentIndex, totalItems);
    }
  }
}

const Algorithm = new Algorithms();

export { algorithm, Algorithm };

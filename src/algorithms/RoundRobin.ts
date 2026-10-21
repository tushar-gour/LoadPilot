class RoundRobin {
  public getNextIndex(currentIndex: number, totalItems: number): number {
    if (totalItems <= 0) {
      throw new Error("Total items must be greater than zero.");
    }
    return (currentIndex + 1) % totalItems;
  }
}

export default new RoundRobin();

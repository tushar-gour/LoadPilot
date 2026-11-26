import type { Server } from "./Server.js";
import type { Registration } from "./BackendRegistration.js";
import type { AlgorithmStrategy, SchedulingCandidate, SelectionContext, RequestSettlement } from "../algorithms/SchedulingTypes.js";

/** Owns cursor and scheduling orchestration; never makes health decisions. */
export class PoolScheduler implements SelectionContext {
  private cursor = 0;
  private membershipVersion = 0;

  constructor(
    private readonly strategy: AlgorithmStrategy,
    private readonly slots: readonly Server[],
    private readonly registrations: ReadonlyMap<Server, Registration>,
    private readonly isEligible: (server: Server) => boolean,
  ) {}

  membershipChanged(removedIndex?: number): void {
    this.membershipVersion++;
    if (removedIndex !== undefined && removedIndex < this.cursor) this.cursor--;
    if (this.cursor >= this.slots.length) this.cursor = 0;
    this.strategy.membershipChanged?.(this.registrations.values());
  }

  firstEligible(): number | undefined {
    const count = this.slots.length;
    for (let offset = 0; offset < count; offset++) {
      const index = (this.cursor + offset) % count;
      if (this.isEligible(this.slots[index]!)) return index;
    }
    return undefined;
  }

  candidates(includeDuplicateSlots = false): readonly SchedulingCandidate[] {
    const result: SchedulingCandidate[] = [];
    const seen = new Set<Registration>();
    const count = this.slots.length;
    for (let offset = 0; offset < count; offset++) {
      const index = (this.cursor + offset) % count;
      const server = this.slots[index]!;
      if (!this.isEligible(server)) continue;
      const registration = this.registrations.get(server)!;
      if (includeDuplicateSlots || !seen.has(registration)) result.push({ index, backendId: registration.id, baseUrl: server.baseUrl, state: registration });
      seen.add(registration);
    }
    return result;
  }

  select(): Server | null {
    const version = this.membershipVersion;
    const index = this.strategy.select(this);
    if (version !== this.membershipVersion) throw new Error("Backend membership changed during selection.");
    if (index === undefined) return null;
    const selected = this.slots[index];
    if (!selected || !Number.isInteger(index) || !this.isEligible(selected))
      throw new Error("Algorithm selected an invalid or ineligible backend.");
    this.cursor = (index + 1) % this.slots.length;
    return selected;
  }

  beginRequest(server: Server): RequestSettlement | undefined {
    if (!this.strategy.beginRequest) return undefined;
    const registration = this.registrations.get(server);
    if (!registration) throw new Error("Cannot reserve an unregistered backend.");
    return this.strategy.beginRequest(registration);
  }
}

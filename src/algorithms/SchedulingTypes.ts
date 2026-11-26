/** Internal state for one continuous backend registration. */
export interface SchedulingState {
  readonly weight: number;
  registrations: number;
  activeRequests: number;
  latencyMs: number | undefined;
  credit: number;
  lastSelected: number;
}
export interface SchedulingCandidate {
  readonly index: number;
  readonly backendId: number;
  readonly baseUrl: string;
  readonly state: SchedulingState;
}
export interface SelectionContext {
  firstEligible(): number | undefined;
  candidates(includeDuplicateSlots?: boolean): readonly SchedulingCandidate[];
}
export type RequestSettlement = (headersMs?: number) => void;
export interface AlgorithmStrategy {
  select(context: SelectionContext): number | undefined;
  membershipChanged?(states: Iterable<SchedulingState>): void;
  beginRequest?(state: SchedulingState): RequestSettlement;
}

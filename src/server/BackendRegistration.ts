import type { Server } from "./Server.js";
import type { SchedulingState } from "../algorithms/SchedulingTypes.js";
/** Identity for one continuous registration lifetime of a Server. */
export interface BackendRegistration {
  readonly id: number;
  readonly server: Server;
  readonly registrations: number;
}
export interface Registration extends BackendRegistration, SchedulingState {
  registrations: number;
}

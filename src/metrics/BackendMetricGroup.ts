import type { BackendRegistration } from "../server/ServerPool.js";
import { MetricGroup } from "./MetricGroup.js";
export class BackendMetricGroup extends MetricGroup {
  constructor(readonly registration: BackendRegistration) {
    super();
  }
}

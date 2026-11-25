import type { BackendRegistration } from "../server/ServerPool.js";
import { MetricGroup } from "./MetricGroup.js";
import { BackendMetricGroup } from "./BackendMetricGroup.js";
export class PoolMetricGroup extends MetricGroup {
  readonly backends = new WeakMap<BackendRegistration, BackendMetricGroup>();
  readonly activeBackends = new Set<BackendMetricGroup>();

  backend(registration: BackendRegistration): BackendMetricGroup {
    let group = this.backends.get(registration);
    if (!group) {
      group = new BackendMetricGroup(registration);
      this.backends.set(registration, group);
    }
    return group;
  }
}

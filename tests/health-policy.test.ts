import { test } from "node:test";
import assert from "node:assert/strict";
import { HealthState } from "../src/index.js";
import { HealthTransitionPolicy, type HealthTransitionState } from "../src/health/HealthTransitionPolicy.js";

test("Health policy independently applies thresholds, saturation, recovery and reset", () => {
  const policy = new HealthTransitionPolicy({healthyThreshold:2,unhealthyThreshold:3});
  const record: HealthTransitionState = {state:HealthState.UNKNOWN,consecutiveSuccesses:0,consecutiveFailures:0};
  policy.apply(record,true); assert.equal(record.state,HealthState.HEALTHY);
  for(let i=0;i<2;i++)policy.apply(record,false);
  assert.equal(record.state,HealthState.HEALTHY);
  policy.apply(record,true); assert.equal(record.consecutiveFailures,0);
  for(let i=0;i<5;i++)policy.apply(record,false);
  assert.equal(record.state,HealthState.UNHEALTHY); assert.equal(record.consecutiveFailures,3);
  policy.apply(record,true); assert.equal(record.state,HealthState.UNHEALTHY);
  policy.apply(record,true); assert.equal(record.state,HealthState.HEALTHY);
  policy.apply(record,true); assert.equal(record.consecutiveSuccesses,2);
  policy.reset(record); assert.deepEqual(record,{state:HealthState.UNKNOWN,consecutiveSuccesses:0,consecutiveFailures:0});
});

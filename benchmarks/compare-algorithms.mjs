import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw Error("Usage: npm run bench:compare-algorithms -- <baseline.json> <candidate.json>");
const read = path => JSON.parse(readFileSync(path,"utf8"));
const baseline=read(beforePath), candidate=read(afterPath);
const validate = report => {
  assert.equal(report.schemaVersion,1);
  assert.equal(report.executionStatus,"completed");
  assert.match(report.environment.gitCommit,/^[a-f0-9]{40}$/);
  assert.equal(report.environment.workingTreeDirty,false,"Benchmark requires a clean tracked working tree");
  const {profiles,algorithms,repetitions}=report.configuration;
  assert.ok(Number.isInteger(repetitions)&&repetitions>=2,"Use at least two repetitions");
  assert.equal(report.rows.length,profiles.length*algorithms.length*repetitions);
  const seen=new Set();
  for(const row of report.rows){
    assert.ok(profiles.includes(row.profile)&&algorithms.includes(row.algorithm));
    assert.ok(Number.isInteger(row.repetition)&&row.repetition>=1&&row.repetition<=repetitions);
    const key=JSON.stringify([row.profile,row.algorithm,row.repetition]);
    assert.ok(!seen.has(key));seen.add(key);
    assert.equal(row.passed,true);
    assert.ok(row.result.completed>0);
    assert.equal(row.result.attempted,row.result.completed);
    assert.equal(row.result.failed+row.result.cancelled,0);
    for(const n of [row.result.requestsPerSecond,row.result.latencyMs.p95])assert.ok(Number.isFinite(n)&&n>0);
  }
};
validate(baseline);validate(candidate);
assert.notEqual(baseline.environment.gitCommit,candidate.environment.gitCommit);
assert.deepEqual(baseline.configuration,candidate.configuration,"Benchmark settings differ");
for(const key of ["node","platform","osRelease","cpu","logicalCpus","totalRamBytes","gcExposed"])
  assert.equal(baseline.environment[key],candidate.environment[key],`Environment differs: ${key}`);
const median = values => {const s=[...values].sort((a,b)=>a-b);const mid=Math.floor(s.length/2);return s.length%2?s[mid]:(s[mid-1]+s[mid])/2;};
const group=(report,profile,algorithm)=>report.rows.filter(r=>r.profile===profile&&r.algorithm===algorithm);
const pct=(a,b)=>100*(b/a-1);
const table=[];
for(const profile of baseline.configuration.profiles)for(const algorithm of baseline.configuration.algorithms){
  const a=group(baseline,profile,algorithm),b=group(candidate,profile,algorithm);
  const before=median(a.map(r=>r.result.requestsPerSecond)),after=median(b.map(r=>r.result.requestsPerSecond));
  const p95Before=median(a.map(r=>r.result.latencyMs.p95)),p95After=median(b.map(r=>r.result.latencyMs.p95));
  table.push({profile,algorithm,before:before.toFixed(1),after:after.toFixed(1),rpsChangePct:pct(before,after).toFixed(1),p95Before:p95Before.toFixed(2),p95After:p95After.toFixed(2),p95ChangePct:pct(p95Before,p95After).toFixed(1)});
}
console.log(`Baseline ${baseline.environment.gitCommit}; candidate ${candidate.environment.gitCommit}`);
console.table(table);
const flagged=table.filter(row=>Number(row.rpsChangePct)<-15||Number(row.p95ChangePct)>15);
console.log(`${flagged.length} of ${table.length} comparisons crossed the descriptive 15% review threshold.`);
console.log("A descriptive short-run comparison, not a statistical non-regression proof; shared-host noise and sequential ordering can affect results.");

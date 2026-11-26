# Release checklist

Release candidate: 0.2.0. The v0.1.0 package was the initial public release. This minor release adds public per-pool custom scheduling, isolates health transition policy and metrics snapshot assembly, and includes the prior architecture refactor.

## Before publication

- [ ] Inspect all refs/history for secrets with a dedicated scanner (e.g. Gitleaks), including removed files; review findings and rotate real credentials.
- [ ] Confirm fixture keys are synthetic and not reused. Review repository metadata, issues, PRs, Actions logs and artifacts.
- [ ] Pass the six CI jobs, local typecheck, tests, build, package-consumer check, pack dry run, and npm audit.
- [ ] Review matched-workload post-refactor benchmark evidence. Historical benchmark results are tied to their recorded commits; short comparisons are not production capacity or memory certification.
- [ ] Verify the exact release version is unpublished and the authenticated npm user has publisher access.
- [ ] Review generated npm archive; only distribution output, license, README and package metadata should ship.

```sh
git fetch origin
git merge --ff-only origin/main
npm ci
npm run typecheck
npm test
npm run build
npm run check:package
npm audit
npm pack --dry-run
npm view loadpilot version
npm whoami
npm publish --dry-run
```

After verification, publish with npm's supported MFA process:

```sh
npm publish --access public
npm view loadpilot@0.2.0 version
```

If npm stages publication, review and approve the staged version using the authenticated npm account. Verify that 0.2.0 is the operational public version, then create the matching GitHub v0.2.0 release from the verified commit. Never overwrite existing npm versions or publish credentials.

## Performance and reliability evidence

The 30-minute v0.1.0 rerun with corrected sampling completed and passed correctness and resource cleanup; the memory classifier was inconclusive, not a leak-free result. The refactor and v0.2.0 require their own evidence. See benchmarks/README.md and ARCHITECTURE.md.

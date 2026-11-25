# Initial release checklist

Release candidate: 0.1.0 (early-stage library). The package already declares ISC; the root LICENSE makes that declaration explicit.

## Before publication

- [ ] Inspect all refs/history for secrets with a dedicated scanner (e.g. Gitleaks), including removed files; review every finding and rotate real credentials.
- [ ] Verify fixture keys are synthetic and not reused. Review repository metadata, issues, PRs, Actions logs and artifacts for sensitive material before public visibility.
- [ ] Pass typecheck, automated tests, build, package-consumer check, pack dry run, and npm audit.
- [ ] Repeat extended soak with corrected time sampling; publish the measured classification and limitations, not a leak-free claim.
- [ ] Verify npm package name and publisher access; if occupied, choose a scoped package and update imports/docs/lockfile together.
- [ ] Review the generated npm archive and ensure only distribution output, license, README and package metadata are shipped.
- [ ] Make repository public using GitHub settings only after review.

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

An npm E404 for the public package is not a guarantee that a name can be registered; check ownership and npm policy. Authenticate locally with npm's supported publishing process and MFA; do not commit tokens. Once the gates pass, run `npm publish --access public` and verify `npm view loadpilot@0.1.0 version`. Create the matching GitHub v0.1.0 release from the verified commit, including limitations and evidence. Do not republish or overwrite an existing version.

The 30-minute soak submitted for the earlier commit passed correctness checks, but its retained checkpoint distribution was incomplete. A new run is required for the corrected diagnostic.

# Repository Guidelines

These permanent instructions apply to all subsequent tasks in `tushar-gour/LoadPilot`.

## Architecture and conventions

Preserve `LoadPilot → RouteMatcher → ServerPool → HttpProxy → Backend`. Health monitoring controls backend eligibility within each pool; it does not replace the selection algorithm. Preserve existing tests, architectural boundaries, and unrelated developer work. Use strict TypeScript with NodeNext ES modules and `.js` suffixes in relative imports.

## Verification

Run the applicable checks before committing:

```sh
git status
git diff --check
git diff --stat
npm run typecheck
npm test
npm run build
npm pack --dry-run --cache .npm
```

The test command uses Node's test runner through `tsx`. For a focused run, use `npx tsx --test --test-name-pattern="pattern" tests/health.test.ts`. Review untracked file contents separately: `git diff` does not include them. Review staged changes with `git diff --cached --check` and `git diff --cached --stat`.

## Automatic GitHub synchronization

After **every implementation, refactoring, bug fix, test update, or documentation task**:

1. Inspect `git status` and review every modified, added, deleted, and untracked file.
2. Include all files belonging to the completed task, including new source, tests, documentation, and configuration.
3. Never commit secrets, credentials, `.env` files, local caches, generated files excluded by `.gitignore`, or unrelated user changes.
4. Run applicable verification commands and resolve failures before committing.
5. Stage only the intended, reviewed files.
6. Create a descriptive Git commit. Existing history uses prefixes such as `feat:`, `refactor:`, `chore:`, and `style:`.
7. Push to `origin` on the current intended branch. Use `main` for normal development when it is active and no other branch was requested.
8. Confirm the remote branch SHA matches `git rev-parse HEAD`, using `git ls-remote origin refs/heads/<branch>`.
9. If pushing fails, report the error and do not claim GitHub was updated.

Never force-push, overwrite remote changes, or use destructive Git commands. If unrelated uncommitted changes prevent a safe push, preserve them and report the blocker. **Do not stop after implementation: Git synchronization is part of every completed task.**

## File paths and final report

Every final response must provide repository-relative paths for every created, updated, or deleted file, such as `src/LoadPilot.ts` or `tests/health.test.ts`. Never report only absolute Windows paths. Also provide GitHub file links where possible, using the actual pushed branch:

`https://github.com/tushar-gour/LoadPilot/blob/<branch>/src/LoadPilot.ts`

After every task, report:

- Implementation summary and all changed repository-relative file paths.
- Actual tests passed, failed, and skipped; TypeScript and build verification results.
- Remaining limitations or issues.
- Git branch, commit SHA, and commit URL.
- Push confirmation and remaining uncommitted changes, if any.

## Source of truth

GitHub must contain the latest completed and verified version of LoadPilot. Do not report a task as fully synchronized unless its intended changes are available on the remote repository and the remote SHA has been verified.

# Contributing to Golem

Security issues should go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

```bash
git clone https://github.com/ryanthegentry/golem.git
cd golem
npm install
npm test
```

## Development Flow

1. Fork the repo and create a topic branch off `main`.
2. Keep PRs focused on one concern.
3. Add or update tests for code changes.
4. Run `npm test` before opening a PR.
5. Open a PR with a clear summary, linked issue, and test notes.

## Bug-Fix Protocol

When fixing a bug:

1. First write a failing test that reproduces the bug exactly.
2. Verify the test fails for the right reason.
3. Fix the bug with the minimum change required.
4. Verify the test now passes.
5. Run the full test suite to confirm no regressions.

If you cannot write a failing test, the bug is not well enough understood to fix.

## Commit Messages

Conventional commits are preferred:

- `feat:` for user-visible features.
- `fix:` for bug fixes.
- `docs:` for documentation-only changes.
- `test:` for test-only changes.
- `chore:` for maintenance and repository hygiene.

## Code Style

Use the existing TypeScript style in the surrounding files. The TypeScript
compiler and test suite are the source of truth for correctness.

## Extra Review Areas

Changes to covenant logic, signer boundaries, key handling, L402 authentication,
safe harbor exit, refresh scheduling, or auto-sweep behavior need extra review.
These areas affect custody, recovery, or payment verification.

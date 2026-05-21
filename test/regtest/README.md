# Golem regtest harness

End-to-end regtest stack for Golem's covenant primitives. Spins up:

| Service       | Image / source                                            | Host port      |
|---------------|-----------------------------------------------------------|----------------|
| bitcoin       | nigiri `--ci`                                             | 18443 (RPC)    |
| esplora       | nigiri chopsticks                                         | 3000           |
| arkd-wallet   | `ghcr.io/arkade-os/arkd-wallet:v0.9.3`                    | 6060           |
| arkd          | `arkade-os/arkd` v0.9.3 tag (built)                       | 7070, 7071     |
| introspector  | `/tmp/introspector` master HEAD (built)                   | 7073           |
| fulmine       | `/tmp/fulmine` PR #411 commit (built)                     | 7000, 7001     |
| bancod        | `ghcr.io/arkade-os/bancod:v0.0.1-rc.5`                    | 7270, 7271     |
| nbxplorer     | `nicolasdorier/nbxplorer:2.5.30`                          | 32838          |
| pgnbxplorer   | `postgres:16`                                             | 5433           |

The Introspector compose at `/tmp/introspector/docker-compose.regtest.yml` is the base.
The Golem-owned override at `docker-compose.override.yml` (next to this README) adds Fulmine + bancod + a `nbxplorer` healthcheck gate.

## Why Fulmine + bancod

Golem's covenant primitives (`covenant-claim.ts`, `covenant-lifecycle.ts`) were proven against
hand-rolled VHTLC fixtures. The `covenant-receive-e2e.ts` test closes the loop: it asks
**Fulmine via gRPC** to create a `NonInteractiveClaim` VHTLC (ArkLabsHQ/fulmine PR #411), then
exercises Golem's `CovenantClaimHandler` against it. That proves cross-implementation wire
compatibility for Path B, ahead of Boltz shipping the production version.

**bancod** is included because Fulmine's compose declares it as a dependency. Golem itself
self-solves (holds its own preimage, claims itself) and never calls bancod — but Fulmine's
process model expects it to be available.

## PR #411 commit pin

Source of truth — keep in sync between `setup.sh` and `docker-compose.override.yml`:

```
01c72a5b7e00b6b149c7cea995cea002b45835d2
```

If louisinger force-pushes the PR branch, `setup.sh` will fail at `git checkout <commit>`.
Look up the new HEAD via `gh pr view 411 --repo ArkLabsHQ/fulmine --json commits` and
update the pin in both files.

## Dependent unmerged PRs

PR #411 references unmerged upstream commits via Go module pseudo-versions in `/tmp/fulmine/go.mod`:

- `arkade-os/go-sdk` PR #182 — head `163178c642ed38b83a732bceb0ad121a2bb5aed1`
- `arkade-os/arkd`   PR #1068 — head `ae820b3a4d716202a378f333a3ba4237d2b1ff67`

`go mod download` fetches both directly from GitHub branches; no `replace` directives required.
When those PRs merge, Fulmine's `go.mod` will likely re-pin to released versions and the
pseudo-version handling here becomes irrelevant.

## Running

```bash
# First run (slow: builds Fulmine ~5-10 min, Introspector ~2-5 min)
./test/regtest/setup.sh

# Run tests
npx tsx test/regtest/covenant-claim.ts          # hand-rolled VHTLC (regression)
npx tsx test/regtest/covenant-lifecycle.ts      # consolidate + collab-spend (regression)
npx tsx test/regtest/covenant-receive-e2e.ts    # Fulmine sender → Golem self-solve (new)

# Tear down
./test/regtest/teardown.sh
```

## Troubleshooting

- **`unknown command: docker compose`** — the docker-compose plugin isn't wired. Run
  `python3 -c "import json,pathlib; p=pathlib.Path.home()/'.docker'/'config.json'; c=json.loads(p.read_text()); c['cliPluginsExtraDirs']=['/opt/homebrew/lib/docker/cli-plugins']; p.write_text(json.dumps(c,indent=2))"`.
- **`fulmine` container exits immediately** — almost always a dep resolution failure
  during `go mod download` if PRs #182 / #1068 have force-pushed since the pin was last
  updated. Check `docker logs fulmine` for the error and re-pin.
- **`docker logs introspector` shows `OP_INSPECTINPUTSCRIPTPUBKEY` errors** — Introspector
  master may have regressed PR #63. Pin `/tmp/introspector` to a known-good commit.
- **`covenant-claim.ts` and `covenant-lifecycle.ts` were green before, are now red** — likely
  a stack drift (image rebuild changed behavior). Run `teardown.sh && setup.sh` to rebuild
  from a clean slate.

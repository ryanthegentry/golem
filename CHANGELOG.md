# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Phase 1.5 covenant receive: end-to-end keyless lifecycle on regtest
  (claim + refresh + consolidate + post-consolidation refresh + re-consolidate)

## [0.1.0] - 2026-05-22

### Added

- Initial public release
- L402 gateway (dual-mode Lightning + Ark OOR) deployable to Railway
- `golem init` / `golem gateway` / `golem stats` / `golem pay` CLI
- ServerSigner (Phase 1: encrypted hot key)
- RefreshAgent (autonomous VTXO refresh, 60s polling)
- Auto-sweep to Lightning Address with circuit breaker
- 690 passing tests

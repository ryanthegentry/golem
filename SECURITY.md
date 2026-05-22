# Security Policy

## Reporting a Vulnerability

Please do not open a public GitHub issue for suspected vulnerabilities.

Email: **hello@402index.io**.

Please include:

- A description of the issue and, if possible, a minimal proof-of-concept.
- The affected component (covenant claim daemon, signer interface, L402 gateway, refresh agent, auto-sweep, CLI, etc.).
- Your assessment of impact and any suggested mitigations.

We will acknowledge receipt within 72 hours and aim to triage within a week. If
the issue is confirmed and fix-worthy, we will coordinate a disclosure timeline
with you, typically 30-90 days depending on severity and user-facing impact.
Credit is offered in release notes unless you prefer anonymity.

## Experimental Software Warning

Golem is experimental Bitcoin wallet software. Do not use it with funds you
cannot afford to lose.

Phase 1 uses `ServerSigner`, an encrypted hot key stored on the deployment
machine. This is a deliberate bootstrap trade-off, similar to running a
Lightning node hot wallet: compromise of the host can compromise funds reachable
by that key. Phase 1.5 covenant receive primitives are proven on regtest, but
production wiring and upstream support are still evolving.

## Scope

In scope:

- Covenant claim daemon and covenant refresh paths.
- Signer interface boundaries and `ServerSigner` key handling.
- L402 gateway challenge, macaroon, proxy, cache, and payment verification code.
- Refresh agent expiry handling and emergency exit triggers.
- Auto-sweep, safe-harbor, and reserve logic.
- CLI commands that create, import, encrypt, spend, sweep, or expose wallet state.

Out of scope:

- Experimental Ark protocol bugs or Arkade implementation bugs. Report those to
  Ark Labs upstream.
- Third-party services such as Boltz, Railway, Telegram, 402index.io, or external
  API providers unless the issue is caused by Golem's integration code.
- Social-engineering or physical attacks.
- Denial-of-service via ordinary resource exhaustion unless it demonstrates an
  amplification or asymmetric-cost vector.

## Hardening Posture

- Signing is routed through the `GolemSigner` interface.
- Key material must never be logged, included in error messages, or committed.
- Tests cover signer encryption, L402 macaroon verification, timing-safe preimage
  comparison, gateway method validation, safe harbor exit, refresh behavior, and
  covenant receive primitives.
- Security-sensitive bug fixes should follow the failing-test-first protocol in
  [CONTRIBUTING.md](CONTRIBUTING.md).

## Supported Versions

Security fixes are applied to `main`. There is currently no LTS branch policy.

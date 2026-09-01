# TEST_READY — authoritative validation baseline

This document describes the repository-wide readiness contract. It no longer freezes an old Phase 1 assertion count.

## What “ready” means

Repository policy considers a change ready for merge only when the authoritative CI matrix passes on both Ubuntu and Windows and no required gate is skipped, downgraded to a warning, or made conditional merely to obtain green status.

GitHub Actions is configured for pull-request and `main`-push events. Superseded first-attempt PR runs may be cancelled. Main pushes and reruns use SHA/attempt-scoped concurrency groups, so a newly queued validation run does not replace unrelated pending or running validation.

This is a readiness contract, not a GitHub-enforced merge rule: the repository currently has no branch protection/ruleset requiring successful CI, and GitHub-level skip instructions or manual cancellation can prevent a configured run from completing.

## Authoritative gates

The workflow currently enforces:

1. frozen architecture-boundary checks;
2. tracked-working-tree public-release/security hygiene;
3. TypeScript typechecking;
4. ESLint;
5. production browser build;
6. Electron desktop runtime build;
7. Electron desktop bootstrap tests;
8. the complete Vitest suite using the bounded CI worker profile;
9. focused replay verification;
10. the full `.property.test.` convention sweep;
11. the typed E2E interview script;
12. the synthetic interview smoke/demo path.

The complete Vitest suite is the authoritative repository-wide discovery gate. `vitest.config.ts` includes:

```text
tests/**/*.test.ts
tests/**/*.test.tsx
```

Therefore desktop tests, replay tests, property tests, adversarial tests, browser tests, quant tests, verification tests, speech/TTS tests, and `tests/e2e-typed-interview.test.ts` are all covered by full-suite discovery.

CI deliberately reruns the named desktop/replay/property/typed-E2E scripts as focused secondary gates. This both gives focused failure signal and validates those package-script contracts themselves. `pnpm test:property` uses Vitest's path filter on the `.property.test.` naming convention, so it does not rely on a stale hand-maintained list. These focused gates supplement rather than replace the full suite.

## Local aggregate

Run:

```bash
corepack pnpm check
```

The aggregate mirrors the CI categories:

```text
architecture boundaries
security:public
typecheck
lint
build:web
build:desktop
test:desktop
test:ci
test:replay
test:property
test:e2e
demo
```

## Audited repository inventory

At the 2026-09-01 authoritative-main audit:

- 109 Vitest test files matched the repository test naming convention;
- 3 app roots existed: web, server, desktop;
- 15 source-package directories existed under `packages/`;
- `workers/python` provided the isolated Python worker boundary.

These values are baseline observations, not permanent release thresholds. Avoid treating them as expected constants in documentation or CI.

## Coverage represented by the suite

The current test tree includes coverage for, among other areas:

- event sourcing, durable session lifecycle, idempotency, crash/restart and replay;
- delivery lifecycle, renderer transport and reconnect safety;
- public-release hygiene, redaction, loopback CORS/auth and repository boundaries;
- React/browser shell, real tldraw mounting and whiteboard revision synchronization;
- Electron bootstrap/runtime and renderer security boundaries;
- provider policy, execution safety and control-plane behavior;
- deterministic mathematical verification and formal interpretation routing;
- vision preprocessing, freshness and observation admission;
- VAD/STT and TTS bounded worker cores plus browser audio infrastructure;
- local worker/process supervision and local compute admission;
- grounded session evaluation and replay/history projections;
- Quant Trading and Quant Research engines/persistence;
- curated Oxford and quant problem-catalog integrity;
- typed end-to-end interview behavior and the synthetic smoke path.

Passing those tests does **not** imply every backend subsystem is production-wired. Product exposure is tracked separately in `PROJECT.md` and `docs/IMPLEMENTATION_MAP.md`.

## Evidence policy

Use current GitHub Actions results as authoritative execution evidence. Do not copy old “N tests passed” or “N source files scanned” values forward after the repository changes. When a fixed number is useful for an audit, label it with the audited date/baseline rather than presenting it as an invariant.

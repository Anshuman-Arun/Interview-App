# Test infrastructure

## Philosophy

The repository uses layered automated validation rather than a single legacy Phase 1 E2E checklist.

Tests should verify observable contracts and authoritative invariants, with adversarial cases around stale revisions, replay, cancellation, malformed external output, security boundaries, process failures, and cross-platform behavior. Test-only seams must not be documented as live product integrations.

## Runner and discovery

Vitest is the repository test runner. The authoritative full suite is:

```bash
corepack pnpm test
```

`vitest.config.ts` discovers all:

```text
tests/**/*.test.ts
tests/**/*.test.tsx
```

At the 2026-09-01 audit this matched 109 files.

CI uses `pnpm test:ci` for the same full discovery with one worker. This deliberately serializes the authoritative suite so subprocess-heavy repository/security tests cannot starve real local-worker integration tests on GitHub-hosted Windows; it does not change which files or assertions are discovered. The normal local `pnpm test` command keeps Vitest's default worker selection.

## Validation layers

### Static/release gates

- `pnpm security:public` — current tracked-working-tree hygiene and accidental sensitive/local-data checks. It does **not** audit Git history, GitHub issues/metadata, Actions artifacts, or dependency registries; those are separate public-release review surfaces.
- `node scripts/check-architecture-boundaries.mjs` — frozen project dependency and authority-boundary enforcement.
- `pnpm typecheck` — strict TypeScript validation.
- `pnpm lint` — ESLint.
- `pnpm build:web` — production Vite/browser build.
- `pnpm build:desktop` — Electron desktop TypeScript build.

### Full behavior gate

- `pnpm test` — every discovered Vitest file for normal local use.
- `pnpm test:ci` — the same discovery with one worker for the authoritative CI/check profile.

The tree contains unit, integration, adversarial, property, replay, browser, desktop, worker, quant, verification, persistence, transport, and typed E2E tests.

### Smoke gate

- `pnpm demo` — deterministic synthetic interview path through the admitted orchestration stack.

## Focused secondary gates

CI and `pnpm check` intentionally rerun these focused scripts after the full-suite gate:

- `pnpm test:desktop`
- `pnpm test:replay`
- `pnpm test:property` — all files following the `.property.test.` naming convention, serialized with one Vitest worker so SQLite/subprocess-heavy adversarial property files do not resource-contend with one another;
- `pnpm test:e2e`

They are also useful for local iteration. A focused gate passing is never sufficient evidence that the repository is merge-ready; full-suite discovery remains authoritative for repository-wide coverage. Running them in CI additionally prevents the named package scripts from silently becoming stale or broken.

## Major tested surfaces

Representative current surfaces include:

| Area | Representative coverage |
| --- | --- |
| Core authority | session writer, durable lifecycle, idempotency, state/reducer, restart recovery |
| Delivery | delivery lifecycle, crash handling, renderer streaming, deduplication, acknowledgements |
| Security | public-release checks, secret redaction, loopback CORS/auth, provider execution safety |
| Browser/UI | typed session shell, KaTeX, browser command client, real tldraw mounted integration |
| Desktop | Electron bootstrap, production/runtime boundaries, desktop hook/bootstrap behavior |
| Whiteboard/vision | shape normalization/revisions, dirty regions, preprocessing, freshness/admission |
| Speech/audio | browser audio infrastructure, VAD/STT core, TTS worker core, race/limit tests |
| Local runtime | local compute worker protocol/admission and child-process lifecycle supervision |
| Providers | Gemini seam tests, policy/billing admission, provider control plane and lifecycle |
| Formal reasoning | formal interpretation admission/routing and deterministic verifier families |
| Evaluation/replay | grounded session evaluator, replay/history projections, longitudinal/property checks |
| Quant | market-maker/trader engine, Quant Research engine and persistence/property tests |
| Problems | fixture integrity, provenance, expanded Oxford/quant catalogs |
| E2E/smoke | typed interview E2E and synthetic interview demo |

## Cross-platform CI

GitHub Actions runs the required validation on:

- `ubuntu-latest`
- `windows-latest`

for pull-request and `main`-push events.

The workflow uses `fail-fast: false` so one operating system failing does not hide the other platform's result. Superseded first-attempt PR runs may be cancelled. Main pushes and reruns use SHA/attempt-scoped concurrency so newly queued validation does not replace unrelated pending or running validation. Branch protection is not currently configured, and GitHub-level skip/manual-cancel behavior is outside this workflow guarantee.

## Quantitative claims

Do not encode old fixed totals such as “50 suites / 628 tests” as current readiness criteria. The repository changes quickly and those numbers were already stale. When counts are needed, derive them from the current tree or current test output and label the baseline date.

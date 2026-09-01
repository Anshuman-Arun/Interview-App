# Implementation map

This map describes the code that exists on the current repository baseline and, separately, whether the main application actually composes it.

## Status legend

| Status | Definition |
| --- | --- |
| `PRODUCTION_WIRED` | Reached by the current browser/Electron/server product composition. |
| `BACKEND_IMPLEMENTED` | Bounded implementation and tests exist, but the main product does not expose it end to end. |
| `RUNTIME_SEAM_ONLY` | Interface/adapter/runtime seam exists without the intended live runtime/model selected. |
| `TEST/HARNESS_ONLY` | Deterministic fake, fixture, synthetic path, or other non-production harness. |
| `DEFERRED` | Intentionally outside the current implementation milestone. |

## Authoritative product composition

```text
Electron trusted desktop bootstrap (current secure end-to-end host)
        |
        v
apps/web React/Vite renderer
  - typed interview UI
  - KaTeX
  - real Tldraw canvas
        |
        | authenticated loopback HTTP/SSE
        v
apps/server
  - LocalInterviewTransportRuntime
  - SessionRuntimeRegistry
  - SessionWriter -> SQLite semantic event log
  - ServerTurnOrchestrator
        |
        +--> sixPeopleProblem
        +--> Turn/Context/Disclosure/Provider coordinators
        +--> MockModelAdapter
        +--> RendererStreamServer
```

That is the current production interview path. The broader backend map below must not be read as evidence that every subsystem is selected by that path.

## Component-to-code map

| Capability | Main code | Status | Integration notes |
| --- | --- | --- | --- |
| Authoritative session state/events | `packages/events/src/*` | `PRODUCTION_WIRED` | Semantic events + pure reducer are authoritative state representation. |
| Serialized session writer/runtime registry | `packages/interview-engine/src/session-writer.ts` | `PRODUCTION_WIRED` | Application-owned single-writer mutation boundary. |
| SQLite persistence | `packages/persistence/src/*` | `PRODUCTION_WIRED` | Durable event log, processed requests and session projections. |
| Loopback commands + renderer stream | `apps/server/src/*`, `apps/web/src/command-client.ts`, `renderer-client.ts` | `PRODUCTION_WIRED` | Authenticated local HTTP/SSE command/delivery path. |
| Delivery lifecycle | `packages/delivery/src/*` | `PRODUCTION_WIRED` | Stable IDs, exposure/completion acknowledgements, reconnect safety. |
| Typed React/KaTeX interview shell | `apps/web/src/App.tsx`, components/hooks | `PRODUCTION_WIRED` | Main UI; currently Ramsey-specific. |
| Real tldraw canvas bridge | `WhiteboardCanvas.tsx`, `real-tldraw-editor.ts`, `tldraw-whiteboard-adapter.ts` | `PRODUCTION_WIRED` | Real `Tldraw` component is mounted; this is no longer merely an in-memory whiteboard harness. |
| Electron desktop runtime | `apps/desktop/src/*` | `PRODUCTION_WIRED` | Starts backend, serves/loads renderer, injects trusted auth, enforces navigation/permission policy. |
| Browser audio primitives | `apps/web/src/audio/*` | `RUNTIME_SEAM_ONLY` | Capture/playback/cancellation infrastructure exists; `useInterviewSession` deliberately installs a fail-closed placeholder instead of a physical audio player. |
| VAD/STT core | `packages/local-compute/src/speech-*.ts` | `BACKEND_IMPLEMENTED` | Bounded worker, PCM, VAD state machine and recognizer seam. No live Silero/Moonshine inference is claimed. |
| TTS core | `packages/local-compute/src/tts-*.ts` | `BACKEND_IMPLEMENTED` | Bounded request/worker/synthesis contracts. No live Kokoro inference is claimed. |
| Local process supervisor | `packages/local-runtime/src/*` | `BACKEND_IMPLEMENTED` | Child-process registration, readiness, restart, shutdown, environment and bounded diagnostics. Not composed into the main interview path. |
| Python local-compute worker | `workers/python/*`, `packages/local-compute/src/worker-client.ts` | `BACKEND_IMPLEMENTED` | Isolated NDJSON worker boundary with application-owned admission. |
| Vision snapshot/preprocessing | `packages/vision/src/*` | `BACKEND_IMPLEMENTED` | Bounded image/snapshot/dirty-region processing. |
| Vision semantic backend | `packages/interview-engine/src/vision-inference.ts` | `TEST/HARNESS_ONLY` | Current concrete backend is `DeterministicFakeVisionBackend`; no live semantic vision model is production-wired. |
| Vision request/freshness/admission | `vision-request-manager.ts`, `vision-freshness.ts`, `vision-admission.ts` | `BACKEND_IMPLEMENTED` | Application-owned snapshot, board/shape revision and result admission. |
| Formal interpretation request/admission | `formal-interpretation.ts`, `interpretation-coordinator.ts` | `BACKEND_IMPLEMENTED` | Bounded fallible-provider contract, validation, cancellation and admission. |
| Formal protocol routing | `formal-protocol-routing.ts` | `BACKEND_IMPLEMENTED` | Routes admitted statements to allowed deterministic verifier families. |
| Deterministic verification | `packages/verification/src/*`, `verification-coordinator.ts` | `BACKEND_IMPLEMENTED` | Graph, rational/integer, modular, recurrence, probability and combinatorial infrastructure. |
| Grounded session evaluation | `session-evaluator.ts`, `evaluation-model-seam.ts` | `BACKEND_IMPLEMENTED` | Deterministic evidence/provenance scorer plus bounded qualitative proposal seam; no main UI. |
| Replay/history projections | `packages/replay/src/*` | `BACKEND_IMPLEMENTED` | Timeline/session/longitudinal/provenance read models; no main UI. |
| Oxford/quant problem catalogs | `packages/problems/src/problem-catalog.ts`, curated modules | `BACKEND_IMPLEMENTED` | Multiple authored Oxford and quant fixtures with catalog/provenance integrity. Production selection remains hard-coded. |
| Quant Trading infrastructure | `market-maker.ts`, `order-book.ts`, `portfolio-tracker.ts`, `quant-trader-interview.ts` | `BACKEND_IMPLEMENTED` | Deterministic trading interview/scenario machinery; not a selectable product mode. |
| Quant Research infrastructure | `packages/local-compute/src/quant-research/*`, `quant-research-coordinator.ts` | `BACKEND_IMPLEMENTED` | Deterministic scenario, evidence, result and persistence coordination; not a selectable product mode. |
| Provider policy/execution gate | `packages/providers/src/policy.ts`, `execution.ts`, provider coordinator | `PRODUCTION_WIRED` | Production orchestration goes through application-owned admission, but currently with the mock provider. |
| Provider control plane | `packages/providers/src/control-plane.ts`, safe configuration/builtin provider modules | `BACKEND_IMPLEMENTED` | Bounded provider/model/configuration/secret-reference machinery; not selected by the current server composition root. |
| `MockModelAdapter` | `packages/providers/src/mock-model-adapter.ts` | `PRODUCTION_WIRED` | Explicitly instantiated by `ServerTurnOrchestrator`. |
| `GeminiApiAdapter` | `packages/providers/src/gemini-api-adapter.ts` | `RUNTIME_SEAM_ONLY` | Gated adapter exists and is tested; it is not the current server reasoning provider. |
| Synthetic interview | `synthetic-interview.ts`, `apps/server/src/run-synthetic.ts` | `TEST/HARNESS_ONLY` | Deterministic smoke/demo path used by validation. |
| Public-release + architecture checks | `scripts/check-public-release.mjs`, `check-architecture-boundaries.mjs` | `TEST/HARNESS_ONLY` | Required repository validation/invariant gates; they are not part of the product runtime. |
| GitHub Actions CI | `.github/workflows/ci.yml` | `TEST/HARNESS_ONLY` | Repository validation harness for pull-request and main-push events on Ubuntu and Windows. |

## Current integration gap

The architecture/backend is significantly ahead of the user-facing vertical integration.

The current main product path still:

- binds `useInterviewSession` and `ServerTurnOrchestrator` to `sixPeopleProblem`;
- constructs `MockModelAdapter` in server orchestration;
- has no end-to-end voice path exposed in the interview UI;
- does not expose Quant Trading or Quant Research modes;
- does not expose grounded evaluation or replay/history views;
- does not run live Silero, Moonshine, Kokoro, or a live semantic vision backend;
- does not provide a standalone browser-token bootstrap for the default `App`; the current secure end-to-end host is Electron.

Accordingly, backend packages should not be described as “production integrated” merely because their tests pass.

## Package dependency direction

The architecture checker is authoritative for frozen package dependency rules. Its current allowed project-package imports are:

```text
domain           -> (none)
diagnostics      -> domain
events           -> domain
persistence      -> domain, events
providers        -> domain
problems         -> domain
replay           -> domain, events
verification     -> domain
whiteboard       -> domain
vision           -> domain
local-compute    -> domain
local-runtime    -> diagnostics
model-assets     -> (none)
delivery         -> domain, events
interview-engine -> domain, events, persistence, providers, problems,
                    delivery, local-compute, verification, whiteboard
```

Apps remain composition roots; lower-level packages may not import application roots.

Key invariants:

- lower-level packages do not import application composition roots;
- fallible providers/workers propose results; application code owns admission and authoritative state changes;
- provider sessions, local workers, renderer caches and read projections are disposable;
- SQLite semantic events and serialized session writes remain authoritative;
- `POSSIBLY_EXPOSED` delivery is never replayed as safe-to-redeliver output.

## Repository inventory

Audited on 2026-09-01:

- apps: 3 (`web`, `server`, `desktop`);
- source-package directories: 15;
- Python worker directory: `workers/python`;
- Vitest files matched by the repository naming convention: 105.

These are audit observations, not permanent invariants.

## CI contract

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`, with Ubuntu and Windows matrix coverage.

The workflow executes:

- architecture-boundary checks;
- public-release/security hygiene;
- TypeScript;
- ESLint;
- browser build;
- desktop build;
- explicit desktop bootstrap tests;
- one complete Vitest discovery through `test:ci` (the same files as `pnpm test`, with at most two workers);
- focused replay verification;
- the full `.property.test.` convention sweep;
- the typed E2E script;
- the synthetic interview demo.

Superseded first-attempt PR runs may be cancelled. Main-push runs use commit-SHA concurrency groups, so workflow concurrency does not replace one scheduled main-push validation run with another. The repository currently has no branch protection/ruleset requiring successful CI, and GitHub-level skip/manual-cancel behavior remains outside the workflow guarantee.

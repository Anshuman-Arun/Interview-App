# Project status

## Integration state

The repository has moved well beyond the original Phase 1 backend surface, but the user-facing product remains a narrower vertical slice.

The current production composition is a typed interview shell hosted by the Electron trusted bootstrap and backed by local loopback transport, SQLite event sourcing, real tldraw, application-owned session configuration/composition, mock-path Socratic text orchestration, and authenticated read-only evaluation/replay/history review. The default main-UI launch still uses the legacy Oxford Ramsey compatibility path; generic configured Oxford, Quant Trading, and Quant Research identities are supported by the server/session layer but are not yet exposed through selectable launch UI. The bare browser renderer can be exercised through injected/test seams, but the current `App` has no built-in browser-token acquisition flow.

This distinction is deliberate: documentation must describe what the application actually composes today, not what a tested backend package could support later.

## Status legend

- `PRODUCTION_WIRED`: reached by the current app composition path.
- `BACKEND_IMPLEMENTED`: substantive implementation and tests exist, but no end-to-end product exposure.
- `RUNTIME_SEAM_ONLY`: protocol/adapter seam exists without the intended live runtime/model integration.
- `TEST/HARNESS_ONLY`: simulation or validation path, not a production feature.
- `DEFERRED`: intentionally outside the current runtime.

## Current architecture

```text
Electron trusted desktop bootstrap (current secure end-to-end host)
        |
        v
React/Vite renderer + real tldraw
        |
        | authenticated loopback commands / renderer stream
        v
apps/server
        |
        +--> authoritative Session Configuration / composition
        |         +--> exact Oxford problem or Quant scenario identity
        |         +--> registered provider/model identity
        |
        +--> SessionRuntimeRegistry / SessionWriter
        |         |
        |         +--> append-only SQLite semantic event log
        |
        +--> ServerTurnOrchestrator
        |         +--> session-bound Oxford problem
        |         +--> Socratic policy / disclosure checks
        |         +--> MockModelAdapter only for the mock/default path
        |         +--> ProviderCoordinator
        |         +--> delivery stream
        |
        +--> SessionReadService
                  +--> grounded evaluation
                  +--> bounded replay / history / longitudinal views
```

The server boxes above are the **current production path**. Session configuration now binds exact problem/scenario and provider/model identity, but that does not imply live execution for every registered provider: `GeminiApiAdapter`, speech model seams, and live vision backends remain outside the current reasoning/delivery path.

## Component inventory

| Area | Status | Current reality |
| --- | --- | --- |
| Session/event model, SQLite store, recovery | `PRODUCTION_WIRED` | Authoritative state is serialized through the session writer and durable semantic events. |
| Authoritative session configuration/composition | `PRODUCTION_WIRED` | New sessions bind exact mode/target/version and optional registered provider/model identity; recovery reconstructs from persisted authority and fails closed on mismatch. |
| Loopback command + renderer stream transport | `PRODUCTION_WIRED` | Authenticated local transport used by browser/desktop clients. |
| React typed interview shell + KaTeX | `PRODUCTION_WIRED` | Main user-facing interview path. |
| Real tldraw whiteboard | `PRODUCTION_WIRED` | The UI mounts `Tldraw`; student/AI ownership metadata is bridged through the real editor. |
| Electron bootstrap/runtime | `PRODUCTION_WIRED` | Secure renderer bootstrap, backend startup, trusted auth injection, navigation/permission policy. |
| Browser audio primitives | `RUNTIME_SEAM_ONLY` | Capture/playback infrastructure exists, but session delivery has no physical audio player installed. |
| VAD/STT worker core | `BACKEND_IMPLEMENTED` | Bounded worker machinery and recognizer/VAD contracts; no live Silero/Moonshine claim. |
| TTS worker core | `BACKEND_IMPLEMENTED` | Bounded synthesis worker/protocol; no live Kokoro claim. |
| Local worker/process supervision | `BACKEND_IMPLEMENTED` | Child-process lifecycle, readiness, environment, output and shutdown controls. |
| Vision preprocessing | `BACKEND_IMPLEMENTED` | Snapshot/image processing and bounded validation exist. |
| Vision semantic inference | `TEST/HARNESS_ONLY` | The repository currently includes `DeterministicFakeVisionBackend`; no live vision model is production-wired. |
| Vision freshness/admission | `BACKEND_IMPLEMENTED` | Application-owned revision/freshness/result admission exists. |
| Formal interpretation + routing | `BACKEND_IMPLEMENTED` | Bounded interpretation request/admission and deterministic verifier routing exist. |
| Deterministic math verification | `BACKEND_IMPLEMENTED` | Graph, arithmetic, modular, recurrence, probability and combinatorial verifier infrastructure exists. |
| Grounded session evaluation | `PRODUCTION_WIRED` | Deterministic exact-provenance evaluation is exposed through authenticated read-only post-session/historical review UI. |
| Replay/history projections | `PRODUCTION_WIRED` | Bounded timeline/session/longitudinal projections are exposed through authenticated read-only product routes and review UI. |
| Quant Trading engine | `BACKEND_IMPLEMENTED` | Deterministic market-making/interview infrastructure exists; no main UI mode. |
| Quant Research engine | `BACKEND_IMPLEMENTED` | Deterministic scenario/evidence/result engine and coordinator/persistence coverage; no main UI mode. |
| Curated Oxford + quant problem catalogs | `BACKEND_IMPLEMENTED` | Generic server configuration/catalog resolution uses exact catalog identities; selectable mode/problem launch UI remains deferred. |
| Provider control plane | `BACKEND_IMPLEMENTED` | Configuration/capability/secret-reference/policy machinery exists; session composition validates registered provider/model identity. |
| Gemini adapter | `RUNTIME_SEAM_ONLY` | Gated adapter exists, but live non-mock execution is not wired; the orchestrator uses `MockModelAdapter` only for the mock/default path. |
| Synthetic interview | `TEST/HARNESS_ONLY` | Smoke/demo path used by validation. |

## Explicit integration gaps

As of the 2026-09-01 audited baseline, the main product path:

1. still uses the legacy Ramsey compatibility start for the default main-UI new-session action, even though server/session composition supports exact configured Oxford and quant identities;
2. does not execute a live non-mock reasoning provider; mock execution is allowed only for the registered mock/default path and configured non-mock selection fails closed;
3. does not expose end-to-end voice interaction;
4. does not expose Quant Trading or Quant Research as selectable interview modes in the main UI;
5. does not run live Silero, Moonshine, Kokoro, or a live semantic vision backend;
6. does not provide a standalone browser-token bootstrap for the default `App`.

These are implementation-state facts, not claims that the underlying backend work is absent.

## Repository baseline

Audited on 2026-09-01 from authoritative `main`:

- apps: `apps/web`, `apps/server`, `apps/desktop`;
- source package directories: 15 under `packages/`;
- local worker directory: `workers/python`;
- Vitest files discovered by the repository test glob: 109.

Avoid copying fixed total assertion counts into status documents. The suite changes rapidly; `pnpm test` and GitHub Actions are the source of truth.

## Validation and release branch policy

Authoritative CI is configured for pull requests and pushes to `main`, on Ubuntu and Windows. A newer first-attempt PR run may cancel an older superseded PR run. Main pushes and reruns use SHA/attempt-scoped concurrency groups, so newly queued validation does not replace unrelated pending or running validation. This is validation policy, not merge enforcement: the repository currently has no branch protection/ruleset requiring CI, and GitHub-level skip/manual-cancel behavior remains outside the workflow.

The local aggregate is:

```bash
corepack pnpm check
```

It covers:

- frozen architecture-boundary checks;
- public-release/security hygiene;
- TypeScript;
- ESLint;
- browser build;
- Electron desktop build;
- explicit desktop bootstrap tests;
- the complete Vitest suite through the serialized CI variant (`maxWorkers=1`);
- focused replay verification;
- the full `.property.test.` convention sweep;
- the typed E2E script;
- the synthetic interview smoke path.

## Near-term integration milestone

The next product milestone is vertical integration rather than another broad backend expansion: expose the authoritative mode/problem configuration through product launch UI, wire a live production provider without weakening provider admission, connect bounded voice runtimes, and build mode-specific Quant Trading/Quant Research product flows while preserving the existing event, disclosure, delivery, replay, and security invariants.

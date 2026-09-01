# Project status

## Integration state

The repository has moved well beyond the original Phase 1 backend surface, but the user-facing product remains a narrower vertical slice.

The current production composition is a typed Oxford mathematics interview shell hosted by the Electron trusted bootstrap and backed by local loopback transport, SQLite event sourcing, real tldraw, and mock-provider Socratic text orchestration. A larger set of speech, vision, verification, evaluation, replay, provider-control-plane, and quant systems exists behind that shell and is not yet fully product-wired. The bare browser renderer can be exercised through injected/test seams, but the current `App` has no built-in browser-token acquisition flow.

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
        +--> SessionRuntimeRegistry / SessionWriter
        |         |
        |         +--> append-only SQLite semantic event log
        |
        +--> ServerTurnOrchestrator
                  |
                  +--> sixPeopleProblem
                  +--> Socratic policy / disclosure checks
                  +--> MockModelAdapter
                  +--> ProviderCoordinator
                  +--> delivery stream
```

The server/provider box above is the **current production path**. The existence of `GeminiApiAdapter`, provider control-plane code, formal interpretation providers, speech model seams, or vision backends does not mean those are selected by this composition root.

## Component inventory

| Area | Status | Current reality |
| --- | --- | --- |
| Session/event model, SQLite store, recovery | `PRODUCTION_WIRED` | Authoritative state is serialized through the session writer and durable semantic events. |
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
| Grounded session evaluation | `BACKEND_IMPLEMENTED` | Deterministic evaluation with evidence/provenance validation and a bounded fallible qualitative seam. |
| Replay/history projections | `BACKEND_IMPLEMENTED` | Timeline, session, longitudinal and provenance projections exist; no product UI. |
| Quant Trading engine | `BACKEND_IMPLEMENTED` | Deterministic market-making/interview infrastructure exists; no main UI mode. |
| Quant Research engine | `BACKEND_IMPLEMENTED` | Deterministic scenario/evidence/result engine and coordinator/persistence coverage; no main UI mode. |
| Curated Oxford + quant problem catalogs | `BACKEND_IMPLEMENTED` | Catalogs and integrity tests exist; production interview selection remains fixed to Ramsey. |
| Provider control plane | `BACKEND_IMPLEMENTED` | Configuration/capability/secret-reference/policy machinery exists. |
| Gemini adapter | `RUNTIME_SEAM_ONLY` | Gated adapter exists, but `ServerTurnOrchestrator` still creates `MockModelAdapter`. |
| Synthetic interview | `TEST/HARNESS_ONLY` | Smoke/demo path used by validation. |

## Explicit integration gaps

As of the 2026-09-01 audited baseline, the main product path:

1. binds the web session state and server Socratic orchestration to `sixPeopleProblem`;
2. uses `MockModelAdapter` for server reasoning orchestration;
3. does not expose end-to-end voice interaction;
4. does not expose Quant Trading or Quant Research as selectable interview modes;
5. does not expose grounded evaluation or replay/history projections in the main UI;
6. does not run live Silero, Moonshine, Kokoro, or a live semantic vision backend;
7. does not provide a standalone browser-token bootstrap for the default `App`.

These are implementation-state facts, not claims that the underlying backend work is absent.

## Repository baseline

Audited on 2026-09-01 from authoritative `main`:

- apps: `apps/web`, `apps/server`, `apps/desktop`;
- source package directories: 15 under `packages/`;
- local worker directory: `workers/python`;
- Vitest files discovered by the repository test glob: 105.

Avoid copying fixed total assertion counts into status documents. The suite changes rapidly; `pnpm test` and GitHub Actions are the source of truth.

## Validation and release branch policy

Authoritative CI is configured for pull requests and pushes to `main`, on Ubuntu and Windows. A newer first-attempt PR run may cancel an older superseded PR run. Main-push runs use commit-SHA concurrency groups, so workflow concurrency does not replace one scheduled main-push validation run with another. This is validation policy, not merge enforcement: the repository currently has no branch protection/ruleset requiring CI, and GitHub-level skip/manual-cancel behavior remains outside the workflow.

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
- the complete Vitest suite through the two-worker CI variant;
- focused replay verification;
- the full `.property.test.` convention sweep;
- the typed E2E script;
- the synthetic interview smoke path.

## Near-term integration milestone

The next product milestone is vertical integration rather than another broad backend expansion: make problem/mode selection authoritative, select a production provider through the control plane, connect bounded voice runtimes, and surface evaluation/replay without weakening the existing event, disclosure, delivery, or security invariants.

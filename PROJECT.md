# Project status

## Integration state

The repository has moved well beyond the original Phase 1 backend surface, but the user-facing product remains a narrower vertical slice.

The current production composition is a typed interview shell hosted by the Electron trusted bootstrap and backed by local loopback transport, SQLite event sourcing, real tldraw, application-owned session configuration/composition, provider-controlled Socratic text orchestration, and authenticated read-only evaluation/replay/history review. Explicitly configured sessions can execute through the registered mock path or, on Windows desktop/server hosts, the supervised Antigravity CLI reasoning path; Antigravity remains host-policy gated and requires a locally installed/authenticated CLI. Non-Windows application composition currently fails closed for that provider because the PR does not claim hostile-descendant containment from a POSIX process group. The default main-UI launch still uses the legacy Oxford Ramsey compatibility path and does not expose provider selection. Generic configured Oxford, Quant Trading, and Quant Research identities are supported by the server/session layer but are not yet exposed through selectable launch UI. The bare browser renderer can be exercised through injected/test seams, but the current `App` has no built-in browser-token acquisition flow.

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
        |         +--> ProviderRuntimeResolver / ProviderRegistry
        |         |         +--> deterministic mock adapter
        |         |         +--> gated Gemini API adapter
        |         |         +--> supervised Antigravity CLI adapter
        |         +--> ProviderCoordinator / billing + data-use admission
        |         +--> delivery stream
        |
        +--> SessionReadService
                  +--> grounded evaluation
                  +--> bounded replay / history / longitudinal views
```

The server boxes above are the **current production path**. Session configuration binds exact problem/scenario and provider/model identity. On Windows, an explicitly selected `antigravity-cli / gemini-3.7-flash-medium` session can reach a real supervised local CLI process and remote Antigravity inference when the host policy opt-in is enabled and the CLI is locally authenticated. The same selection fails closed on non-Windows hosts in the current production composition. Registration alone still does not authorize execution: provider policy, billing/data-use admission, proposal validation, generation compatibility, and delivery remain application-owned. Speech model seams and live vision backends remain separate runtime concerns.

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
| Local worker/process supervision | `BACKEND_IMPLEMENTED` | Long-lived worker lifecycle plus reusable bounded one-shot process execution, executable identity pinning, isolated homes/cwds, output limits, cancellation, and tree cleanup. |
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
| Provider control plane | `PRODUCTION_WIRED` | Authoritative provider/model selection resolves through the registry/factory path and ProviderCoordinator policy/billing admission before proposal validation. |
| Antigravity CLI reasoning provider | `PRODUCTION_WIRED` | Windows-only in current composition. Explicitly configured sessions can execute `gemini-3.7-flash-medium` through a fresh Job-Object-supervised `agy` process per turn. The host must opt into remote reasoning, the CLI must be locally authenticated, and no mock fallback occurs on failure. Non-Windows hosts fail closed. |
| Gemini API adapter | `RUNTIME_SEAM_ONLY` | The API-key adapter remains available behind the same control plane and policy machinery; ordinary key configuration still cannot prove no incremental spend under the default no-metered policy. |
| Synthetic interview | `TEST/HARNESS_ONLY` | Smoke/demo path used by validation. |

## Explicit integration gaps

As of the 2026-09-02 provider-runtime integration:

1. the default main-UI new-session action still uses the legacy Ramsey compatibility start and does not expose provider/model selection, even though server/session composition supports exact configured Oxford and quant identities;
2. supervised Antigravity reasoning is available only for sessions explicitly configured with its provider/model identity and only when the trusted host permits remote reasoning and the local CLI is installed/authenticated;
3. there is no automatic provider fallback or escalation; an unavailable/unauthenticated Antigravity runtime fails closed and requires explicit retry rather than silently switching to mock;
4. the main UI does not yet expose Quant Trading or Quant Research as selectable interview modes;
5. live speech/TTS/vision model availability remains determined by their separate runtime composition work;
6. the default `App` still does not provide a standalone browser-token bootstrap.

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

The next product milestone is vertical integration rather than another broad backend expansion: expose authoritative mode/problem/provider selection and runtime readiness through product launch UI, connect the bounded live voice/vision runtimes, and build mode-specific Quant Trading/Quant Research product flows while preserving the existing event, disclosure, provider-policy, delivery, replay, and security invariants.

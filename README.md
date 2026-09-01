# Interview App

A local-first technical interview application with an event-sourced session core, typed browser/Electron client, real tldraw whiteboard, deterministic verification infrastructure, and a growing set of Oxford mathematics and quant interview backends.

The repository is intentionally explicit about implementation status. Backend capability is substantially ahead of the user-facing vertical integration; an implemented subsystem is not automatically a live product feature.

## Current product path

The production-wired interview path currently provides:

- a React/Vite interview shell with KaTeX rendering and a real mounted tldraw canvas;
- authenticated loopback command and renderer-stream transports;
- Electron bootstrap/runtime support with a trusted renderer authentication bridge;
- append-only SQLite session persistence, serialized writes, recovery, and delivery-state safety;
- typed student input and Socratic text delivery for the current default Oxford Ramsey (R(3,3)=6) launch path;
- authenticated read-only post-session evaluation, replay, and session-history review backed by authoritative event streams.

Important current limitations:

- the secure end-to-end product path currently relies on the Electron trusted bootstrap; the bare browser app has no built-in way to acquire the server's client token;
- the default main-UI new-session action still uses the legacy Ramsey compatibility start, while the server/session composition layer supports exact configured Oxford, Quant Trading, and Quant Research identities; selectable mode/problem launch UI is still deferred;
- provider/model identity can be bound authoritatively to a session, but live non-mock provider execution is not wired; orchestration uses `MockModelAdapter` only for the registered mock/default path and otherwise fails closed rather than silently substituting mock execution;
- browser audio primitives exist, but the interview UI does not yet install a physical audio player or expose end-to-end voice;
- quant trading/research engines and curated quant problems are not exposed as selectable product modes in the main UI.

## Implementation-status vocabulary

| Status | Meaning |
| --- | --- |
| `PRODUCTION_WIRED` | Reached by the current app composition path and exercised as part of the product runtime. |
| `BACKEND_IMPLEMENTED` | Substantial bounded implementation exists with tests, but the main product path does not expose it end to end. |
| `RUNTIME_SEAM_ONLY` | Adapter/protocol/composition seam exists, but the intended live runtime or model is not connected. |
| `TEST/HARNESS_ONLY` | Exists to test, simulate, or demonstrate behavior rather than serve as the production path. |
| `DEFERRED` | Intentionally not implemented or not selected for the current milestone. |

## Repository map

At the 2026-09-01 audited baseline, the tree contains 3 app roots, 15 source-package directories, one Python worker directory, and 109 Vitest test files.

```text
apps/
  desktop/          Electron bootstrap/runtime
  server/           loopback transport and interview orchestration
  web/              React/Vite renderer, tldraw, typed session UI, browser audio primitives

packages/
  delivery/         delivery lifecycle, renderer protocol, acknowledgements
  diagnostics/      bounded/sanitized diagnostics
  domain/           shared schemas and domain contracts
  events/           semantic events, reducer, replay state
  interview-engine/ orchestration, interpretation, evaluation, verification admission
  local-compute/    worker protocols, speech/TTS cores, quant engines
  local-runtime/    supervised local child-process lifecycle
  model-assets/     local model asset metadata/validation
  persistence/      SQLite event store and durable session repository
  problems/         Oxford/quant problem catalogs and authored fixtures
  providers/        mock/Gemini adapters, policy, provider control plane
  replay/           replay/history/provenance projections
  verification/     deterministic mathematical verifiers
  vision/           image/snapshot preprocessing
  whiteboard/       whiteboard-domain intelligence and shape model

workers/python/     isolated Python local-compute worker boundary
tests/              unit, adversarial, property, replay, desktop, browser, and typed E2E tests
```

## Capability snapshot

| Capability | Status | Notes |
| --- | --- | --- |
| Typed Oxford interview shell | `PRODUCTION_WIRED` | Default launch remains the legacy Ramsey compatibility path; recovered/configured sessions use server-owned public session context rather than a browser-bundled private problem object. |
| Real tldraw integration | `PRODUCTION_WIRED` | `WhiteboardCanvas` mounts the real `Tldraw` component through `RealTldrawEditorBridge`. |
| Electron desktop bootstrap/runtime | `PRODUCTION_WIRED` | Starts the loopback backend, serves/loads the renderer, injects trusted auth, and applies permission/navigation policy. |
| Browser audio capture/playback primitives | `RUNTIME_SEAM_ONLY` | Infrastructure exists; the session hook deliberately has no physical audio player installed. |
| VAD/STT bounded worker core | `BACKEND_IMPLEMENTED` | Model-independent worker core with injected VAD/recognizer seams; no claim of live Silero/Moonshine inference. |
| TTS bounded worker core | `BACKEND_IMPLEMENTED` | Synthesis protocol/worker core exists; no claim of live Kokoro inference. |
| Local process supervision | `BACKEND_IMPLEMENTED` | Bounded child-process manager, readiness, restart/shutdown, environment and diagnostic controls. |
| Vision preprocessing + freshness/admission | `BACKEND_IMPLEMENTED` | Snapshot/preprocessing plus board/shape freshness and result admission exist. |
| Vision semantic inference | `TEST/HARNESS_ONLY` | The current concrete semantic backend is deterministic fake inference; no live vision model is selected. |
| Formal interpretation routing | `BACKEND_IMPLEMENTED` | Bounded proposal admission and deterministic protocol/verifier routing exist. |
| Deterministic mathematical verification | `BACKEND_IMPLEMENTED` | Multiple verifier domains and coordinator/admission paths exist. |
| Grounded session evaluation | `PRODUCTION_WIRED` | Authenticated read-only evaluation is reconstructed from exact authoritative session/problem provenance and surfaced in post-session/historical review UI. |
| Replay/history projections | `PRODUCTION_WIRED` | Authenticated bounded replay/history/longitudinal read models are surfaced in product review UI without appending, acknowledging, or redelivering events. |
| Quant Trading infrastructure | `BACKEND_IMPLEMENTED` | Market-making/trader scenario engine exists; no selectable main UI mode. |
| Quant Research infrastructure | `BACKEND_IMPLEMENTED` | Deterministic research engine/coordinator/persistence coverage exists; no selectable main UI mode. |
| Oxford and quant problem catalogs | `BACKEND_IMPLEMENTED` | Generic server composition/catalog commands resolve exact identities, but the main UI does not yet expose selectable mode/problem launch controls. |
| Provider control plane | `BACKEND_IMPLEMENTED` | Bounded configuration/capability/secret-reference/policy machinery exists; session composition validates registered provider/model identity, while live non-mock execution remains deferred. |
| Gemini adapter | `RUNTIME_SEAM_ONLY` | Gated adapter exists and its identity can be represented in session configuration; it is not yet the live server reasoning provider. |

See `docs/IMPLEMENTATION_MAP.md` for the detailed component map.

## Running locally

Prerequisites:

- Node.js >= 22.12.0
- pnpm 11.19.0

Install:

```bash
corepack pnpm install --frozen-lockfile
```

Production-like desktop run:

```bash
corepack pnpm start:desktop
```

This builds the browser bundle and desktop runtime, then launches Electron with the trusted bootstrap that injects loopback authentication.

For desktop live-reload development, run these in separate terminals:

```bash
corepack pnpm dev:web
```

```bash
corepack pnpm dev:desktop
```

`dev:desktop` expects the Vite development server to already be running. The default dev origins agree on `http://127.0.0.1:5173`, but Vite is allowed to choose another free port when 5173 is occupied; if it reports a different loopback origin, set `INTERVIEW_DESKTOP_DEV_URL` to that exact origin before launching Electron. A bare `dev:web` renderer is useful for UI work, but the current `App` has no built-in browser-token acquisition flow, so `start:server` + `dev:web` alone is not an authenticated end-to-end interview path.

Server-only development and transport testing can still use:

```bash
corepack pnpm start:server
```

Synthetic smoke path:

```bash
corepack pnpm demo
```

## Authoritative validation contract

`pnpm check` is the local aggregate for the same categories enforced by CI:

```bash
corepack pnpm check
```

It runs tracked-working-tree public-release/security hygiene, architecture boundaries, TypeScript, ESLint, browser build, desktop build, the complete Vitest suite, focused desktop/replay/property/typed-E2E gates, and the synthetic interview demo. The repository security gate is not a Git-history or GitHub-metadata/artifact audit.

The complete Vitest discovery is authoritative for repository-wide coverage: `vitest.config.ts` includes every `tests/**/*.test.ts` and `tests/**/*.test.tsx` file. `pnpm test` is the normal local full-suite command; CI and `pnpm check` use `pnpm test:ci`, which runs the same discovery serially (`maxWorkers=1`) for cross-platform runner stability and to prevent subprocess-heavy suites from starving real-worker integration tests. Focused scripts are intentionally rerun as secondary gates so their package-script contracts cannot silently rot. `test:property` follows the `.property.test.` filename convention rather than a hand-maintained partial list.

GitHub Actions is configured for pull requests and pushes to `main` on both Ubuntu and Windows. Superseded first-attempt PR runs may be cancelled. Main pushes and reruns use SHA/attempt-scoped concurrency, so newly queued validation does not replace unrelated pending or running validation. Repository branch protection is not currently configured, and GitHub-level skip/manual-cancel behavior is outside this workflow guarantee.

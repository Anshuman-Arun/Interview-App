# Implementation Map

## Repository baseline

The repository was empty at Phase 0 bootstrap: there was no Git repository, package manifest, source, test, CI, database, configuration, or reusable implementation. The authoritative source `C:\Users\anshu\Downloads\technical_interview_app_architecture_freeze.md` (2,962 lines, read in full on 2026-08-28) was copied byte-for-byte to `docs/ARCHITECTURE.md` (matching SHA-256). This document maps that frozen architecture; it does not revise it.

The workspace uses pnpm, strict TypeScript, Zod at persisted/external boundaries, Vitest, fast-check, ESLint, and Node's built-in `node:sqlite`. Phase 0 has no browser UI and no real remote provider.

## Component-to-code map

| Architecture component | Planned module/package | Main types/functions | Dependencies | Phase |
| --- | --- | --- | --- | --- |
| Session state | `packages/events/src/state.ts` | `SessionState`, `initialSessionState` | domain | 0 |
| Serialized session writer | `packages/interview-engine/src/session-writer.ts` | `SessionWriter`, `SessionRuntimeRegistry` | events, persistence | 0 |
| Commands/results | `packages/domain/src/commands.ts`, `packages/interview-engine/src/session-writer.ts` | `CommandEnvelope`, `CommandResult`, browser-safe Web Crypto ID factories, command-specific result schemas | domain IDs, Zod | 0 |
| Event schemas | `packages/events/src/schemas.ts` | `SessionEventSchema`, `EventDraft`, event payload schemas | domain, Zod | 0 |
| Event store | `packages/persistence/src/sqlite-event-store.ts` | `SqliteEventStore`, atomic `appendIdempotent` | events, `node:sqlite` | 0 |
| Upcasters | `packages/events/src/upcasters.ts` | `EventUpcaster`, `EventUpcasterRegistry` | event schemas | 0 |
| State reducer | `packages/events/src/reducer.ts` | `reduceSessionEvent`, `replaySession` | state, schemas | 0 |
| Snapshots | `packages/persistence/src/snapshots.ts` (deferred) | disposable `SessionSnapshot` cache | event store | post-0 optimization |
| Turn Coordinator | `packages/interview-engine/src/turn-coordinator.ts` | `TurnCoordinator`, input/turn/generation command builders | writer, domain | 0 |
| InputEpisode lifecycle | domain types + `turn-coordinator.ts` + event schemas | utterance onset/discard/finalize; speech/typing/board episode updates; Turn commit | domain, events | 0 |
| GenerationBasis | `packages/domain/src/generation.ts` | `GenerationBasis`, schema | revisions, IDs | 0 |
| Compatibility checker | `packages/interview-engine/src/compatibility.ts` | `isGenerationBasisStillCompatible` | state, GenerationBasis | 0 |
| Context Compiler | `packages/interview-engine/src/context-compiler.ts` | `compileContext`, `CompiledContext` | problem public data, policy, state | 0 |
| Context Epoch | domain revisions + reducer | `ContextEpoch`; increment on non-monotonic truth changes | events | 0 |
| Pedagogical policy | `packages/interview-engine/src/pedagogical-policy.ts` | `selectPedagogicalAction`, `RealizationRequest` | evidence, reasoning graph | 0 baseline; 2 advanced |
| Reasoning graph contracts | `packages/domain/src/reasoning.ts`, `packages/problems/src/problem-integrity.ts`, `problem-catalog.ts` | versioned `ReasoningGraph`; authored-fixture reference, uniqueness, provisional-DAG, disclosure-registry, and catalog integrity gates | IDs/Zod, authored problems | 0 implemented |
| Student evidence | `packages/domain/src/evidence.ts`, events state/reducer, `turn-coordinator.ts`, `verification-coordinator.ts` | scoped proposal validation; `EvidenceRecordState` history; explicit supersession/staleness; application-authoritative inferred and deterministically verified updates | event IDs, Zod | 0 scoped history/supersession baseline; 2 advanced aggregation |
| Verifier contracts | `packages/domain/src/verification.ts`, `packages/verification/src/two-colour-graph-verifier.ts`, `packages/interview-engine/src/verification-coordinator.ts`, events state/reducer | `VerificationResultSchema`, `DeterministicVerifier`, `TwoColourGraphVerifier`, `VerificationCoordinator`, strict work/admission schemas | domain, events, writer, Zod | 0 Oxford verifier and authoritative admission implemented; additional engines later |
| Provider capability model | `packages/domain/src/provider.ts` | `ModelCapabilities`, real cancellation/data-use semantics | Zod | 0 |
| Provider policy/billing verification | `packages/providers/src/policy.ts` | `assertProviderPermitted`, runtime-validated `BillingVerification`, deterministic `ProviderPolicyErrorCode` | capabilities, clock, strict billing schema | 0 fail-closed baseline implemented; provider-specific proofs pending |
| MockModelAdapter | `packages/providers/src/mock-model-adapter.ts` | `MockModelAdapter`, `MockModelSession` | provider contracts, proposal | 0 |
| GeminiApiAdapter | `packages/providers/src/gemini-api-adapter.ts` | disabled experiment boundary until billing/security gates pass | provider policy | late 0 experiment |
| AntigravityCliAdapter | `packages/providers/src/antigravity-cli-adapter.ts` | disabled adapter until isolated deny rules proven | provider policy/security | late 0 experiment |
| ReasoningProvider | `packages/domain/src/provider.ts` | `ReasoningProvider`, `ReasoningSession` | compiled context | 0 |
| VisionProvider | `packages/domain/src/provider.ts`, `vision-freshness.ts`, event state/reducer | `VisionProvider`, request/result lifecycle, `BoardObservation` freshness | whiteboard revisions | 0 |
| InterviewerProposal | `packages/domain/src/proposal.ts` | runtime-validated proposal and board actions | pedagogy, disclosure | 0 |
| Disclosure validator | `packages/interview-engine/src/disclosure-validator.ts` | `DisclosureValidator`, independent analyzer result | protected facts, compatibility | 0 baseline; 2 semantic model |
| Protected disclosure model | `packages/domain/src/disclosure.ts`, `packages/problems/` | `ProtectedDisclosure`, levels, formulations | Zod | 0 |
| DeliveryAtom | `packages/domain/src/delivery.ts` | atom/command/status/medium schemas | IDs, disclosure | 0 |
| Delivery Coordinator | `packages/delivery/src/delivery-coordinator.ts` | queue/start/ack/cancel/recovery transitions | writer, events | 0 |
| Renderer acknowledgements | `packages/delivery/src/renderer.ts`, `renderer-stream-protocol.ts`, `apps/web/src/renderer-client.ts`, `apps/server/src/renderer-stream-server.ts` | `Renderer`, `MockRenderer`, `RendererClient`, stable-ID stream commands, separate exposed/completed acknowledgements | delivery IDs, authenticated loopback transport | 0 TEXT/AUDIO transport harness implemented |
| Whiteboard abstraction | `packages/domain/src/whiteboard.ts`, `packages/whiteboard/` | `WhiteboardAdapter`, ownership-layer board actions | board revisions | 0 contract; 3 integration |
| Local compute worker boundary | `packages/local-compute/src/protocol.ts`, `worker-client.ts`, `workers/python/local_compute_worker.py`; admission in `packages/interview-engine/src/local-compute-coordinator.ts`; lifecycle in events/state/reducer | `LocalComputeRequest`, `LocalComputeResponse`, `LocalComputeWorkerClient`, `LocalComputeCoordinator`, `LocalComputeRequestState` | domain IDs, Zod, Node child process, isolated Python stdio, serialized writer | 0 transcript-analysis boundary and authoritative admission implemented; additional compute functions deferred |
| Frontend/backend protocol | `packages/domain/src/protocol.ts`, `apps/server/src/loopback-command-server.ts`, `renderer-stream-server.ts`, `apps/web/src/command-client.ts`, `renderer-stream.ts` | strict command/response union; typed browser client; caller-stable RequestId retry; browser-compatible shared import graph; exact-Origin CORS; authenticated SSE; start/input/summary/reconnect/exposure/completion | domain schemas, writer, delivery | 0 thin browser transport implemented; polished UI deferred |
| Security boundaries | `packages/domain/src/security.ts`, `apps/server/src/loopback-command-server.ts`, renderer transport | loopback-only bind, exact Origin and preflight method/header allowlists, constant-time client-token check, bounded bodies, syntax-aware idempotent secret redaction, fixed non-secret errors | protocol/provider policy | 0 browser-MVP boundary implemented |
| Testing infrastructure | `tests/`, `vitest.config.ts`, `scripts/check-architecture-boundaries.mjs`, `.github/workflows/ci.yml` | unit, replay, crash, idempotency, exhaustive verifier, fixture integrity, provider-policy, redaction, browser transport, and randomized property tests on Windows/Linux CI | all implemented modules | 0 implemented and enforced in CI |
| Hard-coded Oxford problem | `packages/problems/src/six-people.ts`, `problem-integrity.ts`, `problem-catalog.ts` | public/interviewer/private partitions, approach-aware graph, protected facts, validated immutable catalog projection | domain | 0 implemented |
| Synthetic vertical path | `packages/interview-engine/src/synthetic-interview.ts`, `apps/server/src/run-synthetic.ts` | `runSyntheticInterview` | writer through renderer | 0 |

## Concrete dependency direction

```text
apps/web -----------------------------> delivery
   |                                      |
   +------------------------------------> domain

apps/server
   |
   v
interview-engine --------------------> problems
   |       |         |                    |
   |       |         +------> providers   |
   |       +----------------> delivery    |
   +------------------------> local-compute
   v                                      v
persistence --------------------------> events
   |                                      |
   +--------------------------------------+
                                          v
                                        domain

verification --------------------------> domain
whiteboard ----------------------------> domain
local-compute -------------------------> domain
      |
      +-- supervised NDJSON stdio -----> workers/python
                                           |
                                           +-- untrusted result proposal
```

Rules:

- `domain` imports no project package.
- `events` imports only `domain`.
- `persistence` imports `events` and `domain`; it never calls interview policy.
- `providers`, `problems`, `verification`, and `whiteboard` import only `domain` (providers may return proposals but never events).
- `delivery` may create event drafts but cannot mutate session state or append independently; all drafts go through `SessionWriter`.
- `local-compute` imports domain schemas only. It and `workers/python` cannot import events or persistence, open SQLite, or commit authoritative state.
- `interview-engine` orchestrates policy and effects and is the only layer that joins persistence, providers, delivery, and problems.
- Apps are composition roots. No lower package imports an app. No circular project dependency is permitted.

## Authority and side-effect boundary

```text
untrusted callback/result
  -> runtime schema validation
  -> CommandEnvelope with RequestId
  -> per-session SessionWriter queue
  -> current-state validation
  -> one SQLite transaction (event append + idempotency result)
  -> pure reducer
  -> side-effect command carrying stable ID
```

Provider sessions, renderer caches, snapshots, and local workers are disposable. SQLite semantic events are authoritative.

## Local-compute process boundary

```text
Node supervisor
  -> strict protocol-v1 Zod request
  -> Python -I -u with allowlisted environment
  -> one request per stdin JSON line
  -> one result proposal per stdout JSON line
  -> strict protocol-v1 Zod response
  -> request and source-revision correlation
  -> application-owned deterministic result validation
  -> idempotent command through the serialized SessionWriter
  -> semantic accepted/discarded event
```

Malformed, unsolicited, oversized, or basis-mismatched worker output fails the process closed. Transcript analysis is accepted only while its request is pending, its persisted and callback revisions equal the current transcript revision, its committed InputEpisode remains available, and application code independently reproduces its normalized text and token count. Worker error text is never persisted. A timeout interrupts the complete local worker process because Phase 0 has no honest per-request compute cancellation mechanism. Operational duplicate caches are bounded and disposable; they are not authoritative state.

## Browser-MVP command boundary

```text
browser renderer
  -> 127.0.0.1 or ::1 only
  -> exact Origin + x-interview-client-token
  -> POST /v1/commands (64 KiB maximum)
  -> discriminated protocol-v1 Zod schema
  -> CommandEnvelope without authentication material
  -> SessionRuntimeRegistry
  -> SessionWriter (all mutations)
  -> typed, schema-validated response
```

The protocol deliberately does not serialize `SessionState`. Its summary is an allowlisted projection, typed input is not echoed, errors omit parser/internal details, and authentication values cannot enter command envelopes, event payloads, durable results, or responses. On a server runtime's first authenticated use of each session, persisted `DELIVERING` atoms are recovered through `SessionWriter` as `POSSIBLY_EXPOSED` before dispatch. During a live runtime, `RECONNECT_DELIVERY` returns the original content under the same `DeliveryId`; renderer-side `DeliveryId` memory supplies visible-output deduplication. Exposure and completion acknowledgements are separate idempotent commands.

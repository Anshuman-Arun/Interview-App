# Implementation Map

## Repository baseline

The repository was empty at Phase 0 bootstrap: there was no Git repository, package manifest, source, test, CI, database, configuration, or reusable implementation. The authoritative source `C:\Users\anshu\Downloads\technical_interview_app_architecture_freeze.md` (2,962 lines, read in full on 2026-08-28) was copied byte-for-byte to `docs/ARCHITECTURE.md` (matching SHA-256). This document maps that frozen architecture; it does not revise it.

The workspace uses pnpm, strict TypeScript, Zod at persisted/external boundaries, Vitest, fast-check, ESLint, and Node's built-in `node:sqlite`. Phase 0 has no browser UI and no real remote provider.

## Component-to-code map

| Architecture component | Planned module/package | Main types/functions | Dependencies | Phase |
| --- | --- | --- | --- | --- |
| Session state | `packages/events/src/state.ts` | `SessionState`, `initialSessionState` | domain | 0 |
| Serialized session writer | `packages/interview-engine/src/session-writer.ts` | `SessionWriter`, `SessionRuntimeRegistry` | events, persistence | 0 |
| Commands/results | `packages/domain/src/commands.ts` | `CommandEnvelope`, `CommandResult`, `AsyncResultEnvelope` | domain IDs, Zod | 0 |
| Event schemas | `packages/events/src/schemas.ts` | `SessionEventSchema`, `EventDraft`, event payload schemas | domain, Zod | 0 |
| Event store | `packages/persistence/src/sqlite-event-store.ts` | `SqliteEventStore`, atomic `appendIdempotent` | events, `node:sqlite` | 0 |
| Upcasters | `packages/events/src/upcasters.ts` | `EventUpcaster`, `EventUpcasterRegistry` | event schemas | 0 |
| State reducer | `packages/events/src/reducer.ts` | `reduceSessionEvent`, `replaySession` | state, schemas | 0 |
| Snapshots | `packages/persistence/src/snapshots.ts` (deferred) | disposable `SessionSnapshot` cache | event store | post-0 optimization |
| Turn Coordinator | `packages/interview-engine/src/turn-coordinator.ts` | `TurnCoordinator`, input/turn/generation command builders | writer, domain | 0 |
| InputEpisode lifecycle | domain types + coordinator + event schemas | `InputEpisode`, start/update/commit events | domain, events | 0 |
| GenerationBasis | `packages/domain/src/generation.ts` | `GenerationBasis`, schema | revisions, IDs | 0 |
| Compatibility checker | `packages/interview-engine/src/compatibility.ts` | `isGenerationBasisStillCompatible` | state, GenerationBasis | 0 |
| Context Compiler | `packages/interview-engine/src/context-compiler.ts` | `compileContext`, `CompiledContext` | problem public data, policy, state | 0 |
| Context Epoch | domain revisions + reducer | `ContextEpoch`; increment on non-monotonic truth changes | events | 0 |
| Pedagogical policy | `packages/interview-engine/src/pedagogical-policy.ts` | `selectPedagogicalAction`, `RealizationRequest` | evidence, reasoning graph | 0 baseline; 2 advanced |
| Reasoning graph contracts | `packages/domain/src/reasoning.ts` | versioned `ReasoningGraph`, approaches, milestones, edges | IDs/Zod | 0 |
| Student evidence | `packages/domain/src/evidence.ts` | `EvidenceKey`, `EvidenceValue`, `EvidenceProposal` | event IDs, Zod | 0 contracts; 2 policy |
| Verifier contracts | `packages/domain/src/verification.ts`, `packages/verification/` | `VerificationResult`, `DeterministicVerifier` | domain | 0 contracts; 5 engines |
| Provider capability model | `packages/domain/src/provider.ts` | `ModelCapabilities`, real cancellation/data-use semantics | Zod | 0 |
| Provider policy/billing verification | `packages/providers/src/policy.ts` | `assertProviderPermitted`, `BillingVerification` | capabilities, clock | 0 |
| MockModelAdapter | `packages/providers/src/mock-model-adapter.ts` | `MockModelAdapter`, `MockModelSession` | provider contracts, proposal | 0 |
| GeminiApiAdapter | `packages/providers/src/gemini-api-adapter.ts` | disabled experiment boundary until billing/security gates pass | provider policy | late 0 experiment |
| AntigravityCliAdapter | `packages/providers/src/antigravity-cli-adapter.ts` | disabled adapter until isolated deny rules proven | provider policy/security | late 0 experiment |
| ReasoningProvider | `packages/domain/src/provider.ts` | `ReasoningProvider`, `ReasoningSession` | compiled context | 0 |
| VisionProvider | `packages/domain/src/provider.ts` | `VisionProvider`, `BoardObservation` | whiteboard revisions | 0 |
| InterviewerProposal | `packages/domain/src/proposal.ts` | runtime-validated proposal and board actions | pedagogy, disclosure | 0 |
| Disclosure validator | `packages/interview-engine/src/disclosure-validator.ts` | `DisclosureValidator`, independent analyzer result | protected facts, compatibility | 0 baseline; 2 semantic model |
| Protected disclosure model | `packages/domain/src/disclosure.ts`, `packages/problems/` | `ProtectedDisclosure`, levels, formulations | Zod | 0 |
| DeliveryAtom | `packages/domain/src/delivery.ts` | atom/command/status/medium schemas | IDs, disclosure | 0 |
| Delivery Coordinator | `packages/delivery/src/delivery-coordinator.ts` | queue/start/ack/cancel/recovery transitions | writer, events | 0 |
| Renderer acknowledgements | `packages/delivery/src/renderer.ts` | `Renderer`, `RendererAcknowledgement`, `MockRenderer` | delivery IDs | 0 |
| Whiteboard abstraction | `packages/domain/src/whiteboard.ts`, `packages/whiteboard/` | `WhiteboardAdapter`, ownership-layer board actions | board revisions | 0 contract; 3 integration |
| Local compute worker boundary | `workers/python/README.md`, later protocol schema | untrusted request/result envelopes; no authority | local IPC, commands | 0 contract; 4+ implementation |
| Frontend/backend protocol | `packages/domain/src/protocol.ts`; later `apps/web` | authenticated versioned client commands/server events | domain schemas | 0 contract; 1 transport |
| Security boundaries | `packages/domain/src/security.ts`; later `apps/server` transport | loopback/origin/client-token config, secret redaction | protocol/provider policy | 0 contract; 1 server |
| Testing infrastructure | `tests/`, `vitest.config.ts` | unit, replay, crash, idempotency, property tests | all implemented modules | 0 |
| Hard-coded Oxford problem | `packages/problems/src/six-people.ts` | public/interviewer/private partitions, graph, protected facts | domain | 0 |
| Synthetic vertical path | `packages/interview-engine/src/synthetic-interview.ts`, `apps/server/src/run-synthetic.ts` | `runSyntheticInterview` | writer through renderer | 0 |

## Concrete dependency direction

```text
apps/server
   |
   v
interview-engine --------------------> problems
   |       |         |                    |
   |       |         +------> providers   |
   |       +----------------> delivery    |
   v                                      v
persistence --------------------------> events
   |                                      |
   +--------------------------------------+
                                          v
                                        domain

verification --------------------------> domain
whiteboard ----------------------------> domain
workers/python --validated results-----> server command inbox
```

Rules:

- `domain` imports no project package.
- `events` imports only `domain`.
- `persistence` imports `events` and `domain`; it never calls interview policy.
- `providers`, `problems`, `verification`, and `whiteboard` import only `domain` (providers may return proposals but never events).
- `delivery` may create event drafts but cannot mutate session state or append independently; all drafts go through `SessionWriter`.
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

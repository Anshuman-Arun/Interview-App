# Phase 0 Execution Plan

Each slice ends with tests, type checking, linting, replay checks where relevant, and an invariant scan. A slice is complete only when its listed acceptance criteria are executable and green.

## 1. Workspace/package skeleton

- Files: root pnpm/TypeScript/Vitest/ESLint configuration; `apps/server`; `packages/*`; `workers/python`; `tests`.
- Types/functions: none.
- Tests: toolchain smoke test.
- Dependencies: Node >=22.5, pnpm.
- Complete when installation is reproducible and `typecheck`, `lint`, and `test` run from the root.

## 2. Shared IDs and schema primitives

- Files: `packages/domain/src/ids.ts`, `revisions.ts`.
- Types/functions: all required branded IDs, ID factories, non-negative revision schemas.
- Tests: reject empty IDs/negative revisions; generated IDs round-trip.
- Dependencies: Zod.
- Complete when every persisted/external identity has a runtime schema and loose ID strings do not cross package boundaries.

## 3. Discriminated event schemas

- Files: `packages/events/src/schemas.ts`.
- Types/functions: versioned envelope and typed payload union for the initial semantic events.
- Tests: event-specific payload validation; unknown type/payload rejected.
- Dependencies: slices 2, 9, 15-18.
- Complete when unchecked payloads cannot enter the store.

## 4. SQLite event store

- Files: `packages/persistence/src/sqlite-event-store.ts`.
- Types/functions: schema migration, ordered load, transactional append, unique `(session,sequence)`, event ID and request ID constraints.
- Tests: ordering is sequence-based; duplicate sequence/event/request behavior; rollback.
- Dependencies: slice 3, `node:sqlite`.
- Complete when events plus idempotency results commit atomically and wall time cannot alter order.

## 5. Event upcaster interface

- Files: `packages/events/src/upcasters.ts`.
- Types/functions: `EventUpcaster`, registry, current-version parser.
- Tests: v1 pass-through; missing upcast path fails.
- Dependencies: slice 3.
- Complete when all loaded rows pass through the registry before reduction.

## 6. Pure session reducer

- Files: `packages/events/src/state.ts`, `reducer.ts`.
- Types/functions: initial state, exhaustive reducer, `replaySession`.
- Tests: deterministic replay, strict sequence, no I/O.
- Dependencies: slices 3, 5.
- Complete when equal streams reconstruct equal state without provider/session caches.

## 7. Serialized session writer

- Files: `packages/interview-engine/src/session-writer.ts`.
- Types/functions: per-session promise queue, registry, atomic write/reduce path.
- Tests: concurrent submissions have strict sequences and one final state.
- Dependencies: slices 4, 6.
- Complete when no supported callback path can append or mutate outside the writer.

## 8. Command/result envelopes and idempotency

- Files: `packages/domain/src/commands.ts`; writer/store extensions.
- Types/functions: request/causation/correlation identity and cached command result.
- Tests: duplicate provider result and renderer ack produce no additional event/state change, including after restart.
- Dependencies: slices 4, 7.
- Complete when same `RequestId` returns the persisted prior result.

## 9. InputEpisode/Turn/Generation lifecycle

- Files: domain lifecycle types; event schemas; `turn-coordinator.ts`.
- Types/functions: start/update/commit input; commit turn; start/supersede generation.
- Tests: speech-board-speech episode, false onset discard, late superseded generation.
- Dependencies: slices 2, 3, 7.
- Complete when speech onset is distinct from turn commit and identities cannot be conflated.

## 10. GenerationBasis and compatibility

- Files: `generation.ts`, `compatibility.ts`.
- Types/functions: basis schema and three-valued compatibility.
- Tests: board/transcript/problem/policy/epoch staleness, late generation, missing provenance returns `UNKNOWN`.
- Dependencies: slice 9.
- Complete when only `COMPATIBLE` can enter proposal validation/delivery.

## 11. Context Epoch

- Files: reducer and epoch command helpers.
- Types/functions: monotonic epoch increment on non-monotonic truth corrections.
- Tests: transcript correction increments epoch and invalidates old generation/provider context.
- Dependencies: slices 6, 10.
- Complete when replay reconstructs the epoch and sessions can be rebuilt fresh.

## 12. Context Compiler contracts

- Files: `context-compiler.ts`.
- Types/functions: minimal `CompiledContext`, safe public projection.
- Tests: private solution/protected forbidden facts and prompt-injection control text never enter provider input.
- Dependencies: problem partitions, policy action, disclosure ledger.
- Complete when explicit allowlisted fields—not object omission conventions—form provider context.

## 13. Scoped StudentEvidence contracts

- Files: `evidence.ts`.
- Types/functions: subject/dimension keys, proposal/value provenance.
- Tests: invalid global subject rejected; confidence/range/event provenance required.
- Dependencies: IDs/Zod.
- Complete when authoritative evidence can only be committed by an event and remains locally scoped.

## 14. Reasoning graph contracts

- Files: `reasoning.ts`, hard-coded problem graph.
- Types/functions: version, approaches, milestones, optional prerequisites, merges, errors, extensions.
- Tests: graph reference integrity and at least two approaches.
- Dependencies: slice 2.
- Complete when the live model cannot rewrite the stored graph.

## 15. Pedagogical action contracts

- Files: `pedagogy.ts`, `pedagogical-policy.ts`.
- Types/functions: action taxonomy, `RealizationRequest`, separate maximum disclosure.
- Tests: action selected deterministically from current evidence; model cannot broaden it.
- Dependencies: slices 13-14.
- Complete when policy selection is application-owned.

## 16. InterviewerProposal

- Files: `proposal.ts`.
- Types/functions: proposal schema, claimed action/disclosures, speech and board proposal payloads.
- Tests: malformed/unknown output rejected.
- Dependencies: slices 15, 18.
- Complete when provider output is never a delivery type.

## 17. Disclosure/protected-fact contracts

- Files: `disclosure.ts`, problem metadata, `disclosure-validator.ts`.
- Types/functions: levels 0-5, protected facts, independent analyzer, fail-closed outcome.
- Tests: understated model metadata, protected level above authorization, uncertainty.
- Dependencies: slices 12, 16.
- Complete when claims are ignored for authorization and uncertain validation rejects.

## 18. DeliveryAtom exposure semantics

- Files: `delivery.ts`.
- Types/functions: TEXT/AUDIO/WHITEBOARD, all seven statuses, atom/command schemas.
- Tests: valid transitions and disclosed status predicate.
- Dependencies: IDs/disclosure.
- Complete when generation and delivery identities/statuses are distinct.

## 19. Delivery Coordinator state machine

- Files: `packages/delivery/src/delivery-coordinator.ts`, `renderer.ts`.
- Types/functions: queue/start/expose/complete/cancel/recover/reconnect using stable DeliveryId.
- Tests: every crash boundary, duplicate ack, retry no duplicate output, audio starts as exposed.
- Dependencies: slices 7-8, 18.
- Complete when uncertain `DELIVERING` recovery becomes `POSSIBLY_EXPOSED` and affects the ledger.

## 20. MockModelAdapter

- Files: `mock-model-adapter.ts`.
- Types/functions: deterministic capability declaration, proposal stream, cancellation behavior variants.
- Tests: provider ignores cancellation and late result is discarded by app state.
- Dependencies: slices 10, 12, 16.
- Complete when no provider memory is needed to replay authoritative state.

## 21. Provider capability/policy contracts

- Files: `provider.ts`, `packages/providers/src/policy.ts`.
- Types/functions: actual cancellation meanings, modalities, structured output, sessions, data use, usage, reasoning levels, provider-specific billing evidence.
- Tests: missing/stale/unknown/metered verification; excessive data use.
- Dependencies: clock and configuration.
- Complete when no-metered mode requires current technical no-spend proof, not a boolean label.

## 22. ReasoningProvider/VisionProvider split

- Files: `provider.ts`.
- Types/functions: independent reasoning and board-observation request/result contracts.
- Tests: text-only reasoner is valid; late vision revision is rejected.
- Dependencies: board observations and async envelopes.
- Complete when image support is not required of the reasoner.

## 23. Replay harness

- Files: `reducer.ts`, `tests/replay.test.ts`, demo.
- Types/functions: load/upcast/reduce and state canonicalizer.
- Tests: restart/replay equals live state.
- Dependencies: slices 4-6.
- Complete when SQLite alone reconstructs application truth.

## 24. Crash/idempotency tests

- Files: `tests/delivery-crash.test.ts`, `idempotency.test.ts`.
- Types/functions: fault injection checkpoints.
- Tests: all specified delivery boundaries, provider/renderer duplicates, restart.
- Dependencies: slices 8, 19, 23.
- Complete when every uncertainty is conservative and repeatable.

## 25. Randomized concurrency/property tests

- Files: `tests/concurrency.property.test.ts`.
- Types/functions: randomized callback schedules and invariant assertions.
- Tests: strict sequence, no stale/superseded delivery, idempotency, protected facts, overlay ownership.
- Dependencies: fast-check and prior state machines.
- Complete when deterministic seeds reproduce failures.

## 26. One hard-coded Oxford problem

- Files: `packages/problems/src/six-people.ts`.
- Types/functions: Ramsey `R(3,3)` problem partitions, graph, common error, zero-disclosure probe, protected hints, alternate graph/complement framing.
- Tests: schema/graph/protected metadata integrity and public/private separation.
- Dependencies: slices 14, 17.
- Complete when the one problem exercises the architecture without becoming a content-bank project.

## 27. Thin end-to-end synthetic path

- Files: `synthetic-interview.ts`, `run-synthetic.ts`, `vertical-slice.test.ts`.
- Types/functions: synthetic input through writer/store/reducer/policy/compiler/mock model/validator/delivery/mock renderer/replay.
- Tests: expected events, exposure ledger, replay identity.
- Dependencies: slices 1-23, 26.
- Complete when the preferred vertical flow runs locally with no network or UI.

## 28. Real-provider adapter experiments

- Files: disabled Gemini/Antigravity adapter shells plus experiment docs/tests.
- Types/functions: provider-specific billing/security/cancellation probes.
- Tests: deny by default; no real call until core invariants and explicit configuration pass.
- Dependencies: all core slices.
- Complete when empirical evidence proves a provider is safe under the configured no-metered/data/security policy. This slice must not become authoritative.

## Current-run target

Complete slices 1-23, 26-27 at a coherent baseline, plus the highest-risk tests from 24-25. Any remaining work stays explicitly incomplete rather than represented by permissive stubs.

## Continuation progress — asynchronous inbox slice

Implemented after the initial vertical slice:

- utterance onset/discard/finalization without conflating onset and Turn commitment;
- speech → board → speech grouping inside one InputEpisode;
- barge-in invalidation of active generation and delivery state;
- vision request/result events with broad revision and dependency checks;
- scoped evidence proposal and application-authoritative evidence update events;
- runtime validation of every persisted command result, including duplicate reads;
- file-backed SQLite close/reopen replay and idempotency tests;
- expanded randomized multimodal/vision callback schedules.

## Continuation progress — authenticated loopback protocol slice

Implemented after the asynchronous inbox slice:

- protocol-v1 discriminated command and response schemas;
- Node built-in HTTP server bound exclusively to `127.0.0.1` or `::1`;
- exact Origin allowlisting and constant-time client-token authentication before command construction;
- bounded JSON bodies and generic, schema-validated, secret-free errors;
- browser RequestId propagation into the durable writer for session start, typed Turn commitment, delivery reconnect, exposure acknowledgement, and completion acknowledgement;
- allowlisted read-only session summary instead of serializing authoritative state;
- stable DeliveryId reconnect behavior and renderer-side visible-output deduplication tests.
- first-use crash recovery that marks persisted in-flight deliveries `POSSIBLY_EXPOSED` before a restarted server handles reconnect.

Still pending in Phase 0: a real renderer/audio acknowledgement integration, richer evidence supersession, server-to-client streaming transport, additional local-compute operations, and provider-specific adapter experiments.

## Continuation progress — local-compute worker boundary

Implemented after the authenticated loopback slice:

- protocol-v1 discriminated Zod schemas for health and transcript-analysis requests/results;
- a supervised Python subprocess over NDJSON stdio with isolated mode and an allowlisted environment;
- strict RequestId and source-revision correlation;
- bounded, non-authoritative duplicate-result caches and conflicting-ID rejection;
- fail-closed handling for malformed, unsolicited, oversized, stale-basis, late, and timed-out results;
- explicit whole-process `INTERRUPT_LOCAL_PROCESS` semantics;
- a deterministic Python worker that has no event, SQLite, provider, or application-state authority;
- real-process and fault-injection tests.

## Continuation progress — local-compute result admission

Implemented after the worker process boundary:

- semantic request, accepted-result, and discarded-result events with pure replay state;
- transcript-analysis issuance only for committed speech InputEpisodes;
- callback admission through the single serialized `SessionWriter` with durable RequestId idempotency;
- exact persisted/callback/current transcript-revision checks;
- independent application recomputation of normalized text and token count before acceptance;
- bounded application-owned discard reasons with untrusted worker error messages excluded from events;
- real-worker, duplicate, stale, tampered, malformed, miscorrelated, restart, and replay tests.

Additional worker operations remain deferred. Each must define its own independently checkable admission rule rather than inheriting authority from the subprocess.

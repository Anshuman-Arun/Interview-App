# Adversarial Schedule Verification Harness

## Purpose

This harness stress-tests the frozen Phase 0 architecture under deterministic randomized schedules.

It is a verification harness, not a second implementation of the interview application. The authoritative state used by every schedule remains the production SQLite event stream reduced through the production reducer and mutated only through the production SessionWriter and coordinators.

The harness is designed to find race, stale-callback, idempotency, crash-recovery, disclosure, and replay failures that ordinary example-based tests can miss.

Passing the harness is randomized evidence of robustness. It is not exhaustive proof and it is not a formal verification of all possible schedules.

## Authority boundary

The test-only reference model tracks only invariants and conservative expectations. It never supplies application state to production code and never substitutes for:

- SessionWriter;
- SQLite persistence;
- the event reducer;
- TurnCoordinator;
- LocalComputeCoordinator;
- VerificationCoordinator;
- DeliveryCoordinator;
- provider policy;
- disclosure validation;
- renderer DeliveryId deduplication.

After every generated operation, production state is loaded from SQLite and checked against pure replay and a fresh reconstructed runtime.

## Production components exercised

The schedules directly exercise:

| Area | Production component |
| --- | --- |
| Serialized authority | `SessionWriter`, `SessionRuntimeRegistry` |
| Persistence/restart | `SqliteEventStore` |
| Event validity/replay | `SessionEventSchema`, upcaster-backed `load`, `replaySession` |
| Input/turn/generation | `TurnCoordinator` |
| Generation freshness | `isGenerationBasisStillCompatible` |
| Provider lifecycle | `MockModelAdapter`, provider proposal admission |
| Disclosure | `DisclosureValidator`, `ClosedWorldDisclosureAnalyzer` |
| Vision | production vision request/result admission in `TurnCoordinator` |
| Local compute | `LocalComputeCoordinator` |
| Verification | `VerificationCoordinator`, `TwoColourGraphVerifier`, `AbstainingVerifier` |
| Evidence | production scoped evidence update/supersession/invalidation |
| Delivery | `DeliveryCoordinator` |
| Renderer | production `RendererClient` and `RendererPresentationNotExposedError` |
| Billing | `assertProviderPermitted` |
| Whiteboard ownership | production `BoardActionSchema` |

The harness uses the real six-person Oxford fixture for problem/disclosure scope.

## Test package

```text
tests/adversarial/
  deterministic-scheduler.ts
  model.ts
  generators.ts
  invariants.ts
  fixtures.ts
  core-schedules.property.test.ts
  delivery-schedules.property.test.ts
  callback-admission.property.test.ts
  restart-replay.property.test.ts
  regression-seeds.test.ts
```

## Deterministic scheduler

`DeterministicScheduler` uses explicit deferred promises as callback barriers.

A callback is registered under a stable label and cannot execute until its release operation is selected. Schedules therefore control callback ordering without timing sleeps.

Scheduled callback families include:

- provider proposal, primary and duplicate;
- vision result, primary and duplicate;
- local-compute result, primary and duplicate;
- deterministic-verifier result, primary and duplicate;
- renderer exposed acknowledgement, primary and duplicate;
- renderer completed acknowledgement, primary and duplicate.

Cancellation and state changes may occur before or after callback release because operation order is generated explicitly.

Unreleased callbacks are cancelled and drained during fixture cleanup.

## File-backed restart model

Each generated run creates a temporary directory and a file-backed SQLite database.

A restart performs:

```text
close SqliteEventStore
→ reopen same database path
→ create fresh SessionRuntimeRegistry
→ reconstruct fresh SessionWriter
→ recreate production coordinators
```

Pending scheduled callbacks refer to the fixture's current coordinator fields, so a callback released after restart is admitted through the newly reconstructed runtime rather than the pre-crash writer.

Every temporary database and directory is removed in a `finally` path.

## Reference model

The reference model deliberately tracks only invariant-level information:

- expected authoritative event sequence;
- Context Epoch;
- transcript revision;
- board revision;
- current committed InputEpisode and Turn identities;
- GenerationId status;
- worker/verifier/vision pending-versus-terminal state;
- DeliveryId conservative state;
- active evidence per EvidenceKey;
- RequestId fingerprints;
- whether physical renderer presentation may have occurred;
- whether a presenter positively proved non-exposure.

Delivery model states are distinct:

```text
GENERATED
QUEUED
DELIVERING
EXPOSED
COMPLETED
CANCELLED
POSSIBLY_EXPOSED
```

Generation is never equated with delivery, and delivery is never equated with physical exposure.

## Generated operation families

### Core schedules

Core schedules randomize meaningful orderings of:

- provider callback and exact duplicate;
- vision callback and exact duplicate;
- board revision;
- new typed-input Turn commitment;
- transcript correction / Context Epoch advance;
- generation supersession;
- provider switch and replacement generation;
- scoped evidence update;
- start of queued delivery;
- fresh billing evidence;
- missing billing evidence;
- stale billing evidence;
- future billing evidence;
- malformed billing evidence.

### Callback-admission schedules

Callback schedules randomize:

- accepted/stale worker response;
- duplicate worker response;
- tampered worker response;
- miscorrelated worker response;
- matching/stale verifier response;
- duplicate verifier response;
- tampered verifier response;
- verifier switching;
- malformed verifier result;
- transcript correction;
- board revision;
- application restart.

### Delivery schedules

Delivery schedules randomize:

- queue/start;
- exposed acknowledgement;
- duplicate exposed acknowledgement;
- completed acknowledgement;
- duplicate completed acknowledgement;
- cancellation before exposure;
- reconnect;
- barge-in;
- restart and conservative recovery.

Renderer acknowledgement callbacks are released through the deterministic scheduler rather than called by arbitrary timing.

### Restart/replay schedules

Restart schedules combine:

- evidence updates;
- explicit evidence supersession;
- transcript correction and staleness;
- worker callbacks/duplicates;
- verifier callbacks/duplicates;
- repeated file-backed restart.

## Always-on invariants

The following checks run after every generated operation where applicable:

| Frozen property | Harness assertion |
| --- | --- |
| Event sequence is authority | loaded sequence is exactly 1..N |
| Event runtime validity | every loaded event passes current `SessionEventSchema` after store upcasting |
| Live state equals event authority | `writer.getState() === replaySession(store.load())` |
| Restart reconstruction | a separately opened fresh runtime equals pure replay |
| Model sequence | reference sequence equals persisted sequence |
| Current identities | model's committed InputEpisode/Turn exist and match in production state |
| Generation state | tracked generation states match production state |
| Callback terminality | tracked worker/verifier/vision requests match production state |
| Delivery state | conservative model status matches production DeliveryAtom status |
| Disclosure ledger | EXPOSED/COMPLETED/POSSIBLY_EXPOSED atoms contribute their disclosure IDs |
| Disclosure ceiling | disclosed atoms tied to a production generation do not exceed the app-selected maximum |
| Evidence cardinality | at most one ACTIVE evidence record exists per EvidenceKey |
| Evidence projection | active history record equals `studentEvidence` projection |
| Secret persistence | adversarial secret fixture does not occur in events or checked persisted results |

Additional operation/regression assertions cover:

- stale or UNKNOWN generation output never creating delivery;
- superseded/late provider output remaining inert;
- validator uncertainty failing closed;
- protected disclosure claims not authorizing delivery;
- worker/verifier tampering and miscorrelation failing closed;
- duplicate callbacks remaining idempotent;
- renderer duplicate presentation suppression;
- presenter-proven non-exposure permitting safe same-ID retry;
- ambiguous presentation suppressing retry;
- crash recovery making uncertain started delivery `POSSIBLY_EXPOSED`;
- persisted exposure not being demoted after restart;
- AI whiteboard actions being unable to target the student layer;
- no-metered billing checks failing closed for missing/stale/future/malformed evidence;
- conflicting RequestId reuse failing closed.

## Stable named regression scenarios

`regression-seeds.test.ts` contains stable named scenarios for the required high-risk schedules, including:

1. provider ignores cancellation and returns after replacement generation;
2. transcript correction advances Context Epoch before an old provider result;
3. late vision result after board revision;
4. duplicate local-worker result across restart;
5. stale verifier result followed by duplicate;
6. evidence update → supersede → correction/stale → restart → fresh rebuild;
7. generated hint cancelled before exposure;
8. renderer exposure followed by crash before acknowledgement persistence;
9. exposure acknowledgement persisted immediately before crash;
10. reconnect of the same DeliveryId without duplicate presentation;
11. ambiguous renderer failure suppressing retry;
12. presenter-proven non-exposure permitting same-ID retry;
13. missing/stale billing verification failing closed;
14. secret-bearing malformed/error material not being persisted/reflected;
15. UNKNOWN generation provenance producing no DeliveryAtom;
16. whiteboard student-layer mutation rejected by runtime schema;
17. stale queued delivery blocked after generation-basis invalidation;
18. conflicting RequestId reuse failing closed.

Counterexamples discovered by property testing should be minimized by fast-check and then promoted into this stable regression file.

## Fast-check execution levels

Default CI settings are intentionally bounded:

| Suite | Default runs | Default seed |
| --- | ---: | ---: |
| core | 12 | 20260829 |
| callbacks | 10 | 20260830 |
| delivery | 8 | 20260831 |
| restart | 6 | 20260832 |

Total default property runs: **36**, plus named regressions.

Each suite prints its run count, seed, and replay path before execution.

Extended local runs are controlled without package.json changes:

- `ADVERSARIAL_RUNS` — override run count for each property suite;
- `ADVERSARIAL_SEED` — use one explicit fast-check seed;
- `ADVERSARIAL_SUITE` — identifies the suite whose path should be replayed;
- `ADVERSARIAL_PATH` — fast-check shrink/replay path.

### POSIX

Run the default adversarial package:

```sh
./node_modules/.bin/vitest run tests/adversarial
```

Run 500 cases per property suite with an explicit seed:

```sh
ADVERSARIAL_RUNS=500 ADVERSARIAL_SEED=123456 ./node_modules/.bin/vitest run tests/adversarial
```

Replay one minimized core failure:

```sh
ADVERSARIAL_RUNS=1 \
ADVERSARIAL_SEED=123456 \
ADVERSARIAL_SUITE=core \
ADVERSARIAL_PATH='0:1:0' \
./node_modules/.bin/vitest run tests/adversarial/core-schedules.property.test.ts
```

### PowerShell

Run the default adversarial package:

```powershell
& .\node_modules\.bin\vitest.cmd run tests/adversarial
```

Run 500 cases per property suite with an explicit seed:

```powershell
$env:ADVERSARIAL_RUNS = "500"
$env:ADVERSARIAL_SEED = "123456"
& .\node_modules\.bin\vitest.cmd run tests/adversarial
```

Replay one minimized core failure:

```powershell
$env:ADVERSARIAL_RUNS = "1"
$env:ADVERSARIAL_SEED = "123456"
$env:ADVERSARIAL_SUITE = "core"
$env:ADVERSARIAL_PATH = "0:1:0"
& .\node_modules\.bin\vitest.cmd run tests/adversarial/core-schedules.property.test.ts
```

Unset the variables afterward if the shell will be reused.

## Failure classification

Expected fail-closed operations are asserted explicitly.

Examples:

- attempting an acknowledgement in an invalid delivery state must reject;
- a miscorrelated worker callback must throw before append;
- malformed verifier output must fail before append;
- billing policy violations must throw a specific `ProviderPolicyError.code`.

Unexpected exceptions are not swallowed and fail the property.

Fast-check prints the failing seed and minimized path; the harness also prints the configured suite/seed/path at startup.

## Cleanup and resource rules

Every randomized run uses `try/finally`.

Cleanup:

- cancels and resolves every unreleased deterministic scheduler barrier;
- drains scheduled callback promises with `Promise.allSettled`;
- closes SQLite;
- recursively removes its temporary database directory.

Renderer regression fixtures are in-process and do not start external servers or workers.

This harness adds no process, package, worker, dependency, or CI configuration.

## What the harness cannot prove

The harness cannot prove:

- all asynchronous schedules have been explored;
- semantic disclosure classification is mathematically complete;
- a remote provider's billing or cancellation semantics;
- real microphone/AEC/VAD/STT/TTS timing;
- browser paint/audio hardware exposure timing;
- whiteboard integration behavior not exposed by current Phase 0 contracts;
- absence of bugs outside generated operation families.

Randomized state-machine testing provides reproducible empirical counterexamples and broad schedule coverage. Formal proof would require a separately specified transition system and proof obligations.

## Production defects discovered

The final verification branch intentionally remains failing because it contains deterministic reproducers for genuine production defects. No production fix belongs on this verification-only branch.

### ADV-001 — stale queued delivery can start after generation invalidation

**Affected frozen invariant:** only output whose current GenerationBasis is `COMPATIBLE` may become deliverable; stale generation output must not progress toward exposure.

**Discovered by randomized schedule:**

```text
suite: core
seed: 20260829
path: 6:1:2
```

Fast-check minimized the failing generated schedule to:

```text
RELEASE_PROVIDER_DUPLICATE
BILLING_CURRENT
BILLING_MISSING
BOARD_REVISION
BILLING_STALE
PROVIDER_SWITCH
START_QUEUED_DELIVERY
RELEASE_VISION_PRIMARY
```

The irrelevant billing/vision/provider-switch operations can be removed manually. The stable named regression reduces the defect to:

```text
1. accept a COMPATIBLE provider proposal and queue its DeliveryAtom;
2. commit a board revision;
3. verify the originating GenerationBasis is now INCOMPATIBLE;
4. call DeliveryCoordinator.markStarted(deliveryId).
```

**Observed production behavior:** `markStarted` succeeds, appends `DELIVERY_STARTED`, and moves the stale queued atom to `DELIVERING`.

**Expected behavior:** the stale queued atom must not start. A revision-changing application transition should invalidate/cancel it, or the application orchestration boundary must reject start after a final compatibility check.

**Smallest likely production location:** application-owned invalidation/orchestration around `TurnCoordinator.commitBoardPatch` / other basis-changing transitions and delivery-start authorization. `packages/delivery` itself must not gain an architecture-violating dependency on interview policy.

This reproduces identically on Ubuntu and Windows.

### ADV-002 — conflicting RequestId reuse returns a false duplicate success

**Affected frozen invariant:** the same RequestId with the same command fingerprint is idempotent; conflicting RequestId reuse must fail closed.

**Stable deterministic regression:**

```text
1. queue and start one DeliveryAtom;
2. ACK_DELIVERY_EXPOSED using RequestId R;
3. verify state is EXPOSED;
4. ACK_DELIVERY_COMPLETED using the same RequestId R.
```

**Observed production behavior:** the second command resolves successfully with the previously persisted boolean result. No completion event is appended and authoritative delivery state remains `EXPOSED`.

This means RequestId equality alone is currently treated as sufficient proof of duplicate-command identity.

**Expected behavior:** the second use of `R` has a different command fingerprint and must be rejected as conflicting reuse.

**Smallest likely production location:** the durable processed-request/idempotency boundary spanning `SessionWriter.execute` and `SqliteEventStore.processed_requests`, which currently persists RequestId/result but no command fingerprint/type identity.

This reproduces identically on Ubuntu and Windows.

### Verification status with known defects

On CI run `33276173458`:

- architecture boundary checker passed on Ubuntu and Windows;
- typecheck passed on Ubuntu and Windows;
- lint passed on Ubuntu and Windows;
- callback-admission property passed;
- delivery property passed;
- restart/replay property passed;
- the core property failed only on ADV-001;
- the named regression package failed only on ADV-002 before ADV-001 was promoted into its own named regression;
- all non-adversarial test files passed;
- synthetic demo was not executed by the sequential CI workflow because Vitest intentionally failed first.

The branch is therefore intentionally red until production fixes the frozen invariants above.

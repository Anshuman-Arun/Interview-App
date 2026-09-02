# Replay and Performance History Read Model

## Authority boundary

`packages/replay` is a pure, non-authoritative projection layer. It may read persisted
semantic events and completed `SessionEvaluation` artifacts, but it cannot append
events, mutate `SessionState`, manufacture evidence, change disclosure state, or
perform evaluation. The authoritative event stream remains the source of truth.

The package deliberately depends only on `domain` and `events`. It does not import
persistence, the session writer, delivery coordinator, providers, workers, or apps.
The architecture boundary checker enforces this dependency direction.

## Projection flow

```text
authoritative persisted event history
        |
        v
safe metadata validation + existing event upcasters
        |
        v
authoritative-sequence normalization
        |
        +--> projectReplayTimeline(...)
        |
        +--> projectSessionHistory(...)
                    |
                    v
          projectLongitudinalHistory(...)
```

`sequence` is the primary chronology. Wall-clock timestamps are display metadata
only. Raw input order, object insertion order, filesystem order, and map iteration
are never used as authority. When a stable secondary order is required, replay uses
explicit UTF-16 code-unit comparison rather than locale-sensitive collation.

## Public API

The package intentionally exposes three projection entrypoints:
`projectReplayTimeline`, `projectSessionHistory`, and
`projectLongitudinalHistory`, plus projection types, bounded configuration, and
the sanitized `ReplayProjectionError`. It also exposes the narrow
`assertReplayPrefixValidForRecovery` admission seam used by deterministic Quant
recovery to validate event provenance/transition semantics before recovery
writes; this returns no replay projection or internal state. Raw normalization/upcaster hooks
and collection/text slicing helpers remain internal implementation details.

The current event-type catalog is compile-time exhaustive: all 52 current
authoritative `EventType` values require an explicit timeline mapping and
source-policy decision before TypeScript will accept the replay package. Specialized
domains may additionally require an explicit validation-boundary decision rather
than being silently treated as generically validated.

## Deterministic Quant compatibility boundary

Quant Research contributes three authoritative events:
`QUANT_RESEARCH_SCENARIO_INITIALIZED`, `QUANT_RESEARCH_ACTION_ACCEPTED`, and
`QUANT_RESEARCH_SCENARIO_COMPLETED`. Quant Trading contributes four:
`QUANT_TRADING_SCENARIO_INITIALIZED`, `QUANT_TRADING_ACTION_ACCEPTED`,
`QUANT_TRADING_ROUND_RESOLVED`, and `QUANT_TRADING_SCENARIO_COMPLETED`.
Generic replay recognizes all seven, validates their event schemas, reducer
transitions, source policy, lifecycle relationships, and command grouping, but it
does not duplicate either dedicated deterministic Quant replay engine from
`local-compute`.

The first Quant event is therefore an explicit specialized semantic boundary.
Generic timeline entries at and after that boundary use
`stateValidation: "SPECIALIZED_DOMAIN_UNVERIFIED"`, the projection reports
`SPECIALIZED_DOMAIN_VALIDATION_REQUIRED`, `complete` is false, and
`projectSessionHistory` does not expose current authoritative state beyond the
pre-Quant prefix. Application-owned composition/recovery additionally invokes the
dedicated deterministic replay path before treating Quant state as authoritative.

Generic replay exposes only bounded, non-private Quant metadata such as
family/version compatibility identity, action kind, round/action counts, and safe
completion metadata. It intentionally withholds seeds, hidden order-flow outcomes,
counterparties, candidate action values, generated parameters, grading references,
and other private deterministic evidence from public read models. This prevents a
schema-valid but deterministically tampered Quant history from becoming trusted
performance state through the generic read model.

## Timeline semantics

Each projected timeline entry retains provenance sufficient to identify the
authoritative event that produced it: event ID, session ID, sequence, persisted and
logical schema/type where known, source, elapsed/wall time, causation ID, and
correlation ID. Related utterance, input episode, Turn, Generation, Delivery, and
request IDs are attached when the event contract supplies them.

Generated/provider/verifier interpretation text is intentionally not copied into
candidate-visible replay output. Persisted provider proposals are represented by
non-content metadata such as realized action, claimed disclosure level, claimed-ID
count, whether speech text was present, and board-action count. Internal policy
targets, formal-interpretation text, verifier reasons, vision interpretations, and
model-claimed disclosure IDs are withheld.

Candidate-visible AI content is projected exactly once, from the authoritative
`DELIVERY_EXPOSED` transition. `DELIVERY_COMPLETED` remains a distinct lifecycle
entry but does not repeat content. `POSSIBLY_EXPOSED` continues to count as
disclosed for policy/evaluation, but its content and exact disclosure IDs are
withheld: replay must not turn uncertain prior exposure into a new definite
exposure outside the delivery authority boundary. Generated, rejected, queued,
delivering, cancelled, and merely possibly exposed material therefore cannot
become a new replay disclosure path.

Problem prompts and private problem partitions are not copied into replay entries.
The projection never reads canonical solutions. WHITEBOARD InputEpisode semantic
content is admitted only when paired with the corresponding authoritative
`BOARD_PATCH_COMMITTED` transition from the same serialized command, preventing
invented board semantics from appearing in committed Turns.

## Delivery and exposure

Delivery states remain distinct:

```text
VALIDATED -> QUEUED     -> authorized, not known presented
DELIVERING              -> delivery in progress, exposure not established
EXPOSED / COMPLETED     -> presented
CANCELLED               -> cancelled before known exposure
POSSIBLY_EXPOSED        -> possibly presented
```

`POSSIBLY_EXPOSED` is never collapsed into cancellation or completion. Generated
but never delivered content is not rendered as candidate-visible dialogue, and
duplicate acknowledgements do not create duplicate delivery identities.

A `DELIVERY_QUEUED` entry records both the atom's persisted admission status
(`persistedAtomStatus: VALIDATED`) and the post-event reducer status
(`status: QUEUED`), preserving the validation-to-queue transition without
fabricating a separate event.

Only `DELIVERY_EXPOSED` may include candidate-visible TEXT/AUDIO/WHITEBOARD
content and bounded disclosure IDs. AUDIO records only that an audio reference was
stored; it does not assert that PCM/media is still available. WHITEBOARD replay
preserves visible action operation/content and target/revision metadata without
exposing the internal `annotationPurpose`. For QUEUED, DELIVERING, CANCELLED,
POSSIBLY_EXPOSED, and COMPLETED entries, only safe delivery metadata is projected;
atom content and exact disclosure IDs are withheld. Free-text cancellation and
uncertainty reasons are also withheld because those application-internal strings
are not a safe alternate channel for realization content. Their effective disclosure
level and disclosure-ID count remain available for audit. A validated proposal's
delivery authorization is also consumption-bounded: replay rejects fresh DeliveryId
duplicates that would realize more TEXT/AUDIO/board outputs than the proposal
actually authorized. Every newly queued atom is also rechecked against the
generation's current `GenerationBasis`, so a later Turn/revision cannot authorize
fresh delivery from a proposal that was valid only for stale state.

## Evidence and verification history

Evidence projection keeps every authoritative update and invalidation, plus the
latest ACTIVE evidence when complete replay is available. For a complete replay,
each committed evidence-update record is also labeled with its final authoritative
status (ACTIVE, SUPERSEDED, or STALE). That status is omitted when the event stream
is truncated or crosses an unknown semantic boundary, so incomplete history is
never presented as a final evidence judgment. Provider `EVIDENCE_PROPOSED` payloads are not exposed in the timeline:
rejected proposals are non-authoritative, and successful proposals become
inspectable only through the resulting authoritative `STUDENT_EVIDENCE_UPDATED`
event.

Verification projection links each request to its verifier, GenerationBasis,
evidence scope, interpretation provenance, and accepted/discarded callback. Every
verification request must include provenance for the committed Turn named by its
basis; additional supporting event IDs may be present, so this check does not
overfit the current one-ID producer shape. Per-request `statusIsCurrent` and the verification summary's
`statusIsCurrent` are true only when the complete authoritative session state was
replayed. A request observed as PENDING in a truncated or unknown prefix remains
visible for chronology but is not claimed to be the current request state. VERIFIED,
CONTRADICTED, and UNRESOLVED are retained exactly. Discarded callbacks remain
discarded and are never promoted into authoritative verification outcomes.

Generation history retains GenerationId, GenerationBasis, provider, safe context
manifest hashes, non-content proposal metadata, supersession provenance, and
downstream DeliveryIds. In incomplete histories, the status records the latest
state actually observed in the validated prefix (for example PROPOSAL_RECEIVED)
while `statusIsCurrent: false` makes clear that a hidden tail may have changed it.
Current-schema histories that attempt to authorize or start delivery from a
superseded/rejected/incompatible generation fail replay validation rather than being
made to look current.

## Lifecycle and recovery

Session completion is inferred only from an authoritative `SESSION_COMPLETED`
event/state replay. Absence of later events never implies completion. After a
session becomes COMPLETED or ARCHIVED, replay still enforces the status requirements
of the authoritative producer for each event type. User/interview operations whose
coordinator requires an ACTIVE session remain invalid; newly queueing or starting a
Delivery is also ACTIVE-only, so terminal sessions cannot reopen output merely
because an older validated generation remains revision-compatible. Already-issued
cleanup/callback paths that the application intentionally permits (such as a late
vision result, discarding a still-capturing utterance, or acknowledging completion
of an already EXPOSED delivery) may finish. This preserves real serialized races
without reopening the session or inventing a blanket terminal rule that current
producers do not enforce. Terminal event classification is compile-time exhaustive
across the current `EventType` union, so a newly added authoritative event cannot
silently default to post-terminal permission. Session resumption is counted from
`SESSION_RESUMED`; `RECOVERY`-source
`DELIVERY_POSSIBLY_EXPOSED` events are counted separately without assuming that
every such event proves an application crash. Empty, active,
completed, archived, resumed, and crash-recovered streams are supported.

When an unknown future event or event-limit truncation prevents a complete
authoritative replay, `currentStateAvailable` is false and current-state-only
fields are omitted. Known prefix history remains available with explicit
`complete: false` / truncation metadata. `validatedThroughSequence` reports the
last sequence whose semantics were validated; `observedThroughSequence` reports
the last normalized event metadata retained in the bounded projection. The latter
may extend beyond an unknown semantic boundary and must not be interpreted as
validated state.

## Event versions and unknown future events

Known legacy/current events go through the repository's existing
`EventUpcasterRegistry`. The projection never mutates persisted historical events.

For known events, replay snapshots the already-validated top-level metadata plus the
payload reference before upcasting, so accessor/proxy values cannot change event
identity between metadata admission and schema parsing. Longitudinal selection
similarly requires the deeply parsed SessionId/start time to match the lightweight
envelope used to choose the bounded result window. Optional evaluation collections
are snapshotted once under their aggregate import budget before full schema
validation. These rules make adversarial stateful getters fail closed instead of
creating time-of-check/time-of-use ambiguity. Replay and longitudinal array
containers must also report a non-negative safe-integer length that matches the
number of values actually iterated; Proxy containers cannot claim one cardinality
while supplying another.

Future/unknown events retain only safe bounded metadata and appear as
`UNKNOWN_EVENT`; their payload is intentionally withheld. Normalized replay
entries do not retain a second reference to the raw event after upcasting/metadata
extraction, so unknown/private payloads are not unnecessarily kept alive by the
read model. The first unknown event
is a semantic boundary: later known event payloads are also withheld because their
meaning may depend on state transitions this version cannot understand. The
timeline is marked incomplete. Malformed known events, unsupported legacy versions,
mixed session IDs, and duplicate/gapped projected-prefix sequences fail with a
fixed `ReplayProjectionError` that does not echo user content. Upcasters may change
schema representation but may not rewrite immutable event identity/chronology
metadata.

## Evaluation

`projectSessionHistory` may consume an application-owned grounded
`SessionEvaluation` only when the underlying generic event history is fully
replayable and the session is terminal (COMPLETED or ARCHIVED). Archived-incomplete
evaluations are representable without inventing completion.

Replay validates exact session/problem/lifecycle/turn identity, disclosed
interventions against authoritative DeliveryId + GenerationId + final exposure
status, and every resolvable grounded evidence reference (EVIDENCE_EVENT,
VERIFICATION_REQUEST, DELIVERY, TURN, and MILESTONE). Milestone assistance
disclosure IDs and intervention-related milestone IDs must also be grounded in the
attached evaluation/intervention set.

Grounded evaluator scores remain nullable. Replay preserves categorical support and
composite coverage metadata, but intentionally omits qualitative strengths,
improvement text, milestone descriptions/reasons, intervention summaries, and other
reasoning text. It does not call or duplicate `session-evaluator.ts`, recompute
scores, or fabricate an `EVALUATION_AVAILABLE` authoritative timeline event when
no such event exists.

Longitudinal averages and medians use only non-null supported scores and report a
per-dimension `scoredSessionCount` denominator. If no included session is scored
for a dimension the aggregate is `null`, not zero. Improvement deltas require
both adjacent exact-problem attempts to have non-null composite scores; unsupported
pairs are counted in `improvementComparisonsSkipped` instead of receiving an
invented delta.

## Longitudinal comparability

Cross-session aggregation is conservative. A supplied summary claiming
`currentStateAvailable: true` must fit the same complete-projection envelope that
`projectSessionHistory` can actually produce: lifecycle status/completion/archive
flags must agree, terminal sessions cannot retain in-flight deliveries, delivery
outcome counts cannot exceed queued deliveries, each current evidence record must
have a distinct authoritative evidence EventId, and event/count totals must fit the
replay hard limit. This keeps aggregate arithmetic and lifecycle/evidence patterns
inside the range of genuine projections rather than merely shape-valid caller data. The selector scans every lightweight identity/sort envelope so
duplicate SessionIds cannot hide outside the result window, but retains raw/envelope
references only for the deterministic top `maxSessions` candidates before deep
validation.

- repeated attempts and evaluation deltas require exact problem ID **and version**;
- evidence patterns require exact structured evidence-key identity;
- unrelated problem milestones are not compared as if they were common skills;
- no skill taxonomy is fabricated. The output explicitly reports
  `skillTaxonomyAvailable: false` as the extension seam.

## Resource limits

Projection limits are deterministic hard caps. Callers may lower them for smaller
views, but may not raise them above the package defaults:

| Resource | Default |
| --- | ---: |
| events materialized/upcast into one projection | 20,000 |
| timeline entries | 5,000 |
| sessions retained/deep-validated in one longitudinal query | 500 |
| text preview | 512 Unicode code points |
| identifier / label accepted at replay boundary | 512 code units |
| disclosure IDs per entry | 64 |
| provenance/event IDs per entry | 128 |
| evidence-history entries | 2,000 |
| verification entries | 1,000 |
| generation entries | 1,000 |
| evaluation collection items (aggregate import budget) | 20,000 |

Every bounded collection reports `truncated`, `limit`, and
`remainingCount`. The 512-character identifier limit is a replay/import safety
limit only; it does not alter authoritative domain schemas or writer contracts.
Oversized imported identifiers fail with sanitized projection errors rather than
being truncated into ambiguous identities. Optional imported SessionEvaluation
artifacts are preflighted with an aggregate collection-item budget before full
schema parsing, preventing unbounded milestone/intervention/feedback arrays from
defeating the read-model resource boundary. Summary counts are computed over the full validated event prefix
rather than the bounded display rows. History is never silently dropped. The
normalizer may still scan supplied event metadata to recover authoritative sequence
order; the event cap bounds semantic upcasting/materialization and output state.

## Future UI integration

A replay UI can render these typed read models without being given mutation
authority. UI work, audio storage/playback, real tldraw replay, evaluator scoring
changes, provider routing, and new authoritative events are intentionally outside
this package.

## Replay-boundary test discipline

Replay tests that need delivery lifecycle records queue validated delivery atoms
through the authoritative session writer instead of depending on pedagogical
proposal admission. That keeps the read-model tests focused on persisted event
semantics while proposal/disclosure admission remains covered by its owning
subsystem.


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
the sanitized `ReplayProjectionError`. Raw normalization/upcaster hooks and
collection/text slicing helpers remain internal implementation details.

The current event-type catalog is compile-time exhaustive: adding a new
authoritative `EventType` requires an explicit timeline mapping and source-policy
decision before TypeScript will accept the replay package.

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
VALIDATED / QUEUED      -> authorized, not known presented
DELIVERING              -> delivery in progress, exposure not established
EXPOSED / COMPLETED     -> presented
CANCELLED               -> cancelled before known exposure
POSSIBLY_EXPOSED        -> possibly presented
```

`POSSIBLY_EXPOSED` is never collapsed into cancellation or completion. Generated
but never delivered content is not rendered as candidate-visible dialogue, and
duplicate acknowledgements do not create duplicate delivery identities.

Only `DELIVERY_EXPOSED` may include candidate-visible TEXT/AUDIO/WHITEBOARD
content and bounded disclosure IDs. AUDIO records only that an audio reference was
stored; it does not assert that PCM/media is still available. WHITEBOARD replay
preserves visible action operation/content and target/revision metadata without
exposing the internal `annotationPurpose`. For QUEUED, DELIVERING, CANCELLED,
POSSIBLY_EXPOSED, and COMPLETED entries, only safe delivery metadata is projected;
atom content and exact disclosure IDs are withheld. Their effective disclosure
level and disclosure-ID count remain available for audit. A validated proposal's
delivery authorization is also consumption-bounded: replay rejects fresh DeliveryId
duplicates that would realize more TEXT/AUDIO/board outputs than the proposal
actually authorized.

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
overfit the current one-ID producer shape. VERIFIED,
CONTRADICTED, and UNRESOLVED are retained exactly. Discarded callbacks remain
discarded and are never promoted into authoritative verification outcomes.

Generation history retains GenerationId, GenerationBasis, provider, safe context
manifest hashes, non-content proposal metadata, supersession provenance, and
downstream DeliveryIds. Current-schema histories that attempt to authorize or start
delivery from a superseded/rejected/incompatible generation fail replay validation
rather than being made to look current.

## Lifecycle and recovery

Session completion is inferred only from an authoritative `SESSION_COMPLETED`
event/state replay. Absence of later events never implies completion. Once a
session is COMPLETED or ARCHIVED, replay rejects new semantic work; the only
post-terminal delivery transition admitted is a renderer `DELIVERY_COMPLETED`
acknowledgement for an atom that was already authoritatively EXPOSED. This preserves
the real renderer race without reopening the session. Session
resumption is counted from `SESSION_RESUMED`; `RECOVERY`-source
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

`projectSessionHistory` may consume an already completed `SessionEvaluation`
only when the underlying event history is fully replayable and contains an
authoritative session completion. It validates session/problem/turn identity and
evaluation count consistency, then publishes only score/count summaries. It does
not call or duplicate `session-evaluator.ts`, recompute scores, or fabricate an
`EVALUATION_AVAILABLE` authoritative timeline event when no such event exists.

## Longitudinal comparability

Cross-session aggregation is conservative:

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
| sessions in one longitudinal query | 500 |
| text preview | 512 Unicode code points |
| identifier / label accepted at replay boundary | 512 code units |
| disclosure IDs per entry | 64 |
| provenance/event IDs per entry | 128 |
| evidence-history entries | 2,000 |
| verification entries | 1,000 |
| generation entries | 1,000 |

Every bounded collection reports `truncated`, `limit`, and
`remainingCount`. The 512-character identifier limit is a replay/import safety
limit only; it does not alter authoritative domain schemas or writer contracts.
Oversized imported identifiers fail with sanitized projection errors rather than
being truncated into ambiguous identities. Summary counts are computed over the full validated event prefix
rather than the bounded display rows. History is never silently dropped. The
normalizer may still scan supplied event metadata to recover authoritative sequence
order; the event cap bounds semantic upcasting/materialization and output state.

## Future UI integration

A replay UI can render these typed read models without being given mutation
authority. UI work, audio storage/playback, real tldraw replay, evaluator scoring
changes, provider routing, and new authoritative events are intentionally outside
this package.

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
are never used as authority.

## Timeline semantics

Each projected timeline entry retains provenance sufficient to identify the
authoritative event that produced it: event ID, session ID, sequence, persisted and
logical schema/type where known, source, elapsed/wall time, causation ID, and
correlation ID. Related utterance, input episode, Turn, Generation, Delivery, and
request IDs are attached when the event contract supplies them.

Generated proposal text is intentionally not copied into replay output. A persisted
provider proposal is represented by bounded metadata such as realized action,
claimed disclosure level, whether speech text was present, and board-action count.
Candidate-visible content is shown only through validated `DeliveryAtom` content.
This prevents rejected/generated material from becoming a replay disclosure path.

Problem prompts and private problem partitions are not copied into replay entries.
The projection never reads canonical solutions.

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

TEXT and AUDIO may include a bounded text preview when that text was authoritatively
stored in the delivery atom. AUDIO records only that an audio reference was stored;
it does not assert that PCM/media is still available. WHITEBOARD replay preserves
generic board-action operation, annotation purpose, target/revision metadata, and
bounded authored content without depending on tldraw.

## Evidence and verification history

Evidence projection keeps every authoritative update and invalidation, plus the
latest ACTIVE evidence when complete replay is available. Superseded and stale
records therefore remain inspectable rather than being flattened into the final
value.

Verification projection links each request to its verifier, GenerationBasis,
evidence scope, interpretation provenance, and accepted/discarded callback. VERIFIED,
CONTRADICTED, and UNRESOLVED are retained exactly. Discarded callbacks remain
discarded and are never promoted into authoritative verification outcomes.

Generation history retains GenerationId, GenerationBasis, provider, safe context
manifest hashes, proposal metadata, supersession provenance, and downstream
DeliveryIds. A lifecycle event appearing after supersession is flagged as a
projection integrity issue rather than made to look current.

## Lifecycle and recovery

Session completion is inferred only from an authoritative `SESSION_COMPLETED`
event/state replay. Absence of later events never implies completion. Session
resumption is counted from `SESSION_RESUMED`; recovery-origin
`DELIVERY_POSSIBLY_EXPOSED` events are counted separately. Empty, active,
completed, archived, resumed, and crash-recovered streams are supported.

When an unknown future event or event-limit truncation prevents a complete
authoritative replay, `currentStateAvailable` is false and current-state-only
fields are omitted. Known prefix history remains available with explicit
`complete: false` / truncation metadata.

## Event versions and unknown future events

Known legacy/current events go through the repository's existing
`EventUpcasterRegistry`. The projection never mutates persisted historical events.

Future/unknown events retain only safe bounded metadata and appear as
`UNKNOWN_EVENT`; their payload is intentionally withheld. The timeline is marked
incomplete. Malformed known events, unsupported legacy versions, mixed session IDs,
and duplicate/gapped sequences fail with a fixed `ReplayProjectionError` that
does not echo user content.

## Evaluation

`projectSessionHistory` may consume an already completed `SessionEvaluation`.
It validates session/problem identity and publishes only score/count summaries.
It does not call or duplicate `session-evaluator.ts`, and it does not fabricate an
`EVALUATION_AVAILABLE` authoritative timeline event when no such event exists.

## Longitudinal comparability

Cross-session aggregation is conservative:

- repeated attempts and evaluation deltas require exact problem ID **and version**;
- evidence patterns require an exact serialized evidence key;
- unrelated problem milestones are not compared as if they were common skills;
- no skill taxonomy is fabricated. The output explicitly reports
  `skillTaxonomyAvailable: false` as the extension seam.

## Resource limits

Default projection bounds are deterministic and caller-overridable:

| Resource | Default |
| --- | ---: |
| events read into one projection | 20,000 |
| timeline entries | 5,000 |
| sessions in one longitudinal query | 500 |
| text preview | 512 Unicode code points |
| disclosure IDs per entry | 64 |
| evidence-history entries | 2,000 |
| verification entries | 1,000 |
| generation entries | 1,000 |

Every bounded collection reports `truncated`, `limit`, and
`remainingCount`. History is never silently dropped.

## Future UI integration

A replay UI can render these typed read models without being given mutation
authority. UI work, audio storage/playback, real tldraw replay, evaluator scoring
changes, provider routing, and new authoritative events are intentionally outside
this package.

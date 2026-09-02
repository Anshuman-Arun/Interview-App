# Vision Observation Admission Core

This subsystem implements the semantic vision boundary above image preprocessing. It does not decode, crop, resize, transport, or persist image bytes.

## Authority boundary

Vision output is perceptual and fallible. An accepted observation can say that a model believes text, an equation, an arrow, a label, or a diagram relation is present. Admission does not make that interpretation mathematically correct and does not create EvidenceValue, choose pedagogy, create BoardAction, or mutate any whiteboard layer.

The flow is:

authoritative board basis -> preprocessed snapshot identity -> VisionInferenceRequest -> fallible backend -> VisionBackendResult -> application admission -> AcceptedBoardObservation

A later EvidenceInterpreter may use an accepted observation together with transcript, problem context, and deterministic verification.

## Request and snapshot basis

VisionInferenceRequest is protocol version 1 and binds request/session identity, source BoardRevision, a bounded region, relevant shape IDs, optional per-shape revision bindings, requested observation kind, and a VisionSnapshotBasis.

VisionSnapshotBasis contains snapshotId, SHA-256 snapshotHash, preprocessingVersion, and sourceBoardRevision. Image bytes are intentionally absent from this semantic object. Application preprocessing adapters may bind a validated, in-memory image payload to backend execution separately; that payload is ephemeral and is never part of semantic request identity, events, replay state, or diagnostics.

All request/result schemas are strict. Identity and provenance strings are validated without silent whitespace normalization. Unknown fields, non-finite or extreme coordinates, out-of-range region extents, unsafe revisions, malformed or oversized request/session/region/shape IDs, duplicate/partial revision dependencies, excessive arrays, malformed confidence, control-bearing backend metadata, and oversized interpretation text are rejected. The same bounded request-ID schema is applied to callback and cancellation lookups before manager cache access.

## Freshness

Admission fails closed.

1. The request session must match the authority view.
2. A current board revision lower than the source is impossible and rejected as SOURCE_MISMATCH.
3. Exact board revision is fresh subject to any available shape/region checks.
4. Freshness authority is supplied as a request-scoped data snapshot, not as live shape/region callbacks. This prevents admission from mixing values read from different board revisions inside one authority view.
5. If the board advanced and authoritative per-shape state is unavailable, the result is STALE_BOARD.
6. When shape revision bindings are supplied, they cover the complete relevant source-shape set rather than a partial subset.
7. If the board advanced, every relevant source shape must have the same authoritative revision and the application must independently snapshot the bounded region as COMPATIBLE. Matching old shapes alone is insufficient because a new shape could have appeared inside the region.
8. An explicitly absent or changed relevant source shape is STALE_SHAPE. An incomplete/malformed authority snapshot is FRESHNESS_UNKNOWN.
9. Missing/UNKNOWN region compatibility on an advanced board fails closed as FRESHNESS_UNKNOWN.
10. Snapshot, session, region, source, request, backend/model provenance, and proposal dependencies must match exactly or as an allowed subset where proposals narrow relevant shapes.

UNKNOWN never becomes fresh.

## Backend seam

VisionInferenceBackend exposes bounded application-owned provenance plus analyze(request, executionOptions). executionOptions always carries AbortSignal and may carry an ephemeral validated imagePayload whose actual bytes are SHA-256 checked against request.snapshotBasis.snapshotHash before backend execution. Execution payload metadata is also capped at the preprocessing hard envelope (64 MiB encoded bytes, 16384 px per dimension, 64 MiPixels) before bytes are copied, and the backend receives a defensive snapshot rather than the caller-owned buffer. AbortSignal is a cancellation request only; the application does not claim that provider compute stopped.

DeterministicFakeVisionBackend is provided for tests. No Gemini, local model, provider-control-plane, or OCR wiring is included.

## Cancellation and idempotency

VisionRequestManager bounds active requests, underlying backend execution slots, terminal tombstones, diagnostics, and accepted observations. Defaults are 8 in-flight requests, 64 terminal tombstones, 128 diagnostics, and at most 16 observations per result; hard configuration ceilings are 64 in-flight requests, 128 tombstones, and 256 diagnostics. Tombstones are intentionally kept small because an accepted result may itself contain multiple bounded interpretations and shape references.

Cancellation marks the request terminal and settles the application-facing submit promise before AbortSignal is fired. A backend that ignores cancellation may continue computing in the background, but the application no longer waits on it and any late callback receives the terminal REQUEST_CANCELLED outcome. An execution slot remains reserved until the underlying backend promise actually settles, so repeated start/cancel cycles cannot bypass maxInFlight. A backend that never settles after ignoring AbortSignal consumes one bounded slot rather than enabling unbounded orphaned executions. This intentionally distinguishes application cancellation from provider-compute cancellation.

Repeated identical registration/submission and callbacks are idempotent while their active entry or bounded terminal tombstone is retained. Concurrent submit callers receive equal but independently cloned result objects rather than a shared mutable alias. Manager-owned requests and terminal outcomes are never returned by reference; public results are cloned so caller mutation cannot rewrite the active basis or poison later duplicate outcomes. The authority resolver and backend analyze method are captured when their owning manager/request is created so replacing fields on caller-owned wrapper objects cannot redirect in-flight work. Reusing a retained RequestId with conflicting request basis or backend provenance is CONFLICTING_REQUEST_ID. Tombstones are FIFO bounded; late callbacks for evicted IDs become UNKNOWN_REQUEST. A later production event-store adapter must provide session-lifetime replay/idempotency beyond this bounded in-memory window rather than making this cache unbounded.

shutdown() cancels current work and rejects new registrations. supersedeStaleRequests() lets an authoritative board-change path proactively tombstone work; admission re-checks freshness again when a backend result arrives.

## Provenance and diagnostics

AcceptedBoardObservation retains request/session/proposal IDs, observation kind, the legacy BoardObservation payload, exact snapshot basis, the complete request-level source shape set (even when an individual proposal narrows its own relevant shapes), any complete shape revision bindings, backend/provider/model/capability versions, the board revision at admission, and a bounded freshness proof mode distinguishing exact-board admission from shape-and-region-compatible admission after an unrelated board change.

Diagnostics contain only bounded IDs/revisions/counts/backend identifiers and stable rejection codes. Raw screenshot bytes, provider payloads, board interpretations, credentials, arbitrary backend exceptions, and stack traces are not recorded. Backend results must be inert JSON-like data: accessor-backed or non-plain objects, symbol keys, enumerable or hidden unknown own fields, sparse arrays, array side properties, excessive arrays, and oversized interpretations are rejected before deep runtime parsing. Result, proposal, snapshot-basis, and backend-provenance objects each have explicit allowed own-key sets. Oversized proposal arrays are rejected without traversing their elements.

## Integration seams

Application preprocessing integration: construct VisionInferenceRequest from validated snapshot metadata and keep the prepared image payload private to backend execution, bound by snapshot hash. Raw payload bytes must not be serialized into the semantic request or persisted event stream. No image decoding or resizing belongs in semantic admission.

Future real tldraw PR: implement the manager's request-scoped authority resolver by atomically snapshotting the current authoritative BoardRevision and, when available, current states for every relevant source shape. To keep an observation valid after a broader board revision changes, the same snapshot operation must also classify the bounded region COMPATIBLE only when no added/deleted/moved content invalidated it. If those narrow proofs are unavailable, omit them and the subsystem conservatively requires the exact BoardRevision.

Future provider routing: implement VisionInferenceBackend and supply application-owned VisionBackendProvenance. Backend output remains runtime-validated and cannot authorize itself by returning different metadata.

Persistence/event integration should record semantic request/admission outcomes through the existing single-writer event path when this subsystem is production-wired. This PR intentionally avoids changing the persisted vision event schema while concurrent whiteboard/preprocessing work is unmerged.


## Legacy Phase-0 vision path

Current main still contains the older TurnCoordinator.processVisionResult / vision-freshness.ts path used for already-constructed Phase-0 BoardObservation events. That path does not carry snapshot hash, backend provenance, or narrow freshness proof and is not equivalent to this subsystem.

Raw backend output, preprocessing snapshots, and VisionObservationProposal values must enter through VisionRequestManager/admitVisionBackendResult. This PR intentionally does not rewrite the persisted legacy event schema while the real tldraw and preprocessing work are unmerged. A later integration should route production snapshot inference through Theta first, then persist only the admitted semantic observation through the single-writer event path.

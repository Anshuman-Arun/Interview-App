# Speech VAD / endpointing / STT worker core

This module is the non-authoritative speech-processing core for Phase 4 voice work. It intentionally stops at bounded observations and transcript candidates. It does **not** create or commit `Turn`s, mutate `SessionState`, write SQLite, update student evidence, choose pedagogy, authorize disclosure, or decide whether a callback is current for the interview session.

The intended integration remains:

```text
captured PCM
    -> speech worker core
    -> bounded speech/transcript result
    -> application callback admission
    -> InputEpisode / TurnCoordinator
```

## Authority boundary

`packages/local-compute/src/speech-*` depends only on the domain ID layer and local-compute code. It has no events, persistence, interview-engine, provider, or renderer dependency. `UtteranceId` is speech identity only; finalization is an acoustic/endpointing observation, not application Turn commitment.

Speech onset is similarly only an observation. The application is responsible for using a `SPEECH_STARTED` result to stop local playback/supersede generation and for deciding whether the eventual transcript still belongs to a current `InputEpisode`.

## PCM contract

PCM arrives as two pieces:

1. a runtime-validated metadata envelope (`SpeechPcmFrameEnvelopeSchema`);
2. an out-of-band binary payload (`ArrayBufferView`).

The current contract is deliberately binary-transport-neutral rather than encoding thousands of floating point samples into JSON.

Supported input is:

- protocol version 1;
- `F32LE` samples;
- mono only;
- 16 kHz or 48 kHz;
- maximum 100 ms per frame;
- sequence zero for the first frame, then contiguous increasing sequence numbers;
- non-overlapping monotonic timestamps with at most 250 ms cumulative drift from sample-derived time;
- exact payload-byte metadata;
- finite samples only (NaN and infinities fail closed);
- private/non-shared backing storage at admission (a SharedArrayBuffer-backed view must be copied by the capture adapter first).

The payload is copied once at the trust boundary before asynchronous work begins. This prevents later caller mutation from changing admitted PCM. Shared mutable backing storage is rejected because it could change concurrently while the snapshot copy itself is being made. The worker keeps immutable-owned chunks, hashes those chunks incrementally, and materializes one contiguous utterance buffer only when recognition begins.

A `SourceAudioBasis` binds results to stream identity, sequence range, timestamps, format, sample count, and a SHA-256 hash of the exact admitted PCM bytes. Its duration, sequence span, and timestamp span are cross-validated against the sample count; timestamps cannot claim less audio than the PCM contains or drift arbitrarily far beyond sample-derived duration.

## VAD state machine

The deterministic state machine is:

```text
SILENCE
  -> POSSIBLE_SPEECH
  -> SPEECH
  -> POSSIBLE_END
```

with terminal `FINALIZED` and `CANCELLED` states. A custom per-stream VAD factory must return a fresh machine in the initial `SILENCE` state; pre-advanced or reused mutable state is rejected before the stream is admitted.

It supports:

- onset hysteresis;
- separate onset and continuation thresholds;
- false-start rejection;
- resumption after a short pause;
- deterministic speech/silence duration accounting;
- a bounded pre-speech lifetime so silence-only streams cannot occupy concurrency forever;
- reset and cancellation.

`SPEECH_STARTED.atTimestampMs` reports the timestamp of the first accepted onset-candidate frame rather than the later hysteresis-confirmation frame.

The state machine consumes a bounded probability observation rather than depending on one specific model. `DeterministicEnergyVadBackend` and `ScriptedVadBackend` exist for self-contained tests. `SileroVadBackend` is a production seam around an injected runtime and an explicitly supplied local model path. It performs no model download. The validated `streamId` is passed into the Silero runtime callback so a recurrent/stateful implementation can isolate state between simultaneous streams; a runtime that keeps recurrent state must keep that state bounded and stream-scoped rather than sharing one hidden state across callers.

## Adaptive endpointing

Endpointing is separate from raw VAD. `AdaptiveEndpointingPolicy` receives VAD durations/state plus an optional bounded `appearsIncomplete` hint. The policy supports:

- minimum speech duration;
- minimum silence to finalize;
- longer silence when an utterance appears incomplete;
- maximum pause;
- maximum utterance duration;
- explicit flush;
- too-short discard.

A shape-valid endpoint decision is still bounded by worker-owned admission rules: onset-candidate audio is not eligible for finalization/STT until VAD has actually confirmed speech. An injected endpointing policy therefore cannot promote unconfirmed `POSSIBLE_SPEECH` audio into a finalized utterance.

The linguistic hint is deliberately just an input seam. Later partial-STT or application activity signals can compute it without moving authority into the VAD state machine. Endpoint inputs and configuration are runtime validated even when called directly from JavaScript/TypeScript.

When a frame would cross the configured maximum utterance duration, that frame acts only as the trigger to finalize the already-admitted utterance; its PCM is **not** included in that utterance's `SourceAudioBasis`. A future capture adapter must carry/reframe that PCM into a fresh stream (sequence zero with a new stream identity) if it represents continuing user speech. Dropping the trigger frame would otherwise lose up to one bounded frame of audio.

## STT and Moonshine seam

`SpeechRecognizer` is the recognition boundary. It receives owned PCM plus the exact `SourceAudioBasis` and returns an untrusted candidate that is validated before emission.

The deterministic fake recognizer is the normal CI backend.

`MoonshineSpeechRecognizer` is a production-oriented adapter seam. It requires:

- an explicitly supplied local model path;
- optional explicitly supplied local config path;
- model/version identity;
- an injected `MoonshineRuntime` implementation.

URLs, control/format-character path abuse, malformed runtime identities, incomplete/typoed option bags, malformed callbacks, and malformed direct recognition input are rejected. The adapter contains no downloader or model-cache ownership; that responsibility belongs to the asset layer. The adapter validates its request/utterance IDs, source-audio basis, exact PCM byte count, and raw runtime result before constructing a transcript candidate. Bounded string/array preflights run before deeper regex or per-entry validation so an already-oversized callback does not force unnecessary full traversal at the admission boundary.

The adapter also reports cancellation honestly:

- `RUNTIME_ABORT` only when the injected runtime declares abort support;
- otherwise `NONE`, while the worker core still suppresses late results after cancellation.

The current repository does not carry Moonshine model assets/runtime dependencies, so deterministic CI does not claim a live Moonshine inference test.

## Transcript admission

Recognizer output is untrusted. Admission validates and/or safely normalizes:

- request and utterance IDs;
- exact audio basis;
- transcript length (20,000 characters maximum);
- Unicode surrogate validity;
- bounded control/format-character abuse, including bidi/zero-width controls;
- confidence in `[0, 1]`;
- at most 1,000 word-timing entries;
- monotonic/sample-duration-bounded timing metadata;
- bounded printable model identity and configured-model identity matching.

`TranscriptResultGate` makes identical duplicate callbacks idempotent and rejects conflicting reuse of a result request ID. It stores only bounded fingerprints rather than retaining duplicate full transcript candidates.

Empty transcripts are valid observations; the application may decide they are not sufficient to commit input.

## Cancellation and supersession

Cancellation is safe even when compute cannot be stopped immediately.

Once a stream is cancelled or the worker is shutting down:

- the stream is marked closed/tombstoned immediately, including cancellation before its first PCM frame;
- the worker-owned buffered PCM store is released;
- in-flight VAD and recognition `AbortSignal`s are triggered;
- `RUNTIME_ABORT_REQUESTED` means the advertised abort-capable runtime received its aborted signal;
- an optional explicit runtime cancellation hook is additional best-effort work and is separately time-bounded;
- all not-yet-returned results from cancelled work are suppressed, including a finalized observation that was built immediately before STT began;
- late underlying compute may still finish when the injected runtime ignores abort, but its result is never re-admitted by this core.

VAD and recognizer calls themselves are time-bounded. A timeout releases ordinary stream state and suppresses any later callback; it does **not** falsely claim that an uncooperative native/runtime computation was physically stopped. An abort-ignoring underlying promise may therefore retain the isolated frame/utterance input until it actually settles. Such lingering VAD and STT work remains counted against a hard underlying-operation budget, so repeated cancellation/timeouts cannot create unbounded native work. If an underlying callback never settles, availability deliberately fails closed at that bound until the runtime is restarted or the operation actually finishes.

The cancellation result distinguishes:

- `RUNTIME_ABORT_REQUESTED`;
- `SUPPRESS_LATE_RESULT_ONLY`;
- `NOT_RECOGNIZING`.

This is intentionally analogous to generation supersession: acceptance correctness never depends on provider/process cancellation succeeding.

## Concurrency and idempotency

The core supports multiple independent streams up to a fixed bound. Within one stream, frame/VAD/endpoint operations are serialized through one promise chain so asynchronous VAD results cannot reorder state transitions.

Request IDs are reserved globally while work is in flight rather than only after completion:

- identical concurrent requests coalesce onto one operation;
- conflicting concurrent reuse fails closed with `REQUEST_ID_CONFLICT`;
- successful and stable failed outcomes are remembered in one bounded replay cache;
- a valid request that failed cannot later reuse the same ID with different content.

The number of in-flight/queued requests is hard-bounded. Cancellation gets a reserve only for an active stream or a stream with an actually admitted in-flight frame, so nonexistent stream IDs cannot steal emergency cancellation capacity. Cancellation reserve is bounded by the maximum stream count, and shutdown has one separate dedicated reserve slot. Within each stream, frame/VAD/endpoint operations remain serialized through one promise chain.

Closed stream IDs are retained in a bounded tombstone set so recent late frames fail as `STREAM_FINALIZED` rather than accidentally creating a new utterance with the same identity. Stream IDs are still required to be unique; the application remains the authority for stale callback admission outside this bounded worker replay window.

Cancellation intentionally bypasses the per-stream processing chain so it can suppress an in-flight recognizer even while that operation is waiting on underlying compute.

## Resource limits

Current hard defaults:

| Resource | Limit |
|---|---:|
| Frame duration | 100 ms |
| Utterance duration | 60 s |
| Unconfirmed pre-speech/silence-only stream lifetime | 10 s |
| PCM timestamp drift from sample time | 250 ms |
| PCM buffered per stream | 12 MiB |
| Concurrent streams | 4 |
| In-flight/queued requests | 64 ordinary + up to 4 admitted-stream cancellation reserve + 1 shutdown reserve |
| Underlying VAD operations | at most concurrent-stream bound (4 default) until actual promise settlement |
| Underlying recognizer operations | at most concurrent-stream bound (4 default) until actual promise settlement |
| Remembered request outcomes | 1,024 |
| Closed-stream tombstones | 1,024 |
| Transcript text | 20,000 chars |
| Word timings | 1,000 |
| Transcript-result fingerprint cache | 128 default / 1,024 hard max |
| VAD callback timeout | 2 s default / 5 s hard max |
| Recognizer timeout | 30 s default / 60 s hard max |
| Runtime cancellation-hook timeout | 500 ms default / 2 s hard max |
| Diagnostics | 32 entries |
| Diagnostic field | 256 chars |

Finalized audio is recognized inline; there is no finalized-utterance queue in this core. The queue bound is therefore zero. Frame/control request backpressure is independently bounded, and configuration may lower—but cannot raise—the protocol hard limits. A future process transport that deliberately queues recognition work must add an explicit finite queue bound rather than changing this silently.

## Diagnostics

Diagnostics contain only bounded stable metadata such as failure code and stream identity. They never include raw PCM, full transcripts, credentials, arbitrary recognizer exception text, or arbitrary model/runtime error objects.

## Current integration status and remaining wiring

Browser audio capture/playback infrastructure and the local worker lifecycle manager are now present in the repository, and a bounded local model-asset manager also exists. This speech core intentionally remains decoupled from those packages; their presence does not mean live speech is product-wired.

Remaining integration work is to:

- add a thin adapter that converts captured browser/native PCM buffers into the metadata envelope + binary payload contract, preserving a max-duration trigger frame by moving/reframing it into the next stream rather than silently dropping PCM outside the finalized source basis;
- choose the concrete process topology and launch/supervise the speech runtime through the local lifecycle manager without changing the VAD/endpoint/STT contracts;
- resolve integrity-checked local Silero/Moonshine model paths through the model-asset boundary and pass trusted explicit paths into the existing adapter seams rather than moving download/cache ownership into speech code;
- provide production AEC before real microphone use.

Application integration still must:

- admit `SPEECH_STARTED` into the serialized session path for barge-in effects;
- attach accepted transcript candidates to `InputEpisode`s;
- reject stale/cancelled callbacks using current application state;
- decide when an `InputEpisode` becomes a committed `Turn`;
- implement production AEC and hardware latency/echo tests.

None of those responsibilities should be moved into this worker core.

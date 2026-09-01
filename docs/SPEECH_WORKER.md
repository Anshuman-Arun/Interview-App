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
- non-overlapping monotonic timestamps;
- exact payload-byte metadata;
- finite samples only (NaN and infinities fail closed).

The payload is copied once at the trust boundary before asynchronous work begins. This prevents a caller from mutating a submitted buffer while VAD/STT is reading it. The worker then keeps immutable-owned chunks and only materializes one contiguous utterance buffer when recognition begins.

A `SourceAudioBasis` binds results to stream identity, sequence range, timestamps, format, sample count, and a SHA-256 hash of the exact admitted PCM bytes.

## VAD state machine

The deterministic state machine is:

```text
SILENCE
  -> POSSIBLE_SPEECH
  -> SPEECH
  -> POSSIBLE_END
```

with terminal `FINALIZED` and `CANCELLED` states.

It supports:

- onset hysteresis;
- separate onset and continuation thresholds;
- false-start rejection;
- resumption after a short pause;
- deterministic speech/silence duration accounting;
- reset and cancellation.

The state machine consumes a bounded probability observation rather than depending on one specific model. `DeterministicEnergyVadBackend` and `ScriptedVadBackend` exist for self-contained tests. `SileroVadBackend` is a production seam around an injected runtime and an explicitly supplied local model path. It performs no model download.

## Adaptive endpointing

Endpointing is separate from raw VAD. `AdaptiveEndpointingPolicy` receives VAD durations/state plus an optional bounded `appearsIncomplete` hint. The policy supports:

- minimum speech duration;
- minimum silence to finalize;
- longer silence when an utterance appears incomplete;
- maximum pause;
- maximum utterance duration;
- explicit flush;
- too-short discard.

The linguistic hint is deliberately just an input seam. Later partial-STT or application activity signals can compute it without moving authority into the VAD state machine.

## STT and Moonshine seam

`SpeechRecognizer` is the recognition boundary. It receives owned PCM plus the exact `SourceAudioBasis` and returns an untrusted candidate that is validated before emission.

The deterministic fake recognizer is the normal CI backend.

`MoonshineSpeechRecognizer` is a production-oriented adapter seam. It requires:

- an explicitly supplied local model path;
- optional explicitly supplied local config path;
- model/version identity;
- an injected `MoonshineRuntime` implementation.

URLs are rejected as model paths, and the adapter contains no downloader or model-cache ownership. That responsibility belongs to the asset layer.

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
- bounded control characters/whitespace;
- confidence in `[0, 1]`;
- at most 1,000 word-timing entries;
- monotonic/in-range timing metadata;
- model name/version bounds.

`TranscriptResultGate` makes identical duplicate callbacks idempotent and rejects conflicting reuse of a result request ID.

Empty transcripts are valid observations; the application may decide they are not sufficient to commit input.

## Cancellation and supersession

Cancellation is safe even when compute cannot be stopped immediately.

Once a stream is cancelled or the worker is shutting down:

- the stream is marked closed immediately;
- buffered PCM is released;
- the recognition `AbortSignal` is triggered;
- runtime cancellation is requested only if honestly supported;
- late recognition results are suppressed regardless of whether underlying compute stops.

The cancellation result distinguishes:

- `RUNTIME_ABORT_REQUESTED`;
- `SUPPRESS_LATE_RESULT_ONLY`;
- `NOT_RECOGNIZING`.

This is intentionally analogous to generation supersession: acceptance correctness never depends on provider/process cancellation succeeding.

## Concurrency and idempotency

The core supports multiple independent streams up to a fixed bound. Within one stream, frame/VAD/endpoint operations are serialized through one promise chain so asynchronous VAD results cannot reorder state transitions.

Frame/control request IDs are remembered in a bounded cache:

- identical replay returns the same bounded events;
- conflicting reuse fails closed with `REQUEST_ID_CONFLICT`.

Closed stream IDs are retained in a bounded tombstone set so late frames fail as `STREAM_FINALIZED` rather than accidentally creating a new utterance with the same identity.

Cancellation intentionally bypasses the per-stream processing chain so it can suppress an in-flight recognizer even while that operation is waiting on underlying compute.

## Resource limits

Current hard defaults:

| Resource | Limit |
|---|---:|
| Frame duration | 100 ms |
| Utterance duration | 60 s |
| PCM buffered per stream | 12 MiB |
| Concurrent streams | 4 |
| Remembered request results | 1,024 |
| Closed-stream tombstones | 1,024 |
| Transcript text | 20,000 chars |
| Word timings | 1,000 |
| Diagnostics | 32 entries |
| Diagnostic field | 256 chars |

Finalized audio is recognized inline; there is no unbounded finalized-utterance queue. The queue bound is therefore zero in this core. A future process transport that deliberately queues recognition work must add an explicit finite queue bound rather than changing this silently.

## Diagnostics

Diagnostics contain only bounded stable metadata such as failure code and stream identity. They never include raw PCM, full transcripts, credentials, arbitrary recognizer exception text, or arbitrary model/runtime error objects.

## Deferred integration after open infrastructure PRs merge

No code in this subsystem imports the open infrastructure branches.

After **PR #32 (local audio capture/playback)** merges, add a thin adapter that converts captured browser/native PCM buffers into the metadata envelope + binary payload contract. AEC remains outside this core and is still required before production microphone use.

After **PR #35 (local worker lifecycle manager)** merges, choose the concrete process topology and launch/supervise the speech runtime through that manager. The VAD/endpoint/STT contracts should not change.

After **PR #37 (local model asset/cache manager)** merges, pass resolved local Silero/Moonshine model paths into the existing adapter seams. Do not add download/cache ownership to speech code.

Application integration still must:

- admit `SPEECH_STARTED` into the serialized session path for barge-in effects;
- attach accepted transcript candidates to `InputEpisode`s;
- reject stale/cancelled callbacks using current application state;
- decide when an `InputEpisode` becomes a committed `Turn`;
- implement production AEC and hardware latency/echo tests.

None of those responsibilities should be moved into this worker core.

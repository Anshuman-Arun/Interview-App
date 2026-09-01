# Bounded TTS Worker Core

## Purpose

This subsystem turns an already validated interviewer text atom into bounded PCM audio. It is deliberately non-authoritative.

The authority boundary is:

```text
validated interviewer text
        ↓
TTS request
        ↓
TTS worker/core
        ↓
validated PCM chunks
        ↓
renderer/player
        ↓
physical playback
        ↓
authoritative renderer acknowledgement
        ↓
DeliveryCoordinator exposure state
```

The following are distinct facts:

```text
TTS generated PCM
≠ renderer received PCM
≠ playback started
≠ content exposed
≠ delivery completed
```

This package never decides that a delivery is exposed, completed, or possibly exposed. Those states remain application/renderer authority under the frozen architecture.

## Placement

The implementation lives in `packages/local-compute/src`:

- `tts-protocol.ts` — versioned runtime-validated input/output contracts and hard limits.
- `tts-core.ts` — text normalization, deterministic segmentation, PCM validation, synthesizer abstraction, deterministic fake synthesizer, and Kokoro adapter seam.
- `tts-request-manager.ts` — bounded admission, streaming, cancellation, late-result suppression, idempotency, tombstones, and safe diagnostics.
- `tts-worker.ts` — transport-neutral worker façade that runtime-validates every incoming/outgoing message.

The implementation imports no event store, delivery coordinator, persistence layer, session writer, or interview authority.

## Request protocol

Protocol version: `1`.

A synthesis request contains only information needed to produce speech:

```ts
{
  protocolVersion: 1,
  type: "SYNTHESIZE",
  requestId,
  text,
  voice,
  speed,
  language,
  sampleRate,
  outputFormat: "PCM_F32LE"
}
```

No `generationId` or `deliveryId` is copied into the worker because the worker does not need those identities to synthesize audio and must not become a shadow authority for interview delivery state. The application that creates the request retains the correlation.

Supported protocol languages are currently `en-US` and `en-GB`. A selected synthesizer may support only a subset of the protocol voices, languages, and sample rates; all three capability dimensions are snapshotted and checked before model execution.

Supported requested sample rates are:

- 22,050 Hz
- 24,000 Hz
- 44,100 Hz
- 48,000 Hz

Speed is finite and must be within `[0.5, 2.0]`. No numeric/string coercion is performed.

Unknown fields, malformed Unicode, unsupported control characters, empty/whitespace-only text, unsupported sample rates, malformed voice IDs, excessive metadata, NaN, and infinities fail closed.

Cancellation uses a separate strict message:

```ts
{
  protocolVersion: 1,
  type: "CANCEL_SYNTHESIS",
  requestId
}
```

Cancellation results distinguish:

- `NOT_NEEDED`
- `REQUESTED`
- `UNSUPPORTED`

`REQUESTED` means only that the adapter invoked a runtime cancellation capability. It does not claim that provider/model computation actually stopped.

## Text normalization

Normalization is narrow and deterministic:

1. CRLF/CR line endings become LF.
2. Unicode is normalized to NFC.
3. Runs of spaces/tabs inside a line collapse to one space.
4. Leading/trailing spaces on each line are removed.
5. Three or more consecutive newlines collapse to two.
6. Leading/trailing whitespace is removed.

The normalizer does not attempt semantic rewriting and does not invent mathematical pronunciation. Strings such as:

```text
x^2
P(A|B)
1/2
R(3,3)
```

remain textually intact apart from conservative whitespace normalization.

A future pronunciation layer can be added before segmentation, but it must remain deterministic and meaning-preserving.

## Deterministic segmentation

Long text is split without an LLM.

The planner considers:

1. sentence punctuation (`.`, `?`, `!`);
2. secondary punctuation (`;`, `:`, `,`);
3. whitespace;
4. a hard Unicode code-point boundary fallback.

The planner also uses a conservative deterministic duration estimate to cap a segment. Identical normalized text, speed, and limits yield identical segment boundaries and segment hashes.

The default limits are:

| Limit | Value |
|---|---:|
| Request text | 12,000 characters |
| Request UTF-8 bytes | 48,000 bytes |
| Voice identifier | 64 characters |
| Segment length | 600 characters |
| Segments/request | 64 |
| Estimated request duration | 120,000 ms |
| Estimated segment duration | 20,000 ms |

Impossible requests are rejected before model execution. The request-level estimated-duration budget is additionally capped by the requested sample rate and the 12 MiB float32 PCM byte budget, so high-sample-rate requests cannot pass preflight when their estimated audio could not fit the configured output limits.

## Source basis and hashes

Every admitted request is canonicalized in a fixed field order and hashed with SHA-256. The basis includes both the exact validated input text and the normalized synthesis text, so normalization-equivalent but byte-different payloads still conflict when they reuse a request ID.

The stream carries:

- `requestBasisHash` — exact canonical validated synthesis basis;
- `normalizedTextHash`;
- `segmentHash` for each source segment;
- `pcmHash` for every emitted chunk;
- `chunkBasisHash` — SHA-256 over a fixed JSON field order containing protocol version, request basis, sequence, segment index/hash, chunk index, final-in-segment, sample rate, channel/sample-format constants, frame/byte counts, and the computed PCM hash;
- `audioHash` over all emitted PCM bytes for a completed stream.

This is integrity/correlation metadata, not an exposure claim. A later transport can independently check that bytes were not mixed across request/segment/sequence boundaries.

## PCM contract

The current application-facing format is:

```text
mono
IEEE-754 float32
little-endian
interleaved frame representation (one channel)
PCM_F32LE
```

The synthesizer returns a `Float32Array` plus metadata. The worker snapshots that mutable array immediately at the trust boundary, then validates:

- exact requested sample rate;
- exactly one channel;
- non-empty samples;
- every sample finite;
- normalized sample amplitude in `[-1, 1]`;
- frame count;
- byte count;
- duration derived from frames/sample rate;
- model-reported duration consistency;
- aggregate duration and byte limits.

NaN and infinity are rejected. Mutable model buffers cannot mutate already admitted output.

PCM is serialized into canonical base64 only at the transport-neutral message boundary.

## Streaming

A successful stream is:

```text
AUDIO_BEGIN
AUDIO_CHUNK*
AUDIO_END
```

`AUDIO_BEGIN` has sequence `0`. Every later message increments the request sequence exactly once.

Chunks contain:

- request identity/basis;
- global sequence;
- source segment index/hash;
- chunk index;
- final-in-segment flag;
- PCM metadata;
- frame/byte count;
- per-chunk PCM and basis hashes;
- canonical base64 audio bytes.

`AUDIO_END` contains final aggregate frames, bytes, duration, model identity, and aggregate audio hash.

These messages mean only that validated synthesis output was admitted to the worker's output sink. They do not mean that a renderer accepted it or that the user heard it.

## Resource limits

Hard default output/admission bounds:

| Limit | Value |
|---|---:|
| Concurrent runtime reservations | 2 |
| Output duration/request | 120,000 ms |
| PCM bytes/request | 12 MiB |
| Frames/chunk | 4,096 |
| Chunks/request | 4,096 |
| Remembered request identities | 1,024 |
| Diagnostic observations | 64 |

The request manager retains a runtime reservation for cancelled external work until the underlying model, output-sink, and runtime-cancellation promises actually settle. This is important when a neural runtime cannot truly cancel, its cancellation hook stalls, or a transport sink stalls: logical cancellation may finish immediately, but repeated cancel/restart cycles cannot accumulate unbounded zombie model/sink/cancel calls.

## Cancellation and barge-in compatibility

Cancellation is application-driven. The worker does not detect barge-in.

Expected later flow:

```text
student speech onset
→ application supersedes generation/delivery
→ application cancels TTS request
→ worker marks request cancelled immediately
→ worker suppresses all later accepted output
→ playback layer stops already queued/playing audio
→ renderer/application owns exposure acknowledgement
```

Cancellation is checked:

- before synthesis begins;
- before each segment;
- while a segment runtime call is pending;
- after runtime return and before PCM admission;
- before every chunk;
- after output-sink admission points;
- during shutdown.

If runtime compute cannot be stopped, the worker still resolves logical cancellation and drops the late model result. It does not mislabel this as provider/model compute cancellation.

The bounded cancellation result is not the playback-stop primitive. Barge-in handling must stop local playback first and may issue/observe TTS cancellation concurrently; it must not wait for the cancellation acknowledgement before stopping audio.

If cancellation races an output-sink call that was already invoked, this core cannot retract that invocation. It stops making any subsequent sink calls, retains the request's reservation until the pending sink promise settles, and relies on downstream request supersession/playback stop to reject or neutralize stale queued audio. A sink promise resolving after logical cancellation is not an exposure or completion claim.

The bounded races in this core assume injected synthesizer, sink, and cancellation functions return control to the JavaScript event loop promptly. No in-process Promise timeout can preempt a function that blocks synchronously. A concrete native/subprocess TTS binding therefore must keep these adapter calls asynchronous/non-blocking; hard process termination and supervision belong to the separate local-worker lifecycle layer.

## Request identity and tombstones

For a retained request ID:

- identical in-flight request + identical basis coalesces to one model computation;
- conflicting payload fails with `REQUEST_ID_CONFLICT`;
- identical completed retry returns the remembered terminal summary and never replays PCM;
- conflicting completed retry fails while the tombstone is retained.

The remembered cache is FIFO-bounded. After the oldest tombstone is evicted, an ID can be reused; this is deliberate bounded-memory behavior. A cancelled request whose underlying model, output-sink, or runtime-cancellation call is still physically running is retained separately in a tiny in-flight retirement map (bounded by the concurrency limit), so eviction cannot allow its request ID to be reused before that old external work actually settles. The retirement entry also retains the already-created terminal summary, so an identical retry remains idempotent even if the ordinary FIFO tombstone rotates out before the external work settles.

Duplicate late model callbacks do not re-enter the accepted stream because terminal/cancelled requests are no longer eligible for emission.

## Failure model

Stable worker codes:

- `INVALID_REQUEST`
- `UNSUPPORTED_VOICE`
- `UNSUPPORTED_LANGUAGE`
- `UNSUPPORTED_SAMPLE_RATE`
- `MODEL_UNAVAILABLE`
- `SYNTHESIS_FAILED`
- `OUTPUT_INVALID`
- `RESOURCE_LIMIT`
- `CANCELLED`
- `REQUEST_ID_CONFLICT`
- `SHUTDOWN`
- `INTERNAL_ERROR`

The public worker façade emits bounded generic messages. It does not forward arbitrary runtime exceptions, tracebacks, credentials, or local filesystem paths.

## Diagnostics

`inspect()` exposes bounded snapshots containing only:

- request ID;
- observational request state;
- voice;
- model ID;
- planned segment count;
- output sample rate;
- synthesized duration when it is available on the recorded observation;
- stable error code when failed;
- aggregate manager counts.

It deliberately omits:

- source text;
- raw PCM/base64;
- PCM hashes;
- runtime exception objects;
- model/config paths;
- credentials.

Inspection returns immutable copies and does not mutate synthesis state.

## Synthesizer abstraction

`SpeechSynthesizer` owns only synthesis mechanics:

```ts
interface SpeechSynthesizer {
  identity
  supportedVoices
  supportedLanguages
  supportedSampleRates
  synthesize(segmentRequest)
  cancel?(requestId)
  close?()
}
```

The deterministic fake implementation is suitable for ordinary CI and is byte-stable for the same segment/configuration.

## Kokoro integration seam

`KokoroSpeechSynthesizer` is a production-facing adapter boundary, not a model downloader.

The caller must supply:

- an injected `KokoroRuntime`;
- an explicit absolute model path;
- an explicit absolute config path when the selected runtime needs one.

The adapter:

- never downloads a model;
- never owns process lifecycle;
- validates bounded runtime voice/language/sample-rate metadata;
- exposes defensive capability views backed by the validated immutable capability basis;
- validates requested voice/language/sample rate before synthesis;
- leaves runtime PCM untrusted until the synthesis core snapshots and validates it before admission;
- reports model/model-version/runtime-version provenance;
- maps runtime failures to stable worker codes;
- marks waveform determinism as `NOT_GUARANTEED`;
- reports cancellation as `UNSUPPORTED` unless the runtime actually exposes a cancel call; the request manager, not the adapter, owns the bounded wait and retained reservation for a slow cancellation hook.

A concrete library/process binding can implement `KokoroRuntime` once the local-runtime and model-asset work is integrated. Ordinary CI does not require Kokoro or any model file.

## Determinism

The worker guarantees deterministic control behavior for:

- parsing;
- normalization;
- segmentation;
- request canonicalization/hashing;
- admission;
- request conflict handling;
- chunk sequencing;
- output validation.

The deterministic fake synthesizer additionally guarantees byte-stable PCM for equal input/configuration.

The Kokoro adapter explicitly does **not** promise byte-identical neural audio. Model/runtime/GPU behavior must be benchmarked before any stronger claim is made.

## Future integration

This branch intentionally does not depend on these currently open PRs.

### PR #32 — local audio capture/playback infrastructure

Integration should adapt validated `AUDIO_CHUNK` PCM into the browser playback queue. Physical `playing`/completion events from that layer, not this worker, feed renderer acknowledgement semantics.

### PR #35 — secure local worker lifecycle manager

Integration should place any external Kokoro process/runtime behind the lifecycle manager. This TTS core must not begin spawning/killing processes itself when that PR lands.

### PR #37 — secure local model asset/cache manager

Integration should resolve and integrity-check the Kokoro model/config with the asset manager, then pass the resulting trusted explicit paths into the injected Kokoro runtime. This TTS core must not download or cache models itself.

## Explicitly deferred

This subsystem does not implement:

- browser playback;
- exposure acknowledgement;
- authoritative delivery transitions;
- microphone capture;
- AEC;
- VAD/STT/endpointing;
- worker process supervision;
- automatic model acquisition/cache ownership;
- Electron startup;
- interviewer/provider generation;
- concrete hardware tuning.

The intended integration remains:

```text
validated DeliveryAtom AUDIO/text
        ↓
TTS request
        ↓
this bounded core
        ↓
validated PCM stream
        ↓
browser playback (#32)
        ↓
physical playback event
        ↓
renderer acknowledgement
        ↓
authoritative DeliveryCoordinator exposure state
```

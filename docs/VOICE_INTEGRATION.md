# Voice Integration: Speech Admission, Authoritative Barge-In, and AUDIO Delivery

This document describes the application integration that connects the existing browser audio, speech worker, TTS worker, authoritative interview state, and renderer delivery system.

The frozen invariants remain unchanged:

- generation is not delivery;
- every audible AI response is an authoritative `AUDIO` `DeliveryAtom`;
- exposure is acknowledged from physical playback, not inferred from synthesis;
- provider/TTS cancellation is best-effort and never substitutes for authoritative supersession;
- uncertain delivery is never rewritten as definitely unexposed.

## Browser-to-speech transport

Voice input uses a dedicated authenticated loopback HTTP transport rather than the generic JSON command endpoint.

Endpoints:

- `POST /v1/voice/streams` — open one session-bound speech stream;
- `POST /v1/voice/frames` — one bounded `application/octet-stream` F32LE PCM frame;
- `POST /v1/voice/flush` — explicit endpoint request;
- `POST /v1/voice/cancel` — stream cancellation;
- `GET /v1/voice/audio/<audioRef>` — resolve one ephemeral TTS asset.

The transport is intentionally frame-oriented rather than a giant JSON/base64 command payload. Each PCM frame is independently bounded by the speech protocol's 100 ms maximum, carries exact session/stream/request/sequence/sample-rate metadata, and is admitted only in sequence. The application permits one worker operation at a time per stream and caps concurrent frame requests globally.

Every endpoint:

- binds only to `127.0.0.1` or `::1`;
- requires the exact configured browser Origin;
- requires the local client-token capability;
- uses strict request identities and bounded bodies;
- rejects sequence gaps/duplicates and stream/session mismatches;
- exposes no filesystem path;
- has explicit cancellation and a bounded server-side idle lease.

If an in-flight PCM HTTP request is dropped, the transport immediately cancels the exact bound speech stream; the bounded server-side idle lease remains a second fail-closed backstop. A dropped browser connection therefore cannot create an unbounded PCM backlog or leave a speech stream authoritative forever.

## Browser microphone lifecycle

`BrowserMicrophoneCapture` remains the physical capture owner. `useInterviewVoice` adds only application lifecycle and transport integration:

1. enable microphone;
2. capture mono browser PCM;
3. retain at most eight frames waiting for local transport;
4. stop/fail the voice cycle if backpressure exceeds that bound;
5. cancel the current speech stream on disable, session replacement, or unmount;
6. suppress late results with a local integration epoch.

Input and output device selection use the existing hardened device/playback infrastructure. Device disappearance, permission denial, capture errors, and output-sink failures are surfaced through the minimal voice controls.

Where the browser reports support, capture requests `echoCancellation`, `noiseSuppression`, and `autoGainControl`, plus an ideal 48 kHz sample rate. This is capability-based browser AEC only; there is no custom DSP echo canceller in this change. Speaker/microphone AEC quality still requires real hardware testing.

## Speech admission and authoritative barge-in

The worker is not authoritative. The application admits worker events in `VoiceInputCoordinator`.

For an admitted `SPEECH_STARTED` event:

```text
SpeechWorker SPEECH_STARTED
        |
resolve exact active session + stream
        |
TurnCoordinator.beginUtterance()
        |
authoritative generation/delivery invalidation
        |
best-effort TTS cancellation + asset pruning
        |
browser receives admitted onset
        |
QueuedRendererAudioPlayer.interruptCurrent()
        |
clear audio no longer authorized to begin
        |
abort + replace the old renderer SSE connection
```

The order is deliberate: authority changes before physical interruption.

Barge-in also invalidates the browser's existing renderer-stream connection. This is an ordering barrier for commands that may already have been written to the old SSE socket but not yet processed by the browser. The old consumer stops processing buffered delivery blocks after abort; the replacement connection attaches only after the old consumer settles and server-side disconnect classification completes. Cancelled or `POSSIBLY_EXPOSED` output is therefore not replayed.

The server closes the complementary write-side race as well: after `DeliveryCoordinator.reconnect()` persists `DELIVERING`, renderer transport re-reads the authoritative atom immediately before the synchronous physical SSE write. If `beginUtterance()` invalidated the delivery during that await boundary, no stale command is written.

`beginUtterance()` retains the frozen semantics:

- active/proposal-received/validated generations become `SUPERSEDED`;
- `QUEUED` deliveries become `CANCELLED`;
- `DELIVERING` deliveries without persisted exposure acknowledgement become `POSSIBLY_EXPOSED`.

Stopping an `HTMLAudioElement` never changes that uncertainty classification. Provider or TTS computation may continue, but late results cannot create new deliveries after the generation has been superseded.

False VAD onset is handled before `SPEECH_STARTED`; it does not call `beginUtterance()` and therefore does not invalidate interviewer output.

## STT to authoritative input

A final transcript is accepted only when all of these still match:

- current authoritative session;
- current speech stream;
- worker utterance identity;
- application-created authoritative utterance identity;
- exact finalized `SourceAudioBasis`;
- active integration token/epoch.

The admitted path is:

```text
UTTERANCE_FINALIZED + exact SourceAudioBasis
        |
TRANSCRIPT_CANDIDATE
        |
basis/identity validation
        |
TurnCoordinator.finalizeUtterance(...)
        |
InputEpisode
        |
TurnCoordinator.commitInputEpisode(...)
        |
TurnId
        |
ServerTurnOrchestrator.orchestrateTurn(...)
```

The existing `ServerTurnOrchestrator` remains a dependency. Voice integration does not choose providers, reimplement pedagogy, or bypass provider/disclosure admission.

An empty final transcript causes the capturing utterance to be discarded and does not commit a meaningless Turn.

## Validated text to TTS

TTS receives exact application-admitted interviewer text. It does not receive authority to rewrite semantic content or choose disclosure metadata.

`VoiceSynthesisCoordinator` binds synthesis to:

- source TEXT `DeliveryId`;
- `GenerationId`;
- exact text and SHA-256;
- TTS request-basis and normalized-text hashes;
- TTS model/runtime identity;
- bounded ordered PCM chunks.

Every worker callback must preserve the request identity and request-basis hash. Begin/end model identity must agree. Aggregate PCM is hash-checked before it becomes a browser-resolvable asset.

If TTS is cancelled late, ignores runtime cancellation, returns malformed metadata, changes basis/model identity, or finishes after barge-in, application admission fails closed.

## AUDIO DeliveryAtom semantics

TTS output is not directly played. After synthesis, the application calls the narrow authoritative admission step `TurnCoordinator.queueAudioDeliveryFromValidatedText(...)`.

That admission re-resolves current state and requires:

- the source is the same validated interviewer TEXT realization;
- exact text and text hash still match;
- generation provenance matches;
- generation remains `VALIDATED`;
- generation basis remains `COMPATIBLE`.

The created `AUDIO` atom copies, without reinterpretation:

- the exact semantic text;
- generation provenance;
- effective disclosure IDs;
- effective disclosure level.

TEXT and AUDIO remain separate physical deliveries with separate exposure/completion acknowledgements. If both are exposed, they are two presentations of the same admitted assistance, not one fictional combined exposure.

## Audio references and browser playback

Durable events store only a bounded logical reference of the form:

```text
audio_v1_<sha256>
```

The reference commits to session, generation, source delivery, text hash, synthesis basis, PCM hash, TTS identity, sample rate, and duration. It contains no secret or filesystem path.

PCM/WAV bytes live only in a bounded process-local `EphemeralAudioAssetStore`. The browser resolves the logical reference through the authenticated voice transport, creates a temporary Blob URL, and `QueuedRendererAudioPlayer` revokes that URL when playback settles or is cancelled.

The server-side copy is one-shot and removed when transferred to the browser.

## Crash and reconnect behavior

Ephemeral audio is deliberately not reconstructed from an unsafe path or persisted blob.

On restart/reconnect:

- `POSSIBLY_EXPOSED` is never replayed;
- `DELIVERING` without durable exposure acknowledgement is recovered as `POSSIBLY_EXPOSED`;
- a queued AUDIO atom whose ephemeral asset is missing is cancelled before physical start;
- a DELIVERING AUDIO command whose asset is missing is classified `POSSIBLY_EXPOSED`;
- V1 does not regenerate a missing queued asset automatically.

That last rule is conservative: regeneration may be added only when authoritative semantics can prove a new physical start is safe.

## Production runtime honesty

The production boundary accepts injected `SpeechWorkerCore` and `TtsWorkerCore` instances. This permits a later desktop/model-assets change to provide real Silero-, Moonshine-, and Kokoro-backed runtimes without changing session authority.

This change does **not** install model assets and does **not** claim live production Silero/Moonshine/Kokoro inference. When no voice runtime is configured, the authenticated voice transport exists but input operations fail closed with `VOICE_RUNTIME_UNAVAILABLE`.

Automated tests use deterministic/injected VAD, STT, and TTS implementations only.

## Validation

The focused voice gate is:

```text
pnpm test:e2e:voice
```

The authoritative CI matrix runs on Ubuntu and Windows and also runs:

- architecture and public-release checks;
- TypeScript typecheck and lint;
- browser + Electron builds;
- desktop bootstrap tests;
- the complete Vitest suite;
- replay tests;
- property/concurrency tests;
- typed interview E2E;
- deterministic voice E2E;
- the synthetic interview demo.

The deterministic voice E2E covers the complete integration sequence:

1. validated interviewer response;
2. deterministic TTS;
3. authoritative AUDIO creation;
4. physical browser audio start;
5. exposure acknowledgement;
6. admitted student speech onset;
7. authoritative supersession;
8. physical audio interruption;
9. rejection of late old-generation audio admission;
10. exact-basis STT finalization;
11. new Turn commit;
12. normal `ServerTurnOrchestrator` execution.

Additional focused adversarial coverage verifies false onset, empty transcripts, origin/authentication rejection, frame-size limits, sequence gaps, dropped PCM transport cancellation, buffered renderer-command suppression after barge-in, and the authority race between `DELIVERY_STARTED` persistence and physical SSE write. Existing audio lifecycle, renderer crash, speech-worker, VAD/STT, TTS, delivery crash/reconnect, and property suites remain part of the full CI gate.

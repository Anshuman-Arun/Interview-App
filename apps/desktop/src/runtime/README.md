# Desktop local model runtime

This directory is the desktop composition boundary for local speech and TTS.
It does not own interview/session authority. Authoritative voice ingress,
delivery admission, barge-in, evidence, and replay continue to live in the
existing server/interview-engine paths.

## Production composition

Desktop startup constructs one `DesktopLocalRuntimeComposition` before the
interview server:

```text
app data/model cache
  -> ModelAssetManager verification
  -> per-run verified asset view
  -> LocalRuntimeManager process supervision
  -> exact readiness handshake
  -> Silero/Moonshine/Kokoro adapters
  -> SpeechWorkerCore / TtsWorkerCore
  -> createAndStartServer({ voiceRuntime })
```

The production runtime is:

- VAD: Silero VAD 6.2.1 ONNX, CPU execution;
- STT: Moonshine Tiny English through `moonshine-voice==0.1.5`;
- TTS: Kokoro `af_heart` through Moonshine Voice 0.1.5;
- ONNX Runtime: exactly 1.29.0 for the Silero worker path;
- vision: no production local backend is selected in this integration.

Vision therefore reports `UNAVAILABLE / NO_PRODUCTION_BACKEND_CONFIGURED`.
The desktop never substitutes a deterministic/test vision backend.

## Installation is explicit

Normal desktop startup does not download model weights and does not install
Python packages. Missing assets produce `MISSING_ASSET`; a missing/incompatible
Python runtime produces `UNAVAILABLE` or `FAILED`. Typed interviews remain
usable.

Install the pinned Python runtime dependencies explicitly:

```text
python -m pip install -r workers/python/requirements-local-model-runtime.txt
```

Install the application-owned model manifests explicitly with:

```text
pnpm setup:desktop-models
```

The latter invokes the existing `ModelAssetManager` downloader. It uses fixed
HTTPS source URLs, exact expected byte lengths and SHA-256 digests, bounded
redirects/timeouts/cache size, disk-space checks, staging, verification, and
atomic publication. It does not accept a model- or renderer-provided path or
URL.

## Asset trust boundary

`model-assets.ts` contains the only production asset registry used here.
There is no `latest` model identity. Moonshine assets are pinned to revision
`35d84fc0eb2d7451da9973c990e8a77066abb105`; Silero is pinned to
`7e30209a3e901f9842f81b225f3e93d8199902b1`.

Before launch, installed assets are verified by `ModelAssetManager`, copied
into a fresh bounded runtime view, and verified again. The Python worker then
checks the exact size and SHA-256 of every file it will load before emitting
readiness. Symlink/junction-like runtime paths are rejected.

The runtime view exists because Moonshine expects a fixed relative model
layout. It is deleted only after `LocalRuntimeManager` has verified worker
process-tree shutdown.

## Worker supervision and handshake

Both production workers are registered through `LocalRuntimeManager`; the
desktop code does not call raw `spawn()`.

A worker is trusted only after a bounded stdout JSON readiness message matches
all application-owned expectations:

- component version;
- protocol version;
- worker type;
- runtime version;
- model/version identity;
- exact capability set.

A mismatch fails closed and is not automatically retried as though it were a
transient crash. Runtime-only loopback bearer tokens are supplied through the
manager's secret environment facility and are redacted from diagnostics.

Worker HTTP binds to literal `127.0.0.1`, requires the bearer token, rejects
redirect-based client behavior, and bounds request and response sizes. The
renderer receives neither worker ports/tokens nor local filesystem model paths.

## Speech semantics

The browser/server voice protocol is unchanged. `SpeechWorkerCore` remains
responsible for bounded PCM admission, endpointing, source-audio basis
identity, final transcript admission, cancellation state, and diagnostics.

The local worker accepts mono F32LE at 16 kHz or 48 kHz. Silero operates on
16 kHz recurrent windows; 48 kHz VAD frames are decimated inside the local
worker. Final STT is Moonshine batch inference over the already-bounded
utterance.

Moonshine's batch transcription API does not expose a trustworthy in-flight
interrupt primitive. The runtime therefore reports `supportsAbort = false`.
Barge-in/session cancellation still invalidates the authoritative generation
and rejects late STT results through the existing worker/session machinery.
Desktop shutdown has a bounded process-level escalation if an inference call
does not converge.

## TTS semantics and cancellation

`TtsWorkerCore` continues to bind exact admitted source text, request basis
hash, segment/chunk identity, sample rate, and model identity. The local worker
never paraphrases or generates semantic text.

Kokoro synthesis uses Moonshine's streaming TTS primitive because it exposes
the documented cross-thread `cancel_stream()` barge-in path. The existing TTS
request ID is propagated into the concrete runtime. Cancellation therefore
travels:

```text
TtsRequestManager
  -> ManagedKokoroRuntime.cancel(requestId)
  -> authenticated /v1/tts/cancel
  -> active request identity check
  -> Moonshine cancel_stream()
```

Desktop v1 requests exactly 1.0x TTS speed. The streaming API does not offer
safe per-request speed mutation, so other speeds fail closed instead of being
silently approximated.

Existing authoritative delivery admission still rejects any late audio after
the corresponding text/generation was cancelled or superseded.

## Capability status

`getCapabilityStatus()` returns bounded read-only state suitable for a later
settings/status UI:

```text
speech: READY | MISSING_ASSET | FAILED | UNAVAILABLE
tts:    READY | MISSING_ASSET | FAILED | UNAVAILABLE
vision: READY | MISSING_ASSET | FAILED | UNAVAILABLE
```

It may include bounded model/runtime identities, but never local paths or
worker credentials.

## Production versus tests

Production composition defaults only to
`workers/python/local_model_worker.py`. There is no environment variable that
switches packaged production to a fake model.

CI uses the separate
`tests/fixtures/local-model-http-worker.mjs` deterministic worker and does
not download real weights. Tests exercise authentication, handshake binding,
bounded adapter output, cancellation, crash/restart behavior, missing assets,
and Python source syntax.

## Shutdown and recovery

Desktop teardown preserves authority ordering:

```text
revoke renderer capabilities
  -> stop server command/voice/vision admission
  -> cancel authoritative voice/vision work
  -> stop interview server
  -> shut down local worker cores
  -> stop/verify local process trees
  -> remove runtime asset views
  -> close remaining desktop resources
```

The manager first requests stdin shutdown, then uses its existing bounded
termination/force-cleanup path. A process-tree cleanup failure is surfaced;
runtime views are not removed as though shutdown had succeeded.

Unexpected ready-worker crashes use the manager's finite restart policy. A
restart must identify the exact same runtime/model/capabilities; the client
discovers the new loopback port from the newly admitted handshake. No recovery
path silently selects a different model version.

## Manual verification

CI is intentionally weight-free. A real Windows smoke test should be recorded
separately after installing the pinned dependencies/assets:

1. start the desktop app and confirm speech/TTS report `READY`;
2. speak through a complete utterance and verify final Moonshine transcript;
3. trigger interviewer TTS and verify 24 kHz mono playback;
4. barge in during TTS and verify playback/model synthesis cancellation;
5. kill each worker once and confirm bounded restart with unchanged identity;
6. quit during active STT/TTS and confirm no worker process tree survives;
7. corrupt one cached/runtime-view model file and confirm the worker never
   reaches trusted readiness.

Do not claim this real-device evidence until it has actually been performed.

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
- Python dependency lock: exact graph version 1 on CPython 3.12-3.13;
- vision: no production local backend is selected in this integration.

Vision therefore reports `UNAVAILABLE / NO_PRODUCTION_BACKEND_CONFIGURED`.
The desktop never substitutes a deterministic/test vision backend.

## Installation is explicit

Normal desktop startup does not download model weights and does not install
Python packages. Missing assets produce `MISSING_ASSET`; a missing/incompatible
Python runtime produces `UNAVAILABLE` or `FAILED`. Typed interviews remain
usable.

The supported production interpreter is **CPython 3.12 or 3.13**. The
requirements file pins the complete dependency graph used by the worker, not
only Moonshine/ONNX Runtime. Install it explicitly from wheels:

```text
python -m pip install --only-binary=:all: -r workers/python/requirements-local-model-runtime.txt
```

The worker verifies the installed distribution versions before READY and binds
the dependency-lock version into its trusted runtime handshake. A later pip
resolution therefore cannot silently run under the same admitted runtime
identity.

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

CI installs only the exact pinned Python runtime dependency graph and runs
`validate_local_model_runtime.py` to catch interpreter/package/version/API
drift on both Ubuntu and Windows. It does not download model weights. Runtime integration
still uses the separate `tests/fixtures/local-model-http-worker.mjs`
deterministic worker. Tests exercise authentication, handshake binding, bounded
adapter output, active cancellation, platform-specific crash handling, missing
assets, and Python source syntax.

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

After an unexpected ready-worker crash, recovery is allowed only when
`LocalRuntimeManager` can verify cleanup of the old owned process tree. On
POSIX, verified cleanup can use the finite restart policy; every replacement
must re-admit the exact same runtime/model/capabilities and the client discovers
the new loopback port from that fresh handshake.

Windows is deliberately stricter after a root process has already disappeared:
`taskkill /T` can no longer prove that an unknown descendant did not survive.
That state is reported as `TERMINATION_FAILED` and automatic restart is
suppressed. Normal app-requested shutdown still begins while the root worker is
alive, so the existing tree-aware termination path remains available. This is a
fail-closed security property, not a retry timeout.

## Manual verification

CI is intentionally weight-free. A real Windows smoke test should be recorded
separately after installing the pinned dependencies/assets:

1. start the desktop app and confirm speech/TTS report `READY`;
2. speak through a complete utterance and verify final Moonshine transcript;
3. trigger interviewer TTS and verify 24 kHz mono playback;
4. barge in during TTS and verify playback/model synthesis cancellation;
5. on Windows, kill a worker root unexpectedly and confirm the capability fails
   closed with no automatic restart after tree verification becomes impossible;
6. quit during active STT/TTS and confirm no worker process tree survives;
7. corrupt one cached/runtime-view model file and confirm the worker never
   reaches trusted readiness.

Do not claim this real-device evidence until it has actually been performed.


### Supported wheel platforms

The current production Python worker is validated on Windows x86-64 and Ubuntu
x86-64. Upstream Moonshine 0.1.5 also publishes Linux ARM64 and macOS ARM64
wheels, but those paths are not claimed production-validated by this PR.

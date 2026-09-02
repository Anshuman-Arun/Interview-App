# Local compute worker boundary

`local_compute_worker.py` is a disposable Phase 0 worker launched and supervised by Node. It reads one protocol-v1 JSON request per stdin line and writes one validated result per stdout line.

The Python worker currently implements only a health check and deterministic transcript normalization/token counting to exercise the existing stdio boundary. Results are proposals: the process never opens SQLite, imports application event code, or owns authoritative session state. Duplicate `RequestId` values return a bounded cached response; reuse with different content fails closed.

The Node supervisor launches Python with isolated mode (`-I`), an allowlisted environment, bounded messages, request timeouts, and explicit `INTERRUPT_LOCAL_PROCESS` semantics. This is process isolation, not an OS network sandbox.

The transport-neutral speech/TTS cores live under `packages/local-compute/src/speech-*` and `tts-*`. They continue to own bounded PCM/text protocols, endpointing, result validation, cancellation/supersession, and source-basis semantics rather than this process.

`local_model_worker.py` is the production desktop model process. It is supervised only through `LocalRuntimeManager`, binds to authenticated loopback, verifies exact application-pinned model bytes before readiness, and hosts Silero VAD + Moonshine Tiny English STT or Kokoro TTS. It never opens SQLite or mutates authoritative session state. Its pinned Python dependencies are listed in `requirements-local-model-runtime.txt`; normal application startup does not install them or download model weights automatically.

Production model/cache ownership and composition are documented in `apps/desktop/src/runtime/README.md`. Vision remains unavailable in this worker rather than being represented by a deterministic fake.

`test_fixture_worker.py` is fault-injection code for malformed, duplicated, stale-basis, and delayed response tests; it is not a production worker.

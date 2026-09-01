# Local compute worker boundary

`local_compute_worker.py` is a disposable Phase 0 worker launched and supervised by Node. It reads one protocol-v1 JSON request per stdin line and writes one validated result per stdout line.

The Python worker currently implements only a health check and deterministic transcript normalization/token counting to exercise the existing stdio boundary. Results are proposals: the process never opens SQLite, imports application event code, or owns authoritative session state. Duplicate `RequestId` values return a bounded cached response; reuse with different content fails closed.

The Node supervisor launches Python with isolated mode (`-I`), an allowlisted environment, bounded messages, request timeouts, and explicit `INTERRUPT_LOCAL_PROCESS` semantics. This is process isolation, not an OS network sandbox.

The transport-neutral Phase 4 speech core now lives under `packages/local-compute/src/speech-*`. It implements bounded PCM admission, deterministic VAD/endpointing, recognizer validation, cancellation/supersession, and injected Silero/Moonshine adapter seams without depending on a concrete Python process topology. A future worker-lifecycle adapter may host those seams in Python or another local runtime after the runtime and model-asset infrastructure is available.

Concrete Silero/Moonshine runtime bindings, model assets/cache ownership, production AEC, vision, SymPy packaging, and desktop process supervision remain outside this Python fixture worker.

`test_fixture_worker.py` is fault-injection code for malformed, duplicated, stale-basis, and delayed response tests; it is not a production worker.

# Local compute worker boundary

`local_compute_worker.py` is a disposable Phase 0 worker launched and supervised by Node. It reads one protocol-v1 JSON request per stdin line and writes one validated result per stdout line.

The worker currently implements only a health check and deterministic transcript normalization/token counting to exercise the boundary. Results are proposals: the process never opens SQLite, imports application event code, or owns authoritative session state. Duplicate `RequestId` values return a bounded cached response; reuse with different content fails closed.

The Node supervisor launches Python with isolated mode (`-I`), an allowlisted environment, bounded messages, request timeouts, and explicit `INTERRUPT_LOCAL_PROCESS` semantics. This is process isolation, not an OS network sandbox. Production STT, VAD, vision, SymPy, and packaging remain deferred.

`test_fixture_worker.py` is fault-injection code for malformed, duplicated, stale-basis, and delayed response tests; it is not a production worker.

# Local compute worker boundary

The Python worker is intentionally not implemented in the first Phase 0 vertical slice. When added, it will receive versioned, runtime-validated requests over local IPC and return idempotent result envelopes to the Node session command inbox. It will never open the SQLite event store or own authoritative session state. Raw audio/frame streams are transient by default; only semantic results may become events through `SessionWriter`.

# Session Recovery Coordination

## Purpose

Application restart creates a conservative delivery boundary. Any atom persisted as `DELIVERING` may already have become physically visible even when its exposure acknowledgement is absent. Before a restarted transport serves that session, the application must therefore commit `DELIVERY_POSSIBLY_EXPOSED` and refuse visible replay.

The command and renderer-stream servers are two adapters over the same application runtime. Recovery is not owned independently by either adapter.

## Composition

`LocalInterviewTransportRuntime` creates:

- one `SessionRuntimeRegistry` supplied by the application;
- one `SessionRecoveryCoordinator` over that registry;
- one `LoopbackCommandServer` using the shared coordinator;
- one `RendererStreamServer` using the same coordinator.

Both adapters obtain their `SessionWriter` through the coordinator. The first authenticated use of a session creates one cached recovery promise; concurrent command and renderer attachment share it.

## Recovery sequence

```text
authenticated command or renderer attachment
  -> shared SessionRecoveryCoordinator.ensureRecovered(SessionId)
  -> shared SessionWriter
  -> DeliveryCoordinator.recoverUncertainDeliveries()
  -> serialized current-state recheck
  -> DELIVERY_POSSIBLY_EXPOSED for each still-DELIVERING atom
  -> transport request may continue
```

The process-local promise cache is coordination only. The event stream remains authoritative.

## Defense in depth

`DeliveryCoordinator.recoverUncertainDeliveries()` snapshots candidate DeliveryIds, but its serialized transition rechecks each atom's current status. If another recovery caller already changed the atom from `DELIVERING`, the later command appends no event.

This protects callers outside the composed transport runtime and prevents duplicate semantic recovery events without relying on the operational promise cache.

## Failure behavior

- Recovery failure rejects the waiting transport request.
- A failed promise is removed from the process-local cache, allowing a later request to retry.
- Any events committed before a partial failure remain authoritative.
- Retry is safe because each serialized transition rechecks current state.
- Successful recovery remains cached for the lifetime of that application runtime. A delivery that begins later in the same runtime is not mistaken for a crash remnant.

## Startup and shutdown

The composition runtime starts the command server before the renderer stream. If renderer startup fails, it closes the command server before rejecting startup. Repeated concurrent `start()` calls share one promise and return the same bound addresses.

Shutdown attempts to stop both transports and reports an aggregate failure after both cleanup paths have run.

## Verification

`tests/session-recovery-coordinator.test.ts` covers:

- concurrent command-summary and renderer-stream first use after a file-backed restart;
- one `POSSIBLY_EXPOSED` event across both adapters;
- no visible replay through the renderer stream;
- concurrent composition startup;
- deliberately duplicated recovery coordinators at the serialized transition boundary.

Existing command, renderer, audio-crash, delivery-crash, and file-restart suites continue to exercise the same state machine.

## Limits

This coordination is process-local and intentionally non-authoritative. It does not provide distributed locking, because Phase 0 runs one local application process and one logical SessionWriter per session. A future multi-process topology would require a separately frozen ownership mechanism rather than extending this cache into authority.

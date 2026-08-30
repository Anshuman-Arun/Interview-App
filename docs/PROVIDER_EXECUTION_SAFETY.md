# Provider Execution Safety

## Boundary

`openProviderExecutionSession` is the only production entry point that may call a `ReasoningProvider` session factory. The architecture checker enforces this syntactically across `apps/`, `packages/`, and `workers/`.

The boundary does not make provider output authoritative. It admits an operational adapter session; the Turn Coordinator, proposal validation, disclosure validation, delivery state machine, and serialized writer retain their existing authority.

## Admission sequence

```text
runtime provider identity and capability validation
  -> application policy, privacy, adapter-version, and clock preflight
  -> adapter-owned billing proof when no-metered mode requires it
  -> strict proof validation and freshness check
  -> raw session creation
  -> guarded proposal stream
```

Failure at any stage prevents later stages. In particular, malformed policy, an invalid clock, excessive data use, missing proof, stale proof, and proof/adapter version mismatch all prevent session creation. Application preflight failures do not invoke the adapter's billing verifier.

Provider exceptions are converted to fixed errors. Provider error text, proof objects, enforcement descriptions, and credentials are not persisted or reflected to the frontend.

## Cancellation

Calling `cancelTurn(generationId)` immediately marks that GenerationId cancelled in the guarded session before invoking the raw adapter. Any later proposal for it is suppressed, including output already blocked inside a provider stream when cancellation occurred.

The returned report has two independent fields:

- `outputDisposition: DROP_OUTPUT` is the local guarantee;
- `adapterResult` records only what the adapter can truthfully establish.

`CLOSE_CLIENT_STREAM` is not `CANCEL_PROVIDER_COMPUTE`. A compute-cancellation result also carries `providerConfirmed`, while a local-process interrupt carries `signalSent`. Results exceeding the adapter's declared capability are rejected, but the local output drop remains in force.

## Mock and real providers

`MockModelAdapter` supplies a current proof that its in-process implementation has no network or spend path. It can model honored or ignored cancellation without changing authoritative replay.

No real provider is enabled. Each future adapter must implement and empirically test its own billing-verification mechanism, data-use declaration, capability declaration, and cancellation reporting. Unknown or stale proof fails closed.

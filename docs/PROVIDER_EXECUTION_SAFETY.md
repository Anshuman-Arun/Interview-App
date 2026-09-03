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

The built-in supervised Antigravity CLI adapter is a real reasoning path, but it is not admitted merely because it is registered. Current production composition exposes it only on Windows, where the trusted local-runtime layer owns the CLI process through the supervised execution boundary. It declares remote data use and unknown metered status. The application policy permits that declared remote data-use class but remains no-metered by default. The concrete runtime validates a restricted profile, excludes inherited API-key/custom-endpoint environment variables, and requires audited `agy 1.1.16`, but those facts do not prove spend impossible because OS-native cached authentication can represent subscription, enterprise, or Google Cloud project modes. The production adapter therefore supplies no synthetic `ACCOUNT_QUOTA` proof and fails closed unless the trusted host explicitly enables metered-unknown remote reasoning.

The Gemini API adapter remains a real remote adapter whose ordinary API-key configuration cannot prove spend impossible under the default no-metered policy and therefore continues to fail closed.

Every real adapter must implement and empirically test its own billing-verification mechanism, data-use declaration, capability declaration, and cancellation reporting. Unknown or stale proof fails closed.

## Application orchestration

`ProviderCoordinator` is the production caller above this low-level boundary. It performs this sequence:

```text
TurnCoordinator creates Generation + GenerationBasis
  -> ContextCoordinator compiles and persists safe context identity
  -> admitted ProviderExecutionSession opens
  -> one final proposal is consumed with a stable RequestId
  -> TurnCoordinator independently checks current compatibility and disclosure
  -> validated DeliveryAtoms are queued
  -> provider session closes
```

The in-flight execution map is operational and disposable. On restart, SQLite reconstructs the Generation, manifest, proposal decision, and deliveries; provider session memory is neither reconstructed nor trusted. A retry that needs new provider work starts a fresh Generation.

Cancellation is recorded locally before awaiting an adapter cancellation call. If it races with proposal admission, the Generation is superseded and any resulting `QUEUED` atoms are cancelled before the coordinator returns completion. An atom that may already have begun exposure remains governed by the Delivery Coordinator's conservative exposure rules.

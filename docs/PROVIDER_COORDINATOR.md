# Provider Coordinator

## Responsibility

`ProviderCoordinator` owns disposable asynchronous reasoning-provider execution for one session. It does not append events itself and does not make proposals authoritative.

It composes existing authority boundaries:

- `TurnCoordinator` creates and supersedes Generations and admits proposals;
- `ContextCoordinator` compiles allowlisted context and persists its reproducibility manifest;
- `openProviderExecutionSession` enforces capability, privacy, billing, output, and cancellation safety;
- `DeliveryCoordinator` cancels atoms known to remain queued before exposure.

## Execution lifecycle

Calling `start` creates a new Generation and immediately returns its identity, basis, stable proposal RequestId, and a completion promise. The background completion:

1. compiles context against the current GenerationBasis;
2. opens an admitted provider session;
3. submits the compiled context with the GenerationId;
4. consumes at most the first final `InterviewerProposal`;
5. submits it through the serialized `TurnCoordinator` with input, Turn, Context Epoch, and committed-sequence provenance;
6. closes the provider session;
7. removes disposable in-flight state.

Completion is explicit: `ACCEPTED`, `REJECTED`, `CANCELLED`, or `FAILED` with a fixed stage/code. Raw provider error content is not returned.

## Cancellation and provider switching

`cancelGeneration` marks an in-flight Generation cancelled before awaiting any event transition or provider behavior. It then:

- supersedes an eligible Generation through the serialized writer;
- cancels its atoms that are still provably `QUEUED`;
- requests cancellation from the admitted provider session when one exists.

The admitted session independently guarantees local output suppression even when the provider reports `NONE`. If cancellation races with proposal admission, newly queued atoms are cancelled before completion is returned.

A provider switch is application-controlled: cancel the old Generation and call `start` with the replacement provider. The replacement receives a new GenerationBasis-bound Generation. Late old-provider output is inert.

## Restart behavior

The execution map, cancellation promises, and provider sessions are not persisted. Replay reconstructs authoritative semantic state from SQLite. The application never attempts to infer truth from provider memory or resume a stale provider session; new provider work uses a fresh Generation.

# Deterministic Quant Research Interview Engine

## Purpose

`packages/local-compute/src/quant-research/` implements a standalone, application-owned Quant Research interview subsystem. It owns seeded scenario generation, candidate action validation, exact/deterministic mechanics, stage progression, perturbations, replay, and structured numerical evidence. It deliberately does not call providers or own dialogue.

The engine is intentionally separate from Quant Trader/market-making code and from the main session coordinator. A later integration change can map its public state/evidence into the interview engine without giving a model authority over scenario mechanics.

## Definition format

Every scenario is created from an explicit definition:

```ts
{
  family: "BAYESIAN_UPDATING" | "SAMPLING_ESTIMATION" |
    "EXPERIMENTAL_ALLOCATION" | "MODEL_COMPARISON" |
    "CONSTRAINED_OPTIMIZATION",
  version: "1.0.0",
  seed: number,
  config: { ...family-specific bounded configuration... }
}
```

Definitions are strict runtime-validated plain objects. Unknown fields, unsafe seeds, malformed bounds, and oversized configurations are rejected before scenario generation.

## Deterministic seed semantics

The engine never uses ambient randomness. `DeterministicRng` is seeded from the explicit safe-integer seed plus the family/version namespace. All random-looking observations and latent parameters are generated during initialization. State inspection does not consume RNG state.

Identical `(family, version, seed, config)` inputs therefore produce identical hidden state and, for an identical ordered action sequence, identical public state, evidence, and result.

## Hidden, public, and authoritative state

The implementation separates three concerns:

- **Application-hidden mechanics**: latent means/models/centers, unrevealed observations, deterministic sample ordering, exact optima, and other scoring references.
- **Candidate-visible state**: `getState()` returns only the current prompt, deliberately revealed data, stage/status, public resource limits, and already-earned structured evidence.
- **Authoritative engine state**: accepted structured actions, current stage, revealed observations/summaries, deterministic evidence, and completion status.

`getDiagnostics()` is intentionally narrow and does not return the seed, configuration, latent truth, unrevealed observations, or exact scoring references. `getState()`/`getResult()` return detached structured clones so caller mutation cannot alter engine state.

The original scenario definition must be retained by application persistence for replay. The engine does not expose a convenience getter for it because that would make accidental candidate/provider projection of the seed/config easier.

## Candidate action protocol

Supported strict actions are:

- `SUBMIT_PROBABILITY`
- `REQUEST_OBSERVATION`
- `SUBMIT_NUMERIC_ESTIMATE`
- `ALLOCATE_SAMPLE`
- `CHOOSE_OPTION`
- `SUBMIT_PARAMETERS`

Every action requires an `actionId` matching a bounded safe identifier format. Actions reject unknown fields and malformed numeric values, including NaN, infinity, unsafe/non-integral counts, out-of-domain probabilities, oversized vectors, invalid options, and impossible stage/action combinations.

Accepted action IDs are unique within a scenario. Reuse is rejected. Invalid transitions are computed without mutating authoritative state, so failures are atomic.

## Scenario families

### Bayesian updating

A Beta/Bernoulli interview moves through prior predictive calibration, a revealed deterministic observation batch, a posterior update, and a changed-prior perturbation. Count arithmetic is kept exact through a narrow internal rational seam before conversion for candidate-facing probability comparison.

### Sampling and estimation

The candidate chooses how many observations to request from a seeded finite population, commits an estimate of the latent center, then revises after a disclosed contamination/outlier perturbation. Evidence includes numerical correctness, sample efficiency, adaptation, and robustness.

### Experimental allocation

The candidate allocates a bounded budget between two noisy experiments, sees deterministic sample summaries, selects the higher-mean option, and then reallocates after experiment costs change. Allocation quality is compared with the exact bounded information frontier.

### Model comparison

The candidate distinguishes a constant versus linear latent data-generating family from deterministic noisy observations and reassesses after a single disclosed outlier perturbation. Evidence captures initial correctness, robustness, and consistency.

### Constrained optimization

The candidate chooses two nonnegative integer parameters for a seeded linear/interacting objective under explicit box and budget constraints, then adapts after budget/penalty changes. The engine enumerates the bounded feasible set to own the exact optimum and objective-quality evidence.

## Evidence and scoring

The engine emits deterministic structured evidence rather than pretending to grade communication from text. Evidence categories include:

- numerical correctness;
- calibration;
- adaptation;
- sample efficiency;
- consistency;
- objective quality;
- constraint discipline;
- robustness.

Evidence scores are bounded to `[0, 100]`. `getResult()` aggregates evidence by category and provides an overall deterministic score. The summaries describe what was checked without revealing the hidden reference value.

## Replay

Replay requires:

1. the original scenario definition/version/seed/config; and
2. the ordered accepted candidate actions.

`replayQuantResearch(definition, actions)` creates a fresh engine and reapplies those actions through the same runtime validation and transition path. It returns reconstructed public state, result, and accepted actions. Replay input is bounded to the same maximum action count.

## Resource limits

Current hard bounds include:

- 32-bit unsigned safe seed domain;
- maximum 64 accepted actions;
- maximum 32 observations requested by any one action/config path;
- bounded populations and observation vectors;
- maximum eight numeric parameters per generic parameter action;
- bounded experiment budgets/costs/noise;
- bounded optimization dimensions and brute-force search domain;
- action identifiers limited to 64 safe characters.

Family transitions enforce tighter semantic limits where appropriate.

## Intentionally deferred integration

This PR does not implement:

- Quant Trader interview behavior;
- provider/model dialogue;
- main `SessionWriter`/`TurnCoordinator` integration;
- UI mode selection;
- voice, vision, whiteboard, Electron, or persistence wiring;
- generic language-model post-session evaluation.

A later integration PR should persist the scenario definition and accepted actions in authoritative session events, project only `getState()` into model context, and consume `getResult()` evidence in higher-level evaluation.

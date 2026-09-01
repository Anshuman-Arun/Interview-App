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
  generatorVersion: "quant-research-generator-v1",
  rngVersion: "xorshift32-rejection-v1",
  seed: number,
  config: { ...family-specific bounded configuration... }
}
```

Definitions are strict runtime-validated plain objects. `parseQuantResearchDefinition()` returns a detached, runtime-frozen canonical definition/config suitable for authoritative replay persistence. Unknown fields, accessor-backed values, unsupported scenario/generator/RNG versions, unsafe seeds, malformed bounds, deadlocked experiment budgets, no-op perturbations, non-meaningful outlier settings, zero-noise sampling/model configurations, and oversized configurations are rejected before scenario generation. Generated hidden state is then checked against family-specific invariants before use, including meaningful Bayesian updates, non-degenerate reachable samples, unambiguous experimental evidence, and perturbations that actually change the exact optimal allocation/solution.

## Deterministic seed semantics

The engine never uses ambient randomness. `DeterministicRng` is seeded from the explicit safe-integer seed plus a namespace containing the family, scenario version, generator version, and RNG version. The scenario definition itself carries both `generatorVersion` and `rngVersion`. Runtime parsing rejects incompatible generator or RNG semantics rather than silently replaying a persisted seed under a different implementation. All random-looking observations and latent parameters are generated during initialization. State inspection does not consume RNG state.

Identical `(family, version, generatorVersion, rngVersion, seed, config)` inputs therefore produce identical hidden state and, for an identical ordered action sequence, identical public state, evidence, and result. Public state/results/diagnostics retain the non-secret scenario/generator/RNG compatibility tuple so replay identity is not reduced to the scenario version alone. The compatibility registry is likewise keyed by the full tuple and is bounded independently of the family count so historical implementations can coexist for replay. Golden version-1 fixtures pin representative generated instances so an RNG/generator change cannot silently retain the same compatibility tuple.

## Hidden, public, and authoritative state

The implementation separates three concerns:

- **Application-hidden mechanics**: latent means/models/centers, unrevealed observations, deterministic sample ordering, exact optima, and other scoring references.
- **Candidate-visible state**: `getState()` returns only the current prompt, deliberately revealed data, stage/status, and public resource limits. It never returns numerical scoring evidence while the interview is still in progress.
- **Authoritative engine state**: accepted structured actions, current stage, revealed observations/summaries, deterministic evidence, and completion status.

`getDiagnostics()` is intentionally narrow and does not return the seed, configuration, latent truth, unrevealed observations, or exact scoring references. While a scenario is in progress, `getResult()` returns only status/identity/action count plus empty metrics/evidence; final deterministic evidence is released only after completion. `getState()`/`getResult()` return detached structured clones so caller mutation cannot alter engine state.

Application persistence must retain the canonical definition returned by `parseQuantResearchDefinition()`, not a caller-owned mutable input object. The engine does not expose a convenience hidden-definition getter because that would make accidental candidate/provider projection of the seed/config easier. A typical integration should canonicalize and persist the definition before constructing the engine, then project only `getState()` into candidate/provider context.

## Candidate action protocol

Supported strict actions are:

- `SUBMIT_PROBABILITY`
- `REQUEST_OBSERVATION`
- `SUBMIT_NUMERIC_ESTIMATE`
- `ALLOCATE_SAMPLE`
- `CHOOSE_OPTION`
- `SUBMIT_PARAMETERS`

Every action requires an `actionId` matching a bounded safe identifier format. Validated numeric values are canonicalized so JavaScript negative zero is stored as ordinary zero, preserving identity across JSON-style persistence/replay. Actions reject unknown fields and malformed numeric values, including NaN, infinity, unsafe/non-integral counts, numeric estimates/parameters outside the finite `[-1_000_000, 1_000_000]` domain, sparse/accessor-backed vectors, out-of-domain probabilities, oversized vectors, invalid options, and impossible stage/action combinations.

Accepted action IDs are unique within a scenario. Reuse is rejected. Invalid transitions are computed without mutating authoritative state, so failures are atomic.

## Scenario families

### Bayesian updating

A Beta/Bernoulli interview moves through prior predictive calibration, a revealed deterministic observation batch, a posterior update, and a changed-prior perturbation. Count arithmetic is kept exact through a narrow internal rational seam before conversion for candidate-facing probability comparison.

### Sampling and estimation

The candidate chooses how many observations to request from a seeded finite population, commits an estimate of the latent center, then revises after a disclosed contamination/outlier perturbation. Sample-efficiency credit reflects both observation economy and the achieved numerical quality, so stopping early with an unusable estimate is not treated as efficient. Evidence includes numerical correctness, sample efficiency, adaptation, and robustness.

### Experimental allocation

The candidate allocates a bounded budget between two noisy experiments, with every comparison allocation requiring at least one observation from each arm, sees deterministic sample summaries whose ordering is validated not to contradict the latent mean ordering, selects the higher-mean option, and then reallocates after experiment costs change. The information objective is the reciprocal variance of the estimated mean difference, using the exact variance of the engine's discrete-uniform noise model; allocation quality is compared with the exact bounded frontier under the same feasibility rules as the candidate action.

### Model comparison

The candidate distinguishes a constant versus linear latent data-generating family from deterministic noisy observations and reassesses after a single disclosed outlier perturbation. Linear instances are generated with a disclosed minimum slope magnitude relative to the ordinary noise radius, making the baseline families deterministically distinguishable; after perturbation, the public state preserves both baseline and perturbed observations. Evidence captures initial correctness, robustness, and consistency.

### Constrained optimization

The candidate chooses two nonnegative integer parameters for a seeded linear/interacting objective under explicit box and budget constraints, then adapts after budget/penalty changes. Generated variants are rejected if the base and perturbed problems share an exact optimum, so an unchanged optimal answer cannot receive full adaptation credit. The engine enumerates the bounded feasible set to own the exact optimum and objective-quality evidence.

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

Evidence scores are bounded to `[0, 100]`. For exact allocation/optimization objectives, a non-optimal solution is capped below 100 even if a percentage ratio would otherwise round upward; category and overall aggregation likewise return 100 only when every constituent score is 100. Repeated evidence within a category is averaged first, then the final overall score averages the category-level metrics so a category does not gain accidental weight merely by appearing at more stages. Post-perturbation adaptation scores reflect quality under the changed conditions rather than rewarding an unchanged poor answer. The summaries describe what was checked without revealing the hidden reference value.

Threshold comparisons use a small machine-precision allowance so mathematically symmetric answers on a scoring boundary are not split solely by binary floating-point representation. Bayesian posterior/update perturbation scores combine absolute numerical tolerance with progress from the stale reference toward the changed target; simply repeating the old prior/posterior therefore receives zero update/adaptation credit.

## Replay

Replay requires:

1. the canonical parsed scenario definition, including family, scenario version, generator version, RNG version, seed, and config; and
2. the ordered accepted candidate actions.

`replayQuantResearch(definition, actions)` creates a fresh engine and reapplies those actions through the same runtime validation and transition path. It returns reconstructed public state, result, and accepted actions. The replay container itself is runtime validated, and replay input is bounded to the same maximum action count.

## Resource limits

Current hard bounds include:

- 32-bit unsigned safe seed domain;
- maximum 64 accepted actions;
- maximum 32 observations requested by any one action/config path;
- bounded populations and observation vectors;
- maximum eight numeric parameters per generic parameter action;
- finite numeric estimate/parameter domain of `[-1_000_000, 1_000_000]`;
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

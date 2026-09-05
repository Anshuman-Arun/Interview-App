# Oxford originality and fidelity audits

> **Agent H — Hilbert** owns the independent originality / anti-lifting and Oxford-fidelity gates for Wave 2.

These records operationalize the frozen Wave 1 framework in:

- `docs/oxford-adaptive-problem-contract.md`;
- `docs/oxford-research/originality-audit.md`;
- the deep benchmark corpus, broader reference inventory, and current-bank research snapshot.

They do **not** create a second taxonomy. Mathematical classification continues to use Agent A's canonical schema.

## Two independent gates

Every family keeps separate decisions:

- originality: `PASS | PASS_WITH_NOTES | REVISE | REJECT_TOO_CLOSE`;
- fidelity: `PASS | PASS_WITH_NOTES | REVISE | REJECT_NOT_OXFORD_LIKE`.

A family can be Oxford-like but non-original, original but unsuitable as an Oxford interview, both, or neither. Classic mathematics can clear Hilbert only with truthful provenance; new wording or staging never turns a classic kernel into an independent-original one.

## Mandatory five-pool retrieval

Every retained production proposal records all five pools:

- **A** — deep official benchmark corpus;
- **B** — broader reference inventory;
- **C** — current Interview App bank;
- **D** — surviving same-wave proposals;
- **E** — mandatory external/classic mathematical search.

Pool E is required even when A–D are clean. Absence from a local corpus is never treated as evidence of originality. Review compares objects, constraints, target, kernel, decisive mechanism, diagram topology, representation change, reveal sequence, extensions, and solution dependency structure.

## Mathematical fingerprint

Audit records retain source-independent fingerprints rather than copied external problem text. The validator requires:

- surface objects and constraints;
- target type;
- central and secondary mechanisms;
- critical representation change;
- diagram topology;
- small-case signature;
- opening/deepening/core/transfer/stretch progression;
- solution dependency graph summary;
- distinctive features;
- classic overlap;
- truthful provenance.

## Guided adaptation and error recovery

This audit does not infer either process-grounded skill from milestone completion. A family may be designed to elicit `guided-adaptation` or `error-recovery`, but candidate evidence still requires the authoritative event relationship defined by Agent A.

## Retained audit snapshots

`current-bank-baseline.json` covers all 13 default Oxford fixtures plus the isolated Catalan expert-review fixture at main commit `454a2fe993c8fd70676d04e5d262a1780161f0d6`.

`same-wave-full-certification.json` is the authoritative Wave 2 C/D/E Hilbert snapshot. It certifies **every 47 surviving author family** at these exact heads:

- Agent C — Cantor PR #132: `0d4941ab3197b2297ab389d7438df39f599b2ad5` — 18 survivors;
- Agent D — Dirichlet PR #133: `ecece22058c997d37c4b352fa5ed32bd1daf5243` — 12 survivors;
- Agent E — Euler PR #134: `165bb3100fb894158969abb808caad5bc9150807` — 17 survivors.

The author completion passes introduced **no replacement families**. Cantor removed 2 prior hard rejects, Dirichlet pruned 10 classic/standard kernels, and Euler removed 2 prior hard rejects. Material provenance/staging changes were re-audited at the heads above.

`same-wave-high-risk-batch.json` is retained only as an archival record of the earlier 12-family risk-prioritized pass. It does not drive completion or the default validator.

Current same-wave certification counts:

- originality: `PASS 0 / PASS_WITH_NOTES 35 / REVISE 6 / REJECT_TOO_CLOSE 6`;
- fidelity: `PASS 40 / PASS_WITH_NOTES 7 / REVISE 0 / REJECT_NOT_OXFORD_LIKE 0`.

## Validation

Run:

```bash
node scripts/validate-oxford-audits.mjs
```

With no path argument, the validator checks the current-bank baseline and the authoritative full C/D/E certification. A specific audit JSON path can be supplied to validate only that file.

The validator fails closed on incomplete fingerprints, missing retrieval pools, missing external-search evidence, invalid decision enums, out-of-range similarity scores, originality passes that conflict with hard-fail score combinations unless provenance is explicitly truthful-classic, duplicate family IDs, or forbidden full source/problem/solution text keys.

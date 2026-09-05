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

A family can be Oxford-like but non-original, original but unsuitable as an Oxford interview, both, or neither.

For the current-bank baseline, `REVISE` on originality means that a legacy/classic fixture is still stored with provisional/unknown adaptive provenance and therefore cannot receive an originality/provenance approval yet. It does **not** claim that a known classic must be deleted. A truthfully labelled `classic-problem` may later be recommendation-ready under the frozen contract after independent reviews and calibration pass.

If the same known classic were submitted as a **new independent-original** family, the recorded hard structural match would instead justify `REJECT_TOO_CLOSE`.

## Mandatory five-pool retrieval

Every production proposal must record completion of all five pools:

- **A** — deep official benchmark corpus;
- **B** — broader reference inventory;
- **C** — current Interview App bank;
- **D** — same-wave proposals;
- **E** — external/classic mathematical search.

Pool E is mandatory even when A–D are clean. Phrase similarity alone is insufficient: reviewers compare normalized setup, target, kernel, decisive mechanism, diagram topology, progression, transfer/stretch, and solution dependency.

A pool may truthfully report that no plausible neighbour was found, but it may not be omitted.

## Mathematical fingerprint

Audit records retain source-independent fingerprints rather than full source/problem text. The validator requires:

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

This follows the Wave 1 fingerprint contract while avoiding copyrighted source reproduction.

## Guided adaptation and error recovery

This audit does not infer either process-grounded skill from milestone completion. A family may be designed to elicit `guided-adaptation` or `error-recovery`, but candidate evidence still requires the authoritative event relationship defined by Agent A (intervention/error followed by grounded subsequent progress).

## Current baseline

`current-bank-baseline.json` covers all 13 default Oxford fixtures plus the isolated Catalan expert-review fixture at main commit `454a2fe993c8fd70676d04e5d262a1780161f0d6`.

The baseline deliberately does **not** edit production problem metadata. It is an independent review artifact. A later migration must update provenance/review fields through the existing curated-problem path and must still satisfy Agent G calibration and Agent I correctness review.

## Validation

Run:

```bash
node scripts/validate-oxford-audits.mjs
```

The validator fails closed on incomplete fingerprints, missing retrieval pools, missing external search evidence, invalid decision enums, out-of-range similarity scores, originality passes that conflict with Wave 1 hard-fail score combinations, duplicate family IDs, or audit keys that attempt to store full source/problem/solution text.

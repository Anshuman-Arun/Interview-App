# Deterministic verification

`packages/verification` contains narrow deterministic verifiers. They consume a JSON string that represents a fully structured formal interpretation and return the existing domain `VerificationResult`. They do not parse student prose, call providers, mutate session state, or grant evidence authority.

## Result semantics

The repository's existing result vocabulary is preserved:

- `VERIFIED` means a supported, well-formed claim evaluated exactly and matched the claimed result.
- `CONTRADICTED` means a supported, well-formed claim evaluated exactly and did not match the claimed result.
- `UNRESOLVED` is abstention. It covers malformed or unsupported schemas, insufficient interpretation confidence, undefined arithmetic, and resource-limit failures. Unsupported is never treated as false.

New math verifiers use stable reason-code prefixes such as `CLAIM_VERIFIED`, `CLAIM_CONTRADICTED`, `MALFORMED_INTERPRETATION`, and `RESOURCE_LIMIT` for tests and diagnostics.

## Exact arithmetic model

JSON integers are encoded as canonical base-10 strings; leading zeroes, a leading `+`, whitespace, and negative zero are rejected. Operand literals are capped at 256 decimal digits, while explicit claimed-result literals may use the existing 4,096-digit exact-intermediate bound so supported computations can represent their own exact answers. Rationals are `{ numerator, denominator }` string pairs and are normalized with a positive denominator and gcd reduction. Exported rational operations defensively normalize caller-supplied `ExactRational` values and cross-cancel where practical before enforcing intermediate-size bounds. No floating-point comparison is used for verification.

The shared utility layer provides bounded integer parsing, gcd/lcm, divisibility and modular normalization, exact rational arithmetic, finite sums/products, factorial/binomial/permutation/combinations-with-repetition helpers, and finite set/multiset/permutation checks. Divisibility follows the mathematical existence definition, so `0 | 0` is true while `0 | b` is false for nonzero `b`. Direct bigint helpers and supported expression operations retain resource checks; verifier schemas remain the runtime shape boundary for untrusted structured inputs.

## Verifiers and protocols

| Verifier | Protocol | Supported claims |
| --- | --- | --- |
| `deterministic-modular-arithmetic-verifier@1` | `INTERVIEW_APP_MODULAR_ARITHMETIC_CLAIM` | congruence and divisibility over a small integer-expression grammar |
| `deterministic-rational-arithmetic-verifier@1` | `INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM` | equality of exact structured rational expressions |
| `deterministic-finite-recurrence-verifier@1` | `INTERVIEW_APP_FINITE_RECURRENCE_CLAIM` | finite prefixes and indexed values for bounded constant-coefficient linear recurrences |
| `deterministic-combinatorial-counting-verifier@1` | `INTERVIEW_APP_COMBINATORIAL_COUNTING_CLAIM` | binomial coefficients, permutations, combinations with repetition, two-set inclusion/exclusion |
| `deterministic-probability-arithmetic-verifier@1` | `INTERVIEW_APP_PROBABILITY_ARITHMETIC_CLAIM` | finite expectation, conditional probability from explicit counts/probabilities, and Bayes arithmetic |

The expression grammar is intentionally small. Integer powers accept only bounded non-negative integer exponents; `0^0` is deliberately treated as undefined and therefore abstains instead of choosing a convention. There is no algebra-string parser, symbolic simplifier, recurrence solver, theorem prover, or computer-algebra dependency.

For `LINEAR_PREVIOUS_TERMS`, sequence indices are zero-based: `initial[0]` is index 0. `coefficients[0]` multiplies the immediately previous sequence value, `coefficients[1]` the value two positions back, and so on; the constant is then added. The initial-condition count must exactly match the coefficient count.

Counting helpers use explicit total-function conventions at their finite-domain boundary: `C(n, k) = 0` and `P(n, k) = 0` when `k > n`; combinations with repetition return 1 for zero selections and 0 for positive selections from zero types.

Probability-model inputs are validated as exact rationals in `[0, 1]`; conditioning and Bayes evidence probabilities must be strictly positive. Internally inconsistent supplied probability models abstain as malformed rather than being contradicted as though they were valid models. Claimed probability answers remain exact rational claims: an out-of-range claimed answer is contradicted when the supplied model itself is valid.

## Resource limits

Limits are exported from `limits.ts` and enforced before or during evaluation. Current bounds include:

- 100,000 statement characters;
- 256 decimal digits per supplied operand integer;
- 4,096 decimal digits per exact intermediate or claimed-result integer;
- 32 levels / 10,000 nodes for generic structured input;
- 24 levels / 512 nodes for arithmetic expressions;
- 128 terms per variadic expression;
- exponent at most 1,024;
- recurrence order at most 16 and checked sequence length at most 256;
- combinatorial `n` at most 1,000;
- at most 512 probability outcomes;
- at most 1,024 items for finite-container helpers.

Over-limit or undefined inputs abstain rather than producing positive evidence.

## Registry and evidence scope

`DETERMINISTIC_MATH_VERIFIERS` exposes names, protocol versions, and factories so runtime code can register a verifier without duplicating identities. The registry array and each descriptor are frozen at runtime. It deliberately contains no evidence keys or problem IDs and grants no authorization. A later integration must explicitly bind a verifier name to an allowed curated-problem evidence scope using the existing admission architecture.

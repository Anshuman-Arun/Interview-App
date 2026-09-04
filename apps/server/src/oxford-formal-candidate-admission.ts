import {
  InterpretationProviderResultSchema,
  evidenceKeysEqual,
  generationBasesEqual,
  type FormalInterpretationCandidate,
  type FormalInterpretationRequest,
  type InterpretationProviderResult
} from "../../../packages/domain/src/index.js";
import type {
  FormalInterpretationProvider
} from "../../../packages/interview-engine/src/index.js";
import { parseStrictJson } from "../../../packages/providers/src/index.js";
import {
  ModularArithmeticInterpretationSchema,
  RationalArithmeticInterpretationSchema,
  type IntegerExpression,
  type RationalExpression
} from "../../../packages/verification/src/index.js";
import type { OxfordFormalAnalysisProfile } from "./oxford-formal-analysis-catalog.js";

const DOMINO_STRONG_NUMBERS = new Set(["30", "31", "32", "62", "64"]);
const TRIANGLE_RATIO_NUMBERS = new Set(["1", "2", "3"]);

export function isOxfordFormalAnalysisSourceRelevant(
  profile: OxfordFormalAnalysisProfile,
  sourceText: string
): boolean {
  const text = normalizeText(sourceText);
  switch (profile.target.subject.claimId) {
    case "color-count-arithmetic":
      return containsAny(text, [
        "black",
        "white",
        "color",
        "colour",
        "checker",
        "square",
        "corner",
        "domino",
        "thirty",
        "30",
        "31",
        "32",
        "sixty two",
        "sixty-two",
        "62"
      ]);
    case "listed-prime-remainder": {
      const constructionLanguage = containsAny(text, [
        "product plus one",
        "product-plus-one",
        "multiply all",
        "product of",
        "plus one"
      ]);
      const residueLanguage = containsAny(text, [
        "remainder",
        "modulo",
        " mod ",
        "mod "
      ]);
      const primeContext = containsAny(text, [
        "prime",
        "listed",
        "list",
        "product",
        "constructed",
        "new number",
        "each p",
        "p_"
      ]);
      return constructionLanguage
        || (residueLanguage && primeContext)
        || (
          containsAny(text, ["listed", "list", "prime"])
          && containsAny(text, ["divide", "divides", "divisor"])
        );
    }
    case "prefix-residue-arithmetic": {
      const structuralContext = containsAny(text, [
        "prefix",
        "partial sum",
        "consecutive block",
        "block sum",
        "s_i",
        "s_j"
      ]);
      const residueLanguage = containsAny(text, [
        "residue",
        "same remainder",
        "same residue",
        "modulo n",
        "mod n"
      ]);
      return structuralContext
        || (residueLanguage && containsAny(text, ["sum", "sums", "prefix", "block"]));
    }
    case "median-ratio-arithmetic": {
      const geometryContext = containsAny(text, [
        "median",
        "centroid",
        "midpoint",
        "m_a",
        "m_b",
        "m_c"
      ]);
      const ratioLanguage = containsAny(text, [
        "ratio",
        "two third",
        "two-third",
        "2/3",
        "2:1",
        "1:2",
        "two to one",
        "one to two"
      ]);
      return geometryContext
        || (ratioLanguage && containsAny(text, ["vertex", "along", "segment", "point g"]));
    }
    case "divisibility-step":
      return containsAny(text, [
        "odd part",
        "same odd",
        "power of two",
        "power of 2",
        "2^",
        "smaller divides",
        "divides the larger",
        "divides the bigger"
      ]);
    default:
      return false;
  }
}

export function isOxfordFormalCandidateTargetAdmissible(input: {
  readonly profile: OxfordFormalAnalysisProfile;
  readonly request: FormalInterpretationRequest;
  readonly candidate: FormalInterpretationCandidate;
}): boolean {
  const { profile, request, candidate } = input;
  if (
    request.problem.id !== profile.problemId
    || request.problem.version !== profile.problemVersion
    || request.target.problemId !== profile.target.problemId
    || request.target.subject.claimId !== profile.target.subject.claimId
    || candidate.target.problemId !== profile.target.problemId
    || candidate.target.subject.claimId !== profile.target.subject.claimId
    || candidate.target.dimension !== "CORRECTNESS"
    || !isOxfordFormalAnalysisSourceRelevant(profile, request.source.span.text)
  ) {
    return false;
  }

  let rawStatement: unknown;
  try {
    rawStatement = parseStrictJson(candidate.formalStatement);
  } catch {
    return false;
  }

  const sourceNumbers = extractMentionedIntegers(request.source.span.text);

  if (candidate.protocol.protocol === "RATIONAL_ARITHMETIC") {
    const parsed = RationalArithmeticInterpretationSchema.safeParse(rawStatement);
    if (!parsed.success) return false;
    const statementNumbers = new Set<string>();
    const includeUnitDenominator =
      profile.target.subject.claimId === "median-ratio-arithmetic";
    collectRationalNumbers(
      parsed.data.claim.left,
      statementNumbers,
      includeUnitDenominator
    );
    collectRationalNumbers(
      parsed.data.claim.right,
      statementNumbers,
      includeUnitDenominator
    );
    if (!numbersAreGrounded(statementNumbers, sourceNumbers)) {
      return false;
    }

    switch (profile.target.subject.claimId) {
      case "color-count-arithmetic": {
        const strong = [...statementNumbers].filter((value) =>
          DOMINO_STRONG_NUMBERS.has(unsignedInteger(value))
        );
        return new Set(strong.map(unsignedInteger)).size >= 2;
      }
      case "median-ratio-arithmetic": {
        if (
          [...statementNumbers].some((value) =>
            !TRIANGLE_RATIO_NUMBERS.has(unsignedInteger(value))
          )
        ) {
          return false;
        }
        return new Set(
          [...statementNumbers].map(unsignedInteger)
            .filter((value) => TRIANGLE_RATIO_NUMBERS.has(value))
        ).size >= 2;
      }
      default:
        return false;
    }
  }

  if (candidate.protocol.protocol === "MODULAR_ARITHMETIC") {
    const parsed = ModularArithmeticInterpretationSchema.safeParse(rawStatement);
    if (!parsed.success) return false;
    const statementNumbers = new Set<string>();
    const claim = parsed.data.claim;
    if (claim.kind === "CONGRUENCE") {
      collectIntegerNumbers(claim.left, statementNumbers);
      collectIntegerNumbers(claim.right, statementNumbers);
      statementNumbers.add(claim.modulus);
    } else {
      statementNumbers.add(claim.divisor);
      collectIntegerNumbers(claim.dividend, statementNumbers);
    }
    if (!numbersAreGrounded(statementNumbers, sourceNumbers)) {
      return false;
    }
    if (new Set([...statementNumbers].map(unsignedInteger)).size < 2) {
      return false;
    }

    switch (profile.target.subject.claimId) {
      case "listed-prime-remainder":
        return claim.kind === "CONGRUENCE";
      case "prefix-residue-arithmetic":
        return claim.kind === "CONGRUENCE" || claim.kind === "DIVISIBILITY";
      case "divisibility-step":
        return claim.kind === "DIVISIBILITY";
      default:
        return false;
    }
  }

  return false;
}

export function createOxfordFormalAdmissionProvider(
  profile: OxfordFormalAnalysisProfile,
  provider: FormalInterpretationProvider
): FormalInterpretationProvider {
  return Object.freeze({
    async interpret(
      request: FormalInterpretationRequest,
      runtime?: { readonly signal: AbortSignal }
    ): Promise<unknown> {
      if (
        request.problem.id !== profile.problemId
        || request.problem.version !== profile.problemVersion
        || request.target.problemId !== profile.target.problemId
        || request.target.subject.claimId !== profile.target.subject.claimId
        || !isOxfordFormalAnalysisSourceRelevant(profile, request.source.span.text)
      ) {
        return abstention(request);
      }

      const raw = await provider.interpret(request, runtime);
      const parsed = InterpretationProviderResultSchema.safeParse(raw);
      if (!parsed.success || parsed.data.requestId !== request.requestId) {
        // Preserve malformed/mismatched provider output for the generic
        // coordinator to diagnose and reject rather than laundering it into an
        // ordinary abstention.
        return raw;
      }
      if (
        parsed.data.candidates.some((candidate) =>
          !candidateIdentityMatchesRequest(request, candidate)
        )
      ) {
        // Preserve identity attacks so Liam's generic admission emits the
        // precise source/target/protocol rejection rather than hiding them.
        return raw;
      }
      if (
        parsed.data.candidates.some((candidate) =>
          !isOxfordFormalCandidateTargetAdmissible({
            profile,
            request,
            candidate
          })
        )
      ) {
        return abstention(request);
      }
      return parsed.data;
    }
  });
}

function candidateIdentityMatchesRequest(
  request: FormalInterpretationRequest,
  candidate: FormalInterpretationCandidate
): boolean {
  return candidate.source.requestId === request.requestId
    && candidate.source.generationId === request.generationId
    && generationBasesEqual(candidate.source.basis, request.basis)
    && candidate.source.sourceRevision === request.source.sourceRevision
    && candidate.source.inputEpisodeId === request.source.inputEpisodeId
    && candidate.source.turnId === request.source.turnId
    && candidate.source.eventIds.length === request.source.eventIds.length
    && candidate.source.eventIds.every(
      (eventId, index) => eventId === request.source.eventIds[index]
    )
    && candidate.source.span.start === request.source.span.start
    && candidate.source.span.end === request.source.span.end
    && candidate.source.span.text === request.source.span.text
    && candidate.source.problem.id === request.problem.id
    && candidate.source.problem.version === request.problem.version
    && evidenceKeysEqual(candidate.target, request.target)
    && request.allowedProtocols.some(
      (protocol) =>
        protocol.protocol === candidate.protocol.protocol
        && protocol.version === candidate.protocol.version
    );
}

function abstention(
  request: FormalInterpretationRequest
): InterpretationProviderResult {
  return InterpretationProviderResultSchema.parse({
    protocolVersion: 1,
    requestId: request.requestId,
    candidates: []
  });
}

function containsAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

function collectRationalNumbers(
  expression: RationalExpression,
  output: Set<string>,
  includeUnitDenominator: boolean
): void {
  switch (expression.kind) {
    case "RATIONAL":
      output.add(expression.value.numerator);
      if (
        includeUnitDenominator
        || expression.value.denominator !== "1"
      ) {
        output.add(expression.value.denominator);
      }
      return;
    case "ADD":
    case "SUBTRACT":
    case "MULTIPLY":
    case "DIVIDE":
      collectRationalNumbers(expression.left, output, includeUnitDenominator);
      collectRationalNumbers(expression.right, output, includeUnitDenominator);
      return;
    case "NEGATE":
      collectRationalNumbers(expression.operand, output, includeUnitDenominator);
      return;
    case "SUM":
    case "PRODUCT":
      for (const term of expression.terms) {
        collectRationalNumbers(term, output, includeUnitDenominator);
      }
      return;
  }
}

function collectIntegerNumbers(
  expression: IntegerExpression,
  output: Set<string>
): void {
  switch (expression.kind) {
    case "INTEGER":
      output.add(expression.value);
      return;
    case "ADD":
    case "SUBTRACT":
    case "MULTIPLY":
      collectIntegerNumbers(expression.left, output);
      collectIntegerNumbers(expression.right, output);
      return;
    case "NEGATE":
      collectIntegerNumbers(expression.operand, output);
      return;
    case "POWER":
      collectIntegerNumbers(expression.base, output);
      output.add(String(expression.exponent));
      return;
    case "SUM":
    case "PRODUCT":
      for (const term of expression.terms) collectIntegerNumbers(term, output);
      return;
  }
}

function numbersAreGrounded(
  statementNumbers: ReadonlySet<string>,
  sourceNumbers: ReadonlySet<string>
): boolean {
  return statementNumbers.size > 0
    && [...statementNumbers].every((value) => sourceNumbers.has(value));
}

function unsignedInteger(value: string): string {
  return value.startsWith("-") ? value.slice(1) : value;
}

function extractMentionedIntegers(value: string): ReadonlySet<string> {
  const output = new Set<string>();
  const normalized = normalizeText(value);

  for (const match of normalized.matchAll(/[-+]?\d+/gu)) {
    const raw = match[0];
    if (raw.length > 128) continue;
    try {
      output.add(BigInt(raw).toString());
    } catch {
      // Ignore malformed or unbounded textual numerals.
    }
  }

  const wordText = normalized.replace(/-/gu, " ");
  const tokens = wordText.match(/[a-z]+/gu) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const parsed = parseEnglishInteger(tokens, index);
    if (parsed !== undefined) {
      output.add(String(parsed.value));
      index = parsed.endIndex;
      continue;
    }

    const token = tokens[index];
    if (token === undefined) continue;
    const denominator = FRACTION_DENOMINATORS[token];
    if (denominator !== undefined) {
      const previous = index > 0 ? tokens[index - 1] : undefined;
      if (previous === undefined || !isEnglishNumberToken(previous)) {
        output.add("1");
      }
      output.add(String(denominator));
      continue;
    }
    const implied = IMPLIED_NUMBERS[token];
    if (implied !== undefined) output.add(String(implied));
  }
  return output;
}

function isEnglishNumberToken(token: string): boolean {
  return SMALL_NUMBERS[token] !== undefined
    || TENS_NUMBERS[token] !== undefined
    || token === "hundred"
    || token === "thousand";
}

function parseEnglishInteger(
  tokens: readonly string[],
  startIndex: number
): { readonly value: number; readonly endIndex: number } | undefined {
  let index = startIndex;
  let sign = 1;
  if (tokens[index] === "negative") {
    sign = -1;
    index += 1;
  }

  let current = 0;
  let total = 0;
  let seen = false;
  let lastIndex = index - 1;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    const small = SMALL_NUMBERS[token];
    if (small !== undefined) {
      current += small;
      seen = true;
      lastIndex = index;
      continue;
    }
    const tens = TENS_NUMBERS[token];
    if (tens !== undefined) {
      current += tens;
      seen = true;
      lastIndex = index;
      continue;
    }
    if (token === "hundred" && seen) {
      current *= 100;
      lastIndex = index;
      continue;
    }
    if (token === "thousand" && seen) {
      total += current * 1_000;
      current = 0;
      lastIndex = index;
      continue;
    }
    break;
  }
  if (!seen) return undefined;
  return {
    value: sign * (total + current),
    endIndex: lastIndex
  };
}

const SMALL_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19
});

const TENS_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
});

const FRACTION_DENOMINATORS: Readonly<Record<string, number>> = Object.freeze({
  half: 2,
  halves: 2,
  third: 3,
  thirds: 3,
  quarter: 4,
  quarters: 4,
  fourth: 4,
  fourths: 4,
  fifth: 5,
  fifths: 5,
  sixth: 6,
  sixths: 6,
  seventh: 7,
  sevenths: 7,
  eighth: 8,
  eighths: 8,
  ninth: 9,
  ninths: 9,
  tenth: 10,
  tenths: 10
});

const IMPLIED_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  twice: 2,
  double: 2,
  squared: 2,
  cubed: 3,
  dozen: 12
});

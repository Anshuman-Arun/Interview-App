import { z, type ZodType } from "zod";
import {
  EvidenceKeySchema,
  FormalProtocolRefSchema,
  evidenceKeyToString,
  type DeterministicVerifier,
  type EvidenceKey,
  type FormalProtocolRef
} from "../../domain/src/index.js";
import {
  COMBINATORIAL_COUNTING_PROTOCOL,
  COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
  COMBINATORIAL_COUNTING_VERIFIER_NAME,
  CombinatorialCountingInterpretationSchema,
  DETERMINISTIC_MATH_VERIFIERS,
  FINITE_RECURRENCE_PROTOCOL,
  FINITE_RECURRENCE_PROTOCOL_VERSION,
  FINITE_RECURRENCE_VERIFIER_NAME,
  FiniteRecurrenceInterpretationSchema,
  MAX_MATH_STATEMENT_CHARACTERS,
  MODULAR_ARITHMETIC_PROTOCOL,
  MODULAR_ARITHMETIC_PROTOCOL_VERSION,
  MODULAR_ARITHMETIC_VERIFIER_NAME,
  ModularArithmeticInterpretationSchema,
  PROBABILITY_ARITHMETIC_PROTOCOL,
  PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
  PROBABILITY_ARITHMETIC_VERIFIER_NAME,
  ProbabilityArithmeticInterpretationSchema,
  RATIONAL_ARITHMETIC_PROTOCOL,
  RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
  RATIONAL_ARITHMETIC_VERIFIER_NAME,
  RationalArithmeticInterpretationSchema,
  validateStructuredStatement,
  type DeterministicMathVerifierDescriptor,
  type StructuredStatementValidationCode
} from "../../verification/src/index.js";

export const FORMAL_PROTOCOL_REGISTRY_VERSION = 1 as const;

export const SupportedFormalProtocolSchema = z.enum([
  "MODULAR_ARITHMETIC",
  "RATIONAL_ARITHMETIC",
  "FINITE_RECURRENCE",
  "COMBINATORIAL_COUNTING",
  "PROBABILITY_ARITHMETIC"
]);
export type SupportedFormalProtocol = z.infer<typeof SupportedFormalProtocolSchema>;

export const FormalProtocolRoutingScopeSchema = z.object({
  verifier: z.string().trim().min(1).max(128),
  evidenceKey: EvidenceKeySchema
}).strict();
export type FormalProtocolRoutingScope = z.infer<typeof FormalProtocolRoutingScopeSchema>;

export interface FormalProtocolRouteDefinition {
  readonly protocol: SupportedFormalProtocol;
  readonly version: number;
  readonly verifierProtocol: string;
  readonly verifierProtocolVersion: number;
  readonly verifier: string;
  readonly statementSchema: ZodType;
}

function freezeRoute(definition: FormalProtocolRouteDefinition): FormalProtocolRouteDefinition {
  return Object.freeze(definition);
}

export const FORMAL_PROTOCOL_ROUTES: readonly FormalProtocolRouteDefinition[] = Object.freeze([
  freezeRoute({
    protocol: "MODULAR_ARITHMETIC",
    version: 1,
    verifierProtocol: MODULAR_ARITHMETIC_PROTOCOL,
    verifierProtocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
    verifier: MODULAR_ARITHMETIC_VERIFIER_NAME,
    statementSchema: ModularArithmeticInterpretationSchema
  }),
  freezeRoute({
    protocol: "RATIONAL_ARITHMETIC",
    version: 1,
    verifierProtocol: RATIONAL_ARITHMETIC_PROTOCOL,
    verifierProtocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
    verifier: RATIONAL_ARITHMETIC_VERIFIER_NAME,
    statementSchema: RationalArithmeticInterpretationSchema
  }),
  freezeRoute({
    protocol: "FINITE_RECURRENCE",
    version: 1,
    verifierProtocol: FINITE_RECURRENCE_PROTOCOL,
    verifierProtocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
    verifier: FINITE_RECURRENCE_VERIFIER_NAME,
    statementSchema: FiniteRecurrenceInterpretationSchema
  }),
  freezeRoute({
    protocol: "COMBINATORIAL_COUNTING",
    version: 1,
    verifierProtocol: COMBINATORIAL_COUNTING_PROTOCOL,
    verifierProtocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
    verifier: COMBINATORIAL_COUNTING_VERIFIER_NAME,
    statementSchema: CombinatorialCountingInterpretationSchema
  }),
  freezeRoute({
    protocol: "PROBABILITY_ARITHMETIC",
    version: 1,
    verifierProtocol: PROBABILITY_ARITHMETIC_PROTOCOL,
    verifierProtocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
    verifier: PROBABILITY_ARITHMETIC_VERIFIER_NAME,
    statementSchema: ProbabilityArithmeticInterpretationSchema
  })
]);

export type FormalProtocolRouteFailure =
  | "UNSUPPORTED_PROTOCOL"
  | "VERIFIER_UNAVAILABLE"
  | "VERIFIER_UNAUTHORIZED";

export type FormalProtocolRouteResolution =
  | {
      readonly ok: true;
      readonly protocol: FormalProtocolRef;
      readonly definition: FormalProtocolRouteDefinition;
      readonly descriptor: DeterministicMathVerifierDescriptor;
    }
  | { readonly ok: false; readonly reason: FormalProtocolRouteFailure };

export type FormalStatementRouteFailure =
  | StructuredStatementValidationCode
  | "PROTOCOL_MISMATCH"
  | "CANONICALIZATION_FAILED";

export type FormalStatementRouteValidation =
  | { readonly ok: true; readonly canonicalStatement: string }
  | { readonly ok: false; readonly reason: FormalStatementRouteFailure };

function routeKey(protocol: FormalProtocolRef): string {
  return `${protocol.protocol}\u0000${String(protocol.version)}`;
}

function authorizationKey(verifier: string, evidenceKey: EvidenceKey): string {
  return `${verifier}\u0000${evidenceKeyToString(evidenceKey)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite number cannot enter a canonical formal statement");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Unsupported canonical formal statement value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function hasExpectedVerifierProtocol(
  statement: string,
  definition: FormalProtocolRouteDefinition
): boolean | undefined {
  if (statement.length > MAX_MATH_STATEMENT_CHARACTERS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(statement) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.protocol !== "string" || typeof record.protocolVersion !== "number") return undefined;
  return record.protocol === definition.verifierProtocol
    && record.protocolVersion === definition.verifierProtocolVersion;
}

export class FormalProtocolRoutingRegistry {
  private readonly routes = new Map<string, FormalProtocolRouteDefinition>();
  private readonly descriptors: readonly DeterministicMathVerifierDescriptor[];
  private readonly authorizedScopes = new Set<string>();

  public constructor(
    scopes: readonly FormalProtocolRoutingScope[] = [],
    definitions: readonly FormalProtocolRouteDefinition[] = FORMAL_PROTOCOL_ROUTES,
    descriptors: readonly DeterministicMathVerifierDescriptor[] = DETERMINISTIC_MATH_VERIFIERS
  ) {
    this.descriptors = [...descriptors];
    for (const rawDefinition of definitions) {
      const definition = {
        ...rawDefinition,
        protocol: SupportedFormalProtocolSchema.parse(rawDefinition.protocol),
        version: z.number().int().positive().max(1_000).parse(rawDefinition.version),
        verifierProtocol: z.string().min(1).max(128).parse(rawDefinition.verifierProtocol),
        verifierProtocolVersion: z.number().int().positive().max(1_000).parse(rawDefinition.verifierProtocolVersion),
        verifier: z.string().trim().min(1).max(128).parse(rawDefinition.verifier)
      } satisfies FormalProtocolRouteDefinition;
      const key = routeKey({ protocol: definition.protocol, version: definition.version });
      if (this.routes.has(key)) throw new Error("Duplicate formal protocol route");
      this.routes.set(key, Object.freeze(definition));
    }
    for (const rawScope of scopes) {
      const scope = FormalProtocolRoutingScopeSchema.parse(rawScope);
      this.authorizedScopes.add(authorizationKey(scope.verifier, scope.evidenceKey));
    }
  }

  public list(): readonly Omit<FormalProtocolRouteDefinition, "statementSchema">[] {
    return [...this.routes.values()].map((route) => Object.freeze({
      protocol: route.protocol,
      version: route.version,
      verifierProtocol: route.verifierProtocol,
      verifierProtocolVersion: route.verifierProtocolVersion,
      verifier: route.verifier
    }));
  }

  public resolve(protocolInput: unknown, evidenceKeyInput: unknown): FormalProtocolRouteResolution {
    const parsedProtocol = FormalProtocolRefSchema.safeParse(protocolInput);
    const parsedEvidenceKey = EvidenceKeySchema.safeParse(evidenceKeyInput);
    if (!parsedProtocol.success) return { ok: false, reason: "UNSUPPORTED_PROTOCOL" };
    if (!parsedEvidenceKey.success) return { ok: false, reason: "VERIFIER_UNAUTHORIZED" };

    const definition = this.routes.get(routeKey(parsedProtocol.data));
    if (definition === undefined) return { ok: false, reason: "UNSUPPORTED_PROTOCOL" };

    const matches = this.descriptors.filter((candidate) =>
      candidate.verifier === definition.verifier
      && candidate.protocol === definition.verifierProtocol
      && candidate.protocolVersion === definition.verifierProtocolVersion
    );
    if (matches.length !== 1 || matches[0] === undefined) {
      return { ok: false, reason: "VERIFIER_UNAVAILABLE" };
    }
    if (!this.authorizedScopes.has(authorizationKey(definition.verifier, parsedEvidenceKey.data))) {
      return { ok: false, reason: "VERIFIER_UNAUTHORIZED" };
    }
    return {
      ok: true,
      protocol: parsedProtocol.data,
      definition,
      descriptor: matches[0]
    };
  }

  public createVerifier(resolution: Extract<FormalProtocolRouteResolution, { readonly ok: true }>): DeterministicVerifier | undefined {
    try {
      return resolution.descriptor.create();
    } catch {
      return undefined;
    }
  }

  public validateStatement(
    resolution: Extract<FormalProtocolRouteResolution, { readonly ok: true }>,
    statement: unknown
  ): FormalStatementRouteValidation {
    const validated = validateStructuredStatement(statement, resolution.definition.statementSchema);
    if (!validated.ok) {
      if (
        typeof statement === "string"
        && hasExpectedVerifierProtocol(statement, resolution.definition) === false
      ) {
        return { ok: false, reason: "PROTOCOL_MISMATCH" };
      }
      return { ok: false, reason: validated.code };
    }

    try {
      const canonicalStatement = canonicalJson(validated.data);
      if (canonicalStatement.length > MAX_MATH_STATEMENT_CHARACTERS) {
        return { ok: false, reason: "STATEMENT_TOO_LARGE" };
      }
      return { ok: true, canonicalStatement };
    } catch {
      return { ok: false, reason: "CANONICALIZATION_FAILED" };
    }
  }
}

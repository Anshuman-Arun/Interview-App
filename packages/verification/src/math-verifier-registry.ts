import type { DeterministicVerifier } from "../../domain/src/index.js";
import {
  COMBINATORIAL_COUNTING_PROTOCOL,
  COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
  COMBINATORIAL_COUNTING_VERIFIER_NAME,
  CombinatorialCountingVerifier
} from "./combinatorial-counting-verifier.js";
import {
  FINITE_RECURRENCE_PROTOCOL,
  FINITE_RECURRENCE_PROTOCOL_VERSION,
  FINITE_RECURRENCE_VERIFIER_NAME,
  FiniteRecurrenceVerifier
} from "./finite-recurrence-verifier.js";
import {
  MODULAR_ARITHMETIC_PROTOCOL,
  MODULAR_ARITHMETIC_PROTOCOL_VERSION,
  MODULAR_ARITHMETIC_VERIFIER_NAME,
  ModularArithmeticVerifier
} from "./modular-arithmetic-verifier.js";
import {
  PROBABILITY_ARITHMETIC_PROTOCOL,
  PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
  PROBABILITY_ARITHMETIC_VERIFIER_NAME,
  ProbabilityArithmeticVerifier
} from "./probability-arithmetic-verifier.js";
import {
  RATIONAL_ARITHMETIC_PROTOCOL,
  RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
  RATIONAL_ARITHMETIC_VERIFIER_NAME,
  RationalArithmeticVerifier
} from "./rational-arithmetic-verifier.js";

export interface DeterministicMathVerifierDescriptor {
  readonly verifier: string;
  readonly protocol: string;
  readonly protocolVersion: number;
  readonly create: () => DeterministicVerifier;
}

export const DETERMINISTIC_MATH_VERIFIERS: readonly DeterministicMathVerifierDescriptor[] = Object.freeze([
  {
    verifier: MODULAR_ARITHMETIC_VERIFIER_NAME,
    protocol: MODULAR_ARITHMETIC_PROTOCOL,
    protocolVersion: MODULAR_ARITHMETIC_PROTOCOL_VERSION,
    create: () => new ModularArithmeticVerifier()
  },
  {
    verifier: RATIONAL_ARITHMETIC_VERIFIER_NAME,
    protocol: RATIONAL_ARITHMETIC_PROTOCOL,
    protocolVersion: RATIONAL_ARITHMETIC_PROTOCOL_VERSION,
    create: () => new RationalArithmeticVerifier()
  },
  {
    verifier: FINITE_RECURRENCE_VERIFIER_NAME,
    protocol: FINITE_RECURRENCE_PROTOCOL,
    protocolVersion: FINITE_RECURRENCE_PROTOCOL_VERSION,
    create: () => new FiniteRecurrenceVerifier()
  },
  {
    verifier: COMBINATORIAL_COUNTING_VERIFIER_NAME,
    protocol: COMBINATORIAL_COUNTING_PROTOCOL,
    protocolVersion: COMBINATORIAL_COUNTING_PROTOCOL_VERSION,
    create: () => new CombinatorialCountingVerifier()
  },
  {
    verifier: PROBABILITY_ARITHMETIC_VERIFIER_NAME,
    protocol: PROBABILITY_ARITHMETIC_PROTOCOL,
    protocolVersion: PROBABILITY_ARITHMETIC_PROTOCOL_VERSION,
    create: () => new ProbabilityArithmeticVerifier()
  }
]);

export function createDeterministicMathVerifier(verifier: string): DeterministicVerifier | undefined {
  return DETERMINISTIC_MATH_VERIFIERS.find((descriptor) => descriptor.verifier === verifier)?.create();
}

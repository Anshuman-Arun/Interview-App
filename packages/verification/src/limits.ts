export const MAX_MATH_STATEMENT_CHARACTERS = 100_000 as const;
export const MAX_INTEGER_DECIMAL_DIGITS = 256 as const;
export const MAX_INTERMEDIATE_INTEGER_DECIMAL_DIGITS = 4_096 as const;
// A cross-scaled exact rational component can use twice the reduced-result
// digits, and summing the maximum 1,024 finite-container terms can add at most
// four carry digits: 2 * 4,096 + ceil(log10(1,024)) = 8,196.
export const MAX_WIDE_RATIONAL_WORK_DECIMAL_DIGITS = 8_196 as const;
export const MAX_EXPRESSION_DEPTH = 24 as const;
export const MAX_EXPRESSION_NODES = 512 as const;
export const MAX_STRUCTURED_INPUT_DEPTH = 32 as const;
export const MAX_STRUCTURED_INPUT_NODES = 10_000 as const;
export const MAX_STRUCTURED_ARRAY_ITEMS = 1_024 as const;
export const MAX_VARIADIC_EXPRESSION_TERMS = 128 as const;
export const MAX_POWER_EXPONENT = 1_024 as const;
export const MAX_RECURRENCE_ORDER = 16 as const;
export const MAX_RECURRENCE_SEQUENCE_LENGTH = 256 as const;
export const MAX_COMBINATORIAL_N = 1_000 as const;
export const MAX_PROBABILITY_OUTCOMES = 512 as const;
export const MAX_FINITE_CONTAINER_ITEMS = 1_024 as const;

import { z } from "zod";
import { EvidenceKeySchema } from "./evidence.js";
import { GenerationBasisSchema } from "./generation.js";
import {
  EventIdSchema,
  GenerationIdSchema,
  InputEpisodeIdSchema,
  RequestIdSchema,
  SessionIdSchema,
  TurnIdSchema
} from "./ids.js";

export const FORMAL_INTERPRETATION_SCHEMA_VERSION = 1 as const;
export const MAX_FORMAL_INTERPRETATION_SOURCE_CHARACTERS = 4_096 as const;
export const MAX_FORMAL_INTERPRETATION_STATEMENT_CHARACTERS = 100_000 as const;
export const MAX_FORMAL_INTERPRETATION_CANDIDATES = 8 as const;
export const MAX_FORMAL_INTERPRETATION_PROTOCOLS = 8 as const;
export const MAX_FORMAL_INTERPRETATION_SOURCE_EVENTS = 8 as const;

export const FormalProtocolNameSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/u);
export type FormalProtocolName = z.infer<typeof FormalProtocolNameSchema>;

export const FormalProtocolVersionSchema = z.number().int().positive().max(1_000);

export const FormalProtocolRefSchema = z.object({
  protocol: FormalProtocolNameSchema,
  version: FormalProtocolVersionSchema
}).strict();
export type FormalProtocolRef = z.infer<typeof FormalProtocolRefSchema>;

export const FormalInterpretationProblemRefSchema = z.object({
  id: z.string().min(1).max(256),
  version: z.string().min(1).max(128)
}).strict();
export type FormalInterpretationProblemRef = z.infer<typeof FormalInterpretationProblemRefSchema>;

export const FormalInterpretationSourceSpanSchema = z.object({
  start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  end: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  text: z.string().min(1).max(MAX_FORMAL_INTERPRETATION_SOURCE_CHARACTERS)
}).strict().superRefine((value, context) => {
  if (value.end <= value.start) {
    context.addIssue({ code: "custom", path: ["end"], message: "Source span end must be greater than start" });
  }
  if (value.end - value.start !== value.text.length) {
    context.addIssue({ code: "custom", path: ["text"], message: "Source span length must match bounded source text length" });
  }
});
export type FormalInterpretationSourceSpan = z.infer<typeof FormalInterpretationSourceSpanSchema>;

export const FormalInterpretationSourceRefSchema = z.object({
  kind: z.literal("TURN_TEXT"),
  inputEpisodeId: InputEpisodeIdSchema,
  turnId: TurnIdSchema,
  sourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  eventIds: z.array(EventIdSchema).min(1).max(MAX_FORMAL_INTERPRETATION_SOURCE_EVENTS),
  span: FormalInterpretationSourceSpanSchema
}).strict();
export type FormalInterpretationSourceRef = z.infer<typeof FormalInterpretationSourceRefSchema>;

export const FormalInterpretationRequestSchema = z.object({
  protocolVersion: z.literal(FORMAL_INTERPRETATION_SCHEMA_VERSION),
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
  generationId: GenerationIdSchema,
  basis: GenerationBasisSchema,
  source: FormalInterpretationSourceRefSchema,
  problem: FormalInterpretationProblemRefSchema,
  target: EvidenceKeySchema,
  allowedProtocols: z.array(FormalProtocolRefSchema)
    .min(1)
    .max(MAX_FORMAL_INTERPRETATION_PROTOCOLS)
}).strict().superRefine((value, context) => {
  if (
    value.basis.inputEpisodeId !== value.source.inputEpisodeId
    || value.basis.turnId !== value.source.turnId
    || value.basis.committedInputSequence !== value.source.sourceRevision
  ) {
    context.addIssue({
      code: "custom",
      path: ["source"],
      message: "Interpretation source must match its authoritative generation basis"
    });
  }
  if (
    value.target.problemId !== value.problem.id
    || value.target.subject.kind !== "CLAIM"
    || value.target.dimension !== "CORRECTNESS"
  ) {
    context.addIssue({
      code: "custom",
      path: ["target"],
      message: "Formal interpretation targets are restricted to claim correctness for the exact problem"
    });
  }

  const seen = new Set<string>();
  value.allowedProtocols.forEach((protocol, index) => {
    const key = `${protocol.protocol}\u0000${String(protocol.version)}`;
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["allowedProtocols", index],
        message: "Allowed formal protocols must be unique"
      });
      return;
    }
    seen.add(key);
  });
});
export type FormalInterpretationRequest = z.infer<typeof FormalInterpretationRequestSchema>;

export const FormalInterpretationCandidateSourceSchema = z.object({
  requestId: RequestIdSchema,
  generationId: GenerationIdSchema,
  basis: GenerationBasisSchema,
  sourceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  inputEpisodeId: InputEpisodeIdSchema,
  turnId: TurnIdSchema,
  eventIds: z.array(EventIdSchema).min(1).max(MAX_FORMAL_INTERPRETATION_SOURCE_EVENTS),
  problem: FormalInterpretationProblemRefSchema
}).strict();
export type FormalInterpretationCandidateSource = z.infer<typeof FormalInterpretationCandidateSourceSchema>;

export const FormalInterpretationCandidateSchema = z.object({
  protocolVersion: z.literal(FORMAL_INTERPRETATION_SCHEMA_VERSION),
  candidateId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  protocol: FormalProtocolRefSchema,
  formalStatement: z.string().min(1).max(MAX_FORMAL_INTERPRETATION_STATEMENT_CHARACTERS),
  confidence: z.number().min(0).max(1),
  target: EvidenceKeySchema,
  source: FormalInterpretationCandidateSourceSchema
}).strict();
export type FormalInterpretationCandidate = z.infer<typeof FormalInterpretationCandidateSchema>;

export const InterpretationProviderResultSchema = z.object({
  protocolVersion: z.literal(FORMAL_INTERPRETATION_SCHEMA_VERSION),
  requestId: RequestIdSchema,
  candidates: z.array(FormalInterpretationCandidateSchema)
    .max(MAX_FORMAL_INTERPRETATION_CANDIDATES)
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.candidates.forEach((candidate, index) => {
    if (seen.has(candidate.candidateId)) {
      context.addIssue({
        code: "custom",
        path: ["candidates", index, "candidateId"],
        message: "Formal interpretation candidate IDs must be unique"
      });
      return;
    }
    seen.add(candidate.candidateId);
  });
});
export type InterpretationProviderResult = z.infer<typeof InterpretationProviderResultSchema>;

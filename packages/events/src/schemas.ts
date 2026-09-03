import { z } from "zod";
import {
  BoardRevisionSchema,
  ContextEpochSchema,
  ContextCompilationManifestSchema,
  DeliveryAtomSchema,
  DeliveryIdSchema,
  DisclosureAnalysisSchema,
  EvidenceKeySchema,
  EvidenceProposalSchema,
  EvidenceValueSchema,
  EventIdSchema,
  FormalInterpretationProposalSchema,
  GenerationBasisSchema,
  GenerationIdSchema,
  InputEpisodeIdSchema,
  InterviewSessionConfigurationSchema,
  InterviewerProposalSchema,
  PolicyRevisionSchema,
  ProviderContextSpecFingerprintSchema,
  ProviderRuntimeNameSchema,
  ProblemStateRevisionSchema,
  RealizationRequestSchema,
  RequestIdSchema,
  SessionIdSchema,
  TranscriptRevisionSchema,
  TurnIdSchema,
  UtteranceIdSchema,
  AcceptedBoardObservationSchema,
  BoardObservationSchema,
  BoardShapeIdSchema,
  MAX_VISION_REGION_SHAPES,
  NormalizedBoardMutationSchema,
  VisionBoundsSchema,
  VisionEvidenceInterpreterFingerprintSchema,
  VisionRequestedObservationKindSchema,
  VisionShapeRevisionBindingSchema,
  VisionSnapshotBasisSchema,
  VerificationResultSchema,
  OrderFillSchema,
  QuantTradingCandidateActionSchema
} from "../../domain/src/index.js";

export const CURRENT_EVENT_SCHEMA_VERSION = 3 as const;
export const EventSourceSchema = z.enum(["APPLICATION", "USER", "PROVIDER", "RENDERER", "WORKER", "RECOVERY"]);
export type EventSource = z.infer<typeof EventSourceSchema>;

const PositiveSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value > 0,
  { message: "Expected a positive safe integer" }
);
const NonnegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  { message: "Expected a non-negative safe integer" }
);

const SafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value),
  { message: "Expected a safe integer" }
);
const QuantResearchVersionTagSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/u);
const QuantResearchFamilySchema = z.enum([
  "BAYESIAN_UPDATING",
  "SAMPLING_ESTIMATION",
  "EXPERIMENTAL_ALLOCATION",
  "MODEL_COMPARISON",
  "CONSTRAINED_OPTIMIZATION"
]);
const QuantResearchScoreSchema = z.number().int().min(0).max(100);
const QuantResearchActionIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u);
const QuantResearchFiniteInputSchema = z.number().min(-1_000_000).max(1_000_000);
const QuantResearchRationalSchema = z.object({
  numerator: SafeIntegerSchema,
  denominator: PositiveSafeIntegerSchema
}).strict();
const QuantResearchAllocationSchema = z.object({
  a: NonnegativeSafeIntegerSchema,
  b: NonnegativeSafeIntegerSchema
}).strict();
const QuantResearchOptimizationPointSchema = z.object({
  x: NonnegativeSafeIntegerSchema,
  y: NonnegativeSafeIntegerSchema
}).strict();
const QuantResearchModelPointSchema = z.object({
  x: NonnegativeSafeIntegerSchema,
  y: SafeIntegerSchema
}).strict();

export const QuantResearchScenarioDefinitionEventSchema = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("BAYESIAN_UPDATING"),
    version: QuantResearchVersionTagSchema,
    generatorVersion: QuantResearchVersionTagSchema,
    rngVersion: QuantResearchVersionTagSchema,
    seed: NonnegativeSafeIntegerSchema.max(0xffff_ffff),
    config: z.object({
      priorAlpha: z.number().int().min(1).max(100),
      priorBeta: z.number().int().min(1).max(100),
      observationCount: z.number().int().min(2).max(32),
      perturbedPriorAlpha: z.number().int().min(1).max(100),
      perturbedPriorBeta: z.number().int().min(1).max(100)
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("SAMPLING_ESTIMATION"),
    version: QuantResearchVersionTagSchema,
    generatorVersion: QuantResearchVersionTagSchema,
    rngVersion: QuantResearchVersionTagSchema,
    seed: NonnegativeSafeIntegerSchema.max(0xffff_ffff),
    config: z.object({
      maxSamples: z.number().int().min(3).max(32),
      populationSize: z.number().int().min(8).max(128),
      centerMin: z.number().int().min(-100).max(100),
      centerMax: z.number().int().min(-100).max(100),
      noiseRadius: z.number().int().min(1).max(20),
      outlierShift: z.number().int().min(1).max(50)
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("EXPERIMENTAL_ALLOCATION"),
    version: QuantResearchVersionTagSchema,
    generatorVersion: QuantResearchVersionTagSchema,
    rngVersion: QuantResearchVersionTagSchema,
    seed: NonnegativeSafeIntegerSchema.max(0xffff_ffff),
    config: z.object({
      totalBudget: z.number().int().min(4).max(100),
      costA: z.number().int().min(1).max(20),
      costB: z.number().int().min(1).max(20),
      perturbedCostA: z.number().int().min(1).max(20),
      perturbedCostB: z.number().int().min(1).max(20),
      noiseA: z.number().int().min(1).max(10),
      noiseB: z.number().int().min(1).max(10)
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("MODEL_COMPARISON"),
    version: QuantResearchVersionTagSchema,
    generatorVersion: QuantResearchVersionTagSchema,
    rngVersion: QuantResearchVersionTagSchema,
    seed: NonnegativeSafeIntegerSchema.max(0xffff_ffff),
    config: z.object({
      observationCount: z.number().int().min(6).max(30),
      noiseRadius: z.number().int().min(1).max(10),
      outlierShift: z.number().int().min(1).max(50)
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("CONSTRAINED_OPTIMIZATION"),
    version: QuantResearchVersionTagSchema,
    generatorVersion: QuantResearchVersionTagSchema,
    rngVersion: QuantResearchVersionTagSchema,
    seed: NonnegativeSafeIntegerSchema.max(0xffff_ffff),
    config: z.object({
      budget: z.number().int().min(5).max(60),
      perturbedBudget: z.number().int().min(5).max(60),
      maxX: z.number().int().min(1).max(60),
      maxY: z.number().int().min(1).max(60),
      perturbedPenalty: z.number().int().min(0).max(20)
    }).strict()
  }).strict()
]);
export type QuantResearchScenarioDefinitionEvent = z.infer<typeof QuantResearchScenarioDefinitionEventSchema>;

export const QuantResearchActionEventSchema = z.discriminatedUnion("kind", [
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("SUBMIT_PROBABILITY"),
    value: z.number().min(0).max(1)
  }).strict(),
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("REQUEST_OBSERVATION"),
    count: z.number().int().min(1).max(32)
  }).strict(),
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("SUBMIT_NUMERIC_ESTIMATE"),
    value: QuantResearchFiniteInputSchema
  }).strict(),
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("ALLOCATE_SAMPLE"),
    a: z.number().int().min(0).max(100),
    b: z.number().int().min(0).max(100)
  }).strict(),
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("CHOOSE_OPTION"),
    option: z.enum(["A", "B", "CONSTANT", "LINEAR"])
  }).strict(),
  z.object({
    actionId: QuantResearchActionIdSchema,
    kind: z.literal("SUBMIT_PARAMETERS"),
    values: z.array(QuantResearchFiniteInputSchema).min(1).max(8)
  }).strict()
]);
export type QuantResearchActionEvent = z.infer<typeof QuantResearchActionEventSchema>;

const QuantResearchEvidenceCategorySchema = z.enum([
  "NUMERICAL_CORRECTNESS",
  "CALIBRATION",
  "ADAPTATION",
  "SAMPLE_EFFICIENCY",
  "CONSISTENCY",
  "OBJECTIVE_QUALITY",
  "CONSTRAINT_DISCIPLINE",
  "ROBUSTNESS"
]);
const QuantResearchEvidenceEventSchema = z.object({
  category: QuantResearchEvidenceCategorySchema,
  stage: z.string().min(1).max(64),
  score: QuantResearchScoreSchema,
  summary: z.string().min(1).max(1_000)
}).strict();
const QuantResearchMetricsEventSchema = z.object({
  NUMERICAL_CORRECTNESS: QuantResearchScoreSchema.optional(),
  CALIBRATION: QuantResearchScoreSchema.optional(),
  ADAPTATION: QuantResearchScoreSchema.optional(),
  SAMPLE_EFFICIENCY: QuantResearchScoreSchema.optional(),
  CONSISTENCY: QuantResearchScoreSchema.optional(),
  OBJECTIVE_QUALITY: QuantResearchScoreSchema.optional(),
  CONSTRAINT_DISCIPLINE: QuantResearchScoreSchema.optional(),
  ROBUSTNESS: QuantResearchScoreSchema.optional()
}).strict();

export const QuantResearchResultEventSchema = z.object({
  status: z.enum(["IN_PROGRESS", "COMPLETE"]),
  family: QuantResearchFamilySchema,
  version: QuantResearchVersionTagSchema,
  generatorVersion: QuantResearchVersionTagSchema,
  rngVersion: QuantResearchVersionTagSchema,
  acceptedActionCount: z.number().int().min(0).max(64),
  overallScore: QuantResearchScoreSchema,
  metrics: QuantResearchMetricsEventSchema,
  evidence: z.array(QuantResearchEvidenceEventSchema).max(16)
}).strict();
export type QuantResearchResultEvent = z.infer<typeof QuantResearchResultEventSchema>;

export const QuantResearchAuthoritativeSnapshotEventSchema = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("BAYESIAN_UPDATING"),
    verifierVersion: QuantResearchVersionTagSchema,
    generatedParameters: z.object({
      observations: z.array(z.boolean()).min(2).max(32),
      successes: z.number().int().min(0).max(32)
    }).strict(),
    gradingData: z.object({
      priorPredictive: QuantResearchRationalSchema,
      posterior: QuantResearchRationalSchema,
      perturbedPosterior: QuantResearchRationalSchema
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("SAMPLING_ESTIMATION"),
    verifierVersion: QuantResearchVersionTagSchema,
    generatedParameters: z.object({
      hiddenCenter: SafeIntegerSchema,
      hiddenPopulation: z.array(SafeIntegerSchema).min(8).max(128),
      sampleOrder: z.array(NonnegativeSafeIntegerSchema).min(8).max(128),
      contaminatedObservation: SafeIntegerSchema
    }).strict(),
    gradingData: z.object({
      validatedCenter: SafeIntegerSchema
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("EXPERIMENTAL_ALLOCATION"),
    verifierVersion: QuantResearchVersionTagSchema,
    generatedParameters: z.object({
      hiddenMeanA: SafeIntegerSchema,
      hiddenMeanB: SafeIntegerSchema,
      sequenceA: z.array(SafeIntegerSchema).min(4).max(100),
      sequenceB: z.array(SafeIntegerSchema).min(4).max(100)
    }).strict(),
    gradingData: z.object({
      baseOptimalVariance: QuantResearchRationalSchema,
      baseOptimalAllocations: z.array(QuantResearchAllocationSchema).min(1).max(100),
      perturbedOptimalVariance: QuantResearchRationalSchema,
      perturbedOptimalAllocations: z.array(QuantResearchAllocationSchema).min(1).max(100)
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("MODEL_COMPARISON"),
    verifierVersion: QuantResearchVersionTagSchema,
    generatedParameters: z.object({
      hiddenModel: z.enum(["CONSTANT", "LINEAR"]),
      hiddenIntercept: SafeIntegerSchema,
      hiddenSlope: SafeIntegerSchema,
      points: z.array(QuantResearchModelPointSchema).min(6).max(30),
      perturbedPoints: z.array(QuantResearchModelPointSchema).min(6).max(30)
    }).strict(),
    gradingData: z.object({
      validatedModel: z.enum(["CONSTANT", "LINEAR"])
    }).strict()
  }).strict(),
  z.object({
    family: z.literal("CONSTRAINED_OPTIMIZATION"),
    verifierVersion: QuantResearchVersionTagSchema,
    generatedParameters: z.object({
      coefficientX: SafeIntegerSchema,
      coefficientY: SafeIntegerSchema,
      basePenalty: NonnegativeSafeIntegerSchema
    }).strict(),
    gradingData: z.object({
      baseBestObjective: SafeIntegerSchema,
      baseOptimalPoints: z.array(QuantResearchOptimizationPointSchema).min(1).max(128),
      perturbedBestObjective: SafeIntegerSchema,
      perturbedOptimalPoints: z.array(QuantResearchOptimizationPointSchema).min(1).max(128)
    }).strict()
  }).strict()
]);
export type QuantResearchAuthoritativeSnapshotEvent = z.infer<typeof QuantResearchAuthoritativeSnapshotEventSchema>;

const QuantTradingFamilySchema = z.enum([
  "BASIC_MARKET_MAKING",
  "FAIR_VALUE_UPDATES",
  "INVENTORY_PRESSURE",
  "ADVERSE_SELECTION",
  "RISK_MANAGEMENT"
]);
const QuantTradingVersionSchema = z.literal("1.0.0");
const QuantTradingSeedSchema = NonnegativeSafeIntegerSchema.max(0xffff_ffff);
const QuantTradingFiniteNumberSchema = z.number().refine(Number.isFinite, {
  message: "Expected a finite number"
});
const QuantTradingPositiveFiniteSchema = z.number().refine(
  (value) => Number.isFinite(value) && value > 0,
  { message: "Expected a finite positive number" }
);
const QuantTradingPortfolioEventSchema = z.object({
  cash: QuantTradingFiniteNumberSchema,
  position: SafeIntegerSchema,
  realizedPnL: QuantTradingFiniteNumberSchema,
  unrealizedPnL: QuantTradingFiniteNumberSchema,
  totalPnL: QuantTradingFiniteNumberSchema,
  portfolioValue: QuantTradingFiniteNumberSchema,
  averageCostBasis: QuantTradingFiniteNumberSchema,
  maxDrawdown: z.number().refine((value) => Number.isFinite(value) && value >= 0),
  tradeCount: NonnegativeSafeIntegerSchema
}).strict();
const QuantTradingMarketEventSchema = z.object({
  type: z.literal("FAIR_VALUE_UPDATE"),
  round: PositiveSafeIntegerSchema.max(256),
  previousFairValue: QuantTradingPositiveFiniteSchema,
  fairValue: QuantTradingPositiveFiniteSchema,
  label: z.string().min(1).max(128)
}).strict();
const QuantTradingRiskBreachEventSchema = z.object({
  round: PositiveSafeIntegerSchema.max(256),
  source: z.enum(["POST_ROUND", "FAIR_VALUE_UPDATE"]),
  reason: z.string().min(1).max(240)
}).strict();
const QuantTradingOrderFillEventSchema = OrderFillSchema.superRefine((fill, context) => {
  for (const [field, value] of [
    ["fillId", fill.fillId],
    ["orderId", fill.orderId],
    ["matchedOrderId", fill.matchedOrderId],
    ["counterparty", fill.counterparty]
  ] as const) {
    if (value !== undefined && value.length > 128) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "Quant Trading persisted fill identifiers must be at most 128 characters"
      });
    }
  }
});

export const QuantTradingScenarioDefinitionEventSchema = z.object({
  family: QuantTradingFamilySchema,
  version: QuantTradingVersionSchema,
  seed: QuantTradingSeedSchema
}).strict();
export type QuantTradingScenarioDefinitionEvent = z.infer<typeof QuantTradingScenarioDefinitionEventSchema>;

export const QuantTradingRoundEvidenceEventSchema = z.object({
  round: PositiveSafeIntegerSchema.max(256),
  fairValue: QuantTradingPositiveFiniteSchema,
  marketEvents: z.array(QuantTradingMarketEventSchema).max(16),
  orderFlowType: z.enum(["INFORMED", "NOISE", "NO_TRADE"]),
  incomingMarketSide: z.enum(["BUY", "SELL"]).optional(),
  studentFills: z.array(QuantTradingOrderFillEventSchema).max(64),
  portfolio: QuantTradingPortfolioEventSchema,
  riskBreached: z.boolean(),
  riskReason: z.string().min(1).max(240).optional(),
  accountingInvariantHolds: z.boolean(),
  rngDrawCount: NonnegativeSafeIntegerSchema
}).strict().superRefine((value, context) => {
  if (value.riskBreached !== (value.riskReason !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["riskReason"],
      message: "Quant Trading risk reason must match breach state"
    });
  }
  if (value.marketEvents.some((event) => event.round !== value.round)) {
    context.addIssue({
      code: "custom",
      path: ["marketEvents"],
      message: "Quant Trading market updates must belong to the resolved round"
    });
  }
  if (
    value.orderFlowType === "NO_TRADE"
    && (value.incomingMarketSide !== undefined || value.studentFills.length !== 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["orderFlowType"],
      message: "No-trade rounds cannot contain an incoming side or fills"
    });
  }
  if (value.orderFlowType === "NOISE" && value.incomingMarketSide === undefined) {
    context.addIssue({
      code: "custom",
      path: ["incomingMarketSide"],
      message: "Noise flow must record its incoming market side"
    });
  }
  if (value.incomingMarketSide === undefined && value.studentFills.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["studentFills"],
      message: "Student fills require an incoming market side"
    });
  }
  if (
    value.incomingMarketSide !== undefined
    && value.studentFills.some(
      (fill) => fill.side !== (value.incomingMarketSide === "BUY" ? "SELL" : "BUY")
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["studentFills"],
      message: "Student fill side must oppose the incoming market side"
    });
  }
});
export type QuantTradingRoundEvidenceEvent = z.infer<typeof QuantTradingRoundEvidenceEventSchema>;

export const QuantTradingResultEventSchema = z.object({
  family: QuantTradingFamilySchema,
  version: QuantTradingVersionSchema,
  seed: QuantTradingSeedSchema,
  completionStatus: z.enum(["COMPLETED", "RISK_STOPPED"]),
  plannedRounds: PositiveSafeIntegerSchema.max(256),
  roundsCompleted: NonnegativeSafeIntegerSchema.max(256),
  completionRate: z.number().min(0).max(1),
  finalFairValue: QuantTradingPositiveFiniteSchema,
  finalPortfolio: QuantTradingPortfolioEventSchema,
  tradeCount: NonnegativeSafeIntegerSchema,
  fillVolume: NonnegativeSafeIntegerSchema,
  averageSpread: z.number().refine((value) => Number.isFinite(value) && value >= 0),
  quoteParticipationRate: z.number().min(0).max(1),
  riskBreaches: z.array(QuantTradingRiskBreachEventSchema).max(256),
  informedFlowCount: NonnegativeSafeIntegerSchema,
  noiseFlowCount: NonnegativeSafeIntegerSchema,
  adverseSelectionPnL: QuantTradingFiniteNumberSchema,
  accountingInvariantHolds: z.boolean(),
  objectiveScore: z.number().int().min(0).max(100)
}).strict().superRefine((value, context) => {
  if (
    value.roundsCompleted > value.plannedRounds
    || value.completionRate !== value.roundsCompleted / value.plannedRounds
    || (
      value.completionStatus === "COMPLETED"
      && value.roundsCompleted !== value.plannedRounds
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["roundsCompleted"],
      message: "Quant Trading terminal round progress is inconsistent"
    });
  }
  if (value.tradeCount !== value.finalPortfolio.tradeCount) {
    context.addIssue({
      code: "custom",
      path: ["tradeCount"],
      message: "Quant Trading terminal trade count must match final portfolio"
    });
  }
  if (value.informedFlowCount + value.noiseFlowCount > value.roundsCompleted) {
    context.addIssue({
      code: "custom",
      path: ["informedFlowCount"],
      message: "Quant Trading terminal flow counts cannot exceed resolved rounds"
    });
  }
  if (value.completionStatus === "RISK_STOPPED" && value.riskBreaches.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["riskBreaches"],
      message: "Risk-stopped Quant Trading result requires a recorded risk breach"
    });
  }
  const latestPossibleBreachRound = value.completionStatus === "RISK_STOPPED"
    ? Math.min(value.plannedRounds, value.roundsCompleted + 1)
    : value.roundsCompleted;
  if (value.riskBreaches.some((breach) => breach.round > latestPossibleBreachRound)) {
    context.addIssue({
      code: "custom",
      path: ["riskBreaches"],
      message: "Quant Trading risk breach cannot occur beyond terminal round progress"
    });
  }
});
export type QuantTradingResultEvent = z.infer<typeof QuantTradingResultEventSchema>;

const metadata = {
  eventId: EventIdSchema,
  sessionId: SessionIdSchema,
  sequence: PositiveSafeIntegerSchema,
  schemaVersion: z.literal(CURRENT_EVENT_SCHEMA_VERSION),
  source: EventSourceSchema,
  wallTime: z.iso.datetime(),
  elapsedMs: NonnegativeSafeIntegerSchema,
  causationId: RequestIdSchema,
  correlationId: RequestIdSchema
};

const event = <TType extends string, TPayload extends z.ZodType>(type: TType, payload: TPayload) =>
  z.object({ ...metadata, type: z.literal(type), payload }).strict();

export const SessionEventSchema = z.discriminatedUnion("type", [
  event("SESSION_STARTED", z.object({
    startedAt: z.iso.datetime(),
    configuration: InterviewSessionConfigurationSchema.optional()
  }).strict()),
  event("PROBLEM_PRESENTED", z.object({
    problemId: z.string().min(1),
    problemVersion: z.string().min(1),
    prompt: z.string().min(1),
    providerContextSpecSha256: ProviderContextSpecFingerprintSchema.optional()
  }).strict()),
  event("QUANT_TRADING_SCENARIO_INITIALIZED", z.object({
    definition: QuantTradingScenarioDefinitionEventSchema
  }).strict()),
  event("QUANT_TRADING_ACTION_ACCEPTED", z.object({
    action: QuantTradingCandidateActionSchema
  }).strict()),
  event("QUANT_TRADING_ROUND_RESOLVED", z.object({
    evidence: QuantTradingRoundEvidenceEventSchema
  }).strict()),
  event("QUANT_TRADING_SCENARIO_COMPLETED", z.object({
    result: QuantTradingResultEventSchema
  }).strict()),
  event("QUANT_RESEARCH_SCENARIO_INITIALIZED", z.object({
    definition: QuantResearchScenarioDefinitionEventSchema,
    authoritativeSnapshot: QuantResearchAuthoritativeSnapshotEventSchema
  }).strict()),
  event("QUANT_RESEARCH_ACTION_ACCEPTED", z.object({
    action: QuantResearchActionEventSchema
  }).strict()),
  event("QUANT_RESEARCH_SCENARIO_COMPLETED", z.object({
    result: QuantResearchResultEventSchema.refine(
      (result) => result.status === "COMPLETE",
      {
        path: ["status"],
        message: "Quant Research completion event requires a complete result"
      }
    )
  }).strict()),
  event("UTTERANCE_STARTED", z.object({ utteranceId: UtteranceIdSchema }).strict()),
  event("UTTERANCE_DISCARDED", z.object({ utteranceId: UtteranceIdSchema, reason: z.string().min(1) }).strict()),
  event("INPUT_EPISODE_STARTED", z.object({ inputEpisodeId: InputEpisodeIdSchema }).strict()),
  event("INPUT_EPISODE_UPDATED", z.object({ inputEpisodeId: InputEpisodeIdSchema, modality: z.enum(["SPEECH", "TYPING", "WHITEBOARD"]), semanticContent: z.string().min(1) }).strict()),
  event("INPUT_EPISODE_COMMITTED", z.object({ inputEpisodeId: InputEpisodeIdSchema }).strict()),
  event("TURN_COMMITTED", z.object({ turnId: TurnIdSchema, inputEpisodeId: InputEpisodeIdSchema, studentText: z.string().min(1) }).strict()),
  event("TRANSCRIPT_FINALIZED", z.object({ utteranceId: UtteranceIdSchema, inputEpisodeId: InputEpisodeIdSchema, transcriptRevision: TranscriptRevisionSchema, text: z.string().min(1) }).strict()),
  event("TRANSCRIPT_CORRECTED", z.object({ transcriptRevision: TranscriptRevisionSchema, contextEpoch: ContextEpochSchema, correctedText: z.string().min(1) }).strict()),
  event("BOARD_PATCH_COMMITTED", z.object({
    boardRevision: BoardRevisionSchema,
    summary: z.string().min(1),
    mutation: NormalizedBoardMutationSchema.optional()
  }).strict()),
  event("VISION_REQUESTED", z.object({
    visionRequestId: RequestIdSchema,
    sourceBoardRevision: BoardRevisionSchema,
    regionId: z.string().min(1).max(128),
    relevantShapeIds: z.array(BoardShapeIdSchema).min(1).max(MAX_VISION_REGION_SHAPES),
    snapshotBasis: VisionSnapshotBasisSchema.optional(),
    relevantShapeRevisions: z.array(VisionShapeRevisionBindingSchema)
      .max(MAX_VISION_REGION_SHAPES)
      .optional(),
    regionBounds: VisionBoundsSchema.optional(),
    requestedObservationKind: VisionRequestedObservationKindSchema.optional()
  }).strict().superRefine((request, context) => {
    if (new Set(request.relevantShapeIds).size !== request.relevantShapeIds.length) {
      context.addIssue({
        code: "custom",
        path: ["relevantShapeIds"],
        message: "Vision request relevant shape IDs must be unique"
      });
    }
    if (
      request.snapshotBasis !== undefined
      && request.snapshotBasis.sourceBoardRevision !== request.sourceBoardRevision
    ) {
      context.addIssue({
        code: "custom",
        path: ["snapshotBasis", "sourceBoardRevision"],
        message: "Vision request snapshot basis must match its source board revision"
      });
    }
    if (request.relevantShapeRevisions !== undefined) {
      const bindingIds = request.relevantShapeRevisions.map((binding) => binding.shapeId);
      const relevantIds = new Set(request.relevantShapeIds);
      if (
        new Set(bindingIds).size !== bindingIds.length
        || bindingIds.length !== relevantIds.size
        || !bindingIds.every((shapeId) => relevantIds.has(shapeId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["relevantShapeRevisions"],
          message: "Vision request shape revisions must exactly cover the relevant shape set"
        });
      }
    }
    const extendedProvenanceCount = [
      request.snapshotBasis,
      request.relevantShapeRevisions,
      request.regionBounds,
      request.requestedObservationKind
    ].filter((value) => value !== undefined).length;
    if (extendedProvenanceCount !== 0 && extendedProvenanceCount !== 4) {
      context.addIssue({
        code: "custom",
        message: "Vision request extended provenance must be either complete or absent for legacy replay"
      });
    }
  })),
  event("VISION_RESULT_ACCEPTED", z.object({
    visionRequestId: RequestIdSchema,
    observation: BoardObservationSchema,
    admission: AcceptedBoardObservationSchema.optional(),
    evidenceInterpreterFingerprint: VisionEvidenceInterpreterFingerprintSchema.nullable().optional()
  }).strict().superRefine((value, context) => {
    if (
      value.evidenceInterpreterFingerprint !== undefined
      && value.admission === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceInterpreterFingerprint"],
        message: "Vision evidence bridge authority requires an admitted observation"
      });
    }
  })),
  event("VISION_EVIDENCE_BRIDGE_DECIDED", z.object({
    visionRequestId: RequestIdSchema,
    interpreterFingerprint: VisionEvidenceInterpreterFingerprintSchema,
    decision: z.enum(["NO_PROPOSAL", "PROPOSAL"]),
    proposal: EvidenceProposalSchema.optional()
  }).strict().superRefine((value, context) => {
    if ((value.decision === "PROPOSAL") !== (value.proposal !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["proposal"],
        message: "Vision evidence bridge proposal must match its decision"
      });
    }
  })),
  event("VISION_EVIDENCE_BRIDGE_COMPLETED", z.object({
    visionRequestId: RequestIdSchema,
    interpreterFingerprint: VisionEvidenceInterpreterFingerprintSchema,
    evidenceCommitted: z.boolean()
  }).strict()),
  event("VISION_RESULT_DISCARDED", z.object({
    visionRequestId: RequestIdSchema,
    reason: z.string().min(1).max(240)
  }).strict()),
  event("LOCAL_COMPUTE_REQUESTED", z.object({
    computeRequestId: RequestIdSchema,
    operation: z.literal("ANALYZE_TRANSCRIPT"),
    inputEpisodeId: InputEpisodeIdSchema,
    sourceTranscriptRevision: TranscriptRevisionSchema
  }).strict()),
  event("LOCAL_COMPUTE_RESULT_ACCEPTED", z.object({
    computeRequestId: RequestIdSchema,
    operation: z.literal("ANALYZE_TRANSCRIPT"),
    sourceTranscriptRevision: TranscriptRevisionSchema,
    normalizedText: z.string(),
    tokenCount: z.number().int().nonnegative()
  }).strict()),
  event("LOCAL_COMPUTE_RESULT_DISCARDED", z.object({
    computeRequestId: RequestIdSchema,
    operation: z.literal("ANALYZE_TRANSCRIPT"),
    reason: z.string().min(1)
  }).strict()),
  event("VERIFICATION_REQUESTED", z.object({
    verificationRequestId: RequestIdSchema,
    verifier: z.string().min(1),
    basis: GenerationBasisSchema,
    candidateFormalInterpretation: z.string().min(1).max(100_000),
    interpretationConfidence: z.number().min(0).max(1),
    evidenceKey: EvidenceKeySchema,
    evidenceEventIds: z.array(EventIdSchema).min(1),
    boardRevisionIndependent: z.literal(true).optional(),
    sourceGenerationId: GenerationIdSchema.optional(),
    sourceProposalRequestId: RequestIdSchema.optional()
  }).strict()),
  event("VERIFICATION_RESULT_ACCEPTED", z.object({
    verificationRequestId: RequestIdSchema,
    result: VerificationResultSchema
  }).strict()),
  event("VERIFICATION_RESULT_DISCARDED", z.object({
    verificationRequestId: RequestIdSchema,
    reason: z.string().min(1)
  }).strict()),
  event("EVIDENCE_PROPOSED", z.object({ proposal: EvidenceProposalSchema }).strict()),
  event("STUDENT_EVIDENCE_UPDATED", z.object({
    key: EvidenceKeySchema,
    value: EvidenceValueSchema,
    supersedesEventId: EventIdSchema.optional()
  }).strict()),
  event("STUDENT_EVIDENCE_INVALIDATED", z.object({
    key: EvidenceKeySchema,
    invalidatesEventId: EventIdSchema,
    reason: z.string().min(1)
  }).strict()),
  event("PEDAGOGICAL_ACTION_SELECTED", z.object({ turnId: TurnIdSchema, request: RealizationRequestSchema }).strict()),
  event("MODEL_GENERATION_STARTED", z.object({
    generationId: GenerationIdSchema,
    basis: GenerationBasisSchema,
    provider: ProviderRuntimeNameSchema
  }).strict()),
  event("GENERATION_CONTEXT_COMPILED", z.object({
    generationId: GenerationIdSchema,
    manifest: ContextCompilationManifestSchema
  }).strict()),
  event("MODEL_PROPOSAL_RECEIVED", z.object({ generationId: GenerationIdSchema, proposal: InterviewerProposalSchema }).strict()),
  event("FORMAL_INTERPRETATION_PROPOSAL_RECEIVED", z.object({
    generationId: GenerationIdSchema,
    proposalRequestId: RequestIdSchema,
    proposal: FormalInterpretationProposalSchema
  }).strict()),
  event("FORMAL_INTERPRETATION_PROPOSAL_REJECTED", z.object({
    generationId: GenerationIdSchema,
    reason: z.string().min(1)
  }).strict()),
  event("MODEL_GENERATION_SUPERSEDED", z.object({ generationId: GenerationIdSchema, reason: z.string().min(1) }).strict()),
  event("PROPOSAL_VALIDATED", z.object({ generationId: GenerationIdSchema, analysis: DisclosureAnalysisSchema }).strict()),
  event("PROPOSAL_REJECTED", z.object({ generationId: GenerationIdSchema, reason: z.string().min(1) }).strict()),
  event("DELIVERY_QUEUED", z.object({ atom: DeliveryAtomSchema }).strict()),
  event("DELIVERY_STARTED", z.object({ deliveryId: DeliveryIdSchema }).strict()),
  event("DELIVERY_EXPOSED", z.object({ deliveryId: DeliveryIdSchema }).strict()),
  event("DELIVERY_COMPLETED", z.object({ deliveryId: DeliveryIdSchema }).strict()),
  event("DELIVERY_CANCELLED", z.object({ deliveryId: DeliveryIdSchema, reason: z.string().min(1) }).strict()),
  event("DELIVERY_POSSIBLY_EXPOSED", z.object({ deliveryId: DeliveryIdSchema, reason: z.string().min(1) }).strict()),
  event("POLICY_REVISION_CHANGED", z.object({ policyRevision: PolicyRevisionSchema, contextEpoch: ContextEpochSchema, reason: z.string().min(1) }).strict()),
  event("PROBLEM_STATE_REVISION_CHANGED", z.object({ problemStateRevision: ProblemStateRevisionSchema, contextEpoch: ContextEpochSchema, reason: z.string().min(1) }).strict()),
  event("SESSION_COMPLETED", z.object({ completedAt: z.iso.datetime(), summary: z.string().min(1).optional() }).strict()),
  event("SESSION_ARCHIVED", z.object({ archivedAt: z.iso.datetime(), reason: z.string().min(1).optional() }).strict()),
  event("SESSION_RESUMED", z.object({ resumedAt: z.iso.datetime() }).strict())
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type EventType = SessionEvent["type"];
export type EventBody = SessionEvent extends infer TEvent
  ? TEvent extends SessionEvent
    ? Pick<TEvent, "type" | "payload">
    : never
  : never;
export type EventDraft = EventBody & { readonly source: EventSource };

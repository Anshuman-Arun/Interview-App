import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BoardSceneContextSchema,
  ContextCompilationManifestSchema,
  DisclosureIdSchema,
  MAX_BOARD_SCENE_AI_ANNOTATIONS,
  MAX_BOARD_SCENE_ANNOTATION_PURPOSE_CHARACTERS,
  MAX_BOARD_SCENE_BYTES,
  MAX_BOARD_SCENE_OBSERVATION_CHARACTERS,
  MAX_BOARD_SCENE_SHAPES,
  MAX_BOARD_SCENE_TEXT_CHARACTERS,
  MIN_BOARD_SCENE_SEMANTIC_CONFIDENCE,
  ProviderContextSpecFingerprintSchema,
  RealizationRequestSchema,
  type BoardSceneContext,
  type BoardSceneSemanticObservation,
  type BoardSceneShape,
  type GenerationBasis,
  type GenerationId,
  type InterviewProblem,
  type ProviderContextSpecFingerprint,
  type RealizationRequest,
  type TurnId
} from "../../domain/src/index.js";
import type { SessionState } from "../../events/src/index.js";

export const CompiledContextSchema = z.object({
  problemPrompt: z.string().min(1),
  recentStudentWork: z.string().min(1),
  realizationRequest: RealizationRequestSchema,
  deliveredFacts: z.array(DisclosureIdSchema),
  forbiddenDisclosureIds: z.array(DisclosureIdSchema),
  boardScene: BoardSceneContextSchema.optional()
}).strict();
export type CompiledContext = z.infer<typeof CompiledContextSchema>;

export const CONTEXT_COMPILER_VERSION = "phase0-safe-context@3" as const;

const MAX_LIVE_CONTEXT_STUDENT_TEXT_CHARACTERS = 1_000_000;
const MAX_LIVE_CONTEXT_PROBLEM_PROMPT_CHARACTERS = 100_000;
const MAX_LIVE_CONTEXT_TARGET_CHARACTERS = 1_024;

const BOARD_SCENE_VISIBLE_DELIVERY_STATUSES = new Set(["EXPOSED", "COMPLETED"] as const);

function truncateBoardSceneText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return value.slice(0, maximum);
}

function boardSceneShapeTypePriority(type: BoardSceneShape["type"]): number {
  switch (type) {
    case "formula": return 3;
    case "text": return 2;
    case "arrow": return 1;
    default: return 0;
  }
}

function acceptedObservationStillApplies(
  state: Readonly<SessionState>,
  expectedBoardRevision: GenerationBasis["boardRevision"],
  accepted: NonNullable<SessionState["visionRequests"][string]["acceptedObservation"]>
): boolean {
  if (
    accepted.admittedAtBoardRevision > expectedBoardRevision
    || accepted.observation.confidence < MIN_BOARD_SCENE_SEMANTIC_CONFIDENCE
  ) {
    return false;
  }
  if (accepted.freshnessProof === "EXACT_BOARD_REVISION") {
    return accepted.admittedAtBoardRevision === expectedBoardRevision
      && accepted.observation.sourceBoardRevision === expectedBoardRevision;
  }
  if (accepted.shapeRevisionBindings.length === 0) return false;
  for (const binding of accepted.shapeRevisionBindings) {
    const shape = state.boardShapes[binding.shapeId];
    if (shape === undefined || shape.revision !== binding.expectedRevision) return false;
  }
  return true;
}

function semanticObservationByShape(
  state: Readonly<SessionState>,
  expectedBoardRevision: GenerationBasis["boardRevision"]
): ReadonlyMap<string, BoardSceneSemanticObservation> {
  const selected = new Map<string, {
    readonly admittedAtBoardRevision: number;
    readonly requestId: string;
    readonly value: BoardSceneSemanticObservation;
  }>();

  const requests = Object.values(state.visionRequests)
    .filter((request) =>
      request.status === "ACCEPTED"
      && request.acceptedObservation !== undefined
      && acceptedObservationStillApplies(state, expectedBoardRevision, request.acceptedObservation)
    )
    .sort((left, right) => {
      const leftAccepted = left.acceptedObservation;
      const rightAccepted = right.acceptedObservation;
      if (leftAccepted === undefined || rightAccepted === undefined) return 0;
      if (leftAccepted.admittedAtBoardRevision !== rightAccepted.admittedAtBoardRevision) {
        return rightAccepted.admittedAtBoardRevision - leftAccepted.admittedAtBoardRevision;
      }
      if (leftAccepted.observation.confidence !== rightAccepted.observation.confidence) {
        return rightAccepted.observation.confidence - leftAccepted.observation.confidence;
      }
      return left.visionRequestId < right.visionRequestId
        ? -1
        : left.visionRequestId > right.visionRequestId
          ? 1
          : 0;
    });

  for (const request of requests) {
    const accepted = request.acceptedObservation;
    if (accepted === undefined) continue;
    const value = BoardSceneContextSchema.shape.shapes.element.shape.semanticObservation.parse({
      kind: accepted.observationKind,
      interpretation: truncateBoardSceneText(
        accepted.observation.interpretation,
        MAX_BOARD_SCENE_OBSERVATION_CHARACTERS
      ),
      confidence: accepted.observation.confidence,
      sourceBoardRevision: accepted.observation.sourceBoardRevision
    });
    for (const shapeId of accepted.observation.relevantShapeIds) {
      if (selected.has(shapeId)) continue;
      selected.set(shapeId, {
        admittedAtBoardRevision: accepted.admittedAtBoardRevision,
        requestId: request.visionRequestId,
        value
      });
    }
  }

  return new Map(Array.from(selected.entries()).map(([shapeId, item]) => [shapeId, item.value]));
}

export function boardSceneContextSerializedBytes(scene: BoardSceneContext): number {
  const parsed = BoardSceneContextSchema.parse(scene);
  return new TextEncoder().encode(canonicalJson(parsed)).byteLength;
}

export function buildBoardSceneContext(
  state: Readonly<SessionState>,
  expectedBoardRevision: GenerationBasis["boardRevision"]
): BoardSceneContext | undefined {
  if (
    state.configuration?.mode === "QUANT_TRADING"
    || state.configuration?.mode === "QUANT_RESEARCH"
  ) {
    return undefined;
  }
  if (state.boardRevision !== expectedBoardRevision) {
    throw new Error("Board scene revision does not match the generation basis");
  }

  const authoritativeShapes = Object.values(state.boardShapes);
  if (!state.boardShapeAuthorityKnown && authoritativeShapes.length > 0) {
    throw new Error("Authoritative board shape state is unavailable");
  }

  const semanticByShape = semanticObservationByShape(state, expectedBoardRevision);
  const candidates = authoritativeShapes.map((shape): {
    readonly sceneShape: BoardSceneShape;
    readonly lastModifiedAt: number;
  } => ({
    sceneShape: {
      shapeId: shape.id,
      shapeRevision: shape.revision,
      type: shape.type,
      bounds: {
        x: shape.bounds.x,
        y: shape.bounds.y,
        width: shape.bounds.width,
        height: shape.bounds.height
      },
      ...(shape.text === undefined
        ? {}
        : { text: truncateBoardSceneText(shape.text, MAX_BOARD_SCENE_TEXT_CHARACTERS) }),
      ...(semanticByShape.get(shape.id) === undefined
        ? {}
        : { semanticObservation: semanticByShape.get(shape.id) })
    },
    lastModifiedAt: shape.lastModifiedAt
  }));

  candidates.sort((left, right) => {
    const leftSemantic = left.sceneShape.semanticObservation === undefined ? 0 : 1;
    const rightSemantic = right.sceneShape.semanticObservation === undefined ? 0 : 1;
    if (leftSemantic !== rightSemantic) return rightSemantic - leftSemantic;
    if (left.lastModifiedAt !== right.lastModifiedAt) return right.lastModifiedAt - left.lastModifiedAt;
    const typeDelta =
      boardSceneShapeTypePriority(right.sceneShape.type)
      - boardSceneShapeTypePriority(left.sceneShape.type);
    if (typeDelta !== 0) return typeDelta;
    return left.sceneShape.shapeId < right.sceneShape.shapeId
      ? -1
      : left.sceneShape.shapeId > right.sceneShape.shapeId
        ? 1
        : 0;
  });

  const scene: BoardSceneContext = {
    boardRevision: expectedBoardRevision,
    shapes: [],
    aiAnnotations: []
  };

  for (const candidate of candidates.slice(0, MAX_BOARD_SCENE_SHAPES)) {
    const next = {
      ...scene,
      shapes: [...scene.shapes, candidate.sceneShape]
    };
    if (boardSceneContextSerializedBytes(next) <= MAX_BOARD_SCENE_BYTES) {
      scene.shapes = next.shapes;
    }
  }

  const annotations = Object.values(state.deliveries)
    .filter((atom) =>
      atom.content.medium === "WHITEBOARD"
      && BOARD_SCENE_VISIBLE_DELIVERY_STATUSES.has(
        atom.status as "EXPOSED" | "COMPLETED"
      )
      && atom.content.action.operation !== "erase_ai_annotation"
    )
    .sort((left, right) =>
      left.deliveryId < right.deliveryId ? -1 : left.deliveryId > right.deliveryId ? 1 : 0
    )
    .slice(-MAX_BOARD_SCENE_AI_ANNOTATIONS)
    .reverse();

  for (const atom of annotations) {
    if (atom.content.medium !== "WHITEBOARD") continue;
    const action = atom.content.action;
    const annotation = {
      deliveryId: atom.deliveryId,
      operation: action.operation,
      purpose: truncateBoardSceneText(
        action.annotationPurpose,
        MAX_BOARD_SCENE_ANNOTATION_PURPOSE_CHARACTERS
      ),
      ...(action.targetShapeId === undefined ? {} : { targetShapeId: action.targetShapeId }),
      ...(action.expectedShapeRevision === undefined
        ? {}
        : { targetShapeRevision: action.expectedShapeRevision })
    };
    const next = {
      ...scene,
      aiAnnotations: [...scene.aiAnnotations, annotation]
    };
    if (boardSceneContextSerializedBytes(next) <= MAX_BOARD_SCENE_BYTES) {
      scene.aiAnnotations = next.aiAnnotations;
    }
  }

  if (scene.shapes.length === 0 && scene.aiAnnotations.length === 0) return undefined;
  return BoardSceneContextSchema.parse(scene);
}

const MAX_CANONICAL_JSON_DEPTH = 64;
const MAX_CANONICAL_JSON_NODES = 100_000;
const MAX_CANONICAL_JSON_STRING_CHARACTERS = 1_000_000;
const MAX_CANONICAL_JSON_TOTAL_TEXT_CHARACTERS = 5_000_000;

interface CanonicalJsonBudget {
  nodes: number;
  textCharacters: number;
}

function consumeCanonicalNode(budget: CanonicalJsonBudget): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_JSON_NODES) {
    throw new Error("Canonical JSON exceeds the bounded node budget");
  }
}

function consumeCanonicalText(budget: CanonicalJsonBudget, text: string): void {
  if (text.length > MAX_CANONICAL_JSON_STRING_CHARACTERS) {
    throw new Error("Canonical JSON string exceeds the bounded per-string size");
  }
  budget.textCharacters += text.length;
  if (budget.textCharacters > MAX_CANONICAL_JSON_TOTAL_TEXT_CHARACTERS) {
    throw new Error("Canonical JSON exceeds the bounded aggregate text size");
  }
}

function canonicalJsonBounded(
  value: unknown,
  depth: number,
  budget: CanonicalJsonBudget
): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new Error("Canonical JSON exceeds the bounded nesting depth");
  }
  consumeCanonicalNode(budget);

  if (value === null) return "null";
  if (typeof value === "string") {
    consumeCanonicalText(budget, value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CANONICAL_JSON_NODES) {
      throw new Error("Canonical JSON array exceeds the bounded node budget");
    }
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("Canonical JSON arrays must contain only own data elements");
      }
      items.push(canonicalJsonBounded(descriptor.value, depth + 1, budget));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const descriptors = Object.getOwnPropertyDescriptors(record);
    const keys = Object.keys(descriptors)
      .filter((key) => {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable) return false;
        if (!("value" in descriptor)) {
          throw new Error("Canonical JSON objects must contain only own data properties");
        }
        return descriptor.value !== undefined;
      });
    if (keys.length > MAX_CANONICAL_JSON_NODES) {
      throw new Error("Canonical JSON object exceeds the bounded node budget");
    }
    for (const key of keys) consumeCanonicalText(budget, key);
    keys.sort();
    const entries = keys.map((key) => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("Canonical JSON objects must contain only own data properties");
      }
      return `${JSON.stringify(key)}:${canonicalJsonBounded(descriptor.value, depth + 1, budget)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new Error("Canonical JSON accepts only JSON-compatible values");
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonBounded(value, 0, { nodes: 0, textCharacters: 0 });
}

export function sha256CanonicalJsonSync(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function sha256CanonicalJson(value: unknown): Promise<string> {
  return sha256CanonicalJsonSync(value);
}

export function createProviderContextSpecFingerprintSync(
  problem: InterviewProblem
): ProviderContextSpecFingerprint {
  const digest = sha256CanonicalJsonSync({
    id: problem.id,
    version: problem.version,
    public: problem.public,
    interviewer: problem.interviewer
  });
  return ProviderContextSpecFingerprintSchema.parse(digest);
}

export async function createProviderContextSpecFingerprint(
  problem: InterviewProblem
): Promise<ProviderContextSpecFingerprint> {
  return createProviderContextSpecFingerprintSync(problem);
}

export async function createContextCompilationManifest(input: {
  readonly context: CompiledContext;
  readonly problem: InterviewProblem;
  readonly generationId: GenerationId;
  readonly generationBasis: GenerationBasis;
}) {
  const [contextSha256, reasoningGraphSha256] = await Promise.all([
    sha256CanonicalJson(CompiledContextSchema.parse(input.context)),
    sha256CanonicalJson(input.problem.interviewer.reasoningGraph)
  ]);
  return ContextCompilationManifestSchema.parse({
    schemaVersion: 1,
    compilerVersion: CONTEXT_COMPILER_VERSION,
    hashAlgorithm: "SHA-256",
    generationId: input.generationId,
    generationBasis: input.generationBasis,
    problemId: input.problem.id,
    problemVersion: input.problem.version,
    contextSha256,
    reasoningGraphSha256
  });
}

export function compileContext(input: {
  readonly state: Readonly<SessionState>;
  readonly problem: InterviewProblem;
  readonly turnId: TurnId;
  readonly realizationRequest: RealizationRequest;
  readonly generationBasis?: GenerationBasis;
}): CompiledContext {
  if (
    input.generationBasis !== undefined
    && (
      input.generationBasis.turnId !== input.turnId
      || input.generationBasis.boardRevision !== input.state.boardRevision
    )
  ) {
    throw new Error("Context compilation board basis is stale");
  }
  const turn = input.state.turns[input.turnId];
  if (turn === undefined || turn.turnId !== input.turnId) {
    throw new Error(`Unknown or malformed turn ${input.turnId}`);
  }
  const episode = input.state.inputEpisodes[turn.inputEpisodeId];
  if (
    episode === undefined
    || episode.inputEpisodeId !== turn.inputEpisodeId
    || episode.status !== "COMMITTED"
  ) {
    throw new Error("Context compilation requires the turn's committed InputEpisode");
  }
  if (
    input.state.lastCommittedInputSequence === undefined
    || turn.committedSequence !== input.state.lastCommittedInputSequence
  ) {
    throw new Error("Context compilation requires the latest committed Turn");
  }
  if (
    turn.studentText.length === 0
    || turn.studentText.length > MAX_LIVE_CONTEXT_STUDENT_TEXT_CHARACTERS
  ) {
    throw new Error("Turn student work is outside the bounded live context size");
  }
  if (
    input.problem.public.prompt.length === 0
    || input.problem.public.prompt.length > MAX_LIVE_CONTEXT_PROBLEM_PROMPT_CHARACTERS
  ) {
    throw new Error("Problem prompt is outside the bounded live context size");
  }
  if (
    input.state.problem === undefined
    || input.state.problem.id !== input.problem.id
    || input.state.problem.version !== input.problem.version
  ) throw new Error("Problem does not match the session's presented problem");
  if (input.state.problem.providerContextSpecSha256 === undefined) {
    throw new Error("Problem definition provenance is unavailable for context compilation");
  }
  if (input.state.problem.prompt !== input.problem.public.prompt) {
    throw new Error("Session problem prompt does not match the bound problem definition");
  }
  const providerContextSpecSha256 = createProviderContextSpecFingerprintSync(input.problem);
  if (input.state.problem.providerContextSpecSha256 !== providerContextSpecSha256) {
    throw new Error("Problem definition does not match the session-bound provider context contract");
  }

  const request = RealizationRequestSchema.parse(input.realizationRequest);
  if (
    request.target !== undefined
    && request.target.length > MAX_LIVE_CONTEXT_TARGET_CHARACTERS
  ) {
    throw new Error("Pedagogical target is outside the bounded live context size");
  }
  const authoritativeRequest = RealizationRequestSchema.safeParse(
    input.state.pedagogicalActions[input.turnId]
  );
  if (
    !authoritativeRequest.success
    || canonicalJson(authoritativeRequest.data) !== canonicalJson(request)
  ) {
    throw new Error("Context compilation requires the authoritative pedagogical action for the turn");
  }

  const disclosureById = new Map<
    z.infer<typeof DisclosureIdSchema>,
    (typeof input.problem.interviewer.protectedDisclosures)[number]
  >();
  for (const disclosure of input.problem.interviewer.protectedDisclosures) {
    if (disclosureById.has(disclosure.id)) {
      throw new Error("Bound problem contains duplicate protected disclosure IDs");
    }
    disclosureById.set(disclosure.id, disclosure);
  }

  const delivered = new Set<z.infer<typeof DisclosureIdSchema>>();
  for (const disclosureId of input.state.disclosureLedger) {
    if (!disclosureById.has(disclosureId) || delivered.has(disclosureId)) {
      throw new Error("Disclosure ledger is inconsistent with the bound problem definition");
    }
    delivered.add(disclosureId);
  }

  const allowed = new Set(request.allowedDisclosureIds ?? []);
  for (const disclosureId of allowed) {
    const disclosure = disclosureById.get(disclosureId);
    if (disclosure === undefined) {
      throw new Error("Realization request authorizes an unknown protected disclosure");
    }
    if (disclosure.minimumDisclosureLevel > request.maximumDisclosure) {
      throw new Error("Realization request authorizes a protected disclosure above its numeric ceiling");
    }
  }

  const boardScene = buildBoardSceneContext(
    input.state,
    input.generationBasis?.boardRevision ?? input.state.boardRevision
  );

  return CompiledContextSchema.parse({
    problemPrompt: input.state.problem.prompt,
    recentStudentWork: turn.studentText,
    realizationRequest: request,
    deliveredFacts: [...delivered],
    forbiddenDisclosureIds: input.problem.interviewer.protectedDisclosures
      .map((item) => item.id)
      .filter((id) => !allowed.has(id)),
    ...(boardScene === undefined ? {} : { boardScene })
  });
}

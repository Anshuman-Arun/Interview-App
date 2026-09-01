import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ContextCompilationManifestSchema,
  DisclosureIdSchema,
  ProviderContextSpecFingerprintSchema,
  RealizationRequestSchema,
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
  forbiddenDisclosureIds: z.array(DisclosureIdSchema)
}).strict();
export type CompiledContext = z.infer<typeof CompiledContextSchema>;

export const CONTEXT_COMPILER_VERSION = "phase0-safe-context@1" as const;

const MAX_LIVE_CONTEXT_STUDENT_TEXT_CHARACTERS = 1_000_000;
const MAX_LIVE_CONTEXT_PROBLEM_PROMPT_CHARACTERS = 100_000;
const MAX_LIVE_CONTEXT_TARGET_CHARACTERS = 1_024;

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
    for (const item of value) {
      items.push(canonicalJsonBounded(item, depth + 1, budget));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const keys: string[] = [];
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) continue;
      consumeCanonicalText(budget, key);
      keys.push(key);
      if (keys.length > MAX_CANONICAL_JSON_NODES) {
        throw new Error("Canonical JSON object exceeds the bounded node budget");
      }
    }
    keys.sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJsonBounded(record[key], depth + 1, budget)}`
    );
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
}): CompiledContext {
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

  return CompiledContextSchema.parse({
    problemPrompt: input.state.problem.prompt,
    recentStudentWork: turn.studentText,
    realizationRequest: request,
    deliveredFacts: [...delivered],
    forbiddenDisclosureIds: input.problem.interviewer.protectedDisclosures
      .map((item) => item.id)
      .filter((id) => !delivered.has(id) && !allowed.has(id))
  });
}

import { z } from "zod";
import {
  ContextCompilationManifestSchema,
  DisclosureIdSchema,
  RealizationRequestSchema,
  type GenerationBasis,
  type GenerationId,
  type InterviewProblem,
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

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Canonical JSON accepts only JSON-compatible values");
}

export async function sha256CanonicalJson(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  if (turn === undefined) throw new Error(`Unknown turn ${input.turnId}`);
  const delivered = new Set(input.state.disclosureLedger);
  return CompiledContextSchema.parse({
    problemPrompt: input.problem.public.prompt,
    recentStudentWork: turn.studentText,
    realizationRequest: input.realizationRequest,
    deliveredFacts: [...delivered],
    forbiddenDisclosureIds: input.problem.interviewer.protectedDisclosures
      .map((item) => item.id)
      .filter((id) => !delivered.has(id))
  });
}

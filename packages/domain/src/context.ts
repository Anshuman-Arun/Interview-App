import { z } from "zod";
import { GenerationBasisSchema } from "./generation.js";
import { GenerationIdSchema } from "./ids.js";

export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const ContextCompilationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  compilerVersion: z.string().min(1),
  hashAlgorithm: z.literal("SHA-256"),
  generationId: GenerationIdSchema,
  generationBasis: GenerationBasisSchema,
  problemId: z.string().min(1),
  problemVersion: z.string().min(1),
  contextSha256: Sha256HexSchema,
  reasoningGraphSha256: Sha256HexSchema
}).strict();

export type ContextCompilationManifest = z.infer<typeof ContextCompilationManifestSchema>;

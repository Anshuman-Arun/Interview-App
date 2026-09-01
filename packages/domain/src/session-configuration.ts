import { z } from "zod";

export const InterviewModeSchema = z.enum([
  "OXFORD_MATHEMATICS",
  "QUANT_TRADING",
  "QUANT_RESEARCH"
]);
export type InterviewMode = z.infer<typeof InterviewModeSchema>;

export const SessionTargetIdentitySchema = z.object({
  id: z.string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  version: z.string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
}).strict();
export type SessionTargetIdentity = z.infer<typeof SessionTargetIdentitySchema>;

export const InterventionPolicySchema = z.enum([
  "MINIMAL",
  "BALANCED",
  "STRICT"
]);
export type InterventionPolicy = z.infer<typeof InterventionPolicySchema>;

const ProviderMachineIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u);

export const ProviderSelectionReferenceSchema = z.object({
  providerId: ProviderMachineIdSchema,
  modelId: ProviderMachineIdSchema
}).strict();
export type ProviderSelectionReference = z.infer<typeof ProviderSelectionReferenceSchema>;

const ConfigurationCommonShape = {
  configurationVersion: z.literal(1).default(1),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  interventionPolicy: InterventionPolicySchema.default("BALANCED"),
  providerSelection: ProviderSelectionReferenceSchema.optional()
} as const;

const DifficultySchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const OxfordInterviewSessionConfigurationSchema = z.object({
  ...ConfigurationCommonShape,
  mode: z.literal("OXFORD_MATHEMATICS"),
  problem: SessionTargetIdentitySchema,
  difficulty: DifficultySchema.optional()
}).strict();

export const QuantTradingSessionConfigurationSchema = z.object({
  ...ConfigurationCommonShape,
  mode: z.literal("QUANT_TRADING"),
  scenario: SessionTargetIdentitySchema
}).strict();

export const QuantResearchSessionConfigurationSchema = z.object({
  ...ConfigurationCommonShape,
  mode: z.literal("QUANT_RESEARCH"),
  scenario: SessionTargetIdentitySchema
}).strict();

export const InterviewSessionConfigurationSchema = z.discriminatedUnion("mode", [
  OxfordInterviewSessionConfigurationSchema,
  QuantTradingSessionConfigurationSchema,
  QuantResearchSessionConfigurationSchema
]);
export type InterviewSessionConfiguration = z.infer<typeof InterviewSessionConfigurationSchema>;


const CatalogTitleSchema = z.string().min(1).max(160);
const CatalogCategorySchema = z.string().min(1).max(80);

export const InterviewCatalogEntrySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("OXFORD_MATHEMATICS"),
    id: SessionTargetIdentitySchema.shape.id,
    version: SessionTargetIdentitySchema.shape.version,
    title: CatalogTitleSchema,
    category: CatalogCategorySchema,
    difficulty: z.string().min(1).max(64)
  }).strict(),
  z.object({
    mode: z.literal("QUANT_TRADING"),
    id: SessionTargetIdentitySchema.shape.id,
    version: SessionTargetIdentitySchema.shape.version,
    title: CatalogTitleSchema
  }).strict(),
  z.object({
    mode: z.literal("QUANT_RESEARCH"),
    id: SessionTargetIdentitySchema.shape.id,
    version: SessionTargetIdentitySchema.shape.version,
    title: CatalogTitleSchema
  }).strict()
]);
export type InterviewCatalogEntry = z.infer<typeof InterviewCatalogEntrySchema>;

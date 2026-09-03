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

const CommonSecretValuePattern =
  /^(?:sk[-_][a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9_-]{20,}|hf_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,})$/u;

const ProviderMachineIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u)
  .refine((value) => !CommonSecretValuePattern.test(value), {
    message: "Provider selection identifiers must not contain credential material"
  });

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
const PublicProblemTextSchema = z.string().min(1).max(20_000);
const PublicProblemMetadataTextSchema = z.string().min(1).max(256);

export const InterviewProblemPublicViewSchema = z.object({
  id: SessionTargetIdentitySchema.shape.id,
  version: SessionTargetIdentitySchema.shape.version,
  title: CatalogTitleSchema,
  category: CatalogCategorySchema,
  difficulty: z.string().min(1).max(64),
  prompt: PublicProblemTextSchema,
  givenInformation: z.array(PublicProblemTextSchema).max(64),
  topics: z.array(PublicProblemMetadataTextSchema).max(64)
}).strict();
export type InterviewProblemPublicView = z.infer<typeof InterviewProblemPublicViewSchema>;


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

export const SessionConfigurationSourceSchema = z.enum([
  "CONFIGURED",
  "LEGACY_COMPATIBILITY"
]);
export type SessionConfigurationSource = z.infer<typeof SessionConfigurationSourceSchema>;

export const ProviderLaunchAvailabilityReasonSchema = z.enum([
  "CREDENTIALS_REQUIRED",
  "DISABLED",
  "RUNTIME_CONFIGURATION_UNAVAILABLE",
  "RUNTIME_DEPENDENCY_UNAVAILABLE",
  "POLICY_UNAVAILABLE",
  "POLICY_DENIED",
  "CAPABILITY_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
  "UNKNOWN"
]);
export type ProviderLaunchAvailabilityReason = z.infer<typeof ProviderLaunchAvailabilityReasonSchema>;

export const ProviderLaunchOptionSchema = z.object({
  providerId: ProviderMachineIdSchema,
  providerDisplayName: z.string().min(1).max(160),
  providerKind: z.enum(["MOCK", "REMOTE_API", "LOCAL_PROCESS", "OTHER"]),
  modelId: ProviderMachineIdSchema,
  modelDisplayName: z.string().min(1).max(160),
  availability: z.enum(["AVAILABLE", "UNAVAILABLE"]),
  reason: ProviderLaunchAvailabilityReasonSchema.optional()
}).strict().superRefine((option, context) => {
  if ((option.availability === "AVAILABLE") === (option.reason !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "Unavailable provider options require a bounded reason and available options must not include one"
    });
  }
});
export type ProviderLaunchOption = z.infer<typeof ProviderLaunchOptionSchema>;

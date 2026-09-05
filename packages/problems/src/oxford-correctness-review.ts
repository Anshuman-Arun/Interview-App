import {
  OXFORD_REVIEW_STATUSES,
  type OxfordReviewStatus
} from "./oxford-adaptive-taxonomy.js";

export const OXFORD_CORRECTNESS_AUDIT_SCHEMA_VERSION = 1 as const;

export const OXFORD_CORRECTNESS_RECOMMENDATIONS = [
  "approve",
  "revise",
  "reject"
] as const;
export type OxfordCorrectnessRecommendation =
  (typeof OXFORD_CORRECTNESS_RECOMMENDATIONS)[number];

export const OXFORD_CORRECTNESS_FINDING_AREAS = [
  "statement",
  "approach",
  "canonical-solution",
  "common-error",
  "hint",
  "extension",
  "prerequisite",
  "computation"
] as const;
export type OxfordCorrectnessFindingArea =
  (typeof OXFORD_CORRECTNESS_FINDING_AREAS)[number];

export const OXFORD_CORRECTNESS_FINDING_SEVERITIES = [
  "note",
  "warning",
  "error"
] as const;
export type OxfordCorrectnessFindingSeverity =
  (typeof OXFORD_CORRECTNESS_FINDING_SEVERITIES)[number];

export type OxfordCorrectnessFindingStatus = "open" | "resolved";

export interface OxfordCorrectnessFinding {
  readonly id: string;
  readonly area: OxfordCorrectnessFindingArea;
  readonly severity: OxfordCorrectnessFindingSeverity;
  readonly status: OxfordCorrectnessFindingStatus;
  readonly summary: string;
  readonly evidence: string;
}

export interface OxfordCorrectnessReviewSource {
  readonly kind: "existing-bank" | "author-pr";
  readonly authorAgent?: string;
  readonly prNumber?: number;
  readonly reviewedAuthorHead?: string;
}

export interface OxfordCorrectnessReviewRecord {
  readonly schemaVersion: typeof OXFORD_CORRECTNESS_AUDIT_SCHEMA_VERSION;
  readonly familyId: string;
  readonly problemVersion: string;
  readonly reviewerAgent: string;
  readonly reviewedAt: string;
  readonly source: OxfordCorrectnessReviewSource;
  readonly mathematicalCorrectness: OxfordReviewStatus;
  readonly recommendation: OxfordCorrectnessRecommendation;
  readonly independentlySolved: boolean;
  readonly statementChecked: boolean;
  readonly approachesChecked: boolean;
  readonly canonicalSolutionChecked: boolean;
  readonly hintsChecked: boolean;
  readonly extensionsChecked: boolean;
  readonly prerequisitesChecked: boolean;
  readonly independentSolutionSummary: string;
  readonly computationalChecks: readonly string[];
  readonly findings: readonly OxfordCorrectnessFinding[];
  readonly unresolvedUncertainties: readonly string[];
}

const REVIEW_STATUS_SET = new Set<string>(OXFORD_REVIEW_STATUSES);
const RECOMMENDATION_SET = new Set<string>(OXFORD_CORRECTNESS_RECOMMENDATIONS);
const FINDING_AREA_SET = new Set<string>(OXFORD_CORRECTNESS_FINDING_AREAS);
const FINDING_SEVERITY_SET = new Set<string>(OXFORD_CORRECTNESS_FINDING_SEVERITIES);
const CANONICAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;

export function assertOxfordCorrectnessReviewRecord(
  value: unknown
): asserts value is OxfordCorrectnessReviewRecord {
  if (!isRecord(value)) throw new Error("Oxford correctness review must be an object");

  assertExactNumber(value.schemaVersion, OXFORD_CORRECTNESS_AUDIT_SCHEMA_VERSION, "schemaVersion");
  assertCanonicalId(value.familyId, "familyId");
  assertPatternString(value.problemVersion, SEMVER, "problemVersion");
  assertNonBlankString(value.reviewerAgent, "reviewerAgent");
  assertPatternString(value.reviewedAt, ISO_DATE, "reviewedAt");

  if (!isRecord(value.source)) throw new Error("Oxford correctness review source must be an object");
  if (value.source.kind !== "existing-bank" && value.source.kind !== "author-pr") {
    throw new Error("Oxford correctness review source kind must be existing-bank or author-pr");
  }
  if (value.source.kind === "author-pr") {
    assertNonBlankString(value.source.authorAgent, "source.authorAgent");
    if (!Number.isInteger(value.source.prNumber) || (value.source.prNumber as number) <= 0) {
      throw new Error("source.prNumber must be a positive integer for author-pr reviews");
    }
    assertPatternString(value.source.reviewedAuthorHead, GIT_SHA, "source.reviewedAuthorHead");
  } else if (
    value.source.authorAgent !== undefined
    || value.source.prNumber !== undefined
    || value.source.reviewedAuthorHead !== undefined
  ) {
    throw new Error("existing-bank review source must not claim an author PR or author head");
  }

  if (typeof value.mathematicalCorrectness !== "string"
      || !REVIEW_STATUS_SET.has(value.mathematicalCorrectness)) {
    throw new Error("mathematicalCorrectness must use the canonical Oxford review statuses");
  }
  if (typeof value.recommendation !== "string"
      || !RECOMMENDATION_SET.has(value.recommendation)) {
    throw new Error("recommendation must be approve, revise, or reject");
  }

  for (const field of [
    "independentlySolved",
    "statementChecked",
    "approachesChecked",
    "canonicalSolutionChecked",
    "hintsChecked",
    "extensionsChecked",
    "prerequisitesChecked"
  ] as const) {
    if (typeof value[field] !== "boolean") {
      throw new Error(`${field} must be boolean`);
    }
  }

  assertNonBlankString(value.independentSolutionSummary, "independentSolutionSummary");
  assertStringArray(value.computationalChecks, "computationalChecks");
  assertStringArray(value.unresolvedUncertainties, "unresolvedUncertainties");

  if (!Array.isArray(value.findings)) throw new Error("findings must be an array");
  const findingIds = new Set<string>();
  for (const finding of value.findings) {
    if (!isRecord(finding)) throw new Error("each correctness finding must be an object");
    assertCanonicalId(finding.id, "finding.id");
    if (findingIds.has(finding.id)) {
      throw new Error(`duplicate correctness finding id "${finding.id}"`);
    }
    findingIds.add(finding.id);
    if (typeof finding.area !== "string" || !FINDING_AREA_SET.has(finding.area)) {
      throw new Error("finding.area is invalid");
    }
    if (typeof finding.severity !== "string" || !FINDING_SEVERITY_SET.has(finding.severity)) {
      throw new Error("finding.severity is invalid");
    }
    if (finding.status !== "open" && finding.status !== "resolved") {
      throw new Error("finding.status must be open or resolved");
    }
    assertNonBlankString(finding.summary, "finding.summary");
    assertNonBlankString(finding.evidence, "finding.evidence");
  }

  const openErrors = value.findings.filter((finding) =>
    isRecord(finding)
    && finding.severity === "error"
    && finding.status === "open"
  );

  if (value.mathematicalCorrectness === "approved") {
    if (value.recommendation !== "approve") {
      throw new Error("approved mathematical correctness requires an approve recommendation");
    }
    if (!value.independentlySolved
        || !value.statementChecked
        || !value.approachesChecked
        || !value.canonicalSolutionChecked
        || !value.hintsChecked
        || !value.extensionsChecked
        || !value.prerequisitesChecked) {
      throw new Error("approved mathematical correctness requires every audit dimension checked");
    }
    if (openErrors.length > 0) {
      throw new Error("approved mathematical correctness cannot coexist with open error findings");
    }
    if (value.unresolvedUncertainties.length > 0) {
      throw new Error("approved mathematical correctness cannot coexist with unresolved uncertainties");
    }
  }

  if (value.mathematicalCorrectness === "changes-required") {
    if (value.recommendation === "approve") {
      throw new Error("changes-required mathematical correctness cannot recommend approval");
    }
    if (openErrors.length === 0 && value.unresolvedUncertainties.length === 0) {
      throw new Error("changes-required review must identify an open error or unresolved uncertainty");
    }
  }

  if (
    (value.mathematicalCorrectness === "unreviewed"
      || value.mathematicalCorrectness === "in-review")
    && value.recommendation === "approve"
  ) {
    throw new Error("incomplete correctness review cannot recommend approval");
  }

  if (value.recommendation === "reject"
      && value.mathematicalCorrectness !== "changes-required") {
    throw new Error("reject recommendation must map to canonical changes-required status");
  }
}

export function assertOxfordCorrectnessReviewBatch(
  value: unknown
): asserts value is readonly OxfordCorrectnessReviewRecord[] {
  if (!Array.isArray(value)) throw new Error("Oxford correctness review batch must be an array");

  const familyIds = new Set<string>();
  for (const record of value) {
    assertOxfordCorrectnessReviewRecord(record);
    if (familyIds.has(record.familyId)) {
      throw new Error(`duplicate Oxford correctness review for family "${record.familyId}"`);
    }
    familyIds.add(record.familyId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonBlankString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a nonblank string`);
  }
}

function assertPatternString(
  value: unknown,
  pattern: RegExp,
  label: string
): asserts value is string {
  assertNonBlankString(value, label);
  if (!pattern.test(value)) throw new Error(`${label} has invalid format`);
}

function assertCanonicalId(value: unknown, label: string): asserts value is string {
  assertPatternString(value, CANONICAL_ID, label);
}

function assertExactNumber(value: unknown, expected: number, label: string): void {
  if (value !== expected) throw new Error(`${label} must equal ${String(expected)}`);
}

function assertStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) assertNonBlankString(item, `${label} entry`);
}

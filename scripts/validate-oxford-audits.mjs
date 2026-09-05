import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ORIGINALITY_DECISIONS = new Set([
  "PASS",
  "PASS_WITH_NOTES",
  "REVISE",
  "REJECT_TOO_CLOSE"
]);

export const FIDELITY_DECISIONS = new Set([
  "PASS",
  "PASS_WITH_NOTES",
  "REVISE",
  "REJECT_NOT_OXFORD_LIKE"
]);

export const RETRIEVAL_POOLS = Object.freeze(["A", "B", "C", "D", "E"]);
export const SIMILARITY_DIMENSIONS = Object.freeze([
  "wording",
  "setup",
  "target",
  "kernel",
  "decisiveMechanism",
  "diagram",
  "progression",
  "transferStretch"
]);

const REQUIRED_FINGERPRINT_FIELDS = Object.freeze([
  "surfaceObjects",
  "constraints",
  "targetType",
  "centralMechanism",
  "secondaryMechanisms",
  "criticalRepresentationChange",
  "diagramTopology",
  "smallCaseSignature",
  "progressionSignature",
  "solutionDependencyGraphSummary",
  "distinctiveFeatures",
  "knownClassicOverlap",
  "authorProvenance"
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasForbiddenTextKey(value, trail = "$") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = hasForbiddenTextKey(value[i], `${trail}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (["problemText", "sourceText", "solutionText", "fullProblem", "fullSolution"].includes(key)) {
      return `${trail}.${key}`;
    }
    const hit = hasForbiddenTextKey(nested, `${trail}.${key}`);
    if (hit) return hit;
  }
  return null;
}

export function hardFailRules(scores) {
  const rules = [];
  if (scores.wording === 3) rules.push("R1");
  if (scores.kernel >= 2 && scores.decisiveMechanism >= 2) rules.push("R3");
  if (scores.diagram >= 2 && scores.kernel >= 2) rules.push("R4");
  if (scores.progression >= 2 && scores.decisiveMechanism >= 2) rules.push("R5");
  if (scores.setup >= 2 && scores.target >= 2 && scores.decisiveMechanism >= 2) rules.push("R3");
  return [...new Set(rules)];
}

function validateScores(scores, label) {
  assert(scores && typeof scores === "object", `${label} similarity is required`);
  for (const dimension of SIMILARITY_DIMENSIONS) {
    const score = scores[dimension];
    assert(Number.isInteger(score) && score >= 0 && score <= 3,
      `${label}.${dimension} must be an integer from 0 to 3`);
  }
}

function validateFingerprint(fingerprint, familyId) {
  assert(fingerprint && typeof fingerprint === "object", `${familyId}: fingerprint is required`);
  for (const field of REQUIRED_FINGERPRINT_FIELDS) {
    assert(Object.hasOwn(fingerprint, field), `${familyId}: fingerprint missing ${field}`);
  }
  assert(Array.isArray(fingerprint.surfaceObjects) && fingerprint.surfaceObjects.length > 0,
    `${familyId}: surfaceObjects must be non-empty`);
  assert(Array.isArray(fingerprint.constraints) && fingerprint.constraints.length > 0,
    `${familyId}: constraints must be non-empty`);
  assert(nonBlank(fingerprint.targetType), `${familyId}: targetType must be non-blank`);
  assert(nonBlank(fingerprint.centralMechanism), `${familyId}: centralMechanism must be non-blank`);
  assert(Array.isArray(fingerprint.secondaryMechanisms),
    `${familyId}: secondaryMechanisms must be an array`);
  assert(nonBlank(fingerprint.criticalRepresentationChange),
    `${familyId}: criticalRepresentationChange must be non-blank; use "none" when appropriate`);
  assert(nonBlank(fingerprint.diagramTopology),
    `${familyId}: diagramTopology must be non-blank; use "none" when appropriate`);
  assert(nonBlank(fingerprint.smallCaseSignature),
    `${familyId}: smallCaseSignature must be non-blank; use "none" when appropriate`);
  const progression = fingerprint.progressionSignature;
  assert(progression && typeof progression === "object",
    `${familyId}: progressionSignature must be an object`);
  for (const stage of ["opening", "firstDeepening", "core", "transfer", "stretch"]) {
    assert(nonBlank(progression[stage]),
      `${familyId}: progressionSignature.${stage} must be non-blank; use "none" when absent`);
  }
  assert(nonBlank(fingerprint.solutionDependencyGraphSummary),
    `${familyId}: solutionDependencyGraphSummary must be non-blank`);
  assert(Array.isArray(fingerprint.distinctiveFeatures) && fingerprint.distinctiveFeatures.length > 0,
    `${familyId}: distinctiveFeatures must be non-empty`);
  assert(nonBlank(fingerprint.knownClassicOverlap),
    `${familyId}: knownClassicOverlap must be non-blank`);
  assert(nonBlank(fingerprint.authorProvenance),
    `${familyId}: authorProvenance must be non-blank`);
}

function validateAudit(record) {
  assert(nonBlank(record.familyId), "audit familyId must be non-blank");
  assert(nonBlank(record.sourceRef), `${record.familyId}: sourceRef must be non-blank`);
  assert(["current-bank", "expert-review", "same-wave-proposal"].includes(record.subjectKind),
    `${record.familyId}: invalid subjectKind`);
  assert(nonBlank(record.reviewedAt), `${record.familyId}: reviewedAt must be non-blank`);
  assert(record.reviewer?.agent === "H" && record.reviewer?.name === "Hilbert",
    `${record.familyId}: reviewer must be Agent H — Hilbert`);
  validateFingerprint(record.fingerprint, record.familyId);

  assert(ORIGINALITY_DECISIONS.has(record.originalityDecision),
    `${record.familyId}: invalid originalityDecision`);
  assert(FIDELITY_DECISIONS.has(record.fidelityDecision),
    `${record.familyId}: invalid fidelityDecision`);

  assert(record.retrieval && typeof record.retrieval === "object",
    `${record.familyId}: retrieval is required`);
  for (const pool of RETRIEVAL_POOLS) {
    const status = record.retrieval[pool];
    assert(status && status.completed === true,
      `${record.familyId}: retrieval pool ${pool} must be completed`);
    assert(nonBlank(status.note), `${record.familyId}: retrieval pool ${pool} needs a note`);
  }
  assert(Array.isArray(record.externalSearchQueries) && record.externalSearchQueries.length > 0,
    `${record.familyId}: Pool E requires retained externalSearchQueries`);

  assert(Array.isArray(record.nearestMatches),
    `${record.familyId}: nearestMatches must be an array`);
  let externalMatchCount = 0;
  for (let i = 0; i < record.nearestMatches.length; i += 1) {
    const match = record.nearestMatches[i];
    const label = `${record.familyId}.nearestMatches[${i}]`;
    assert(RETRIEVAL_POOLS.includes(match.pool), `${label}: invalid pool`);
    assert(nonBlank(match.source), `${label}: source is required`);
    assert(Array.isArray(match.matchedFingerprintFeatures) && match.matchedFingerprintFeatures.length > 0,
      `${label}: matchedFingerprintFeatures must be non-empty`);
    validateScores(match.similarity, label);
    assert(nonBlank(match.explanation), `${label}: explanation is required`);
    if (match.pool === "E") externalMatchCount += 1;
  }
  assert(externalMatchCount > 0,
    `${record.familyId}: at least one retained Pool E nearest match is required`);

  const classic = record.classicProblemCheck;
  assert(classic && typeof classic === "object" && nonBlank(classic.result) && nonBlank(classic.notes),
    `${record.familyId}: classicProblemCheck is required`);

  assert(record.fidelityNotes && typeof record.fidelityNotes === "object",
    `${record.familyId}: fidelityNotes are required`);
  for (const field of [
    "accessibleOpening",
    "promptability",
    "reasoningEvidence",
    "transfer",
    "ceiling",
    "prerequisiteBurden"
  ]) {
    assert(nonBlank(record.fidelityNotes[field]),
      `${record.familyId}: fidelityNotes.${field} must be non-blank`);
  }

  assert(Array.isArray(record.requiredChanges),
    `${record.familyId}: requiredChanges must be an array`);
  assert(Array.isArray(record.bankDisposition) && record.bankDisposition.length > 0,
    `${record.familyId}: bankDisposition must be non-empty`);
  assert(typeof record.wouldRejectIfClaimedOriginal === "boolean",
    `${record.familyId}: wouldRejectIfClaimedOriginal must be boolean`);
  assert(record.handoff && typeof record.handoff === "object"
    && typeof record.handoff.canProgressAfterGI === "boolean"
    && nonBlank(record.handoff.note),
    `${record.familyId}: handoff is incomplete`);

  if (["PASS", "PASS_WITH_NOTES"].includes(record.originalityDecision)) {
    for (const match of record.nearestMatches) {
      const hardFails = hardFailRules(match.similarity);
      assert(hardFails.length === 0,
        `${record.familyId}: originality pass conflicts with hard-fail match ${match.source}: ${hardFails.join(",")}`);
    }
  }
}

export function validateAuditDocument(document) {
  assert(document && typeof document === "object", "audit document must be an object");
  assert(document.schemaVersion === 1, "audit document schemaVersion must be 1");
  assert(document.agent === "H — Hilbert", "audit document agent must be H — Hilbert");
  assert(nonBlank(document.basedOnMainCommit), "basedOnMainCommit is required");
  assert(Array.isArray(document.audits) && document.audits.length > 0,
    "audit document audits must be non-empty");

  const forbidden = hasForbiddenTextKey(document);
  assert(forbidden === null,
    `copyright guard: full problem/source/solution text key is forbidden at ${forbidden}`);

  const ids = new Set();
  for (const record of document.audits) {
    validateAudit(record);
    assert(!ids.has(record.familyId), `duplicate audit familyId ${record.familyId}`);
    ids.add(record.familyId);
  }

  const summary = document.summary;
  assert(summary && summary.totalFamilies === document.audits.length,
    "summary.totalFamilies must equal audits.length");

  return {
    totalFamilies: document.audits.length,
    originality: countDecisions(document.audits, "originalityDecision"),
    fidelity: countDecisions(document.audits, "fidelityDecision")
  };
}

function countDecisions(records, key) {
  const counts = {};
  for (const record of records) counts[record[key]] = (counts[record[key]] ?? 0) + 1;
  return counts;
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const target = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(root, "docs", "oxford-audits", "current-bank-baseline.json");
  const document = JSON.parse(fs.readFileSync(target, "utf8"));
  const summary = validateAuditDocument(document);
  process.stdout.write(`Oxford audit validation passed: ${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

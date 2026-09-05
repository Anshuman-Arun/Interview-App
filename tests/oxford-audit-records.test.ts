import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_PATH = path.join(ROOT, "docs", "oxford-audits", "current-bank-baseline.json");
const SAME_WAVE_PATH = path.join(ROOT, "docs", "oxford-audits", "same-wave-high-risk-batch.json");

describe("Oxford originality/fidelity audit records", () => {
  it("passes the fail-closed Agent H validator", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT, "scripts", "validate-oxford-audits.mjs"), AUDIT_PATH],
      { cwd: ROOT, encoding: "utf8" }
    );

    expect(output).toContain("Oxford audit validation passed (current-bank-baseline.json)");
  });

  it("retains all five retrieval pools and an external nearest match for every audited family", () => {
    const document = JSON.parse(readFileSync(AUDIT_PATH, "utf8")) as {
      audits: Array<{
        familyId: string;
        retrieval: Record<string, { completed: boolean }>;
        nearestMatches: Array<{ pool: string }>;
        externalSearchQueries: string[];
      }>;
    };

    expect(document.audits).toHaveLength(14);
    expect(new Set(document.audits.map((audit) => audit.familyId)).size).toBe(14);

    for (const audit of document.audits) {
      expect(Object.keys(audit.retrieval).sort()).toEqual(["A", "B", "C", "D", "E"]);
      expect(Object.values(audit.retrieval).every((pool) => pool.completed)).toBe(true);
      expect(audit.externalSearchQueries.length).toBeGreaterThan(0);
      expect(audit.nearestMatches.some((match) => match.pool === "E")).toBe(true);
    }
  });
  it("validates the retained high-risk same-wave C/D/E batch", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT, "scripts", "validate-oxford-audits.mjs"), SAME_WAVE_PATH],
      { cwd: ROOT, encoding: "utf8" }
    );

    expect(output).toContain("Oxford audit validation passed (same-wave-high-risk-batch.json)");

    const document = JSON.parse(readFileSync(SAME_WAVE_PATH, "utf8")) as {
      audits: Array<{
        familyId: string;
        authorPr?: { number: number };
        retrieval: Record<string, { completed: boolean }>;
        nearestMatches: Array<{ pool: string }>;
      }>;
    };

    expect(document.audits).toHaveLength(12);
    expect(new Set(document.audits.map((audit) => audit.familyId)).size).toBe(12);
    expect(new Set(document.audits.map((audit) => audit.authorPr?.number))).toEqual(
      new Set([132, 133, 134])
    );
    for (const audit of document.audits) {
      expect(Object.keys(audit.retrieval).sort()).toEqual(["A", "B", "C", "D", "E"]);
      expect(Object.values(audit.retrieval).every((pool) => pool.completed)).toBe(true);
      expect(audit.nearestMatches.some((match) => match.pool === "E")).toBe(true);
    }
  });

});

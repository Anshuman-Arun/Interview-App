import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_PATH = path.join(ROOT, "docs", "oxford-audits", "current-bank-baseline.json");
const SAME_WAVE_PATH = path.join(ROOT, "docs", "oxford-audits", "same-wave-high-risk-batch.json");
const FULL_CERT_PATH = path.join(ROOT, "docs", "oxford-audits", "same-wave-full-certification.json");

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

      expect(["PASS", "PASS_WITH_NOTES"]).toContain((audit as any).originalityDecision);
      expect(["PASS", "PASS_WITH_NOTES"]).toContain((audit as any).fidelityDecision);
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
        originalityDecision: "PASS" | "PASS_WITH_NOTES" | "REVISE" | "REJECT_TOO_CLOSE";
        fidelityDecision: "PASS" | "PASS_WITH_NOTES" | "REVISE" | "REJECT_NOT_OXFORD_LIKE";
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

  it("certifies every surviving C/D/E family at the reviewed author heads", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT, "scripts", "validate-oxford-audits.mjs"), FULL_CERT_PATH],
      { cwd: ROOT, encoding: "utf8" }
    );

    expect(output).toContain("Oxford audit validation passed (same-wave-full-certification.json)");

    const document = JSON.parse(readFileSync(FULL_CERT_PATH, "utf8")) as {
      summary: {
        totalFamilies: number;
        survivingTotal: number;
        replacementCount: number;
        authorPrs: Array<{ number: number; head: string; surviving: number }>;
      };
      audits: Array<{
        familyId: string;
        authorPr: { number: number; head: string };
        retrieval: Record<string, { completed: boolean }>;
        externalSearchQueries: string[];
        nearestMatches: Array<{ pool: string }>;
      }>;
    };

    expect(document.summary.totalFamilies).toBe(41);
    expect(document.summary.survivingTotal).toBe(41);
    expect(document.summary.replacementCount).toBe(0);
    expect(document.audits).toHaveLength(41);
    expect(new Set(document.audits.map((audit) => audit.familyId)).size).toBe(41);

    const expected = new Map<number, { head: string; surviving: number }>([
      [132, { head: "8b22dc5df99111fb95e27a2c006d5e74544dd385", surviving: 17 }],
      [133, { head: "65d570a1f6dad3773edb7eea4568d9399f3164c8", surviving: 11 }],
      [134, { head: "1ce96b5b89be971399cab5080d4487a908ea294d", surviving: 13 }]
    ]);

    for (const [pr, expectedState] of expected) {
      const summary = document.summary.authorPrs.find((entry) => entry.number === pr);
      expect(summary).toEqual(expect.objectContaining(expectedState));
      const audits = document.audits.filter((audit) => audit.authorPr.number === pr);
      expect(audits).toHaveLength(expectedState.surviving);
      expect(new Set(audits.map((audit) => audit.authorPr.head))).toEqual(
        new Set([expectedState.head])
      );
    }

    for (const audit of document.audits) {
      expect(Object.keys(audit.retrieval).sort()).toEqual(["A", "B", "C", "D", "E"]);
      expect(Object.values(audit.retrieval).every((pool) => pool.completed)).toBe(true);
      expect(audit.externalSearchQueries.length).toBeGreaterThan(0);
      expect(audit.nearestMatches.some((match) => match.pool === "E")).toBe(true);
      expect(["PASS", "PASS_WITH_NOTES"]).toContain(audit.originalityDecision);
      expect(["PASS", "PASS_WITH_NOTES"]).toContain(audit.fidelityDecision);
    }
  });

});

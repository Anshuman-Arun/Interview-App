import process from "node:process";
import { performance } from "node:perf_hooks";
import {
  newSessionId,
  type ProviderSelectionReference
} from "../../../packages/domain/src/index.js";
import {
  SessionRuntimeRegistry,
  TurnCoordinator
} from "../../../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../../../packages/persistence/src/index.js";
import { getProblemById } from "../../../packages/problems/src/index.js";
import {
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_PROVIDER_ID
} from "../../../packages/providers/src/index.js";
import { ProviderBackedFormalInterpretationProvider } from "./formal-interpretation-provider.js";
import { ProviderRuntimeResolver } from "./provider-runtime.js";
import { SessionRecoveryCoordinator } from "./session-recovery-coordinator.js";
import { StudentReasoningAnalysisCoordinator } from "./student-reasoning-analysis-coordinator.js";

const selection: ProviderSelectionReference = {
  providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
  modelId: ANTIGRAVITY_CLI_MODEL_ID
};

const corpus = Object.freeze([
  {
    problemId: "oxford-domino-chessboard",
    text: "There are 64 squares, so 64 divided by 2 equals 32."
  },
  {
    problemId: "oxford-euclid-primes",
    text: "Two divides four."
  },
  {
    problemId: "oxford-prefix-sums-mod-n",
    text: "Three divides six."
  },
  {
    problemId: "oxford-triangle-medians",
    text: "Two thirds equals 2 divided by 3."
  },
  {
    problemId: "oxford-divisibility-chain",
    text: "Three divides twelve."
  },
  {
    problemId: "oxford-domino-chessboard",
    text: "Maybe induction would work here."
  }
]);

if (process.platform !== "win32") {
  throw new Error("The real Antigravity formal-interpretation smoke requires Windows");
}
if (process.env["INTERVIEW_ALLOW_METERED_REMOTE_REASONING"] !== "1") {
  throw new Error(
    "Set INTERVIEW_ALLOW_METERED_REMOTE_REASONING=1 only after intentionally authorizing the selected Antigravity account's billing/data-use policy"
  );
}

const runtime = new ProviderRuntimeResolver();

// Warm the exact selected runtime with the same zero-inference readiness
// checks used by product launch. Performance numbers below should measure the
// interpretation request itself, not first-use executable hashing/profile
// verification.
const launch = await runtime.evaluateLaunchOption(selection);
if (launch.availability !== "AVAILABLE") {
  throw new Error(
    "Selected Antigravity runtime is not ready for formal interpretation: "
      + (launch.reason ?? "UNKNOWN")
  );
}

const latencies: number[] = [];
let abstained = 0;
let malformed = 0;
let deterministicAccepted = 0;
const results: Array<Record<string, unknown>> = [];

try {
  for (const sample of corpus) {
    const selectedProblem = getProblemById(sample.problemId);
    if (selectedProblem === undefined) {
      throw new Error("Missing smoke problem " + sample.problemId);
    }

    const store = new SqliteEventStore(":memory:");
    const registry = new SessionRuntimeRegistry(store);
    try {
      const sessionId = newSessionId();
      const writer = registry.get(sessionId);
      const turns = new TurnCoordinator(writer);
      await turns.startConfiguredSession({
        configuration: {
          configurationVersion: 1,
          mode: "OXFORD_MATHEMATICS",
          problem: {
            id: selectedProblem.id,
            version: selectedProblem.version
          },
          difficulty: selectedProblem.interviewer.difficulty,
          interventionPolicy: "BALANCED",
          providerSelection: selection
        },
        problem: selectedProblem
      });
      const committed = await turns.commitInput(sample.text);
      const sessions = new SessionRecoveryCoordinator(registry, store);
      const analysis = new StudentReasoningAnalysisCoordinator(
        sessions,
        new ProviderBackedFormalInterpretationProvider(sessions, runtime)
      );

      const startedAt = performance.now();
      const outcome = await analysis.analyze({
        sessionId,
        turnId: committed.turnId,
        inputEpisodeId: committed.inputEpisodeId
      });
      const latencyMs = performance.now() - startedAt;
      latencies.push(latencyMs);

      let interpretationStatus = "SKIPPED";
      let verificationStatus: string | undefined;
      if (outcome.status === "ANALYZED") {
        interpretationStatus = outcome.interpretation.status;
        if (outcome.interpretation.status === "NO_SUPPORTED_INTERPRETATION") {
          abstained += 1;
        }
        if (outcome.interpretation.status === "INVALID_PROVIDER_OUTPUT") {
          malformed += 1;
        }
        if (outcome.interpretation.status === "ACCEPTED") {
          deterministicAccepted += 1;
          verificationStatus = outcome.interpretation.verificationStatus;
        }
      }

      results.push({
        problemId: sample.problemId,
        text: sample.text,
        latencyMs: Math.round(latencyMs),
        analysisStatus: outcome.status,
        interpretationStatus,
        ...(verificationStatus === undefined ? {} : { verificationStatus })
      });
    } finally {
      await registry.closeAll();
      store.close();
    }
  }
} finally {
  await runtime.drain();
}

const sorted = [...latencies].sort((left, right) => left - right);
const midpoint = Math.floor(sorted.length / 2);
const median = sorted.length % 2 === 0
  ? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
  : (sorted[midpoint] ?? 0);

console.log(JSON.stringify({
  provider: selection,
  sampleCount: corpus.length,
  medianInterpretationLatencyMs: Math.round(median),
  approximateWorstCaseLatencyMs: Math.round(Math.max(...latencies)),
  abstentionRate: abstained / corpus.length,
  malformedResultRate: malformed / corpus.length,
  deterministicVerificationAcceptanceRate:
    deterministicAccepted / corpus.length,
  results
}, null, 2));

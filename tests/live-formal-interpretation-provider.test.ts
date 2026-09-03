import { describe, expect, it } from "vitest";
import {
  evidenceKeyToString,
  newSessionId,
  type FormalInterpretationRequest,
  type ProviderSelectionReference
} from "../packages/domain/src/index.js";
import {
  SessionRuntimeRegistry,
  TurnCoordinator
} from "../packages/interview-engine/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { getProblemById } from "../packages/problems/src/index.js";
import {
  ANTIGRAVITY_CLI_FORMAL_INTERPRETER_AGENT_ID,
  ANTIGRAVITY_CLI_MODEL_ID,
  ANTIGRAVITY_CLI_PROVIDER_ID,
  type SupervisedCliExecutionRequest,
  type SupervisedCliExecutionResult
} from "../packages/providers/src/index.js";
import {
  ProviderBackedFormalInterpretationProvider,
  ProviderRuntimeResolver,
  SessionRecoveryCoordinator
} from "../apps/server/src/index.js";
import {
  StudentReasoningAnalysisCoordinator
} from "../apps/server/src/student-reasoning-analysis-coordinator.js";
import {
  resolveOxfordFormalAnalysisProfile
} from "../apps/server/src/oxford-formal-analysis-catalog.js";

const ANTIGRAVITY_SELECTION: ProviderSelectionReference = {
  providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
  modelId: ANTIGRAVITY_CLI_MODEL_ID
};

function problem(problemId = "oxford-domino-chessboard") {
  const value = getProblemById(problemId);
  if (value === undefined) throw new Error("Missing test problem " + problemId);
  return value;
}

function remoteAllowedPolicy() {
  return {
    allowMeteredUsage: true,
    maximumDataUse: "REMOTE_MAY_BE_USED_FOR_IMPROVEMENT" as const,
    billingVerificationMaxAgeMs: 60_000
  };
}

function executionResult(stdout: string): SupervisedCliExecutionResult {
  return {
    exitCode: 0,
    stdout,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: 0
  };
}

function formalContext(execution: SupervisedCliExecutionRequest) {
  const envelope = JSON.parse(execution.stdin.trim()) as {
    readonly message?: { readonly content?: unknown };
  };
  const content = envelope.message?.content;
  if (typeof content !== "string") throw new Error("Missing formal prompt");
  const marker = "APPLICATION_OWNED_FORMAL_INTERPRETATION_CONTEXT_JSON\n";
  const index = content.indexOf(marker);
  if (index < 0) throw new Error("Missing formal context marker");
  return JSON.parse(content.slice(index + marker.length)) as {
    readonly requestIdentity: {
      readonly requestId: string;
    };
    readonly source: FormalInterpretationRequest["source"];
    readonly target: FormalInterpretationRequest["target"];
    readonly allowedProtocols: FormalInterpretationRequest["allowedProtocols"];
    readonly exactCandidateSourceToEcho: unknown;
  };
}

function formalStream(
  execution: SupervisedCliExecutionRequest,
  mode: "CORRECT" | "FALSE" | "ABSTAIN" | "UNRELATED_TRUE"
): string {
  const schemaIndex = execution.args.indexOf("--json-schema");
  const schemaRaw = schemaIndex < 0 ? undefined : execution.args[schemaIndex + 1];
  if (schemaRaw === undefined) throw new Error("Missing schema argument");
  const schema = JSON.parse(schemaRaw) as unknown;
  const context = formalContext(execution);
  const protocol = context.allowedProtocols[0];
  if (protocol === undefined) throw new Error("Expected allowed protocol");

  const result = {
    protocolVersion: 1,
    requestId: context.requestIdentity.requestId,
    candidates: mode === "ABSTAIN"
      ? []
      : [{
          protocolVersion: 1,
          candidateId: "candidate-1",
          protocol,
          formalStatement: JSON.stringify({
            protocol: "INTERVIEW_APP_RATIONAL_ARITHMETIC_CLAIM",
            protocolVersion: 1,
            claim: mode === "UNRELATED_TRUE"
              ? {
                  kind: "EQUALITY",
                  left: {
                    kind: "RATIONAL",
                    value: { numerator: "2", denominator: "1" }
                  },
                  right: {
                    kind: "RATIONAL",
                    value: { numerator: "2", denominator: "1" }
                  }
                }
              : {
                  kind: "EQUALITY",
                  left: {
                    kind: "SUBTRACT",
                    left: {
                      kind: "RATIONAL",
                      value: { numerator: "32", denominator: "1" }
                    },
                    right: {
                      kind: "RATIONAL",
                      value: { numerator: "2", denominator: "1" }
                    }
                  },
                  right: {
                    kind: "RATIONAL",
                    value: {
                      numerator: mode === "CORRECT" ? "30" : "31",
                      denominator: "1"
                    }
                  }
                }
          }),
          confidence: 1,
          target: context.target,
          source: context.exactCandidateSourceToEcho
        }]
  };

  return [
    JSON.stringify({
      event: "init",
      conversation_id: "formal-live-test",
      init: {
        tools: [],
        permission_mode: "strict",
        model: ANTIGRAVITY_CLI_MODEL_ID,
        agent: ANTIGRAVITY_CLI_FORMAL_INTERPRETER_AGENT_ID,
        json_schema: schema
      }
    }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "formal-live-test",
        status: "SUCCESS",
        response: JSON.stringify(result),
        num_turns: 1,
        structured_output: result,
        json_schema: schema
      }
    })
  ].join("\n") + "\n";
}

async function configuredHarness(
  selection: ProviderSelectionReference = ANTIGRAVITY_SELECTION,
  studentText = "Thirty-two minus two equals thirty."
) {
  const store = new SqliteEventStore(":memory:");
  const registry = new SessionRuntimeRegistry(store);
  const sessionId = newSessionId();
  const writer = registry.get(sessionId);
  const turns = new TurnCoordinator(writer);
  const selectedProblem = problem();

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
  const committed = await turns.commitInput(studentText);
  const sessions = new SessionRecoveryCoordinator(registry, store);
  return {
    store,
    registry,
    sessionId,
    writer,
    turns,
    committed,
    sessions,
    selectedProblem
  };
}

describe("production formal interpretation provider", () => {
  it("uses the configured Antigravity runtime and lets only deterministic verification commit correctness", async () => {
    const harness = await configuredHarness();
    let executeCalls = 0;
    let observedPrompt = "";
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        resolveRuntime(selection) {
          if (
            selection.providerId !== ANTIGRAVITY_SELECTION.providerId
            || selection.modelId !== ANTIGRAVITY_SELECTION.modelId
          ) return undefined;
          return {
            executor: {
              async execute(execution: SupervisedCliExecutionRequest) {
                executeCalls += 1;
                observedPrompt = execution.stdin;
                execution.onProcessStart();
                return executionResult(formalStream(execution, "CORRECT"));
              }
            }
          };
        }
      },
      policySource: {
        resolvePolicy: remoteAllowedPolicy
      }
    });

    try {
      const provider = new ProviderBackedFormalInterpretationProvider(
        harness.sessions,
        resolver
      );
      const analysis = new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        provider
      );
      const outcome = await analysis.analyze({
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      });

      expect(outcome.status).toBe("ANALYZED");
      if (outcome.status !== "ANALYZED") throw new Error("Expected analysis");
      expect(outcome.interpretation).toMatchObject({
        status: "ACCEPTED",
        verificationStatus: "VERIFIED",
        evidenceCommitted: true
      });
      expect(executeCalls).toBe(1);
      expect(observedPrompt).toContain(harness.selectedProblem.public.prompt);
      expect(observedPrompt).toContain(harness.committed.turnId);
      expect(observedPrompt).not.toContain("canonicalSolution");
      expect(observedPrompt).not.toContain("disclosureBudget");
      expect(harness.writer.getState().generations).toEqual({});
      expect(harness.writer.getState().deliveries).toEqual({});

      const profile = resolveOxfordFormalAnalysisProfile(harness.selectedProblem);
      if (profile === undefined) throw new Error("Expected formal profile");
      expect(
        harness.writer.getState().studentEvidence[evidenceKeyToString(profile.target)]
      ).toMatchObject({
        value: "CORRECT",
        inferenceConfidence: 1
      });
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });

  it("preserves a false model-interpreted claim as deterministic contradiction, not correctness evidence", async () => {
    const harness = await configuredHarness(
      ANTIGRAVITY_SELECTION,
      "Thirty-two minus two equals thirty-one."
    );
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        resolveRuntime() {
          return {
            executor: {
              async execute(execution: SupervisedCliExecutionRequest) {
                execution.onProcessStart();
                return executionResult(formalStream(execution, "FALSE"));
              }
            }
          };
        }
      },
      policySource: {
        resolvePolicy: remoteAllowedPolicy
      }
    });

    try {
      const outcome = await new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        new ProviderBackedFormalInterpretationProvider(harness.sessions, resolver)
      ).analyze({
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      });

      expect(outcome.status).toBe("ANALYZED");
      if (outcome.status !== "ANALYZED") throw new Error("Expected analysis");
      expect(outcome.interpretation).toMatchObject({
        status: "ACCEPTED",
        verificationStatus: "CONTRADICTED",
        evidenceCommitted: false
      });
      const profile = resolveOxfordFormalAnalysisProfile(harness.selectedProblem);
      if (profile === undefined) throw new Error("Expected formal profile");
      expect(
        harness.writer.getState().studentEvidence[evidenceKeyToString(profile.target)]
      ).toBeUndefined();
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });

  it("allows strategy statements to abstain with no verifier work", async () => {
    const harness = await configuredHarness(
      ANTIGRAVITY_SELECTION,
      "Maybe the checkerboard coloring is useful, but I am not sure what arithmetic follows."
    );
    let executeCalls = 0;
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        resolveRuntime() {
          return {
            executor: {
              async execute(execution: SupervisedCliExecutionRequest) {
                executeCalls += 1;
                execution.onProcessStart();
                return executionResult(formalStream(execution, "ABSTAIN"));
              }
            }
          };
        }
      },
      policySource: {
        resolvePolicy: remoteAllowedPolicy
      }
    });

    try {
      const outcome = await new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        new ProviderBackedFormalInterpretationProvider(harness.sessions, resolver)
      ).analyze({
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      });
      expect(outcome).toMatchObject({
        status: "ANALYZED",
        interpretation: {
          status: "NO_SUPPORTED_INTERPRETATION",
          reason: "NO_INTERPRETATION"
        }
      });
      expect(executeCalls).toBe(1);
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });

  it("skips target-irrelevant arithmetic before resolving any provider runtime", async () => {
    const harness = await configuredHarness(
      ANTIGRAVITY_SELECTION,
      "One half equals two fourths."
    );
    let runtimeCalls = 0;
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        resolveRuntime() {
          runtimeCalls += 1;
          throw new Error("irrelevant source must not reach provider resolution");
        }
      },
      policySource: {
        resolvePolicy: remoteAllowedPolicy
      }
    });

    try {
      const outcome = await new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        new ProviderBackedFormalInterpretationProvider(harness.sessions, resolver)
      ).analyze({
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      });

      expect(outcome).toEqual({
        status: "SKIPPED",
        reason: "SOURCE_NOT_RELEVANT"
      });
      expect(runtimeCalls).toBe(0);
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });

  it("rejects a grounded-source provider that substitutes an unrelated true arithmetic fact", async () => {
    const harness = await configuredHarness();
    let executeCalls = 0;
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        resolveRuntime() {
          return {
            executor: {
              async execute(execution: SupervisedCliExecutionRequest) {
                executeCalls += 1;
                execution.onProcessStart();
                return executionResult(formalStream(execution, "UNRELATED_TRUE"));
              }
            }
          };
        }
      },
      policySource: {
        resolvePolicy: remoteAllowedPolicy
      }
    });

    try {
      const outcome = await new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        new ProviderBackedFormalInterpretationProvider(harness.sessions, resolver)
      ).analyze({
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      });

      expect(outcome).toMatchObject({
        status: "ANALYZED",
        interpretation: {
          status: "NO_SUPPORTED_INTERPRETATION"
        }
      });
      expect(executeCalls).toBe(1);
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
      const profile = resolveOxfordFormalAnalysisProfile(harness.selectedProblem);
      if (profile === undefined) throw new Error("Expected formal profile");
      expect(
        harness.writer.getState().studentEvidence[evidenceKeyToString(profile.target)]
      ).toBeUndefined();
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });

  it("never switches to a different provider when the configured provider lacks this adapter", async () => {
    const harness = await configuredHarness({
      providerId: "mock-model",
      modelId: "mock-default"
    });
    let runtimeCalls = 0;
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        resolveRuntime() {
          runtimeCalls += 1;
          throw new Error("unsupported provider must not resolve a formal runtime");
        }
      }
    });

    try {
      const outcome = await new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        new ProviderBackedFormalInterpretationProvider(harness.sessions, resolver)
      ).analyze({
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      });
      expect(outcome).toMatchObject({
        status: "ANALYZED",
        interpretation: {
          status: "NO_SUPPORTED_INTERPRETATION"
        }
      });
      expect(runtimeCalls).toBe(0);
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });

  it("performs no formal inference when billing/data-use policy denies the selected provider", async () => {
    const harness = await configuredHarness();
    let executeCalls = 0;
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        resolveRuntime() {
          return {
            executor: {
              async execute() {
                executeCalls += 1;
                throw new Error("denied provider must not execute");
              }
            }
          };
        }
      },
      policySource: {
        resolvePolicy() {
          return {
            allowMeteredUsage: false,
            maximumDataUse: "LOCAL_ONLY" as const,
            billingVerificationMaxAgeMs: 60_000
          };
        }
      }
    });

    try {
      const outcome = await new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        new ProviderBackedFormalInterpretationProvider(harness.sessions, resolver)
      ).analyze({
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      });
      expect(outcome).toMatchObject({
        status: "ANALYZED",
        interpretation: {
          status: "NO_SUPPORTED_INTERPRETATION"
        }
      });
      expect(executeCalls).toBe(0);
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });

  it("physically aborts provider interpretation when the bounded analysis deadline expires", async () => {
    const harness = await configuredHarness();
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let observedAbort = false;
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        resolveRuntime() {
          return {
            executor: {
              async execute(execution: SupervisedCliExecutionRequest) {
                execution.onProcessStart();
                entered?.();
                return await new Promise<SupervisedCliExecutionResult>((_resolve, reject) => {
                  const abort = (): void => {
                    observedAbort = true;
                    reject(new Error("cancelled"));
                  };
                  if (execution.signal.aborted) abort();
                  else execution.signal.addEventListener("abort", abort, { once: true });
                });
              }
            }
          };
        }
      },
      policySource: {
        resolvePolicy: remoteAllowedPolicy
      }
    });

    try {
      const analysis = new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        new ProviderBackedFormalInterpretationProvider(harness.sessions, resolver),
        25
      );
      const completion = analysis.analyze({
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      });

      await started;
      await expect(completion).resolves.toEqual({
        status: "SKIPPED",
        reason: "TIME_LIMIT"
      });
      expect(observedAbort).toBe(true);
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });

  it("releases provider capacity when control-plane resolution ignores cancellation", async () => {
    const harness = await configuredHarness();
    let runtimeCalls = 0;
    let executeCalls = 0;
    const never = new Promise<never>(() => undefined);
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        async resolveRuntime() {
          runtimeCalls += 1;
          if (runtimeCalls <= 2) return await never;
          return {
            executor: {
              async execute(execution: SupervisedCliExecutionRequest) {
                executeCalls += 1;
                execution.onProcessStart();
                return executionResult(formalStream(execution, "CORRECT"));
              }
            }
          };
        }
      },
      policySource: {
        resolvePolicy: remoteAllowedPolicy
      }
    });

    try {
      const analysis = new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        new ProviderBackedFormalInterpretationProvider(harness.sessions, resolver),
        25
      );

      await expect(analysis.analyze({
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      })).resolves.toEqual({
        status: "SKIPPED",
        reason: "TIME_LIMIT"
      });

      const second = await harness.turns.commitInput(
        "Thirty-two minus two equals thirty."
      );
      await expect(analysis.analyze({
        sessionId: harness.sessionId,
        turnId: second.turnId,
        inputEpisodeId: second.inputEpisodeId
      })).resolves.toEqual({
        status: "SKIPPED",
        reason: "TIME_LIMIT"
      });

      const third = await harness.turns.commitInput(
        "Thirty-two minus two equals thirty."
      );
      const recovered = await analysis.analyze({
        sessionId: harness.sessionId,
        turnId: third.turnId,
        inputEpisodeId: third.inputEpisodeId
      });
      expect(recovered).toMatchObject({
        status: "ANALYZED",
        interpretation: {
          status: "ACCEPTED",
          verificationStatus: "VERIFIED",
          evidenceCommitted: true
        }
      });
      expect(runtimeCalls).toBe(3);
      expect(executeCalls).toBe(1);
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });

  it("does not send stale candidate text after runtime resolution completes", async () => {
    const harness = await configuredHarness();
    let releaseRuntime: (() => void) | undefined;
    const runtimeGate = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    let executeCalls = 0;
    let enteredRuntime: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredRuntime = resolve;
    });
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        async resolveRuntime() {
          enteredRuntime?.();
          await runtimeGate;
          return {
            executor: {
              async execute(execution: SupervisedCliExecutionRequest) {
                executeCalls += 1;
                execution.onProcessStart();
                return executionResult(formalStream(execution, "CORRECT"));
              }
            }
          };
        }
      },
      policySource: {
        resolvePolicy: remoteAllowedPolicy
      }
    });

    try {
      const analysis = new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        new ProviderBackedFormalInterpretationProvider(harness.sessions, resolver)
      );
      const pending = analysis.analyze({
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      });

      await entered;
      await harness.turns.commitInput("A newer committed candidate turn.");
      releaseRuntime?.();

      const outcome = await pending;
      expect(outcome).toMatchObject({
        status: "ANALYZED",
        interpretation: {
          status: "STALE"
        }
      });
      expect(executeCalls).toBe(0);
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(0);
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });

  it("reuses the deterministic interpretation request identity instead of invoking the provider twice", async () => {
    const harness = await configuredHarness();
    let executeCalls = 0;
    const resolver = new ProviderRuntimeResolver({
      adapterRuntimeSource: {
        resolveRuntime() {
          return {
            executor: {
              async execute(execution: SupervisedCliExecutionRequest) {
                executeCalls += 1;
                execution.onProcessStart();
                return executionResult(formalStream(execution, "CORRECT"));
              }
            }
          };
        }
      },
      policySource: {
        resolvePolicy: remoteAllowedPolicy
      }
    });

    try {
      const analysis = new StudentReasoningAnalysisCoordinator(
        harness.sessions,
        new ProviderBackedFormalInterpretationProvider(harness.sessions, resolver)
      );
      const input = {
        sessionId: harness.sessionId,
        turnId: harness.committed.turnId,
        inputEpisodeId: harness.committed.inputEpisodeId
      };
      const first = await analysis.analyze(input);
      const second = await analysis.analyze(input);

      expect(first).toEqual(second);
      expect(executeCalls).toBe(1);
      expect(Object.values(harness.writer.getState().verificationRequests)).toHaveLength(1);
    } finally {
      await harness.registry.closeAll();
      harness.store.close();
    }
  });
});

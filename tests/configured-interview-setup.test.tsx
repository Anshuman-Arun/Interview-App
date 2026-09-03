// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InterviewSessionConfigurationSchema,
  type InterviewCatalogEntry,
  type InterviewSessionConfiguration,
  type ProviderLaunchOption
} from "../packages/domain/src/index.js";
import { NewInterviewPage } from "../apps/web/src/pages/NewInterviewPage.js";

const CATALOG: readonly InterviewCatalogEntry[] = [
  {
    mode: "OXFORD_MATHEMATICS",
    id: "six-people",
    version: "1.0.0",
    title: "Six People",
    category: "Combinatorics",
    difficulty: "STANDARD"
  },
  {
    mode: "OXFORD_MATHEMATICS",
    id: "oxford-divisibility-chain",
    version: "1.0.0",
    title: "A Divisibility Pair in {1,...,2n}",
    category: "Number Theory",
    difficulty: "STANDARD"
  },
  {
    mode: "QUANT_TRADING",
    id: "BASIC_MARKET_MAKING",
    version: "1.0.0",
    title: "Basic Market Making"
  },
  {
    mode: "QUANT_RESEARCH",
    id: "MODEL_COMPARISON",
    version: "1.0.0",
    title: "Model Comparison"
  }
];

const PROVIDERS: readonly ProviderLaunchOption[] = [
  {
    providerId: "mock-model",
    providerDisplayName: "Mock",
    providerKind: "MOCK",
    modelId: "mock-default",
    modelDisplayName: "Default",
    availability: "AVAILABLE"
  },
  {
    providerId: "gemini-api",
    providerDisplayName: "Gemini API",
    providerKind: "REMOTE_API",
    modelId: "gemini-2.5-flash",
    modelDisplayName: "Gemini 2.5 Flash",
    availability: "UNAVAILABLE",
    reason: "POLICY_DENIED"
  }
];

function setSelect(testId: string, value: string): void {
  const element = document.querySelector(
    `[data-testid="${testId}"]`
  );
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`Expected select ${testId}`);
  }
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setInput(testId: string, value: string): void {
  const element = document.querySelector(
    `[data-testid="${testId}"]`
  );
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Expected input ${testId}`);
  }
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("configured interview setup product flow", () => {
  let root: Root | undefined;
  const originalAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    if (root !== undefined) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    document.body.innerHTML = "";
    if (originalAct === undefined) {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    } else {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalAct);
    }
    vi.restoreAllMocks();
  });

  it("builds an exact configured Oxford launch from server-owned metadata", async () => {
    const started: InterviewSessionConfiguration[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <NewInterviewPage
          catalog={CATALOG}
          catalogLoading={false}
          catalogError={null}
          providerOptions={PROVIDERS}
          providerOptionsLoading={false}
          providerOptionsError={null}
          activeSessionId={null}
          startPending={false}
          onRefreshCatalog={async () => CATALOG}
          onRefreshProviderOptions={async () => PROVIDERS}
          onStart={async (configuration) => {
            started.push(configuration);
          }}
          onResumeActive={null}
        />
      );
    });

    expect(document.body.textContent).toContain("Oxford Mathematics");
    expect(document.body.textContent).toContain("Registered but unavailable");
    expect(document.body.textContent).not.toContain("API key");
    expect(document.body.textContent).not.toContain("reasoningGraph");

    await act(async () => {
      setSelect(
        "interview-target-select",
        "OXFORD_MATHEMATICS:oxford-divisibility-chain@1.0.0"
      );
      setSelect("provider-select", "mock-model:mock-default");
      setInput("duration-input", "30");
      setSelect("intervention-select", "STRICT");
    });

    const start = document.querySelector(
      '[data-testid="start-configured-session-btn"]'
    );
    if (!(start instanceof HTMLButtonElement)) {
      throw new Error("Expected configured Start button");
    }
    await act(async () => {
      start.click();
      await Promise.resolve();
    });

    expect(started).toHaveLength(1);
    expect(started[0]).toEqual(
      InterviewSessionConfigurationSchema.parse({
        configurationVersion: 1,
        mode: "OXFORD_MATHEMATICS",
        problem: {
          id: "oxford-divisibility-chain",
          version: "1.0.0"
        },
        durationMinutes: 30,
        interventionPolicy: "STRICT",
        providerSelection: {
          providerId: "mock-model",
          modelId: "mock-default"
        }
      })
    );
    expect(
      started[0]?.mode === "OXFORD_MATHEMATICS"
        ? started[0].difficulty
        : "not-oxford"
    ).toBeUndefined();
  });

  it("filters targets by mode and resets a stale target after catalog refresh", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const props = {
      catalogLoading: false,
      catalogError: null,
      providerOptions: PROVIDERS,
      providerOptionsLoading: false,
      providerOptionsError: null,
      activeSessionId: null,
      startPending: false,
      onRefreshCatalog: async () => CATALOG,
      onRefreshProviderOptions: async () => PROVIDERS,
      onStart: async (_configuration: InterviewSessionConfiguration) => undefined,
      onResumeActive: null
    } as const;

    await act(async () => {
      root?.render(<NewInterviewPage {...props} catalog={CATALOG} />);
    });
    await act(async () => {
      setSelect("interview-mode-select", "QUANT_TRADING");
    });

    const target = document.querySelector(
      '[data-testid="interview-target-select"]'
    );
    if (!(target instanceof HTMLSelectElement)) {
      throw new Error("Expected target select");
    }
    expect([...target.options].map((option) => option.textContent))
      .toEqual(["Basic Market Making"]);

    await act(async () => {
      setSelect("interview-mode-select", "OXFORD_MATHEMATICS");
      setSelect(
        "interview-target-select",
        "OXFORD_MATHEMATICS:oxford-divisibility-chain@1.0.0"
      );
    });

    const refreshed = CATALOG.filter(
      (entry) => entry.id !== "oxford-divisibility-chain"
    );
    await act(async () => {
      root?.render(<NewInterviewPage {...props} catalog={refreshed} />);
    });

    const refreshedTarget = document.querySelector(
      '[data-testid="interview-target-select"]'
    );
    if (!(refreshedTarget instanceof HTMLSelectElement)) {
      throw new Error("Expected refreshed target select");
    }
    expect(refreshedTarget.value).toBe(
      "OXFORD_MATHEMATICS:six-people@1.0.0"
    );
  });

  it("fails closed when launch metadata is unavailable or an active session exists", async () => {
    const onStart = vi.fn(async (_configuration: InterviewSessionConfiguration) => undefined);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <NewInterviewPage
          catalog={[]}
          catalogLoading={false}
          catalogError="Catalog unavailable"
          providerOptions={[]}
          providerOptionsLoading={false}
          providerOptionsError="Providers unavailable"
          activeSessionId={null}
          startPending={false}
          onRefreshCatalog={async () => []}
          onRefreshProviderOptions={async () => []}
          onStart={onStart}
          onResumeActive={null}
        />
      );
    });

    const unavailableStart = document.querySelector(
      '[data-testid="start-configured-session-btn"]'
    );
    expect(unavailableStart).toBeInstanceOf(HTMLButtonElement);
    expect((unavailableStart as HTMLButtonElement).disabled).toBe(true);
    expect(onStart).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(
        <NewInterviewPage
          catalog={CATALOG}
          catalogLoading={false}
          catalogError={null}
          providerOptions={PROVIDERS}
          providerOptionsLoading={false}
          providerOptionsError={null}
          activeSessionId={"session_00000000-0000-4000-8000-000000000777"}
          startPending={false}
          onRefreshCatalog={async () => CATALOG}
          onRefreshProviderOptions={async () => PROVIDERS}
          onStart={onStart}
          onResumeActive={() => undefined}
        />
      );
    });

    const activeStart = document.querySelector(
      '[data-testid="start-configured-session-btn"]'
    );
    expect((activeStart as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Starting a second authoritative session is disabled."
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  LOCAL_MODEL_ACTIVATION_ARG,
  isLocalModelActivationLaunch,
  relaunchArgsForLocalModelActivation,
  runtimeCapabilityNeedsActivationRetry,
  shouldUsePreparedRuntimeStartupBudget
} from "../apps/desktop/src/startup-policy.js";

describe("desktop startup policy", () => {
  it("uses the long prepared-runtime budget only for an explicit activation relaunch", () => {
    expect(shouldUsePreparedRuntimeStartupBudget({
      activationRequested: false,
      hasPreparedRuntimeViews: true
    })).toBe(false);
    expect(shouldUsePreparedRuntimeStartupBudget({
      activationRequested: true,
      hasPreparedRuntimeViews: false
    })).toBe(false);
    expect(shouldUsePreparedRuntimeStartupBudget({
      activationRequested: true,
      hasPreparedRuntimeViews: true
    })).toBe(true);
  });

  it("recognizes and normalizes the activation relaunch argument", () => {
    const argv = [
      "Interview App.exe",
      "--desktop-production",
      LOCAL_MODEL_ACTIVATION_ARG,
      LOCAL_MODEL_ACTIVATION_ARG
    ];
    expect(isLocalModelActivationLaunch(argv)).toBe(true);
    expect(relaunchArgsForLocalModelActivation(argv, false)).toEqual([
      "--desktop-production"
    ]);
    expect(relaunchArgsForLocalModelActivation(argv, true)).toEqual([
      "--desktop-production",
      LOCAL_MODEL_ACTIVATION_ARG
    ]);
  });

  it("retries activation only for worker lifecycle failures that can improve after restart", () => {
    for (const reasonCode of [
      "START_CANCELLED",
      "WORKER_START_FAILED",
      "WORKER_FAILED",
      "WORKER_STOPPED",
      "WORKER_RESTARTING",
      "VOICE_RUNTIME_INCOMPLETE"
    ]) {
      expect(runtimeCapabilityNeedsActivationRetry({
        state: "UNAVAILABLE",
        reasonCode
      })).toBe(true);
    }
    expect(runtimeCapabilityNeedsActivationRetry({
      state: "MISSING_ASSET",
      reasonCode: "VISION_ASSET_MISSING"
    })).toBe(false);
    expect(runtimeCapabilityNeedsActivationRetry({ state: "READY" })).toBe(false);
    expect(runtimeCapabilityNeedsActivationRetry(undefined)).toBe(false);
  });
});

// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudentInputArea } from "../apps/web/src/components/StudentInputArea.js";

const ACT_ENVIRONMENT_KEY = "IS_REACT_ACT_ENVIRONMENT";
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error)
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("StudentInputArea adversarial submission serialization", () => {
  beforeEach(() => {
    Reflect.set(globalThis, ACT_ENVIRONMENT_KEY, true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    if (root !== undefined) {
      await act(async () => root?.unmount());
    }
    root = undefined;
    host?.remove();
    host = undefined;
    vi.restoreAllMocks();
  });

  it("admits only one submit across same-tick click and keyboard activation", async () => {
    const pending = deferred();
    const onSubmit = vi.fn(() => pending.promise);

    await act(async () => {
      root?.render(<StudentInputArea onSubmit={onSubmit} />);
    });

    const textarea = document.querySelector(
      "[data-testid='reasoning-textarea']"
    );
    const button = document.querySelector(
      "[data-testid='submit-reasoning-btn']"
    );
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("reasoning textarea did not mount");
    }
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("submit button did not mount");
    }

    await act(async () => {
      setTextareaValue(textarea, "  one authoritative step  ");
    });

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "Enter"
      }));
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("one authoritative step");
    expect(textarea.disabled).toBe(true);
    expect(button.disabled).toBe(true);

    pending.resolve();
    await act(async () => {
      await pending.promise;
    });

    expect(textarea.disabled).toBe(false);
  });

  it("restores the failed draft without permitting duplicate in-flight submits", async () => {
    const pending = deferred();
    const onSubmit = vi.fn(() => pending.promise);

    await act(async () => {
      root?.render(<StudentInputArea onSubmit={onSubmit} />);
    });

    const textarea = document.querySelector(
      "[data-testid='reasoning-textarea']"
    );
    const button = document.querySelector(
      "[data-testid='submit-reasoning-btn']"
    );
    if (!(textarea instanceof HTMLTextAreaElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error("reasoning composer did not mount");
    }

    await act(async () => {
      setTextareaValue(textarea, "retry me");
    });
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    pending.reject(new Error("transport failed"));
    await act(async () => {
      await pending.promise.catch(() => undefined);
    });

    expect(textarea.value).toBe("retry me");
    expect(textarea.disabled).toBe(false);
  });
});

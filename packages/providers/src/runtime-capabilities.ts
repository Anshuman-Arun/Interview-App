import {
  type ModelCapabilities
} from "../../domain/src/index.js";

const REFLECT_APPLY_INTRINSIC = Reflect.apply;
const SET_CONSTRUCTOR_INTRINSIC = Set;

/* eslint-disable @typescript-eslint/unbound-method -- Captured Set methods are invoked only via Reflect.apply. */
const SET_HAS_INTRINSIC = Set.prototype.has;
const SET_ADD_INTRINSIC = Set.prototype.add;
/* eslint-enable @typescript-eslint/unbound-method */

type InputModality = "text" | "image";

function setHas<T>(set: ReadonlySet<T>, value: T): boolean {
  const result: unknown = REFLECT_APPLY_INTRINSIC(SET_HAS_INTRINSIC, set, [value]);
  return result === true;
}

function setAdd<T>(set: Set<T>, value: T): void {
  REFLECT_APPLY_INTRINSIC(SET_ADD_INTRINSIC, set, [value]);
}

function copyInputModalities(
  hasText: boolean,
  hasImage: boolean
): Set<InputModality> {
  const copy = new SET_CONSTRUCTOR_INTRINSIC<InputModality>();
  if (hasText) setAdd(copy, "text");
  if (hasImage) setAdd(copy, "image");
  return copy;
}

function copyReasoningLevels(
  values: readonly string[]
): string[] {
  const copy: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined) copy.push(value);
  }
  return copy;
}

/**
 * Creates an application-owned capability value after schema validation.
 *
 * JavaScript native Sets cannot be made deeply immutable: Object.freeze(set)
 * still permits Set.prototype.add.call(set, value). Instead, collection-valued
 * properties return defensive copies while all scalar capability fields and
 * the outer object are frozen. Mutating a retrieved collection therefore
 * cannot change the capability value observed by later policy/execution code.
 */
export function snapshotValidatedModelCapabilities(
  capabilities: ModelCapabilities
): ModelCapabilities {
  const hasText = setHas(capabilities.inputModalities, "text");
  const hasImage = setHas(capabilities.inputModalities, "image");
  const reasoningLevels = capabilities.reasoningLevels === undefined
    ? undefined
    : Object.freeze(copyReasoningLevels(capabilities.reasoningLevels));

  const snapshot: ModelCapabilities = {
    get inputModalities() {
      return copyInputModalities(hasText, hasImage);
    },
    textStreaming: capabilities.textStreaming,
    structuredOutput: capabilities.structuredOutput,
    persistentSession: capabilities.persistentSession,
    resumableSession: capabilities.resumableSession,
    cancellation: capabilities.cancellation,
    sessionSurvivesClientAbort: capabilities.sessionSurvivesClientAbort,
    sessionSurvivesProviderCancel: capabilities.sessionSurvivesProviderCancel,
    usageReporting: capabilities.usageReporting,
    ...(reasoningLevels === undefined
      ? {}
      : {
          get reasoningLevels() {
            return [...reasoningLevels];
          }
        }),
    dataUse: capabilities.dataUse
  };
  return Object.freeze(snapshot);
}

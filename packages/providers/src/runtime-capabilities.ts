import {
  type ModelCapabilities
} from "../../domain/src/index.js";

const REFLECT_APPLY_INTRINSIC = Reflect.apply;

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

function immutableSetMutation(): never {
  throw new TypeError("Provider capability sets are immutable");
}

function readonlyInputModalities(
  source: ReadonlySet<InputModality>
): Set<InputModality> {
  const target = new Set<InputModality>();
  if (setHas(source, "text")) setAdd(target, "text");
  if (setHas(source, "image")) setAdd(target, "image");

  let proxy: Set<InputModality>;
  proxy = new Proxy(target, {
    get(set, key) {
      if (key === "add" || key === "delete" || key === "clear") {
        return immutableSetMutation;
      }
      if (key === "size") return set.size;
      if (key === "has") {
        return (value: InputModality): boolean => setHas(set, value);
      }
      if (key === "forEach") {
        return (
          callback: (
            value: InputModality,
            key: InputModality,
            owner: Set<InputModality>
          ) => void,
          thisArg?: unknown
        ): void => {
          for (const value of set) {
            REFLECT_APPLY_INTRINSIC(callback, thisArg, [value, value, proxy]);
          }
        };
      }
      if (key === Symbol.iterator || key === "values" || key === "keys") {
        return (): SetIterator<InputModality> => set.values();
      }
      if (key === "entries") {
        return (): SetIterator<[InputModality, InputModality]> => set.entries();
      }
      return Reflect.get(set, key, set) as unknown;
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
    setPrototypeOf() {
      return false;
    }
  });

  return Object.freeze(proxy);
}

function frozenReasoningLevels(
  values: readonly string[] | undefined
): string[] | undefined {
  if (values === undefined) return undefined;
  const copy: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined) copy.push(value);
  }
  return Object.freeze(copy) as string[];
}

/**
 * Creates an application-owned capability value whose mutable collection
 * members cannot be changed after provider admission. Call only after schema
 * validation has established the ModelCapabilities shape.
 */
export function snapshotValidatedModelCapabilities(
  capabilities: ModelCapabilities
): ModelCapabilities {
  const reasoningLevels = frozenReasoningLevels(capabilities.reasoningLevels);
  return Object.freeze({
    inputModalities: readonlyInputModalities(capabilities.inputModalities),
    textStreaming: capabilities.textStreaming,
    structuredOutput: capabilities.structuredOutput,
    persistentSession: capabilities.persistentSession,
    resumableSession: capabilities.resumableSession,
    cancellation: capabilities.cancellation,
    sessionSurvivesClientAbort: capabilities.sessionSurvivesClientAbort,
    sessionSurvivesProviderCancel: capabilities.sessionSurvivesProviderCancel,
    usageReporting: capabilities.usageReporting,
    ...(reasoningLevels === undefined ? {} : { reasoningLevels }),
    dataUse: capabilities.dataUse
  });
}

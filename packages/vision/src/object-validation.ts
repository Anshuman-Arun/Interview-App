import { isProxy } from "node:util/types";

const MAX_SNAPSHOTTED_OBJECT_FIELDS = 64;

export function snapshotOwnEnumerableRecord(
  value: unknown,
  label: string,
  allowedFields?: ReadonlySet<string>
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }

  if (isProxy(value)) {
    throw new TypeError(`${label} must not be a Proxy object`);
  }

  if (Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    throw new TypeError(`${label} could not be inspected safely`);
  }
  if (keys.length > MAX_SNAPSHOTTED_OBJECT_FIELDS) {
    throw new RangeError(
      `${label} contains too many own enumerable fields for bounded validation`
    );
  }
  if (allowedFields !== undefined) {
    let maximumAllowedFieldLength = 0;
    for (const allowedField of allowedFields) {
      maximumAllowedFieldLength = Math.max(maximumAllowedFieldLength, allowedField.length);
    }
    for (const key of keys) {
      if (key.length > maximumAllowedFieldLength || !allowedFields.has(key)) {
        throw new RangeError(`${label} contains an unknown field`);
      }
    }
  }

  const snapshot: Record<string, unknown> = { __proto__: null };
  for (const key of keys) {
    let isOwn: boolean;
    try {
      isOwn = Object.prototype.hasOwnProperty.call(value, key);
    } catch {
      throw new TypeError(`${label} changed while being snapshotted`);
    }
    if (!isOwn) {
      throw new TypeError(`${label} changed while being snapshotted`);
    }

    let entryValue: unknown;
    try {
      entryValue = Reflect.get(value, key);
    } catch {
      throw new TypeError(`${label} contains a field that could not be read safely`);
    }
    snapshot[key] = entryValue;
  }
  return Object.freeze(snapshot);
}


export function snapshotOwnEnumerableRecordForSchema(
  value: unknown,
  label: string,
  allowedFields: ReadonlySet<string>
): Readonly<Record<string, unknown>> | undefined {
  try {
    return snapshotOwnEnumerableRecord(value, label, allowedFields);
  } catch {
    return undefined;
  }
}

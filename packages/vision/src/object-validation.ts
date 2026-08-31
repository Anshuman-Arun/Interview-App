export function snapshotOwnEnumerableRecord(
  value: unknown,
  label: string
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new TypeError(`${label} could not be inspected safely`);
  }
  if (isArray) throw new TypeError(`${label} must be an object`);

  let entries: [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch {
    throw new TypeError(`${label} could not be read safely`);
  }

  const snapshot: Record<string, unknown> = {};
  Object.setPrototypeOf(snapshot, null);
  for (const [key, entryValue] of entries) snapshot[key] = entryValue;
  return Object.freeze(snapshot);
}

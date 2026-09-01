export const MAX_REPLAY_IDENTIFIER_CHARS = 512;
export const MAX_REPLAY_EVALUATION_COLLECTION_ITEMS = 20_000;

export interface ReplayBounds {
  readonly maxEvents: number;
  readonly maxTimelineEntries: number;
  readonly maxSessions: number;
  readonly maxTextPreviewChars: number;
  readonly maxDisclosureIds: number;
  readonly maxProvenanceIds: number;
  readonly maxEvidenceHistoryEntries: number;
  readonly maxVerificationEntries: number;
  readonly maxGenerationEntries: number;
}

export const DEFAULT_REPLAY_BOUNDS: ReplayBounds = Object.freeze({
  maxEvents: 20_000,
  maxTimelineEntries: 5_000,
  maxSessions: 500,
  maxTextPreviewChars: 512,
  maxDisclosureIds: 64,
  maxProvenanceIds: 128,
  maxEvidenceHistoryEntries: 2_000,
  maxVerificationEntries: 1_000,
  maxGenerationEntries: 1_000
});

export interface TruncationInfo {
  readonly truncated: boolean;
  readonly limit: number;
  readonly remainingCount: number;
}

export interface TextPreview {
  readonly text: string;
  readonly originalLength: number;
  readonly truncated: boolean;
}

function boundedPositiveSafeInteger(
  value: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError("Invalid replay bounds");
  }
  return value;
}

export function resolveReplayBounds(overrides: Partial<ReplayBounds> = {}): ReplayBounds {
  try {
    return {
      maxEvents: boundedPositiveSafeInteger(
        overrides.maxEvents ?? DEFAULT_REPLAY_BOUNDS.maxEvents,
        DEFAULT_REPLAY_BOUNDS.maxEvents
      ),
      maxTimelineEntries: boundedPositiveSafeInteger(
        overrides.maxTimelineEntries ?? DEFAULT_REPLAY_BOUNDS.maxTimelineEntries,
        DEFAULT_REPLAY_BOUNDS.maxTimelineEntries
      ),
      maxSessions: boundedPositiveSafeInteger(
        overrides.maxSessions ?? DEFAULT_REPLAY_BOUNDS.maxSessions,
        DEFAULT_REPLAY_BOUNDS.maxSessions
      ),
      maxTextPreviewChars: boundedPositiveSafeInteger(
        overrides.maxTextPreviewChars ?? DEFAULT_REPLAY_BOUNDS.maxTextPreviewChars,
        DEFAULT_REPLAY_BOUNDS.maxTextPreviewChars
      ),
      maxDisclosureIds: boundedPositiveSafeInteger(
        overrides.maxDisclosureIds ?? DEFAULT_REPLAY_BOUNDS.maxDisclosureIds,
        DEFAULT_REPLAY_BOUNDS.maxDisclosureIds
      ),
      maxProvenanceIds: boundedPositiveSafeInteger(
        overrides.maxProvenanceIds ?? DEFAULT_REPLAY_BOUNDS.maxProvenanceIds,
        DEFAULT_REPLAY_BOUNDS.maxProvenanceIds
      ),
      maxEvidenceHistoryEntries: boundedPositiveSafeInteger(
        overrides.maxEvidenceHistoryEntries ?? DEFAULT_REPLAY_BOUNDS.maxEvidenceHistoryEntries,
        DEFAULT_REPLAY_BOUNDS.maxEvidenceHistoryEntries
      ),
      maxVerificationEntries: boundedPositiveSafeInteger(
        overrides.maxVerificationEntries ?? DEFAULT_REPLAY_BOUNDS.maxVerificationEntries,
        DEFAULT_REPLAY_BOUNDS.maxVerificationEntries
      ),
      maxGenerationEntries: boundedPositiveSafeInteger(
        overrides.maxGenerationEntries ?? DEFAULT_REPLAY_BOUNDS.maxGenerationEntries,
        DEFAULT_REPLAY_BOUNDS.maxGenerationEntries
      )
    };
  } catch {
    throw new RangeError("Invalid replay bounds");
  }
}

export function truncationInfo(total: number, limit: number): TruncationInfo {
  return {
    truncated: total > limit,
    limit,
    remainingCount: Math.max(0, total - limit)
  };
}

export function previewText(value: string, limit: number): TextPreview {
  let originalLength = 0;
  let text = "";
  for (const character of value) {
    if (originalLength < limit) text += character;
    originalLength += 1;
  }
  return {
    text: originalLength > limit ? text : value,
    originalLength,
    truncated: originalLength > limit
  };
}

export function takeBounded<T>(
  values: readonly T[],
  limit: number
): { readonly values: readonly T[]; readonly truncation: TruncationInfo } {
  return {
    values: values.slice(0, limit),
    truncation: truncationInfo(values.length, limit)
  };
}

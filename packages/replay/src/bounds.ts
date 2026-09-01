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

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function resolveReplayBounds(overrides: Partial<ReplayBounds> = {}): ReplayBounds {
  return {
    maxEvents: positiveSafeInteger("maxEvents", overrides.maxEvents ?? DEFAULT_REPLAY_BOUNDS.maxEvents),
    maxTimelineEntries: positiveSafeInteger(
      "maxTimelineEntries",
      overrides.maxTimelineEntries ?? DEFAULT_REPLAY_BOUNDS.maxTimelineEntries
    ),
    maxSessions: positiveSafeInteger("maxSessions", overrides.maxSessions ?? DEFAULT_REPLAY_BOUNDS.maxSessions),
    maxTextPreviewChars: positiveSafeInteger(
      "maxTextPreviewChars",
      overrides.maxTextPreviewChars ?? DEFAULT_REPLAY_BOUNDS.maxTextPreviewChars
    ),
    maxDisclosureIds: positiveSafeInteger(
      "maxDisclosureIds",
      overrides.maxDisclosureIds ?? DEFAULT_REPLAY_BOUNDS.maxDisclosureIds
    ),
    maxProvenanceIds: positiveSafeInteger(
      "maxProvenanceIds",
      overrides.maxProvenanceIds ?? DEFAULT_REPLAY_BOUNDS.maxProvenanceIds
    ),
    maxEvidenceHistoryEntries: positiveSafeInteger(
      "maxEvidenceHistoryEntries",
      overrides.maxEvidenceHistoryEntries ?? DEFAULT_REPLAY_BOUNDS.maxEvidenceHistoryEntries
    ),
    maxVerificationEntries: positiveSafeInteger(
      "maxVerificationEntries",
      overrides.maxVerificationEntries ?? DEFAULT_REPLAY_BOUNDS.maxVerificationEntries
    ),
    maxGenerationEntries: positiveSafeInteger(
      "maxGenerationEntries",
      overrides.maxGenerationEntries ?? DEFAULT_REPLAY_BOUNDS.maxGenerationEntries
    )
  };
}

export function truncationInfo(total: number, limit: number): TruncationInfo {
  return {
    truncated: total > limit,
    limit,
    remainingCount: Math.max(0, total - limit)
  };
}

export function previewText(value: string, limit: number): TextPreview {
  const characters = Array.from(value);
  const truncated = characters.length > limit;
  return {
    text: truncated ? characters.slice(0, limit).join("") : value,
    originalLength: characters.length,
    truncated
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

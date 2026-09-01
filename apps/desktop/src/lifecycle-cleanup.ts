export type DesktopCleanupAttempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

export function tryDesktopCleanup(cleanup: () => void): DesktopCleanupAttempt {
  try {
    cleanup();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

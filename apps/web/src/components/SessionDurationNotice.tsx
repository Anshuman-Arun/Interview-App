import { useEffect, useMemo, useState } from "react";

const MILLISECONDS_PER_MINUTE = 60_000;

export function SessionDurationNotice({
  durationMinutes,
  createdAt,
  visible
}: {
  readonly durationMinutes?: number;
  readonly createdAt?: string | null;
  readonly visible: boolean;
}) {
  const deadline = useMemo(() => {
    if (durationMinutes === undefined || createdAt === undefined || createdAt === null) {
      return null;
    }
    const createdAtMs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs)) return null;
    return createdAtMs + durationMinutes * MILLISECONDS_PER_MINUTE;
  }, [createdAt, durationMinutes]);

  const [plannedTimeReached, setPlannedTimeReached] = useState(false);

  useEffect(() => {
    if (!visible || deadline === null) {
      setPlannedTimeReached(false);
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      setPlannedTimeReached(true);
      return;
    }

    setPlannedTimeReached(false);
    const timeoutId = globalThis.setTimeout(() => {
      setPlannedTimeReached(true);
    }, remainingMs);

    return () => globalThis.clearTimeout(timeoutId);
  }, [deadline, visible]);

  if (!visible || !plannedTimeReached) return null;

  return (
    <aside
      className="session-duration-notice"
      role="status"
      aria-live="polite"
      data-testid="session-duration-notice"
    >
      <strong>Planned session time reached</strong>
      <span>You can keep working. End the interview when you are ready.</span>
    </aside>
  );
}

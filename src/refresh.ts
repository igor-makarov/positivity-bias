export const HOUR = 3_600_000;
// Match the existing minute-7 cron. Reads and cron share one attempt per window,
// so a read between ticks cannot suppress the following scheduled refresh.
export const REFRESH_MINUTE = 7;

export function refreshDue(lastAttemptAt: string | null | undefined, now = Date.now()) {
  const previous = Date.parse(lastAttemptAt || "");
  if (!Number.isFinite(previous)) return true;
  const window = (time: number) => Math.floor((time - REFRESH_MINUTE * 60_000) / HOUR);
  return window(now) > window(previous);
}

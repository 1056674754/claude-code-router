import { useEffect, useState } from "react";

export type DailyActivityPoint = {
  day: string;
  totalTokens: number;
};

/**
 * Whole-history daily token totals for the activity calendar. The dashboard's
 * range selector is deliberately ignored: a calendar that only shows the
 * selected range is not a calendar. Polls once a minute, same cadence as the
 * rest of the dashboard.
 */
function samePoints(left: DailyActivityPoint[], right: DailyActivityPoint[]): boolean {
  return left.length === right.length
    && left.every((point, index) => point.day === right[index].day && point.totalTokens === right[index].totalTokens);
}

export function useDailyActivitySeries(pollMs = 60_000): DailyActivityPoint[] {
  const [points, setPoints] = useState<DailyActivityPoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void window.ccr?.getUsageDailyActivity?.().then((next) => {
        if (!cancelled && Array.isArray(next)) {
          // Same payload, same array: a poll must not repaint a thousand cells.
          setPoints((current) => (samePoints(current, next) ? current : next));
        }
      }).catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pollMs]);

  return points;
}

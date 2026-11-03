import type { UsageSeriesPoint, UsageStatsRange } from "@ccr/core/contracts/app";

export type TokenActivityCell = {
  date: Date;
  dateKey: string;
  dateLabel: string;
  dayIndex: number;
  inObservedRange: boolean;
  intensity: 0 | 1 | 2 | 3 | 4;
  totalTokens: number;
  weekIndex: number;
};

export type TokenActivitySummary = {
  activeDays: number;
  avgPerDay: number;
  avgPerWeek: number;
  cells: TokenActivityCell[];
  dayCount: number;
  longestStreak: number;
  maxTokens: number;
  totalTokens: number;
  weekCount: number;
};

type TokenActivityOptions = {
  anchor?: Date | string;
  maxWeeks?: number;
  minWeeks?: number;
  now?: Date | string;
  range?: UsageStatsRange;
};

const dayMs = 24 * 60 * 60 * 1000;

export function buildTokenActivity(series: ReadonlyArray<Pick<UsageSeriesPoint, "bucket" | "totalTokens">>, options: TokenActivityOptions = {}): TokenActivitySummary {
  const totalsByDay = new Map<string, number>();
  let observedStart: Date | undefined;
  let observedEnd: Date | undefined;

  for (const point of series) {
    const date = startOfLocalDay(parseActivityDate(point.bucket));
    if (!isFiniteDate(date)) {
      continue;
    }
    const key = activityDateKey(date);
    totalsByDay.set(key, (totalsByDay.get(key) ?? 0) + Math.max(0, point.totalTokens));
    observedStart = observedStart && observedStart <= date ? observedStart : date;
    observedEnd = observedEnd && observedEnd >= date ? observedEnd : date;
  }

  const today = startOfLocalDay(new Date());
  const rangeWindow = activityRangeWindow(options.range, options.now);
  observedStart = rangeWindow?.start ?? observedStart ?? today;
  observedEnd = rangeWindow?.end ?? observedEnd ?? today;
  // The grid can be anchored to "today" even when the newest record is older,
  // so the calendar always ends on the current week and the latest day keeps
  // its right-edge position.
  const anchor = options.anchor ? startOfLocalDay(new Date(options.anchor)) : undefined;
  const gridEndDate = anchor && isFiniteDate(anchor) && anchor > observedEnd ? anchor : observedEnd;

  let gridStart = startOfActivityWeek(observedStart);
  const gridEnd = endOfActivityWeek(gridEndDate);
  let weekCount = weeksBetween(gridStart, gridEnd);
  const minWeeks = positiveInteger(options.minWeeks);
  const maxWeeks = positiveInteger(options.maxWeeks);

  if (minWeeks && weekCount < minWeeks) {
    gridStart = addDays(gridStart, -(minWeeks - weekCount) * 7);
    weekCount = minWeeks;
  }
  if (maxWeeks && weekCount > maxWeeks) {
    gridStart = addDays(gridEnd, -(maxWeeks * 7 - 1));
    gridStart = startOfActivityWeek(gridStart);
    weekCount = maxWeeks;
  }

  const dayCount = Math.max(1, daysBetween(observedStart, observedEnd) + 1);
  const totalTokens = sumObservedTokens(totalsByDay, observedStart, observedEnd);
  const maxTokens = maxObservedTokens(totalsByDay, observedStart, observedEnd);
  const cells: TokenActivityCell[] = [];

  for (let weekIndex = 0; weekIndex < weekCount; weekIndex += 1) {
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = addDays(gridStart, weekIndex * 7 + dayIndex);
      const dateKey = activityDateKey(date);
      const total = totalsByDay.get(dateKey) ?? 0;
      cells.push({
        date,
        dateKey,
        dateLabel: formatActivityDateLabel(date),
        dayIndex,
        inObservedRange: date >= observedStart && date <= observedEnd,
        intensity: tokenActivityIntensity(total, maxTokens),
        totalTokens: total,
        weekIndex
      });
    }
  }

  const activeDays = countObservedDays(totalsByDay, observedStart, observedEnd, (value) => value > 0);

  return {
    activeDays,
    avgPerDay: totalTokens / dayCount,
    avgPerWeek: totalTokens / Math.max(1 / 7, dayCount / 7),
    cells,
    dayCount,
    longestStreak: longestObservedStreak(totalsByDay, observedStart, observedEnd),
    maxTokens,
    totalTokens,
    weekCount
  };
}

function parseActivityDate(bucket: string): Date {
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(bucket.trim());
  if (!dateOnly) {
    return new Date(bucket);
  }

  const year = Number(dateOnly[1]);
  const month = Number(dateOnly[2]);
  const day = Number(dateOnly[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return new Date(Number.NaN);
  }
  return date;
}

function activityRangeWindow(range: UsageStatsRange | undefined, nowInput: Date | string | undefined): { end: Date; start: Date } | undefined {
  if (!range) {
    return undefined;
  }
  const now = normalizeActivityNow(nowInput);
  if (!isFiniteDate(now)) {
    return undefined;
  }
  const end = startOfLocalDay(now);
  if (range === "today") {
    return { end, start: end };
  }
  if (range === "24h") {
    const start = new Date(now);
    start.setHours(start.getHours() - 24);
    return { end, start: startOfLocalDay(start) };
  }
  return {
    end,
    start: addDays(end, range === "7d" ? -6 : -29)
  };
}

function normalizeActivityNow(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return new Date(value);
  }
  return new Date();
}

export function activityDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const activityDateLabelFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const activityMonthFormat = new Intl.DateTimeFormat(undefined, { month: "short" });

export function formatActivityDateLabel(date: Date): string {
  return activityDateLabelFormat.format(date);
}

export type ActivityAxisMonthLabel = {
  key: string;
  label: string;
  left: number;
};

function startOfActivityGridWeek(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
  return copy;
}

// The heatmap axis spans calendar months, not months that happen to contain
// data: empty padding columns still get their label so the axis is never
// truncated. Labels are laid out in pixels from the grid's left edge.
// CJK glyphs are roughly 10px and latin ones 6px at the axis label size; the
// estimate only decides whether two labels can sit next to each other.
function estimateAxisLabelWidth(label: string): number {
  let width = 0;
  for (const char of label) {
    width += (char.codePointAt(0) ?? 0) > 0x2e80 ? 10 : 6;
  }
  return width + 4;
}

/**
 * Maps a pointer offset inside the canvas to a grid position. Shared by the
 * component and its unit test: the gap between squares must not respond.
 */
export function cellAtOffset(offsetX: number, offsetY: number, weekStep: number, cellSize: number) {
  const column = Math.floor(offsetX / weekStep);
  const row = Math.floor(offsetY / weekStep);
  const onCell = offsetX - column * weekStep <= cellSize && offsetY - row * weekStep <= cellSize;
  return { column, onCell, row };
}

export function buildActivityAxisMonthLabels(options: {
  columns: number;
  formatMonth?: (date: Date) => string;
  gridWidth: number;
  lastDate: Date;
  weekStep: number;
}): ActivityAxisMonthLabel[] {
  const { columns, gridWidth, lastDate, weekStep } = options;
  if (columns <= 0) {
    return [];
  }
  const formatMonth = options.formatMonth ?? ((date: Date) => activityMonthFormat.format(date));
  const lastWeekStart = startOfActivityGridWeek(lastDate);
  const gridStart = new Date(lastWeekStart.getFullYear(), lastWeekStart.getMonth(), lastWeekStart.getDate() - (columns - 1) * 7);
  const lastWeekEnd = new Date(lastWeekStart.getFullYear(), lastWeekStart.getMonth(), lastWeekStart.getDate() + 6);
  type Candidate = ActivityAxisMonthLabel & { partial?: boolean };
  const candidates: Candidate[] = [];
  const monthStart = new Date(gridStart.getFullYear(), gridStart.getMonth(), 1);
  if (monthStart < gridStart) {
    candidates.push({ key: `0-${gridStart.getMonth()}`, label: formatMonth(gridStart), left: 0, partial: true });
    monthStart.setMonth(monthStart.getMonth() + 1);
  }
  while (monthStart <= lastWeekEnd) {
    const column = Math.round((monthStart.getTime() - gridStart.getTime()) / 604800000);
    if (column >= 0 && column < columns) {
      const label = formatMonth(monthStart);
      const labelWidth = estimateAxisLabelWidth(label);
      const naturalLeft = column * weekStep;
      // Keep the final label inside the grid instead of letting it run off the
      // clipped right edge.
      const left = Math.max(0, Math.min(naturalLeft, gridWidth - labelWidth));
      candidates.push({ key: `${column}-${monthStart.getMonth()}`, label, left });
    }
    monthStart.setMonth(monthStart.getMonth() + 1);
  }

  // Labels may not overlap, but a real month boundary always beats the partial
  // month that happens to sit on the left edge: it is dropped in its favour
  // instead of leaving a hole in the axis.
  const labels: ActivityAxisMonthLabel[] = [];
  for (const candidate of candidates) {
    const previous = labels[labels.length - 1];
    // The new label has to clear the previous label's own box, not its own:
    // completeness beats a wide aesthetic gap, otherwise the last month of a
    // narrow axis silently disappears.
    const threshold = previous ? estimateAxisLabelWidth(previous.label) + 4 : Number.POSITIVE_INFINITY;
    if (!previous || candidate.left - previous.left >= threshold) {
      labels.push({ key: candidate.key, label: candidate.label, left: candidate.left });
      continue;
    }
    const previousPartial = candidates.find((entry) => entry.key === previous.key)?.partial;
    if (previousPartial) {
      labels.pop();
      labels.push({ key: candidate.key, label: candidate.label, left: candidate.left });
    }
  }
  return labels;
}

function tokenActivityIntensity(value: number, maxValue: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || maxValue <= 0) {
    return 0;
  }
  const ratio = value / maxValue;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.45) return 3;
  if (ratio >= 0.2) return 2;
  return 1;
}

function sumObservedTokens(totalsByDay: Map<string, number>, start: Date, end: Date): number {
  let total = 0;
  walkDays(start, end, (date) => {
    total += totalsByDay.get(activityDateKey(date)) ?? 0;
  });
  return total;
}

function maxObservedTokens(totalsByDay: Map<string, number>, start: Date, end: Date): number {
  let max = 0;
  walkDays(start, end, (date) => {
    max = Math.max(max, totalsByDay.get(activityDateKey(date)) ?? 0);
  });
  return max;
}

function countObservedDays(totalsByDay: Map<string, number>, start: Date, end: Date, predicate: (value: number) => boolean): number {
  let count = 0;
  walkDays(start, end, (date) => {
    if (predicate(totalsByDay.get(activityDateKey(date)) ?? 0)) {
      count += 1;
    }
  });
  return count;
}

function longestObservedStreak(totalsByDay: Map<string, number>, start: Date, end: Date): number {
  let current = 0;
  let longest = 0;
  walkDays(start, end, (date) => {
    if ((totalsByDay.get(activityDateKey(date)) ?? 0) > 0) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  });
  return longest;
}

function walkDays(start: Date, end: Date, visit: (date: Date) => void) {
  for (let date = startOfLocalDay(start); date <= end; date = addDays(date, 1)) {
    visit(date);
  }
}

function startOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfActivityWeek(date: Date): Date {
  const next = startOfLocalDay(date);
  const mondayOffset = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - mondayOffset);
  return next;
}

function endOfActivityWeek(date: Date): Date {
  return addDays(startOfActivityWeek(date), 6);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return startOfLocalDay(next);
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((startOfLocalDay(end).getTime() - startOfLocalDay(start).getTime()) / dayMs));
}

function weeksBetween(start: Date, end: Date): number {
  return Math.max(1, Math.floor(daysBetween(start, end) / 7) + 1);
}

function isFiniteDate(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

import assert from "node:assert/strict";
import test from "node:test";
import { activityDateKey, buildActivityAxisMonthLabels, buildTokenActivity, cellAtOffset } from "@ccr/ui/lib/usage-activity.ts";

test("buildTokenActivity summarizes observed token days and streaks", () => {
  withTimezone("America/New_York", () => {
    const summary = buildTokenActivity([
      { bucket: "2026-06-02", totalTokens: 10 },
      { bucket: "2026-06-03", totalTokens: 30 },
      { bucket: "2026-06-04", totalTokens: 60 },
      { bucket: "2026-06-05", totalTokens: -20 },
      { bucket: "not-a-date", totalTokens: 999 }
    ]);

    assert.equal(summary.totalTokens, 100);
    assert.equal(summary.activeDays, 3);
    assert.equal(summary.dayCount, 4);
    assert.equal(summary.longestStreak, 3);
    assert.equal(summary.maxTokens, 60);
    assert.equal(summary.weekCount, 1);
    assert.equal(summary.cells.length, 7);

    const cellsByDate = new Map(summary.cells.map((cell) => [cell.dateKey, cell]));
    assert.equal(cellsByDate.get("2026-06-01")?.inObservedRange, false);
    assert.equal(cellsByDate.get("2026-06-02")?.inObservedRange, true);
    assert.equal(cellsByDate.get("2026-06-02")?.intensity, 1);
    assert.equal(cellsByDate.get("2026-06-03")?.intensity, 3);
    assert.equal(cellsByDate.get("2026-06-04")?.intensity, 4);
    assert.equal(cellsByDate.get("2026-06-05")?.intensity, 0);
  });
});

test("buildTokenActivity clamps the grid to maxWeeks ending at the observed week", () => {
  withTimezone("America/New_York", () => {
    const summary = buildTokenActivity(
      [
        { bucket: "2026-06-02", totalTokens: 10 },
        { bucket: "2026-06-20", totalTokens: 30 }
      ],
      { maxWeeks: 2 }
    );

    assert.equal(summary.weekCount, 2);
    assert.equal(summary.cells.length, 14);
    const keys = new Set(summary.cells.map((cell) => cell.dateKey));
    assert.equal(keys.has("2026-06-02"), false);
    assert.equal(keys.has("2026-06-08"), true);
    assert.equal(keys.has("2026-06-20"), true);
  });
});

test("buildTokenActivity pads to minWeeks when asked for a fixed calendar window", () => {
  withTimezone("America/New_York", () => {
    const summary = buildTokenActivity(
      [{ bucket: "2026-06-03", totalTokens: 10 }],
      { minWeeks: 2 }
    );

    assert.equal(summary.weekCount, 2);
    assert.equal(summary.cells.length, 14);
  });
});

test("activityDateKey formats local calendar dates", () => {
  assert.equal(activityDateKey(new Date(2026, 0, 5, 14, 30)), "2026-01-05");
});

test("buildTokenActivity averages sparse data over the selected range window", () => {
  withTimezone("America/New_York", () => {
    const summary = buildTokenActivity(
      [
        { bucket: "2026-06-29", totalTokens: 10 },
        { bucket: "2026-06-30", totalTokens: 30 }
      ],
      { now: "2026-06-30T12:00:00.000Z", range: "30d" }
    );

    assert.equal(summary.totalTokens, 40);
    assert.equal(summary.activeDays, 2);
    assert.equal(summary.dayCount, 30);
    assert.equal(summary.longestStreak, 2);
    assert.equal(Math.round(summary.avgPerDay * 100) / 100, 1.33);
    assert.equal(Math.round(summary.avgPerWeek * 100) / 100, 9.33);
  });
});

function withTimezone(timezone, run) {
  const previousTimezone = process.env.TZ;
  process.env.TZ = timezone;
  try {
    run();
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
}

test("activity axis labels every month it spans, padding included", () => {
  const weekStep = 17;
  const columns = 66;
  const gridWidth = columns * weekStep - 4;
  const labels = buildActivityAxisMonthLabels({
    columns,
    formatMonth: (date) => `${date.getMonth() + 1}月`,
    gridWidth,
    lastDate: new Date(2026, 10, 3),
    weekStep
  });

  // 66 weeks ending 2026-11-03 reach back into August 2025: 16 named months.
  assert.equal(labels.length, 16);
  assert.equal(labels[0].label, "8月");
  assert.deepEqual(labels.slice(-3).map((entry) => entry.label), ["9月", "10月", "11月"]);
  assert.equal(labels[0].left, 0);

  for (let index = 1; index < labels.length; index += 1) {
    assert.ok(labels[index].left > labels[index - 1].left, "labels stay left to right");
  }

  const last = labels[labels.length - 1];
  // Same estimate the axis uses: CJK glyphs are wider than latin digits.
  const estimateWidth = (label) => [...label].reduce((total, char) => total + (char.codePointAt(0) > 0x2e80 ? 10 : 6), 4);
  assert.ok(
    last.left + estimateWidth(last.label) <= gridWidth,
    "the final label stays inside the grid instead of running off the clipped edge"
  );
});

test("activity axis prefers a real month boundary over a squeezed partial month", () => {
  const weekStep = 10;
  const columns = 32;
  const labels = buildActivityAxisMonthLabels({
    columns,
    formatMonth: (date) => `${date.getMonth() + 1}月`,
    gridWidth: columns * weekStep - 4,
    lastDate: new Date(2026, 10, 3),
    weekStep
  });

  // The grid starts mid-March, so April's boundary lands on top of the partial
  // "3月" label: the boundary wins instead of leaving a hole in the axis.
  assert.equal(labels[0].label, "4月");
  assert.deepEqual(labels.slice(-2).map((entry) => entry.label), ["10月", "11月"]);

  const estimateWidth = (label) => [...label].reduce((total, char) => total + (char.codePointAt(0) > 0x2e80 ? 10 : 6), 4);
  for (let index = 1; index < labels.length; index += 1) {
    const previous = labels[index - 1];
    assert.ok(
      labels[index].left >= previous.left + estimateWidth(previous.label),
      "labels never overlap, but the axis still names every month that fits"
    );
  }
});

test("activity axis still labels a short narrow calendar", () => {
  const weekStep = 8;
  const columns = 8;
  const labels = buildActivityAxisMonthLabels({
    columns,
    formatMonth: (date) => `${date.getMonth() + 1}月`,
    gridWidth: columns * weekStep - 2,
    lastDate: new Date(2026, 10, 3),
    weekStep
  });

  assert.ok(labels.length >= 1, "a short axis still labels the month it can fit");
});

test("activity axis renders nothing without columns", () => {
  assert.deepEqual(
    buildActivityAxisMonthLabels({ columns: 0, gridWidth: 0, lastDate: new Date(2026, 10, 3), weekStep: 17 }),
    []
  );
});

test("cellAtOffset maps a pointer to a square and rejects the gaps", () => {
  const weekStep = 17;
  const cellSize = 13;

  assert.deepEqual(cellAtOffset(0, 0, weekStep, cellSize), { column: 0, onCell: true, row: 0 });
  assert.deepEqual(cellAtOffset(3 * weekStep + cellSize, 2 * weekStep + cellSize, weekStep, cellSize), { column: 3, onCell: true, row: 2 });
  // The 4px gutter between squares must not respond to hover.
  assert.equal(cellAtOffset(3 * weekStep + cellSize + 2, 0, weekStep, cellSize).onCell, false);
  assert.equal(cellAtOffset(0, weekStep - 1, weekStep, cellSize).onCell, false);
});

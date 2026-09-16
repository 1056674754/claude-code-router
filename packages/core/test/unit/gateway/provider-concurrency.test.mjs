import assert from "node:assert/strict";
import test from "node:test";
import { acquireProviderSlot, activeProviderSlotCountForTest } from "@ccr/core/gateway/upstream/provider-concurrency.ts";

test("provider gate admits up to the cap immediately and queues the rest FIFO", async () => {
  const first = await acquireProviderSlot("gate-fifo", 2);
  const second = await acquireProviderSlot("gate-fifo", 2);
  assert.equal(activeProviderSlotCountForTest("gate-fifo"), 2);

  const third = acquireProviderSlot("gate-fifo", 2);
  const fourth = acquireProviderSlot("gate-fifo", 2);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(activeProviderSlotCountForTest("gate-fifo"), 2);

  first();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(activeProviderSlotCountForTest("gate-fifo"), 2);

  const thirdRelease = await Promise.race([
    third.then((release) => ({ granted: true, release })),
    new Promise((resolve) => setTimeout(() => resolve({ granted: false, release: () => {} }), 100))
  ]);
  assert.equal(thirdRelease.granted, true);
  thirdRelease.release();

  second();
  const fourthRelease = await fourth.then((release) => ({ granted: true, release }));
  assert.equal(fourthRelease.granted, true);
  fourthRelease.release();
  assert.equal(activeProviderSlotCountForTest("gate-fifo"), 0);
});

test("provider gate queue waiters are abort-aware", async () => {
  const controller = new AbortController();
  const first = await acquireProviderSlot("gate-abort", 1);
  const queued = acquireProviderSlot("gate-abort", 1, { signal: controller.signal });
  assert.equal(activeProviderSlotCountForTest("gate-abort"), 1);

  first();
  await Promise.resolve();
  assert.equal(activeProviderSlotCountForTest("gate-abort"), 1);

  const settled = await Promise.race([
    queued.then((release) => ({ kind: "granted", release })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "still-waiting" }), 50))
  ]);

  controller.abort();
  const outcome = await queued.then(
    (release) => ({ kind: "granted", release }),
    (error) => ({ kind: "rejected", error })
  );

  if (settled.kind === "granted") {
    assert.equal(outcome.kind, "granted");
    outcome.release();
  } else {
    assert.equal(outcome.kind, "aborted");
  }
  assert.equal(activeProviderSlotCountForTest("gate-abort"), 0);
});

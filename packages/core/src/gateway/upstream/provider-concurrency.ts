type ConcurrencyWaiter = {
  settled: boolean;
  grant: (() => void) | undefined;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
};

type ProviderGate = {
  active: number;
  waiters: ConcurrencyWaiter[];
};

const gates = new Map<string, ProviderGate>();

function gateFor(providerKey: string): ProviderGate {
  let gate = gates.get(providerKey);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    gates.set(providerKey, gate);
  }
  return gate;
}

function leave(gate: ProviderGate): void {
  gate.active = Math.max(0, gate.active - 1);
  const next = gate.waiters.shift();
  if (next) {
    // The slot transfers to the waiter: count it as active immediately.
    gate.active += 1;
    next.grant?.();
  }
}

/**
 * FIFO per-provider concurrency gate: holds upstream fan-out for provider
 * targets that declare maxConcurrency, so bursty agent fan-outs queue at the
 * gateway instead of tripping upstream risk control. Resolves with an
 * idempotent release function once a slot is granted, or with undefined if
 * the caller aborted while queued (nothing to release).
 */
export function acquireProviderSlot(
  providerKey: string,
  maxConcurrency: number,
  handlers: {
    signal?: AbortSignal;
  } = {}
): Promise<(() => void) | undefined> {
  const gate = gateFor(providerKey);
  const release = () => leave(gate);
  if (gate.active < maxConcurrency) {
    gate.active += 1;
    return Promise.resolve(release);
  }

  return new Promise((resolve) => {
    const waiter = {
      settled: false,
      grant: undefined as (() => void) | undefined,
      signal: handlers.signal,
      abortListener: undefined as (() => void) | undefined
    };
    const grant = () => {
      if (waiter.settled) {
        return;
      }
      waiter.settled = true;
      handlers.signal?.removeEventListener("abort", abortListener);
      resolve(release);
    };
    waiter.grant = grant;
    const abortListener = () => {
      if (waiter.settled) {
        return;
      }
      waiter.settled = true;
      const position = gate.waiters.indexOf(waiter);
      if (position >= 0) {
        gate.waiters.splice(position, 1);
      }
      resolve(undefined);
    };
    waiter.abortListener = abortListener;
    if (handlers.signal?.aborted) {
      abortListener();
      return;
    }
    handlers.signal?.addEventListener("abort", abortListener, { once: true });
    gate.waiters.push(waiter);
  });
}

/** Test visibility: current in-flight count for a provider key. */
export function activeProviderSlotCountForTest(providerKey: string): number {
  return gateFor(providerKey).active;
}

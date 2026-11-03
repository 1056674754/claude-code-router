// Per-provider circuit breaker for the standby (fallbackProviders) chain.
// States: closed → (failureThreshold consecutive failures) → open → (after
// openMs) half-open → one probe decides. The PRIMARY routed provider is never
// gated — the user's route rule is the authority; only standby hand-offs are
// skipped while a standby's circuit is open. In-memory by design: restarts
// reset circuits, matching the gateway's lifetime.

export type CircuitBreakerState = "closed" | "open" | "half-open";

const failureThreshold = 5;
const openMs = 30_000;

type CircuitEntry = {
  consecutiveFailures: number;
  halfOpenProbes: number;
  openedAtMs?: number;
  state: CircuitBreakerState;
};

const circuits = new Map<string, CircuitEntry>();

export function circuitState(providerName: string | undefined): CircuitBreakerState {
  if (!providerName) {
    return "closed";
  }
  const entry = circuits.get(providerName);
  if (!entry) {
    return "closed";
  }
  if (entry.state === "open" && entry.openedAtMs !== undefined && Date.now() - entry.openedAtMs >= openMs) {
    entry.state = "half-open";
    entry.halfOpenProbes = 0;
  }
  return entry.state;
}

// Standby hand-off gate: closed/half-open circuits admit attempts (a half-open
// circuit admits a bounded number of probes), open circuits do not.
export function circuitAllows(providerName: string | undefined): boolean {
  if (!providerName) {
    return true;
  }
  const state = circuitState(providerName);
  if (state !== "open") {
    return true;
  }
  return false;
}

export function recordCircuitSuccess(providerName: string | undefined): void {
  if (!providerName) {
    return;
  }
  circuits.delete(providerName);
}

export function recordCircuitFailure(providerName: string | undefined): void {
  if (!providerName) {
    return;
  }
  const entry = circuits.get(providerName) ?? {
    consecutiveFailures: 0,
    halfOpenProbes: 0,
    state: "closed" as CircuitBreakerState
  };
  entry.consecutiveFailures += 1;
  if (entry.state === "half-open" || entry.consecutiveFailures >= failureThreshold) {
    entry.state = "open";
    entry.openedAtMs = Date.now();
    entry.halfOpenProbes = 0;
  }
  circuits.set(providerName, entry);
}

export function resetCircuitBreaker(providerName?: string): void {
  if (providerName) {
    circuits.delete(providerName);
  } else {
    circuits.clear();
  }
}

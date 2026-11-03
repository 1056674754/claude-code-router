import { useSyncExternalStore } from "react";

import { ACTIVITY_SCOPES, type ActivityScope } from "@/lib/usage-activity";

// Shared by the overview card and the macOS panel: both windows run on the same
// file:// origin, so one key remembers the choice. The value also lives in a
// module-level store because the activity widget is repeatable - two cards in
// the same window have to agree without waiting for a `storage` event, which
// never fires in the document that wrote.
export const ACTIVITY_SCOPE_STORAGE_KEY = "ccr.activity.scope";

const defaultActivityScope: ActivityScope = "all";

function normalizeActivityScope(value: string | null | undefined): ActivityScope {
  return ACTIVITY_SCOPES.find((scope) => scope === value) ?? defaultActivityScope;
}

function readStoredActivityScope(): ActivityScope {
  try {
    return normalizeActivityScope(window.localStorage.getItem(ACTIVITY_SCOPE_STORAGE_KEY));
  } catch {
    return defaultActivityScope;
  }
}

let currentScope: ActivityScope | null = null;
const listeners = new Set<() => void>();

function getScopeSnapshot(): ActivityScope {
  if (currentScope === null) {
    currentScope = readStoredActivityScope();
  }
  return currentScope;
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function handleStorage(event: StorageEvent) {
  // `key === null` means the whole storage area was cleared from another window.
  if (event.key !== null && event.key !== ACTIVITY_SCOPE_STORAGE_KEY) {
    return;
  }
  const next = readStoredActivityScope();
  if (next === currentScope) {
    return;
  }
  currentScope = next;
  emit();
}

function subscribeScope(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

export function setActivityScope(next: ActivityScope): void {
  currentScope = next;
  try {
    window.localStorage.setItem(ACTIVITY_SCOPE_STORAGE_KEY, next);
  } catch {
    // A blocked storage must not break the switch; the scope still applies to
    // the open windows for as long as they stay open.
  }
  emit();
}

export function useActivityScope(): [ActivityScope, (scope: ActivityScope) => void] {
  const scope = useSyncExternalStore(subscribeScope, getScopeSnapshot, getScopeSnapshot);
  return [scope, setActivityScope];
}

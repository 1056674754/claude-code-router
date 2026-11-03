import { useCallback, useEffect, useState } from "react";

import type { ActivityScope } from "@/lib/usage-activity";

// Shared by the overview card and the macOS panel: both windows run on the same
// file:// origin, so one key remembers the choice and the `storage` event keeps
// the other window in step.
export const ACTIVITY_SCOPE_STORAGE_KEY = "ccr.activity.scope";

const defaultActivityScope: ActivityScope = "all";

function normalizeActivityScope(value: string | null | undefined): ActivityScope {
  return value === "30d" || value === "7d" ? value : defaultActivityScope;
}

function readStoredActivityScope(): ActivityScope {
  try {
    return normalizeActivityScope(window.localStorage.getItem(ACTIVITY_SCOPE_STORAGE_KEY));
  } catch {
    return defaultActivityScope;
  }
}

export function useActivityScope(): [ActivityScope, (scope: ActivityScope) => void] {
  const [scope, setScope] = useState<ActivityScope>(readStoredActivityScope);

  const updateScope = useCallback((next: ActivityScope) => {
    setScope(next);
    try {
      window.localStorage.setItem(ACTIVITY_SCOPE_STORAGE_KEY, next);
    } catch {
      // A blocked storage must not break the switch; the scope still applies to
      // this window for as long as it stays open.
    }
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== ACTIVITY_SCOPE_STORAGE_KEY) {
        return;
      }
      setScope(normalizeActivityScope(event.newValue));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return [scope, updateScope];
}

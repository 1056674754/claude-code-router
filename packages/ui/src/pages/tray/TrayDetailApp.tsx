import {
  applyTrayThemePreference, DEFAULT_TRAY_WIDGETS, emptySnapshots,
  normalizeTrayWidgets, ProviderAccountSnapshot, SnapshotMap, TrayWidgetConfig,
  UsageStatsRange, useCallback, useEffect, useState, useTrayErrorText, useTrayText, useTrayThemePreference
} from "./shared";
import {
  TrayStatusStrip, UsageDetailPanel
} from "./components/index";

export function TrayDetailApp({ provider }: { provider?: string }) {
  const t = useTrayText();
  const formatError = useTrayErrorText();
  useTrayThemePreference();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [range, setRange] = useState<UsageStatsRange>("30d");
  const [snapshots, setSnapshots] = useState<SnapshotMap>(emptySnapshots);
  const [accountSnapshots, setAccountSnapshots] = useState<ProviderAccountSnapshot[]>([]);
  const [accountRefreshing, setAccountRefreshing] = useState(false);
  const [trayWidgets, setTrayWidgets] = useState<TrayWidgetConfig[]>(DEFAULT_TRAY_WIDGETS);

  const refresh = useCallback(async () => {
    if (!window.ccr) {
      setSnapshots(emptySnapshots);
      setAccountSnapshots([]);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const payload = await window.ccr.getTraySnapshot(provider);
      setSnapshots(payload.snapshots);
      setAccountSnapshots(payload.accounts);
      setTrayWidgets(normalizeTrayWidgets(payload.config.trayWidgets, payload.config.trayWindowModules, payload.config.trayComponentVariants));
      applyTrayThemePreference(payload.config.theme);
      setLoadedOnce(true);
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setLoading(false);
    }
  }, [formatError, provider]);

  const refreshAccountSnapshots = useCallback(async () => {
    if (!window.ccr) {
      setAccountSnapshots([]);
      return;
    }

    setAccountRefreshing(true);
    setError("");
    try {
      const accounts = await window.ccr.getProviderAccountSnapshots(provider, { forceRefresh: true });
      setAccountSnapshots(accounts);
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setAccountRefreshing(false);
    }
  }, [formatError, provider]);

  useEffect(() => {
    document.body.classList.add("tray-window");
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void window.ccr?.closeTray();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.classList.remove("tray-window");
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [provider]);

  // Same visibility gate as TrayApp: the window is only ever hidden, so stop
  // polling while hidden and refresh immediately on reopen.
  useEffect(() => {
    let timer: number | undefined;
    const stopPolling = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const startPolling = () => {
      if (timer === undefined) {
        void refresh();
        timer = window.setInterval(() => {
          void refresh();
        }, 5000);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        startPolling();
      } else {
        stopPolling();
      }
    };
    if (document.visibilityState === "visible") {
      startPolling();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  const showSkeleton = loading && !loadedOnce;

  return (
    <main
      className="tray-shell h-screen w-screen overflow-y-auto p-3"
    >
      <TrayStatusStrip totalTokens={snapshots[range].totals.totalTokens} />
      {showSkeleton ? (
        <div className="space-y-2 pt-2">
          <div className="tray-panel h-10 px-3 py-3">
            <div className="h-full w-full animate-pulse rounded bg-white/10" />
          </div>
          <div className="tray-panel h-24 p-3">
            <div className="h-full w-full animate-pulse rounded bg-white/10" />
          </div>
          <div className="tray-panel h-40 p-3">
            <div className="h-full w-full animate-pulse rounded bg-white/10" />
          </div>
        </div>
      ) : (
        <UsageDetailPanel activeStats={snapshots[range]} accountRefreshing={accountRefreshing} accountSnapshots={accountSnapshots} activitySeries={snapshots["180d"]?.series} provider={provider} range={range} widgets={trayWidgets} onRefreshAccount={refreshAccountSnapshots} onRangeChange={setRange} />
      )}
      {loading && !showSkeleton ? <div className="mt-2 text-[11px] font-medium text-slate-300/55">{t("Syncing usage...")}</div> : null}
      {error ? <div className="mt-3 rounded-[12px] border border-rose-400/20 bg-rose-500/15 px-3 py-2 text-[12px] font-medium text-rose-100">{error}</div> : null}
    </main>
  );
}

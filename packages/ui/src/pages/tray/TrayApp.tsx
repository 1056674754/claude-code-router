import {
  AppConfig, applyTrayThemePreference, createSourceTabs, DEFAULT_TRAY_WIDGETS, defaultTrayWidgetVariant, emptySnapshots, formatCompactNumber, formatProviderName,
  formatPercent, formatUpdated, formatUsdCost, normalizeTrayWidgets, ProviderAccountSnapshot, rangeLabel,
  SnapshotMap, SourceTab, TrayComponentVariants, TrayWidgetConfig, UsageComparisonRow, UsageStatsRange, UsageTotals, useCallback, useEffect,
  useMemo, useRef, useState, useTrayErrorText, useTrayText, useTrayThemePreference
} from "./shared";
import {
  AccountSummaryPanel, AnimatedUsageChart, ChartShell, ModelShareChart, RingMetrics,
  SourceGrid, StatsGrid, TokenActivityPanel, TokenMixPanel, TrayStatusStrip
} from "./components/index";
import { isGatewayProviderEnabled } from "@ccr/core/contracts/app";

type TrayHeaderRange = Exclude<UsageStatsRange, "180d">;

const trayHeaderRanges: TrayHeaderRange[] = ["today", "24h", "7d", "30d"];

const traySnapshotCacheKey = "ccr.tray.snapshot.v1";

type CachedTraySnapshot = {
  accounts?: ProviderAccountSnapshot[];
  configuredProviders?: AppConfig["Providers"];
  snapshots?: SnapshotMap;
  theme?: AppConfig["theme"];
  trayWidgets?: TrayWidgetConfig[];
};

function hydrateCachedTraySnapshot(): CachedTraySnapshot | undefined {
  try {
    const raw = localStorage.getItem(traySnapshotCacheKey);
    if (!raw) {
      return undefined;
    }
    return JSON.parse(raw) as CachedTraySnapshot;
  } catch {
    try {
      localStorage.removeItem(traySnapshotCacheKey);
    } catch {
      // Ignore storage failures; the panel just loads fresh.
    }
    return undefined;
  }
}

const cachedTraySnapshot = hydrateCachedTraySnapshot();

export function TrayApp() {
  const t = useTrayText();
  const formatError = useTrayErrorText();
  useTrayThemePreference();
  const [allSnapshots, setAllSnapshots] = useState<SnapshotMap>(() => ({
    ...emptySnapshots,
    ...(cachedTraySnapshot?.snapshots ? { "30d": cachedTraySnapshot.snapshots["30d"] } : {})
  }));
  const [configuredProviders, setConfiguredProviders] = useState<AppConfig["Providers"]>(cachedTraySnapshot?.configuredProviders ?? []);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(Boolean(cachedTraySnapshot));
  const [selectedProvider, setSelectedProvider] = useState<string>();
  const [snapshots, setSnapshots] = useState<SnapshotMap>(cachedTraySnapshot?.snapshots ?? emptySnapshots);
  const [accountSnapshots, setAccountSnapshots] = useState<ProviderAccountSnapshot[]>(cachedTraySnapshot?.accounts ?? []);
  const [accountRefreshing, setAccountRefreshing] = useState(false);
  const [trayWidgets, setTrayWidgets] = useState<TrayWidgetConfig[]>(cachedTraySnapshot?.trayWidgets ?? DEFAULT_TRAY_WIDGETS);
  const [selectedRange, setSelectedRange] = useState<TrayHeaderRange>("30d");
  const refreshGeneration = useRef(0);
  const accountRefreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!window.ccr) {
      setSnapshots(emptySnapshots);
      setAllSnapshots(emptySnapshots);
      setAccountSnapshots([]);
      return;
    }

    const generation = ++refreshGeneration.current;
    setLoading(true);
    setError("");
    try {
      const payload = await window.ccr.getTraySnapshot(selectedProvider);
      if (generation !== refreshGeneration.current) {
        return;
      }
      const configuredProviders = payload.config.Providers.filter((provider) => isGatewayProviderEnabled(provider) && provider.name.trim());
      setSnapshots(payload.snapshots);
      setAllSnapshots((current) => ({ ...current, "30d": payload.allMonth ?? payload.snapshots["30d"] }));
      setAccountSnapshots(payload.accounts);
      setConfiguredProviders(configuredProviders);
      setTrayWidgets(normalizeTrayWidgets(payload.config.trayWidgets, payload.config.trayWindowModules, payload.config.trayComponentVariants));
      applyTrayThemePreference(payload.config.theme);
      setLoadedOnce(true);
      try {
        localStorage.setItem(traySnapshotCacheKey, JSON.stringify({
          accounts: payload.accounts,
          configuredProviders,
          snapshots: payload.snapshots,
          theme: payload.config.theme,
          trayWidgets
        } satisfies CachedTraySnapshot));
      } catch {
        // Storage quota or privacy mode — the panel still works, it just
        // starts from an empty state next launch.
      }
    } catch (nextError) {
      if (generation === refreshGeneration.current) {
        setError(formatError(nextError));
      }
    } finally {
      if (generation === refreshGeneration.current) {
        setLoading(false);
      }
    }
  }, [formatError, selectedProvider]);

  const refreshAccountSnapshots = useCallback(async () => {
    if (!window.ccr) {
      setAccountSnapshots([]);
      return;
    }

    const generation = ++accountRefreshGeneration.current;
    setAccountRefreshing(true);
    setError("");
    try {
      const accounts = await window.ccr.getProviderAccountSnapshots(selectedProvider, { forceRefresh: true });
      if (generation !== accountRefreshGeneration.current) {
        return;
      }
      setAccountSnapshots(accounts);
    } catch (nextError) {
      if (generation === accountRefreshGeneration.current) {
        setError(formatError(nextError));
      }
    } finally {
      if (generation === accountRefreshGeneration.current) {
        setAccountRefreshing(false);
      }
    }
  }, [formatError, selectedProvider]);

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
      void window.ccr?.setTrayDetailOpen(false);
    };
  }, []);

  // The panel window is created once and only hidden afterwards, so gate the
  // poll on document visibility: a hidden panel stops querying stats, and
  // reopening it refreshes immediately instead of showing up-to-a-minute-old
  // throttled data.
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

  const tabs = useMemo(() => createSourceTabs(allSnapshots["30d"].models, configuredProviders), [allSnapshots, configuredProviders]);
  const activeStats = snapshots[selectedRange];
  const activeTotals = activeStats.totals;
  const topModel = activeStats.models[0];
  const hasProviderSwitcher = trayWidgets.some((widget) => widget.type === "source-tabs");
  const hasAnyVisibleModule = trayWidgets.length > 0;
  const showSkeleton = loading && !loadedOnce;

  useEffect(() => {
    if (!hasProviderSwitcher && selectedProvider) {
      setSelectedProvider(undefined);
    }
  }, [hasProviderSwitcher, selectedProvider]);

  useEffect(() => {
    if (!selectedProvider) {
      return;
    }
    const stillAvailable = tabs.some((tab) => tab.provider === selectedProvider);
    if (!stillAvailable) {
      setSelectedProvider(undefined);
    }
  }, [selectedProvider, tabs]);

  return (
    <main className="h-screen w-screen overflow-hidden bg-transparent text-slate-100">
      <aside className="tray-shell flex h-full min-h-0 flex-col overflow-y-auto p-3">
        <TrayStatusStrip totalTokens={activeTotals.totalTokens} />

        <section className="space-y-2">
          {showSkeleton ? (
            <>
              <div className="tray-panel flex h-10 items-center px-3">
                <div className="h-3 w-32 animate-pulse rounded bg-white/10" />
              </div>
              <div className="tray-panel h-9 px-3 py-2">
                <div className="h-full w-full animate-pulse rounded bg-white/10" />
              </div>
              <div className="tray-panel h-28 p-3">
                <div className="h-full w-full animate-pulse rounded bg-white/10" />
              </div>
              <div className="tray-panel h-16 px-3 py-3">
                <div className="h-full w-full animate-pulse rounded bg-white/10" />
              </div>
            </>
          ) : (
            trayWidgets.map((widget, index) => (
              <TrayRuntimeWidget
                accountSnapshots={accountSnapshots}
                accountRefreshing={accountRefreshing}
                activeStats={activeStats}
                activeTotals={activeTotals}
                activitySeries={snapshots["180d"]?.series}
                index={index}
                key={`${widget.id}-${index}`}
                selectedRange={selectedRange}
                selectedProvider={selectedProvider}
                tabs={tabs}
                topModel={topModel}
                widget={widget}
                onChangeRange={setSelectedRange}
                onRefreshAccount={refreshAccountSnapshots}
                onSelectProvider={setSelectedProvider}
              />
            ))
          )}
        </section>

        {loading ? <div className="mt-1.5 text-[11px] font-medium text-slate-300/55">{t("Syncing usage...")}</div> : null}

        {error ? <div className="mt-3 rounded-[12px] border border-rose-400/20 bg-rose-500/15 px-3 py-2 text-[12px] font-medium text-rose-100">{error}</div> : null}

        {!hasAnyVisibleModule && !error ? (
          <div className="tray-panel-subtle flex min-h-[260px] items-center justify-center px-4 text-center text-[12px] font-medium text-slate-400">
            {t("No tray modules enabled")}
          </div>
        ) : null}
      </aside>
    </main>
  );
}

function TrayRuntimeWidget({
  accountSnapshots,
  accountRefreshing,
  activeStats,
  activeTotals,
  activitySeries,
  index,
  selectedRange,
  selectedProvider,
  tabs,
  topModel,
  widget,
  onChangeRange,
  onRefreshAccount,
  onSelectProvider
}: {
  accountSnapshots: ProviderAccountSnapshot[];
  accountRefreshing: boolean;
  activeStats: SnapshotMap["30d"];
  activeTotals: UsageTotals;
  activitySeries?: SnapshotMap["180d"]["series"];
  index: number;
  selectedRange: TrayHeaderRange;
  selectedProvider?: string;
  tabs: SourceTab[];
  topModel?: UsageComparisonRow;
  widget: TrayWidgetConfig;
  onChangeRange: (range: TrayHeaderRange) => void;
  onRefreshAccount: () => void | Promise<void>;
  onSelectProvider: (provider?: string) => void;
}) {
  const t = useTrayText();

  if (widget.type === "source-tabs") {
    return <SourceGrid selectedProvider={selectedProvider} tabs={tabs} onSelect={onSelectProvider} />;
  }

  if (widget.type === "header") {
    return (
      <div className="tray-panel flex min-w-0 items-start justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <h1 className="truncate text-[13px] font-bold text-slate-50">{selectedProvider ? formatProviderName(selectedProvider) : t("Usage Overview")}</h1>
          <p className="mt-0.5 truncate text-[10px] font-medium text-slate-400">{formatUpdated(activeStats.generatedAt, t)}</p>
        </div>
        <TrayHeaderRangeSwitch range={selectedRange} onChange={onChangeRange} />
      </div>
    );
  }

  if (widget.type === "account") {
    return <AccountSummaryPanel refreshing={accountRefreshing} snapshots={accountSnapshots} variant={(widget.variant ?? defaultTrayWidgetVariant("account")) as TrayComponentVariants["account"]} onRefresh={onRefreshAccount} />;
  }

  if (widget.type === "token-flow") {
    return (
      <ChartShell meta={topModel?.label ?? t("No model yet")} title={`${rangeLabel(selectedRange, t)} ${t("Token Flow")}`}>
        <AnimatedUsageChart chartId={`overview-flow-${index}`} series={activeStats.series} variant={(widget.variant ?? defaultTrayWidgetVariant("token-flow")) as TrayComponentVariants["tokenFlow"]} />
      </ChartShell>
    );
  }

  if (widget.type === "activity") {
    return <TokenActivityPanel activitySeries={activitySeries} series={activeStats.series} />;
  }

  if (widget.type === "stats") {
    return (
      <StatsGrid
        items={[
          { label: `${rangeLabel(selectedRange, t)} ${t("tokens")}`, value: formatCompactNumber(activeTotals.totalTokens) },
          { label: `${rangeLabel(selectedRange, t)} ${t("requests")}`, value: formatCompactNumber(activeTotals.requestCount) },
          { label: `${rangeLabel(selectedRange, t)} ${t("Cost")}`, value: formatUsdCost(activeTotals.costUsd) },
          { label: t("Success rate"), value: formatPercent(activeTotals.successRate) }
        ]}
        variant={(widget.variant ?? defaultTrayWidgetVariant("stats")) as TrayComponentVariants["stats"]}
      />
    );
  }

  if (widget.type === "token-mix") {
    return <TokenMixPanel totals={activeTotals} variant={(widget.variant ?? defaultTrayWidgetVariant("token-mix")) as TrayComponentVariants["tokenMix"]} />;
  }

  if (widget.type === "rings") {
    return <RingMetrics totals={activeTotals} variant={(widget.variant ?? defaultTrayWidgetVariant("rings")) as TrayComponentVariants["rings"]} />;
  }

  return <ModelShareChart rows={activeStats.models} variant={(widget.variant ?? defaultTrayWidgetVariant("model-share")) as TrayComponentVariants["modelShare"]} />;
}

function TrayHeaderRangeSwitch({
  range,
  onChange
}: {
  range: TrayHeaderRange;
  onChange: (range: TrayHeaderRange) => void;
}) {
  const t = useTrayText();

  return (
    <div className="tray-segmented flex shrink-0">
      {trayHeaderRanges.map((item) => (
        <button
          className="tray-segmented-item h-5 px-1.5 text-[10px] font-semibold"
          data-active={range === item}
          key={item}
          type="button"
          onClick={() => onChange(item)}
        >
          {rangeLabel(item, t)}
        </button>
      ))}
    </div>
  );
}

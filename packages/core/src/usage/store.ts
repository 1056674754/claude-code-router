import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeClaudeAppGatewayRouteId } from "@ccr/core/agents/claude-app/gateway-routes";
import { REQUEST_LOGS_DB_FILE, USAGE_DB_FILE } from "@ccr/core/config/constants";
import {
  estimateUsageCostUsd,
  estimateUsageCostUsdFromLoadedCatalog,
  preloadUsagePriceCatalog,
  providerModelPricingForUsage
} from "@ccr/core/models/pricing-service";
import { createBetterSqliteDatabase, type BetterSqliteDatabase } from "@ccr/core/storage/sqlite-native";
import { normalizeUsageInputTokens } from "@ccr/core/usage/normalization";
import { resolveUsageModelAttribution } from "@ccr/core/usage/model-attribution";
import type {
  AppConfig,
  GatewayProviderProtocol,
  ProviderModelPricing,
  UsageComparisonRow,
  UsageStatsFilter,
  UsageSeriesPoint,
  UsageStatsRange,
  UsageStatsSnapshot,
  UsageTotals
} from "@ccr/core/contracts/app";

type SqlDatabase = BetterSqliteDatabase;
type SqlValue = bigint | Buffer | number | string | null;

type UsageNumbers = {
  cacheReadTokens?: number;
  cacheWrite1hTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWriteTokens?: number;
  inputIncludesCacheTokens?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type UsageEventInput = {
  client?: string;
  costSource?: string;
  costUsd?: number;
  createdAt?: string;
  credentialId?: string;
  durationMs: number;
  logicalModel?: string;
  method: string;
  model?: string;
  modelIsRouteSelector?: boolean;
  path: string;
  provider?: string;
  pricing?: ProviderModelPricing;
  requestId?: string;
  statusCode: number;
  usage?: UsageNumbers;
};

export type UsageCaptureInput = {
  bodyText: string;
  client?: string;
  config?: Pick<AppConfig, "Providers" | "virtualModelProfiles">;
  durationMs: number;
  fallbackModel?: string;
  method: string;
  path: string;
  providerName?: string;
  providerProtocol?: GatewayProviderProtocol;
  requestId?: string;
  responseHeaders: Headers;
  statusCode: number;
};

type UsageStatsQueryOptions = {
  includeProxy?: boolean;
};

type UsageStoreOptions = {
  estimateCost?: typeof estimateUsageCostUsd;
  requestLogDbFile?: string;
};

type UsageWhereClause = {
  params: SqlValue[];
  where: string;
};

type StoredUsageEvent = {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  client: string;
  costSource: string;
  costUsd: number;
  createdAt: string;
  credentialId: string;
  durationMs: number;
  id: number;
  inputTokens: number;
  logicalModel: string;
  method: string;
  model: string;
  outputTokens: number;
  path: string;
  provider: string;
  requestId: string;
  statusCode: number;
  totalTokens: number;
};

type UsageSnapshot = UsageNumbers & {
  model?: string;
};

const usageEvents = new EventEmitter();
const usageStatsRanges = new Set<UsageStatsRange>(["today", "24h", "7d", "30d", "180d"]);
const emptyTotals: UsageTotals = {
  avgDurationMs: 0,
  cacheRatio: 0,
  cacheTokens: 0,
  costUsd: 0,
  errorCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  requestCount: 0,
  successRate: 0,
  totalTokens: 0
};

export class UsageStore {
  private database?: SqlDatabase;
  private readonly estimateCost: typeof estimateUsageCostUsd;
  private initPromise?: Promise<SqlDatabase>;
  private readonly requestLogDbFile?: string;
  private requestLogBackfillFailureLogged = false;
  private rollupsAllDirty = false;
  private lastBackfillAtMs = 0;
  private backfillPendingSince?: Date;
  private usageCostRepair?: Promise<void>;

  constructor(private readonly dbFile: string, options: UsageStoreOptions = {}) {
    this.estimateCost = options.estimateCost ?? estimateUsageCostUsd;
    this.requestLogDbFile = options.requestLogDbFile;
  }

  async record(event: UsageEventInput): Promise<void> {
    const database = await this.getDatabase();
    const usage = event.usage ?? {};
    const inputTokens = normalizeCount(usage.inputTokens);
    const outputTokens = normalizeCount(usage.outputTokens);
    const cacheReadTokens = normalizeCount(usage.cacheReadTokens);
    const cacheWrite1hTokens = normalizeCount(usage.cacheWrite1hTokens);
    const cacheWrite5mTokens = normalizeCount(usage.cacheWrite5mTokens);
    const cacheWriteTokens = normalizeCount(usage.cacheWriteTokens);
    const cacheTokens = cacheReadTokens + cacheWriteTokens;
    const totalTokens = normalizeCount(usage.totalTokens) || inputTokens + outputTokens + cacheTokens;
    const route = event.modelIsRouteSelector === false ? {} : splitRouteSelector(event.model);
    const model = normalizeLabel(route.model ?? event.model, "unknown");
    const provider = normalizeLabel(event.provider ?? route.provider, "unknown");
    const logicalModel = normalizeLabel(event.logicalModel ?? event.model, model);
    const credentialId = normalizeLabel(event.credentialId, "");
    const explicitCost = normalizeOptionalCost(event.costUsd);
    // Price by the model that actually served the request; the client-facing
    // model can be an unrelated route alias with a wildly different price.
    const pricingModel = logicalModel && logicalModel !== "unknown" && logicalModel !== model
      ? logicalModel
      : model;
    const estimatedCost = explicitCost === undefined
      ? await this.estimateCost({
          cacheReadTokens,
          cacheWrite1hTokens,
          cacheWrite5mTokens,
          cacheWriteTokens,
          inputTokens,
          model: pricingModel,
          outputTokens,
          pricing: event.pricing,
          provider
        })
      : undefined;
    const costUsd = explicitCost ?? estimatedCost?.amountUsd;
    const costSource = explicitCost === undefined
      ? estimatedCost?.source ?? ""
      : normalizeLabel(event.costSource, "gateway_billing");

    const statement = database.prepare(`
      INSERT INTO usage_events (
        created_at,
        request_id,
        client,
        method,
        path,
        model,
        logical_model,
        provider,
        credential_id,
        status_code,
        duration_ms,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        cost_usd,
        cost_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    statement.run(
      event.createdAt ?? new Date().toISOString(),
      event.requestId ?? "",
      normalizeLabel(event.client, "unknown"),
      event.method,
      event.path,
      model,
      logicalModel,
      provider,
      credentialId,
      normalizeCount(event.statusCode),
      normalizeCount(event.durationMs),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costUsd ?? null,
      costSource
    );
    usageEvents.emit("recorded");
  }

  async recordCapture(input: UsageCaptureInput): Promise<void> {
    const headersUsage = extractUsageFromBillingHeaders(input.responseHeaders);
    const bodyUsage = extractUsageFromBody(input.bodyText);
    // Normalize each source under its own convention before merging them: on a
    // translated response the billing headers and the body state input tokens
    // differently, and one shared rule is wrong for one of them.
    const usage = mergeUsageSnapshots(
      normalizeUsageInputTokens(headersUsage, {
        path: input.path,
        providerProtocol: input.providerProtocol,
        source: "providerBilling"
      }),
      normalizeUsageInputTokens(bodyUsage, {
        path: input.path,
        source: "responseBody"
      })
    );
    const fallbackAttribution = resolveUsageModelAttribution(input.config, input.fallbackModel);
    const responseAttribution = resolveUsageResponseModelAttribution(input.config, bodyUsage?.model);
    const route = splitRouteSelector(input.fallbackModel);
    const provider =
      input.providerName ??
      readHeader(input.responseHeaders, "x-gateway-target-provider-name") ??
      readHeader(input.responseHeaders, "x-gateway-target-provider") ??
      responseAttribution.provider ??
      fallbackAttribution.provider ??
      route.provider;
    const model = responseAttribution.model ?? fallbackAttribution.model ?? route.model ?? input.fallbackModel;

    await this.record({
      durationMs: input.durationMs,
      method: input.method,
      logicalModel: fallbackAttribution.logicalModel ?? input.fallbackModel,
      model,
      modelIsRouteSelector: false,
      path: input.path,
      client: input.client,
      provider,
      pricing: providerModelPricingForUsage(input.config, provider, model),
      credentialId: readCredentialId(input.responseHeaders),
      requestId: input.requestId,
      statusCode: input.statusCode,
      usage
    });
  }

  async hasRequestId(requestId: string): Promise<boolean> {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      return false;
    }
    const database = await this.getDatabase();
    return queryRows(
      database,
      "SELECT 1 FROM usage_events WHERE request_id = ? LIMIT 1",
      [normalizedRequestId]
    ).length > 0;
  }

  async getStats(range: UsageStatsRange | null | undefined = "7d", filter: UsageStatsFilter | null | undefined = {}): Promise<UsageStatsSnapshot> {
    const database = await this.getDatabase();
    const now = new Date();
    const normalizedRange = normalizeUsageRange(range);
    const since = getRangeSince(normalizedRange, now);
    this.throttledBackfillFromRequestLogs(database, since);
    this.scheduleUsageCostRepair();
    const normalizedFilter = normalizeUsageFilter(filter);
    if (!normalizedFilter.credential) {
      const rollupSnapshot = this.readStatsFromRollups(database, normalizedRange, now, normalizedFilter);
      if (rollupSnapshot) {
        return rollupSnapshot;
      }
    }
    const query = buildUsageWhereClause(since, filter);

    return {
      clientModels: readClientModelRows(database, query),
      generatedAt: now.toISOString(),
      models: readModelRows(database, query),
      providerModels: readProviderModelRows(database, query),
      range: normalizedRange,
      recentRequests: readRecentRequestRows(database, query),
      series: readUsageSeries(database, normalizedRange, now, query),
      totals: readUsageTotals(database, query)
    };
  }

  // Every getStats call used to attach the (multi-GB) request-log database and
  // scan it; a single panel refresh issued that six times. One pass per cycle
  // is enough — overlapping calls widen the pending window instead of re-scanning.
  private throttledBackfillFromRequestLogs(database: SqlDatabase, since: Date): void {
    const nowMs = Date.now();
    if (nowMs - this.lastBackfillAtMs < usageBackfillMinIntervalMs) {
      this.backfillPendingSince = !this.backfillPendingSince || since < this.backfillPendingSince ? since : this.backfillPendingSince;
      return;
    }
    this.lastBackfillAtMs = nowMs;
    const pendingSince = this.backfillPendingSince;
    this.backfillPendingSince = undefined;
    this.backfillFromRequestLogs(database, pendingSince && pendingSince < since ? pendingSince : since);
  }

  // usage_events is the raw fact table; usage_rollups mirrors it aggregated by
  // local day+hour and routing dimensions. Days are recomputed lazily from an
  // event-id watermark, so queries touch only buckets that actually changed.
  private ensureRollupsFresh(database: SqlDatabase): void {
    const maxId = normalizeCount(queryRows(database, "SELECT COALESCE(MAX(id), 0) AS max_id FROM usage_events")[0]?.max_id);
    const watermark = normalizeCount(queryRows(database, "SELECT value FROM usage_rollup_meta WHERE key = 'watermark'")[0]?.value);
    const dirtyAll = this.rollupsAllDirty ||
      this.rollupTimezoneMoved(database);
    if (maxId === watermark && !dirtyAll) {
      return;
    }
    const dayRows = dirtyAll
      ? queryRows(database, "SELECT DISTINCT strftime('%Y-%m-%d', created_at, 'localtime') AS day_key FROM usage_events")
      : queryRows(database, "SELECT DISTINCT strftime('%Y-%m-%d', created_at, 'localtime') AS day_key FROM usage_events WHERE id > ?", [watermark]);
    for (const dayKey of dayRows.map((row) => String(row.day_key ?? "")).filter(Boolean)) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("DELETE FROM usage_rollups WHERE day_key = ?").run(dayKey);
        database.prepare(`
          INSERT INTO usage_rollups
          SELECT
            strftime('%Y-%m-%d', created_at, 'localtime'),
            CAST(strftime('%H', created_at, 'localtime') AS INTEGER),
            provider,
            model,
            client,
            COALESCE(credential_id, ''),
            COUNT(*),
            COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(cache_read_tokens), 0),
            COALESCE(SUM(cache_write_tokens), 0),
            COALESCE(SUM(CASE
              WHEN total_tokens > input_tokens + output_tokens + cache_read_tokens + cache_write_tokens THEN total_tokens
              ELSE input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
            END), 0),
            COALESCE(SUM(CASE
              WHEN total_tokens - output_tokens > input_tokens + cache_read_tokens + cache_write_tokens THEN total_tokens - output_tokens
              ELSE input_tokens + cache_read_tokens + cache_write_tokens
            END), 0),
            COALESCE(SUM(duration_ms), 0),
            COALESCE(SUM(COALESCE(cost_usd, 0)), 0)
          FROM usage_events
          WHERE strftime('%Y-%m-%d', created_at, 'localtime') = ?
          GROUP BY day_key, hour_bucket, provider, model, client, credential_id
        `).run(dayKey);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    database.prepare(`
      INSERT INTO usage_rollup_meta (key, value) VALUES ('watermark', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(maxId));
    this.rollupsAllDirty = false;
  }

  // day_key/hour_bucket are derived with the OS timezone at build time; when
  // the machine moves zones the stored days no longer match localtime reads.
  private rollupTimezoneMoved(database: SqlDatabase): boolean {
    const currentOffset = String(new Date().getTimezoneOffset());
    const stored = queryRows(database, "SELECT value FROM usage_rollup_meta WHERE key = 'tz_offset'")[0]?.value;
    if (stored === undefined) {
      database.prepare(`
        INSERT INTO usage_rollup_meta (key, value) VALUES ('tz_offset', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(currentOffset);
      return false;
    }
    if (String(stored) === currentOffset) {
      return false;
    }
    database.prepare(`
      INSERT INTO usage_rollup_meta (key, value) VALUES ('tz_offset', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(currentOffset);
    return true;
  }

  private readStatsFromRollups(database: SqlDatabase, range: UsageStatsRange, now: Date, filter: UsageStatsFilter): UsageStatsSnapshot | undefined {
    const buckets = buildBuckets(range, now);
    const firstBucket = buckets[0];
    if (!firstBucket) {
      return undefined;
    }
    try {
      this.ensureRollupsFresh(database);
    } catch (error) {
      console.warn(`[usage] Failed to refresh usage rollups: ${formatError(error)}`);
      return undefined;
    }

    const where = buildRollupWindowClause(firstBucket.key, filter);
    const totalsRow = queryRows(database, `SELECT ${usageRollupTotalsSelect} FROM usage_rollups WHERE ${where.where}`, where.params)[0];
    const seriesRows = queryRows(
      database,
      `SELECT day_key, hour_bucket, ${usageRollupTotalsSelect} FROM usage_rollups WHERE ${where.where} GROUP BY day_key, hour_bucket`,
      where.params
    );
    const totalsByBucket = new Map(seriesRows.map((row) => [
      rollupBucketKey(String(row.day_key ?? ""), normalizeCount(row.hour_bucket), range),
      usageTotalsFromRow(row)
    ]));
    const [dayPart, hourPart] = firstBucket.key.split(" ");
    const [year, month, day] = dayPart.split("-").map(Number);
    // The whole snapshot reads at bucket granularity: totals, groups, and
    // recentRequests share the series window so the card stays internally
    // consistent (totals === sum(series)).
    const windowSince = hourPart
      ? new Date(year, month - 1, day, Number(hourPart.slice(0, 2)))
      : new Date(year, month - 1, day);
    const rollupModels = readRollupGroupRows(database, where, "provider, model, MAX(credential_id) AS credential_id", "provider, model", 8).map(mapModelGroupRow);

    return {
      clientModels: applyMaxShare(readRollupGroupRows(database, where, "client, provider, credential_id, model", "client, provider, credential_id, model", 25).map(mapClientModelGroupRow), (row) => row.totalTokens || row.requestCount),
      generatedAt: now.toISOString(),
      models: applyMaxShare(rollupModels, (row) => row.totalTokens || row.requestCount),
      providerModels: applyMaxShare(readRollupGroupRows(database, where, "provider, credential_id, model", "provider, credential_id, model", 25).map(mapProviderModelGroupRow), (row) => row.totalTokens || row.requestCount),
      range,
      recentRequests: readRecentRequestRows(database, buildUsageWhereClause(windowSince, filter)),
      series: buckets.map(({ key, label }) => ({
        ...(totalsByBucket.get(key) ?? { ...emptyTotals }),
        bucket: key,
        label
      })),
      totals: usageTotalsFromRow(totalsRow)
    };
  }

  async getTotalsSince(since: Date, filter: UsageStatsFilter | null | undefined = {}, options: UsageStatsQueryOptions | null | undefined = {}): Promise<UsageTotals> {
    const database = await this.getDatabase();
    this.throttledBackfillFromRequestLogs(database, since);
    this.scheduleUsageCostRepair();
    return readUsageTotals(database, buildUsageWhereClause(since, filter, options));
  }

  /**
   * One sweep per process: prices unpriced events and re-prices events whose
   * cost was estimated from the client-facing route model instead of the
   * upstream model that actually served the request.
   */
  private scheduleUsageCostRepair(): void {
    this.usageCostRepair ??= this.repairUsageEventCosts().catch((error) => {
      console.warn(`[usage] Failed to repair historical usage costs: ${formatError(error)}`);
    });
  }

  async settleUsageCostRepairForTest(): Promise<void> {
    await this.usageCostRepair;
  }

  private async repairUsageEventCosts(): Promise<void> {
    await preloadUsagePriceCatalog();
    const database = await this.getDatabase();
    const pageSize = 500;
    let cursor = 0;
    let repairedAny = false;
    for (let page = 0; page < 200; page += 1) {
      const rows = queryRows(database, `
        SELECT
          id,
          model,
          logical_model,
          provider,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          cache_write_tokens,
          cost_usd
        FROM usage_events
        WHERE id > ? AND (
          (
            cost_usd IS NULL
            AND input_tokens + output_tokens + cache_read_tokens + cache_write_tokens > 0
          ) OR (
            cost_usd IS NOT NULL
            AND cost_source IN ('', 'models.dev', 'litellm', 'openrouter', 'request_log')
            AND logical_model != ''
            AND lower(logical_model) != 'unknown'
            AND lower(logical_model) != lower(model)
          )
        )
        ORDER BY id
        LIMIT ?
      `, [cursor, pageSize]);
      if (rows.length === 0) {
        return;
      }
      const update = database.prepare("UPDATE usage_events SET cost_usd = ?, cost_source = ? WHERE id = ?");
      database.transaction(() => {
        for (const row of rows) {
          cursor = Math.max(cursor, normalizeCount(row.id));
          const model = String(row.model ?? "").trim();
          const logicalModel = String(row.logical_model ?? "").trim();
          const pricingModel = logicalModel && logicalModel.toLowerCase() !== "unknown" && logicalModel.toLowerCase() !== model.toLowerCase()
            ? logicalModel
            : model;
          const cost = estimateUsageCostUsdFromLoadedCatalog({
            cacheReadTokens: normalizeCount(row.cache_read_tokens),
            cacheWriteTokens: normalizeCount(row.cache_write_tokens),
            inputTokens: normalizeCount(row.input_tokens),
            model: pricingModel,
            outputTokens: normalizeCount(row.output_tokens),
            provider: String(row.provider ?? "")
          });
          if (!cost || (row.cost_usd !== null && Math.abs(Number(row.cost_usd) - cost.amountUsd) < 1e-9)) {
            continue;
          }
          update.run(cost.amountUsd, cost.source, normalizeCount(row.id));
          repairedAny = true;
        }
      })();
      if (rows.length < pageSize) {
        if (repairedAny) {
          // Repairs rewrite cost columns in place; the rollup watermark cannot
          // see them, so force the aggregate days to be rebuilt.
          this.rollupsAllDirty = true;
        }
        return;
      }
    }
  }

  private async getDatabase(): Promise<SqlDatabase> {
    if (this.database) {
      return this.database;
    }

    this.initPromise ??= this.open();
    return this.initPromise;
  }

  private async open(): Promise<SqlDatabase> {
    mkdirSync(dirname(this.dbFile), { recursive: true });
    const database = createBetterSqliteDatabase(this.dbFile);
    configureSqliteDatabase(database);

    database.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        request_id TEXT NOT NULL DEFAULT '',
        client TEXT NOT NULL DEFAULT 'unknown',
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'unknown',
        logical_model TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT 'unknown',
        credential_id TEXT NOT NULL DEFAULT '',
        status_code INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        cost_source TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS usage_events_created_at_idx ON usage_events(created_at);
      CREATE INDEX IF NOT EXISTS usage_events_model_idx ON usage_events(model);
      CREATE INDEX IF NOT EXISTS usage_events_path_idx ON usage_events(path);
      CREATE INDEX IF NOT EXISTS usage_events_request_id_idx ON usage_events(request_id);
      CREATE TABLE IF NOT EXISTS usage_rollups (
        day_key TEXT NOT NULL,
        hour_bucket INTEGER NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        client TEXT NOT NULL DEFAULT '',
        credential_id TEXT NOT NULL DEFAULT '',
        request_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        computed_total_tokens INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day_key, hour_bucket, provider, model, client, credential_id)
      );
      CREATE TABLE IF NOT EXISTS usage_rollup_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    ensureUsageSchema(database);

    this.database = database;
    return database;
  }

  private backfillFromRequestLogs(database: SqlDatabase, since: Date): void {
    const requestLogDbFile = this.requestLogDbFile;
    if (!requestLogDbFile || !existsSync(requestLogDbFile)) {
      return;
    }

    let tempRequestLogDbFile: string | undefined;
    try {
      try {
        this.backfillFromAttachedRequestLog(database, requestLogDbFile, since);
      } catch {
        tempRequestLogDbFile = copySqliteDatabaseToTemp(requestLogDbFile);
        this.backfillFromAttachedRequestLog(database, tempRequestLogDbFile, since);
      }
      this.requestLogBackfillFailureLogged = false;
    } catch (error) {
      if (!this.requestLogBackfillFailureLogged) {
        console.warn(`[usage] Failed to backfill usage from request logs: ${formatError(error)}`);
        this.requestLogBackfillFailureLogged = true;
      }
    } finally {
      if (tempRequestLogDbFile) {
        cleanupSqliteTempCopy(tempRequestLogDbFile);
      }
    }
  }

  private backfillFromAttachedRequestLog(database: SqlDatabase, requestLogDbFile: string, since: Date): void {
    database.exec(`ATTACH DATABASE ${sqlString(requestLogDbFile)} AS request_log_source`);
    try {
      database.prepare(`
          INSERT INTO usage_events (
            created_at,
            request_id,
            client,
            method,
            path,
            model,
            logical_model,
            provider,
            credential_id,
            status_code,
            duration_ms,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            total_tokens,
            cost_usd,
            cost_source
          )
          SELECT
            logs.created_at,
            logs.request_id,
            logs.client,
            logs.method,
            logs.path,
            logs.model,
            logs.model,
            logs.provider,
            logs.credential_id,
            logs.status_code,
            logs.duration_ms,
            logs.input_tokens,
            logs.output_tokens,
            logs.cache_read_tokens,
            logs.cache_write_tokens,
            logs.total_tokens,
            logs.cost_usd,
            'request_log'
          FROM request_log_source.request_logs AS logs
          WHERE logs.source_usage_id IS NULL
            AND logs.path NOT LIKE ?
            AND logs.created_at >= ?
            AND NOT EXISTS (
              SELECT 1
              FROM usage_events AS existing
              WHERE (
                logs.request_id <> ''
                AND existing.request_id = logs.request_id
              ) OR (
                logs.request_id = ''
                AND existing.created_at = logs.created_at
                AND existing.path = logs.path
                AND existing.model = logs.model
              )
            )
        `).run("%/count_tokens%", since.toISOString());
    } finally {
      database.exec("DETACH DATABASE request_log_source");
    }
  }
}

export const usageStore = new UsageStore(USAGE_DB_FILE, { requestLogDbFile: REQUEST_LOGS_DB_FILE });

export function onUsageRecorded(listener: () => void): () => void {
  usageEvents.on("recorded", listener);
  return () => {
    usageEvents.off("recorded", listener);
  };
}

function ensureUsageSchema(database: SqlDatabase): void {
  const columns = new Set(
    queryRows(database, "PRAGMA table_info(usage_events)")
      .map((row) => String(row.name ?? ""))
      .filter(Boolean)
  );

  if (!columns.has("client")) {
    database.exec("ALTER TABLE usage_events ADD COLUMN client TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!columns.has("cost_usd")) {
    database.exec("ALTER TABLE usage_events ADD COLUMN cost_usd REAL");
  }
  if (!columns.has("cost_source")) {
    database.exec("ALTER TABLE usage_events ADD COLUMN cost_source TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has("logical_model")) {
    database.exec("ALTER TABLE usage_events ADD COLUMN logical_model TEXT NOT NULL DEFAULT ''");
    database.exec("UPDATE usage_events SET logical_model = model WHERE logical_model = ''");
  }
  if (!columns.has("credential_id")) {
    database.exec("ALTER TABLE usage_events ADD COLUMN credential_id TEXT NOT NULL DEFAULT ''");
  }
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_client_idx ON usage_events(client)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_created_at_idx ON usage_events(created_at)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_credential_id_idx ON usage_events(credential_id)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_model_idx ON usage_events(model)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_path_idx ON usage_events(path)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_request_id_idx ON usage_events(request_id)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_created_filter_idx ON usage_events(created_at, provider, model, credential_id)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_provider_created_at_idx ON usage_events(provider, created_at)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_model_created_at_idx ON usage_events(model, created_at)");
  database.exec("CREATE INDEX IF NOT EXISTS usage_events_credential_created_at_idx ON usage_events(credential_id, created_at)");
}

export async function getUsageStats(range?: UsageStatsRange | null, filter?: UsageStatsFilter | null): Promise<UsageStatsSnapshot> {
  try {
    return await usageStore.getStats(range, filter);
  } catch (error) {
    console.warn(`[usage] Failed to read usage stats: ${formatError(error)}`);
    return emptySnapshot(normalizeUsageRange(range));
  }
}

export async function getTodayUsageTotals(filter?: UsageStatsFilter | null, options?: UsageStatsQueryOptions | null): Promise<UsageTotals> {
  try {
    return await usageStore.getTotalsSince(floorDay(new Date()), filter, options);
  } catch (error) {
    console.warn(`[usage] Failed to read today's usage totals: ${formatError(error)}`);
    return { ...emptyTotals };
  }
}

export async function getUsageTotalsSince(since: Date, filter?: UsageStatsFilter | null, options?: UsageStatsQueryOptions | null): Promise<UsageTotals> {
  try {
    return await usageStore.getTotalsSince(since, filter, options);
  } catch (error) {
    console.warn(`[usage] Failed to read usage totals: ${formatError(error)}`);
    return { ...emptyTotals };
  }
}

export async function recordGatewayUsageCapture(input: UsageCaptureInput): Promise<void> {
  try {
    await usageStore.recordCapture(input);
  } catch (error) {
    console.warn(`[usage] Failed to record usage: ${formatError(error)}`);
  }
}

function resolveUsageResponseModelAttribution(
  config: Pick<AppConfig, "Providers" | "virtualModelProfiles"> | undefined,
  model: string | undefined
) {
  const decodedClaudeRouteModel = model ? decodeClaudeAppGatewayRouteId(model) : undefined;
  if (decodedClaudeRouteModel) {
    const attribution = resolveUsageModelAttribution(config, decodedClaudeRouteModel);
    return !config || attribution.provider ? attribution : {};
  }
  return resolveUsageModelAttribution(config, model, { physicalModel: true });
}

function buildUsageWhereClause(
  since: Date,
  filter: UsageStatsFilter | null | undefined,
  options: UsageStatsQueryOptions | null | undefined = {}
): UsageWhereClause {
  const normalizedFilter = normalizeUsageFilter(filter);
  const normalizedOptions = normalizeUsageQueryOptions(options);
  const where = ["created_at >= ?"];
  const params: SqlValue[] = [since.toISOString()];
  const credential = normalizeFilterValue(normalizedFilter.credential);
  const provider = normalizeFilterValue(normalizedFilter.provider);
  const model = normalizeFilterValue(normalizedFilter.model);

  if (provider) {
    where.push("provider = ?");
    params.push(provider);
  } else if (!normalizedOptions.includeProxy && normalizedFilter.includeProxy !== true) {
    where.push("provider <> ?");
    params.push("proxy");
  }
  if (model) {
    where.push("model = ?");
    params.push(model);
  }
  if (credential) {
    where.push("credential_id = ?");
    params.push(credential);
  }

  return {
    params,
    where: where.join(" AND ")
  };
}

function normalizeUsageRange(range: UsageStatsRange | null | undefined): UsageStatsRange {
  return range && usageStatsRanges.has(range) ? range : "7d";
}

function normalizeUsageFilter(filter: UsageStatsFilter | null | undefined): UsageStatsFilter {
  if (!isRecord(filter)) {
    return {};
  }
  return {
    credential: typeof filter.credential === "string" ? filter.credential : undefined,
    includeProxy: filter.includeProxy === true,
    model: typeof filter.model === "string" ? filter.model : undefined,
    provider: typeof filter.provider === "string" ? filter.provider : undefined
  };
}

function normalizeUsageQueryOptions(options: UsageStatsQueryOptions | null | undefined): UsageStatsQueryOptions {
  return isRecord(options) && options.includeProxy === true ? { includeProxy: true } : {};
}

function configureSqliteDatabase(database: SqlDatabase): void {
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");
}

function queryRows(database: SqlDatabase, sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
  return database.prepare(sql).all(...params) as Record<string, SqlValue>[];
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function copySqliteDatabaseToTemp(file: string): string {
  const target = join(tmpdir(), `ccr-request-logs-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.sqlite`);
  copyFileSync(file, target);
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${file}${suffix}`;
    if (existsSync(source)) {
      copyFileSync(source, `${target}${suffix}`);
    }
  }
  return target;
}

function cleanupSqliteTempCopy(file: string): void {
  for (const item of [file, `${file}-wal`, `${file}-shm`]) {
    rmSync(item, { force: true });
  }
}

function toStoredUsageEvent(row: Record<string, SqlValue>): StoredUsageEvent {
  return {
    cacheReadTokens: normalizeCount(row.cache_read_tokens),
    cacheWriteTokens: normalizeCount(row.cache_write_tokens),
    client: normalizeLabel(String(row.client ?? ""), "unknown"),
    costSource: String(row.cost_source ?? ""),
    costUsd: normalizeCost(row.cost_usd),
    createdAt: String(row.created_at ?? ""),
    credentialId: normalizeLabel(String(row.credential_id ?? ""), ""),
    durationMs: normalizeCount(row.duration_ms),
    id: normalizeCount(row.id),
    inputTokens: normalizeCount(row.input_tokens),
    logicalModel: normalizeLabel(String(row.logical_model ?? row.model ?? ""), "unknown"),
    method: String(row.method ?? ""),
    model: normalizeLabel(String(row.model ?? ""), "unknown"),
    outputTokens: normalizeCount(row.output_tokens),
    path: normalizeLabel(String(row.path ?? ""), "/"),
    provider: normalizeLabel(String(row.provider ?? ""), "unknown"),
    requestId: String(row.request_id ?? ""),
    statusCode: normalizeCount(row.status_code),
    totalTokens: normalizeCount(row.total_tokens)
  };
}

const usageTotalsSelect = `
            COUNT(*) AS request_count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(CASE
              WHEN total_tokens > input_tokens + output_tokens + cache_read_tokens + cache_write_tokens THEN total_tokens
              ELSE input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
            END), 0) AS computed_total_tokens,
            COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS cost_usd,
            COALESCE(SUM(duration_ms), 0) AS duration_ms,
            COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0) AS success_count,
            COALESCE(SUM(CASE
              WHEN total_tokens - output_tokens > input_tokens + cache_read_tokens + cache_write_tokens THEN total_tokens - output_tokens
              ELSE input_tokens + cache_read_tokens + cache_write_tokens
            END), 0) AS prompt_tokens
`;

const usageBackfillMinIntervalMs = 1500;

const usageRollupTotalsSelect = `
      COALESCE(SUM(request_count), 0) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(computed_total_tokens), 0) AS computed_total_tokens,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(duration_ms), 0) AS duration_ms,
      COALESCE(SUM(success_count), 0) AS success_count
`;

function rollupBucketKey(dayKey: string, hourBucket: number, range: UsageStatsRange): string {
  if (range === "today" || range === "24h") {
    return `${dayKey} ${String(hourBucket).padStart(2, "0")}:00`;
  }
  if (range === "7d") {
    return `${dayKey} ${String(Math.floor(hourBucket / 5) * 5).padStart(2, "0")}:00`;
  }
  return dayKey;
}

function buildRollupWindowClause(firstBucketKey: string, filter: UsageStatsFilter): UsageWhereClause {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const separator = firstBucketKey.indexOf(" ");
  if (separator > 0) {
    const dayKey = firstBucketKey.slice(0, separator);
    const hourBucket = Number(firstBucketKey.slice(separator + 1, separator + 3));
    where.push("(day_key > ? OR (day_key = ? AND hour_bucket >= ?))");
    params.push(dayKey, dayKey, hourBucket);
  } else {
    where.push("day_key >= ?");
    params.push(firstBucketKey);
  }
  const provider = normalizeFilterValue(filter.provider);
  if (provider) {
    where.push("provider = ?");
    params.push(provider);
  } else if (filter.includeProxy !== true) {
    where.push("provider <> ?");
    params.push("proxy");
  }
  const model = normalizeFilterValue(filter.model);
  if (model) {
    where.push("model = ?");
    params.push(model);
  }
  return { params, where: where.join(" AND ") };
}

function readUsageTotals(database: SqlDatabase, query: UsageWhereClause): UsageTotals {
  const row = queryRows(
    database,
    `
      SELECT
        ${usageTotalsSelect}
      FROM usage_events
      WHERE ${query.where}
    `,
    query.params
  )[0];
  return usageTotalsFromRow(row);
}

function readUsageSeries(
  database: SqlDatabase,
  range: UsageStatsRange,
  now: Date,
  query: UsageWhereClause
): UsageSeriesPoint[] {
  const unit: "day" | "fiveHour" | "hour" = range === "today" || range === "24h" ? "hour" : range === "7d" ? "fiveHour" : "day";
  const bucketExpression = unit === "hour"
    ? "strftime('%Y-%m-%d %H:00', created_at, 'localtime')"
    : unit === "fiveHour"
      ? "strftime('%Y-%m-%d', created_at, 'localtime') || ' ' || printf('%02d', (CAST(strftime('%H', created_at, 'localtime') AS INTEGER) / 5) * 5) || ':00'"
      : "strftime('%Y-%m-%d', created_at, 'localtime')";
  const rows = queryRows(
    database,
    `
      SELECT
        ${bucketExpression} AS bucket,
        ${usageTotalsSelect}
      FROM usage_events
      WHERE ${query.where}
      GROUP BY bucket
    `,
    query.params
  );
  const totalsByBucket = new Map(rows.map((row) => [String(row.bucket ?? ""), usageTotalsFromRow(row)]));

  return buildBuckets(range, now).map(({ key, label }) => ({
    ...(totalsByBucket.get(key) ?? { ...emptyTotals }),
    bucket: key,
    label
  }));
}

function mapModelGroupRow(row: Record<string, SqlValue>): UsageComparisonRow {
  return {
    ...usageTotalsFromRow(row),
    caption: normalizeLabel(String(row.provider ?? ""), "unknown"),
    credentialId: normalizeFilterValue(String(row.credential_id ?? "")),
    key: `${normalizeLabel(String(row.provider ?? ""), "unknown")}::${normalizeLabel(String(row.model ?? ""), "unknown")}`,
    label: normalizeLabel(String(row.model ?? ""), "unknown"),
    maxShare: 0,
    model: normalizeLabel(String(row.model ?? ""), "unknown"),
    provider: normalizeLabel(String(row.provider ?? ""), "unknown")
  };
}

function mapClientModelGroupRow(row: Record<string, SqlValue>): UsageComparisonRow {
  const client = normalizeLabel(String(row.client ?? ""), "unknown");
  const model = normalizeLabel(String(row.model ?? ""), "unknown");
  const provider = normalizeLabel(String(row.provider ?? ""), "unknown");
  const credentialId = normalizeFilterValue(String(row.credential_id ?? "")) ?? "";
  return {
    ...usageTotalsFromRow(row),
    caption: credentialId ? `${provider} / ${credentialId} / ${model}` : `${provider} / ${model}`,
    client,
    credentialId: credentialId || undefined,
    key: `${client}::${provider}::${credentialId}::${model}`,
    label: client,
    maxShare: 0,
    model,
    provider
  };
}

function mapProviderModelGroupRow(row: Record<string, SqlValue>): UsageComparisonRow {
  const model = normalizeLabel(String(row.model ?? ""), "unknown");
  const provider = normalizeLabel(String(row.provider ?? ""), "unknown");
  const credentialId = normalizeFilterValue(String(row.credential_id ?? "")) ?? "";
  return {
    ...usageTotalsFromRow(row),
    caption: credentialId ? `${credentialId} / ${model}` : model,
    credentialId: credentialId || undefined,
    key: `${provider}::${credentialId}::${model}`,
    label: provider,
    maxShare: 0,
    model,
    provider
  };
}

function readModelRows(database: SqlDatabase, query: UsageWhereClause): UsageComparisonRow[] {
  const rows = readUsageGroupRows(
    database,
    query,
    "provider, model",
    "provider, model, MAX(credential_id) AS credential_id",
    8
  ).map(mapModelGroupRow);
  return applyMaxShare(rows, (row) => row.totalTokens || row.requestCount);
}

function readClientModelRows(database: SqlDatabase, query: UsageWhereClause): UsageComparisonRow[] {
  const rows = readUsageGroupRows(
    database,
    query,
    "client, provider, credential_id, model",
    "client, provider, credential_id, model",
    25
  ).map(mapClientModelGroupRow);
  return applyMaxShare(rows, (row) => row.totalTokens || row.requestCount);
}

function readProviderModelRows(database: SqlDatabase, query: UsageWhereClause): UsageComparisonRow[] {
  const rows = readUsageGroupRows(
    database,
    query,
    "provider, credential_id, model",
    "provider, credential_id, model",
    25
  ).map(mapProviderModelGroupRow);
  return applyMaxShare(rows, (row) => row.totalTokens || row.requestCount);
}

function readRollupGroupRows(
  database: SqlDatabase,
  where: UsageWhereClause,
  selectColumns: string,
  groupBy: string,
  limit: number
): Record<string, SqlValue>[] {
  return queryRows(
    database,
    `
      SELECT
        ${selectColumns},
        ${usageRollupTotalsSelect}
      FROM usage_rollups
      WHERE ${where.where}
      GROUP BY ${groupBy}
      ORDER BY computed_total_tokens DESC, request_count DESC
      LIMIT ?
    `,
    [...where.params, limit]
  );
}

function readUsageGroupRows(
  database: SqlDatabase,
  query: UsageWhereClause,
  groupBy: string,
  selectColumns: string,
  limit: number
): Record<string, SqlValue>[] {
  return queryRows(
    database,
    `
      SELECT
        ${selectColumns},
        ${usageTotalsSelect}
      FROM usage_events
      WHERE ${query.where}
      GROUP BY ${groupBy}
      ORDER BY computed_total_tokens DESC, request_count DESC
      LIMIT ?
    `,
    [...query.params, limit]
  );
}

function readRecentRequestRows(database: SqlDatabase, query: UsageWhereClause): UsageComparisonRow[] {
  const events = queryRows(
    database,
    `
      SELECT
        id,
        created_at,
        request_id,
        client,
        method,
        path,
        model,
        logical_model,
        provider,
        credential_id,
        status_code,
        duration_ms,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        cost_usd,
        cost_source
      FROM usage_events
      WHERE ${query.where}
      ORDER BY created_at DESC, id DESC
      LIMIT 10
    `,
    query.params
  ).map(toStoredUsageEvent).reverse();
  return buildRecentRequestRows(events);
}

function usageTotalsFromRow(row: Record<string, SqlValue> | undefined): UsageTotals {
  const requestCount = normalizeCount(row?.request_count);
  if (requestCount === 0) {
    return { ...emptyTotals };
  }
  const successfulRequests = normalizeCount(row?.success_count);
  const promptTokens = normalizeCount(row?.prompt_tokens);
  const cacheTokens = normalizeCount(row?.cache_read_tokens);
  return {
    avgDurationMs: Math.round(normalizeCount(row?.duration_ms) / requestCount),
    cacheRatio: ratio(cacheTokens, promptTokens),
    cacheTokens,
    costUsd: normalizeCost(row?.cost_usd),
    errorCount: requestCount - successfulRequests,
    inputTokens: normalizeCount(row?.input_tokens),
    outputTokens: normalizeCount(row?.output_tokens),
    requestCount,
    successRate: successfulRequests / requestCount,
    totalTokens: normalizeCount(row?.computed_total_tokens)
  };
}

function buildSeries(range: UsageStatsRange, now: Date, events: StoredUsageEvent[]): UsageSeriesPoint[] {
  const buckets = buildBuckets(range, now);
  const unit = range === "today" || range === "24h" ? "hour" : range === "7d" ? "fiveHour" : "day";
  const grouped = new Map<string, StoredUsageEvent[]>();
  for (const event of events) {
    const key = formatBucketKey(new Date(event.createdAt), unit);
    const bucket = grouped.get(key) ?? [];
    bucket.push(event);
    grouped.set(key, bucket);
  }

  return buckets.map(({ key, label }) => ({
    ...buildTotals(grouped.get(key) ?? []),
    bucket: key,
    label
  }));
}

function buildBuckets(
  range: UsageStatsRange,
  now: Date
): Array<{ key: string; label: string }> {
  if (range === "today" || range === "24h") {
    const start = range === "today" ? floorDay(now) : floorHour(now);
    if (range === "24h") {
      start.setHours(start.getHours() - 23);
    }
    const count = range === "today" ? floorHour(now).getHours() + 1 : 24;
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(start);
      date.setHours(start.getHours() + index);
      return {
        key: formatBucketKey(date, "hour"),
        label: `${String(date.getHours()).padStart(2, "0")}:00`
      };
    });
  }

  if (range === "7d") {
    // 5-hour buckets over the last 7 days: 168h / 5h = 34 windows, the last
    // one a 3h partial. Matches the 5-hour quota round most providers use.
    const start = floorDay(now);
    start.setDate(start.getDate() - 6);
    return Array.from({ length: 34 }, (_, index) => {
      const date = new Date(start);
      date.setHours(start.getHours() + index * 5);
      return {
        key: formatBucketKey(date, "fiveHour"),
        label: `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:00`
      };
    });
  }

  const count = range === "180d" ? 180 : 30;
  const start = floorDay(now);
  start.setDate(start.getDate() - (count - 1));
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      key: formatBucketKey(date, "day"),
      label: `${date.getMonth() + 1}/${date.getDate()}`
    };
  });
}

function buildRecentRequestRows(events: StoredUsageEvent[]): UsageComparisonRow[] {
  const recent = events.slice(-10).reverse();
  const rows = recent.map((event) => ({
    ...buildTotals([event]),
    caption: `${formatRequestTime(event.createdAt)} · ${event.client} · ${event.path} · ${event.statusCode}`,
    client: event.client,
    credentialId: event.credentialId || undefined,
    key: String(event.id),
    label: event.model || "unknown",
    logicalModel: event.logicalModel,
    maxShare: 0,
    model: event.model,
    provider: event.provider
  }));

  return applyMaxShare(rows, (row) => row.totalTokens || row.avgDurationMs || 1);
}

function applyMaxShare<T extends UsageComparisonRow>(
  rows: T[],
  readValue: (row: T) => number
): T[] {
  const max = Math.max(...rows.map(readValue), 0);
  return rows.map((row) => ({
    ...row,
    maxShare: max > 0 ? readValue(row) / max : 0
  }));
}

function buildTotals(events: StoredUsageEvent[]): UsageTotals {
  if (events.length === 0) {
    return { ...emptyTotals };
  }

  const requestCount = events.length;
  const inputTokens = sum(events, (event) => event.inputTokens);
  const outputTokens = sum(events, (event) => event.outputTokens);
  const cacheTokens = sum(events, (event) => event.cacheReadTokens);
  const costUsd = sum(events, (event) => event.costUsd);
  const totalTokens = sum(events, totalTokenCount);
  const promptTokens = sum(events, promptTokenCount);
  const successfulRequests = events.filter((event) => event.statusCode >= 200 && event.statusCode < 400).length;
  const errorCount = requestCount - successfulRequests;

  return {
    avgDurationMs: Math.round(sum(events, (event) => event.durationMs) / requestCount),
    cacheRatio: ratio(cacheTokens, promptTokens),
    cacheTokens,
    costUsd,
    errorCount,
    inputTokens,
    outputTokens,
    requestCount,
    successRate: successfulRequests / requestCount,
    totalTokens
  };
}

function promptTokenCount(event: StoredUsageEvent): number {
  const cacheTokens = event.cacheReadTokens + event.cacheWriteTokens;
  const promptTokensFromTotal = event.totalTokens - event.outputTokens;
  return Math.max(event.inputTokens + cacheTokens, promptTokensFromTotal);
}

function totalTokenCount(event: StoredUsageEvent): number {
  return Math.max(
    event.totalTokens,
    event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens
  );
}

function extractUsageFromBillingHeaders(headers: Headers): UsageNumbers | undefined {
  const inputTokens = readNumberHeader(headers, "x-gateway-billing-input-tokens");
  const outputTokens = readNumberHeader(headers, "x-gateway-billing-output-tokens");
  const cacheReadTokens = readNumberHeader(headers, "x-gateway-billing-cache-read-tokens");
  const cacheWrite1hTokens = readNumberHeader(headers, "x-gateway-billing-cache-write-1h-tokens");
  const cacheWrite5mTokens = readNumberHeader(headers, "x-gateway-billing-cache-write-5m-tokens");
  const cacheWriteTokens = readNumberHeader(headers, "x-gateway-billing-cache-write-tokens") ??
    sumOptionalNumbers(cacheWrite5mTokens, cacheWrite1hTokens);
  const totalTokens = readNumberHeader(headers, "x-gateway-billing-total-tokens");

  if ([inputTokens, outputTokens, cacheReadTokens, cacheWrite1hTokens, cacheWrite5mTokens, cacheWriteTokens, totalTokens].every((value) => value === undefined)) {
    return undefined;
  }

  return {
    cacheReadTokens,
    cacheWrite1hTokens,
    cacheWrite5mTokens,
    cacheWriteTokens,
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function extractUsageFromBody(text: string): UsageSnapshot | undefined {
  const snapshots: UsageSnapshot[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = parseJson(trimmed);
  if (parsed !== undefined) {
    const snapshot = extractUsageSnapshot(parsed);
    return snapshot && hasUsageNumbers(snapshot) ? snapshot : undefined;
  }

  for (const payload of parseStreamPayloads(trimmed)) {
    const snapshot = extractUsageSnapshot(payload);
    if (snapshot && hasUsageNumbers(snapshot)) {
      snapshots.push(snapshot);
    }
  }

  let merged: UsageSnapshot | undefined;
  for (const snapshot of snapshots) {
    merged = mergeUsageSnapshots(snapshot, merged);
  }
  return merged;
}

function parseStreamPayloads(text: string): unknown[] {
  const payloads: unknown[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line.startsWith("{") ? line : "";
    if (!payload || payload === "[DONE]") {
      continue;
    }
    const parsed = parseJson(payload);
    if (parsed !== undefined) {
      payloads.push(parsed);
    }
  }
  return payloads;
}

function extractUsageSnapshot(payload: unknown): UsageSnapshot | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const response = isRecord(payload.response) ? payload.response : payload;
  const message = isRecord(payload.message) ? payload.message : undefined;
  const usage = isRecord(response.usage)
    ? response.usage
    : isRecord(payload.usage)
      ? payload.usage
      : isRecord(message?.usage)
        ? message.usage
      : undefined;
  const usageMetadata = isRecord(response.usageMetadata)
    ? response.usageMetadata
    : isRecord(payload.usageMetadata)
      ? payload.usageMetadata
      : undefined;

  if (usageMetadata) {
    return {
      cacheReadTokens: asNumber(usageMetadata.cachedContentTokenCount),
      inputIncludesCacheTokens: true,
      inputTokens: asNumber(usageMetadata.promptTokenCount),
      model: asString(response.modelVersion) ?? asString(payload.modelVersion),
      outputTokens: asNumber(usageMetadata.candidatesTokenCount),
      totalTokens: asNumber(usageMetadata.totalTokenCount)
    };
  }

  if (!usage) {
    return undefined;
  }

  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : undefined;
  const hasAnthropicCacheFields =
    usage.cache_read_input_tokens !== undefined ||
    usage.cache_creation_input_tokens !== undefined;
  const hasOpenAiCacheFields =
    inputDetails?.cached_tokens !== undefined ||
    inputDetails?.cache_creation_tokens !== undefined ||
    usage.cached_tokens !== undefined ||
    usage.prompt_tokens !== undefined;
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const cacheWrite5mTokens = asNumber(cacheCreation?.ephemeral_5m_input_tokens);
  const cacheWrite1hTokens = asNumber(cacheCreation?.ephemeral_1h_input_tokens);

  return {
    cacheReadTokens:
      asNumber(usage.cache_read_tokens) ??
      asNumber(usage.cache_read_input_tokens) ??
      asNumber(usage.cached_tokens) ??
      asNumber(inputDetails?.cached_tokens),
    cacheWrite1hTokens,
    cacheWrite5mTokens,
    cacheWriteTokens:
      asNumber(usage.cache_write_tokens) ??
      asNumber(usage.cache_creation_tokens) ??
      asNumber(usage.cache_creation_input_tokens) ??
      asNumber(inputDetails?.cache_creation_tokens) ??
      sumOptionalNumbers(cacheWrite5mTokens, cacheWrite1hTokens),
    inputIncludesCacheTokens: hasAnthropicCacheFields ? false : hasOpenAiCacheFields ? true : undefined,
    inputTokens: asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens),
    model:
      asString(response.model) ??
      asString(payload.model) ??
      asString(message?.model) ??
      asString(response.modelVersion) ??
      asString(payload.modelVersion),
    outputTokens: asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens),
    totalTokens: asNumber(usage.total_tokens)
  };
}

function hasUsageNumbers(snapshot: UsageNumbers): boolean {
  return [
    snapshot.cacheReadTokens,
    snapshot.cacheWrite1hTokens,
    snapshot.cacheWrite5mTokens,
    snapshot.cacheWriteTokens,
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.totalTokens
  ].some((value) => value !== undefined);
}

function mergeUsageSnapshots(primary: UsageNumbers | undefined, fallback: UsageSnapshot | undefined): UsageSnapshot | undefined {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    ...fallback,
    ...Object.fromEntries(Object.entries(primary).filter(([, value]) => value !== undefined))
  };
}

function sumOptionalNumbers(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

function readHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value || undefined;
}

function readCredentialId(headers: Headers): string | undefined {
  return readHeader(headers, "x-ccr-provider-credential-id") ?? parseCredentialChain(readHeader(headers, "x-ccr-provider-credential-chain"))[0];
}

function parseCredentialChain(value: string | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of (value ?? "").split(",")) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function readNumberHeader(headers: Headers, name: string): number | undefined {
  return asNumber(readHeader(headers, name));
}

function asNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : undefined;
}

function normalizeCount(value: unknown): number {
  return asNumber(value) ?? 0;
}

function normalizeCost(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeOptionalCost(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function splitRouteSelector(value: string | undefined): { model?: string; provider?: string } {
  const trimmed = value?.trim();
  if (!trimmed) {
    return {};
  }

  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator >= trimmed.length - 1) {
    return { model: trimmed };
  }

  return {
    model: trimmed.slice(separator + 1).trim(),
    provider: trimmed.slice(0, separator).trim()
  };
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function normalizeFilterValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function getRangeSince(range: UsageStatsRange, now: Date): Date {
  const date = new Date(now);
  if (range === "today") {
    return floorDay(date);
  }
  if (range === "24h") {
    date.setHours(date.getHours() - 24);
  } else if (range === "7d") {
    date.setDate(date.getDate() - 7);
  } else if (range === "180d") {
    date.setDate(date.getDate() - 180);
  } else {
    date.setDate(date.getDate() - 30);
  }
  return date;
}

function floorHour(date: Date): Date {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  return next;
}

function floorDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function formatBucketKey(date: Date, unit: "day" | "fiveHour" | "hour"): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  if (unit === "day") {
    return `${year}-${month}-${day}`;
  }
  const rawHour = unit === "fiveHour" ? Math.floor(date.getHours() / 5) * 5 : date.getHours();
  const hour = String(rawHour).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:00`;
}

function formatRequestTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function ratio(numerator: number, denominator: number): number {
  if (numerator <= 0 || denominator <= 0) {
    return 0;
  }
  return Math.min(1, numerator / denominator);
}

function sum<T>(items: T[], read: (item: T) => number): number {
  return items.reduce((total, item) => total + read(item), 0);
}

function emptySnapshot(range: UsageStatsRange): UsageStatsSnapshot {
  return {
    clientModels: [],
    generatedAt: new Date().toISOString(),
    models: [],
    providerModels: [],
    range,
    recentRequests: [],
    series: buildSeries(range, new Date(), []),
    totals: { ...emptyTotals }
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

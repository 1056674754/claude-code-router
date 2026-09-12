import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RequestLogStore } from "@ccr/core/observability/request-log-store.ts";
import { resetUsagePriceCatalogForTest } from "@ccr/core/models/pricing-service.ts";
import { createBetterSqliteDatabase } from "@ccr/core/storage/sqlite-native.ts";
import { GatewayBillingSynchronizer } from "@ccr/core/usage/billing-sync.ts";
import { resolveUsageModelAttribution } from "@ccr/core/usage/model-attribution.ts";
import { UsageStore } from "@ccr/core/usage/store.ts";

const fusionUsageConfig = {
  Providers: [
    {
      baseUrl: "https://api.moonshot.cn/anthropic",
      models: ["kimi-for-coding", "kimi-vision"],
      name: "Kimi Code - Coding Plan",
      type: "anthropic_messages"
    },
    {
      baseUrl: "https://api.example.com/v1",
      models: ["openai-vision"],
      name: "OpenAI Compatible",
      type: "openai_chat_completions"
    }
  ],
  virtualModelProfiles: [
    {
      baseModel: { fixedModel: "Kimi Code - Coding Plan/kimi-for-coding", mode: "fixed" },
      enabled: true,
      id: "kimisearch",
      key: "kimisearch",
      match: { exactAliases: ["kimisearch"], prefixes: [], suffixes: [] }
    }
  ]
};

test("Fusion usage attribution resolves fixed aliases to their upstream model", () => {
  assert.deepEqual(resolveUsageModelAttribution(fusionUsageConfig, "Fusion/kimisearch"), {
    logicalModel: "Fusion/kimisearch",
    model: "kimi-for-coding",
    provider: "Kimi Code - Coding Plan"
  });
});

test("Fusion usage attribution mirrors gateway virtual-model precedence and target rewriting", () => {
  const config = {
    Providers: [
      { models: ["base", "web-base-tail", "web-special-base"], name: "Requested", type: "openai_chat_completions" },
      { models: ["long-prefix", "short-prefix", "suffix"], name: "Targets", type: "openai_chat_completions" }
    ],
    virtualModelProfiles: [
      {
        baseModel: { fixedModel: "Targets/short-prefix", mode: "fixed" },
        enabled: true,
        match: { exactAliases: [], prefixes: ["web-"], suffixes: [] }
      },
      {
        baseModel: { fixedModel: "Targets/long-prefix", mode: "fixed" },
        enabled: true,
        match: { exactAliases: [], prefixes: ["web-special-"], suffixes: [] }
      },
      {
        baseModel: { fixedModel: "Targets/suffix", mode: "fixed" },
        enabled: true,
        match: { exactAliases: [], prefixes: [], suffixes: ["-tail"] }
      },
      {
        baseModel: { mode: "request" },
        enabled: true,
        match: { exactAliases: [], prefixes: ["raw-"], suffixes: [] }
      }
    ]
  };

  assert.deepEqual(resolveUsageModelAttribution(config, "Requested/web-special-base"), {
    logicalModel: "Requested/web-special-base",
    model: "long-prefix",
    provider: "Targets"
  });
  assert.deepEqual(resolveUsageModelAttribution(config, "Requested/web-base-tail"), {
    logicalModel: "Requested/web-base-tail",
    model: "suffix",
    provider: "Targets"
  });
  assert.deepEqual(resolveUsageModelAttribution(config, "Requested/raw-base"), {
    logicalModel: "Requested/raw-base",
    model: "base",
    provider: "Requested"
  });
});

test("usage attribution preserves slash-containing physical model IDs", () => {
  const model = "accounts/fireworks/models/llama-v3p2-11b-vision-instruct";
  assert.deepEqual(resolveUsageModelAttribution(fusionUsageConfig, model, { physicalModel: true }), {
    logicalModel: model,
    model
  });
});

test("UsageStore supports the 180d range with daily buckets", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    await store.record({
      createdAt: new Date().toISOString(),
      durationMs: 10,
      method: "POST",
      model: "long-window",
      path: "/v1/messages",
      provider: "alpha",
      requestId: "req-180d",
      statusCode: 200,
      usage: { inputTokens: 8, outputTokens: 2 }
    });

    const stats = await store.getStats("180d", { includeProxy: true });
    assert.equal(stats.totals.totalTokens, 10);
    assert.equal(stats.series.length, 180);
    assert.equal(stats.range, "180d");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore buckets the 7d range into aligned 5-hour windows", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-7d-buckets-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    for (const [createdAt, requestId] of [[now, "req-7d-now"], [threeDaysAgo, "req-7d-old"]]) {
      await store.record({
        createdAt: createdAt.toISOString(),
        durationMs: 10,
        method: "POST",
        model: "windowed",
        path: "/v1/messages",
        provider: "alpha",
        requestId,
        statusCode: 200,
        usage: { inputTokens: 5, outputTokens: 1 }
      });
    }

    const stats = await store.getStats("7d", { includeProxy: true });
    assert.equal(stats.series.length, 34);
    for (const point of stats.series) {
      assert.match(point.bucket, /^\d{4}-\d{2}-\d{2} (00|05|10|15|20):00$/);
    }
    const filled = stats.series.filter((point) => point.requestCount > 0);
    assert.equal(filled.reduce((sum, point) => sum + point.requestCount, 0), 2);
    assert.ok(filled.length >= 2);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore aggregates stats in SQLite without loading all events", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    await store.record({
      createdAt: earlier.toISOString(),
      durationMs: 120,
      method: "POST",
      model: "alpha-model",
      path: "/v1/messages",
      provider: "alpha",
      requestId: "req-1",
      statusCode: 200,
      usage: {
        cacheReadTokens: 2,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 17
      }
    });
    await store.record({
      createdAt: now.toISOString(),
      durationMs: 80,
      method: "POST",
      model: "beta-model",
      path: "/v1/messages",
      provider: "beta",
      requestId: "req-2",
      statusCode: 500,
      usage: {
        inputTokens: 4,
        outputTokens: 6
      }
    });

    const stats = await store.getStats("30d", { includeProxy: true });
    assert.equal(stats.totals.requestCount, 2);
    assert.equal(stats.totals.errorCount, 1);
    assert.equal(stats.totals.totalTokens, 27);
    assert.equal(stats.totals.inputTokens, 14);
    assert.equal(stats.totals.outputTokens, 11);
    assert.equal(stats.recentRequests.length, 2);
    assert.equal(stats.models[0]?.requestCount, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore cache ratio denominator includes cache tokens when total tokens omit cache", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-cache-ratio-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));

    await store.record({
      createdAt: new Date().toISOString(),
      durationMs: 50,
      method: "POST",
      model: "glm-cache",
      path: "/v1/messages",
      provider: "zhipu",
      requestId: "cache-ratio-total-omits-cache",
      statusCode: 200,
      usage: {
        cacheReadTokens: 90,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    });

    const stats = await store.getStats("30d");
    assert.equal(stats.totals.totalTokens, 105);
    assert.equal(stats.totals.cacheRatio, 0.9);
    assert.equal(stats.models[0]?.cacheRatio, 0.9);
    assert.equal(stats.recentRequests[0]?.totalTokens, 105);
    assert.equal(stats.recentRequests[0]?.cacheRatio, 0.9);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore excludes proxy rows by default and includes them on request", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-proxy-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const createdAt = new Date().toISOString();

    await store.record({
      createdAt,
      durationMs: 10,
      method: "POST",
      model: "direct/model-a",
      path: "/v1/messages",
      requestId: "direct-1",
      statusCode: 200,
      usage: {
        inputTokens: 5,
        outputTokens: 7
      }
    });
    await store.record({
      createdAt,
      durationMs: 10,
      method: "POST",
      model: "proxy-model",
      path: "/v1/messages",
      provider: "proxy",
      requestId: "proxy-1",
      statusCode: 200,
      usage: {
        inputTokens: 100,
        outputTokens: 200
      }
    });

    const defaultStats = await store.getStats("30d");
    assert.equal(defaultStats.totals.requestCount, 1);
    assert.equal(defaultStats.totals.totalTokens, 12);
    assert.equal(defaultStats.providerModels[0]?.provider, "direct");
    assert.equal(defaultStats.providerModels[0]?.model, "model-a");

    const withProxy = await store.getStats("30d", { includeProxy: true });
    assert.equal(withProxy.totals.requestCount, 2);
    assert.equal(withProxy.totals.totalTokens, 312);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore treats null web RPC usage filters as empty filters", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-null-filter-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));

    await store.record({
      createdAt: new Date().toISOString(),
      durationMs: 10,
      method: "POST",
      model: "alpha-model",
      path: "/v1/messages",
      provider: "alpha",
      requestId: "req-null-filter",
      statusCode: 200,
      usage: {
        inputTokens: 3,
        outputTokens: 4
      }
    });

    const stats = await store.getStats("7d", null);
    assert.equal(stats.range, "7d");
    assert.equal(stats.totals.requestCount, 1);

    const defaultRangeStats = await store.getStats(null, null);
    assert.equal(defaultRangeStats.range, "7d");
    assert.equal(defaultRangeStats.totals.requestCount, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore keeps the Fusion logical model while grouping by the upstream model", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-fusion-attribution-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    await store.record({
      createdAt: new Date().toISOString(),
      durationMs: 25,
      logicalModel: "Fusion/kimisearch",
      method: "POST",
      model: "kimi-for-coding",
      path: "/v1/messages",
      provider: "Kimi Code - Coding Plan",
      requestId: "fusion-request-1",
      statusCode: 200,
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }
    });

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.models[0]?.model, "kimi-for-coding");
    assert.equal(stats.models[0]?.provider, "Kimi Code - Coding Plan");
    assert.equal(stats.recentRequests[0]?.logicalModel, "Fusion/kimisearch");
    assert.equal(stats.totals.requestCount, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore attributes Claude App encoded response model IDs to the routed upstream model", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-claude-app-encoded-model-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const encodedModel = `anthropic/claude-ccr-h${Buffer.from("Fusion/kimisearch", "utf8").toString("hex")}`;

    await store.recordCapture({
      bodyText: [
        "event: message_start",
        `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"${encodedModel}","usage":{"input_tokens":12,"output_tokens":8,"total_tokens":20}}}`,
        "",
        "data: [DONE]",
        ""
      ].join("\n"),
      client: "Claude Code",
      config: fusionUsageConfig,
      durationMs: 100,
      fallbackModel: "Fusion/kimisearch",
      method: "POST",
      path: "/v1/messages",
      providerProtocol: "anthropic_messages",
      requestId: "encoded-claude-app-model",
      responseHeaders: new Headers({ "content-type": "text/event-stream; charset=utf-8" }),
      statusCode: 200
    });

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.models[0]?.model, "kimi-for-coding");
    assert.equal(stats.models[0]?.provider, "Kimi Code - Coding Plan");
    assert.equal(stats.recentRequests[0]?.logicalModel, "Fusion/kimisearch");
    assert.notEqual(stats.models[0]?.model, encodedModel);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lightweight usage synchronization records and deduplicates Fusion internal upstream calls", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-fusion-internal-test-"));
  try {
    let estimateCallCount = 0;
    const store = new UsageStore(path.join(dir, "usage.sqlite"), {
      estimateCost: async () => {
        estimateCallCount += 1;
        return { amountUsd: 99, model: "unexpected", source: "litellm" };
      }
    });
    const synchronizer = new GatewayBillingSynchronizer({ getConfig: () => fusionUsageConfig, store });
    const event = {
      billing: {
        cost: { total: 0.001 },
        usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 }
      },
      emittedAt: new Date().toISOString(),
      eventId: "fusion-vision-event-1",
      outcome: { status: "success", statusCode: 200 },
      performance: { latency_ms: 150 },
      route: { method: "POST", url: "/v1/chat/completions" },
      schema: "ccr.fusion-usage.v1",
      source: { adapterKey: "openai_chat", provider: "fusion_vision" },
      target: {
        credentialId: "test-1",
        model: "kimi-vision",
        providerName: "Kimi Code - Coding Plan"
      }
    };

    assert.equal(await synchronizer.ingest(event), true);
    assert.equal(await store.hasRequestId(event.eventId), true);
    assert.equal(await synchronizer.ingest(event), true);
    assert.equal(await synchronizer.ingest({
      ...event,
      eventId: "top-level-embedding-event",
      source: { adapterKey: "openai_embeddings", provider: "openai" }
    }), false);
    assert.equal(await synchronizer.ingest({ ...event, eventId: "legacy-full-billing-event", schema: undefined }), false);

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.totals.requestCount, 1);
    assert.equal(stats.totals.totalTokens, 55);
    assert.equal(stats.totals.costUsd, 0.001);
    assert.equal(stats.models[0]?.model, "kimi-vision");
    assert.equal(stats.models[0]?.provider, "Kimi Code - Coding Plan");
    assert.equal(stats.recentRequests[0]?.credentialId, "test-1");
    assert.equal(estimateCallCount, 0);

    const database = createBetterSqliteDatabase(path.join(dir, "usage.sqlite"));
    try {
      const queryPlan = database
        .prepare("EXPLAIN QUERY PLAN SELECT 1 FROM usage_events WHERE request_id = ? LIMIT 1")
        .all(event.eventId)
        .map((row) => String(row.detail ?? ""))
        .join("\n");
      assert.match(queryPlan, /usage_events_request_id_idx/);
    } finally {
      database.close();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lightweight Fusion usage normalizes OpenAI cache tokens and estimates unconfigured zero costs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-fusion-zero-cost-test-"));
  try {
    const estimatedInputs = [];
    const store = new UsageStore(path.join(dir, "usage.sqlite"), {
      estimateCost: async (input) => {
        estimatedInputs.push(input);
        return { amountUsd: 0.0025, model: input.model, source: "litellm" };
      }
    });
    const synchronizer = new GatewayBillingSynchronizer({ getConfig: () => fusionUsageConfig, store });

    assert.equal(await synchronizer.ingest({
      billing: {
        cost: { total: 0 },
        usage: {
          cache_read_tokens: 10,
          input_tokens: 50,
          output_tokens: 5,
          total_tokens: 55
        }
      },
      emittedAt: new Date().toISOString(),
      eventId: "fusion-vision-zero-cost-event",
      outcome: { status: "success", statusCode: 200 },
      performance: { latency_ms: 100 },
      route: { method: "POST", url: "/v1/chat/completions" },
      schema: "ccr.fusion-usage.v1",
      source: { adapterKey: "openai_chat", provider: "fusion_vision" },
      target: {
        model: "openai-vision",
        providerName: "OpenAI Compatible::openai_chat_completions"
      }
    }), true);

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.totals.inputTokens, 40);
    assert.equal(stats.totals.cacheTokens, 10);
    assert.equal(stats.totals.totalTokens, 55);
    assert.equal(stats.totals.costUsd, 0.0025);
    assert.equal(stats.models[0]?.provider, "OpenAI Compatible");
    assert.deepEqual(estimatedInputs, [{
      cacheReadTokens: 10,
      cacheWrite1hTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 40,
      model: "openai-vision",
      outputTokens: 5,
      pricing: undefined,
      provider: "OpenAI Compatible"
    }]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lightweight Fusion usage preserves slash-containing external model IDs through storage", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-fusion-external-model-test-"));
  try {
    const estimatedInputs = [];
    const store = new UsageStore(path.join(dir, "usage.sqlite"), {
      estimateCost: async (input) => {
        estimatedInputs.push(input);
        return { amountUsd: 0.004, model: input.model, source: "litellm" };
      }
    });
    const synchronizer = new GatewayBillingSynchronizer({ getConfig: () => fusionUsageConfig, store });
    const model = "accounts/fireworks/models/llama-v3p2-11b-vision-instruct";

    assert.equal(await synchronizer.ingest({
      billing: {
        cost: {},
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
      },
      emittedAt: new Date().toISOString(),
      eventId: "fusion-external-slash-model-event",
      outcome: { status: "success", statusCode: 200 },
      performance: { latency_ms: 100 },
      route: { method: "POST", url: "/v1/chat/completions" },
      schema: "ccr.fusion-usage.v1",
      source: { adapterKey: "openai_chat", provider: "fusion_vision" },
      target: { model }
    }), true);

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.models[0]?.model, model);
    assert.equal(stats.models[0]?.provider, "unknown");
    assert.equal(stats.recentRequests[0]?.logicalModel, model);
    assert.deepEqual(estimatedInputs, [{
      cacheReadTokens: 0,
      cacheWrite1hTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 10,
      model,
      outputTokens: 3,
      pricing: undefined,
      provider: "unknown"
    }]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lightweight Fusion usage honors numeric-string zero costs from global core billing rates", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-fusion-global-rate-test-"));
  try {
    let estimateCallCount = 0;
    const store = new UsageStore(path.join(dir, "usage.sqlite"), {
      estimateCost: async () => {
        estimateCallCount += 1;
        return { amountUsd: 99, model: "unexpected", source: "litellm" };
      }
    });
    const synchronizer = new GatewayBillingSynchronizer({
      getConfig: () => fusionUsageConfig,
      getGlobalBillingConfig: () => ({
        rates: {
          openai: {
            cacheReadPerMillionUsd: "0",
            cacheWritePerMillionUsd: "0",
            inputPerMillionUsd: "0",
            outputPerMillionUsd: "0"
          }
        }
      }),
      store
    });

    assert.equal(await synchronizer.ingest({
      billing: {
        cost: { total: 0 },
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
      },
      emittedAt: new Date().toISOString(),
      eventId: "fusion-global-zero-rate-event",
      outcome: { status: "success", statusCode: 200 },
      performance: { latency_ms: 100 },
      route: { method: "POST", url: "/v1/chat/completions" },
      schema: "ccr.fusion-usage.v1",
      source: { adapterKey: "openai_chat", provider: "fusion_vision" },
      target: {
        model: "openai-vision",
        providerName: "OpenAI Compatible::openai_chat_completions"
      }
    }), true);

    const stats = await store.getStats("today", { includeProxy: true });
    assert.equal(stats.totals.costUsd, 0);
    assert.equal(estimateCallCount, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("lightweight Fusion usage coalesces concurrent deliveries of the same event", async () => {
  let hasRequestIdCallCount = 0;
  let recordCallCount = 0;
  let releaseRecord;
  let markRecordStarted;
  const recordStarted = new Promise((resolve) => {
    markRecordStarted = resolve;
  });
  const recordReleased = new Promise((resolve) => {
    releaseRecord = resolve;
  });
  const store = {
    hasRequestId: async () => {
      hasRequestIdCallCount += 1;
      return false;
    },
    record: async () => {
      recordCallCount += 1;
      markRecordStarted();
      await recordReleased;
    }
  };
  const synchronizer = new GatewayBillingSynchronizer({ getConfig: () => fusionUsageConfig, store });
  const event = {
    billing: {
      cost: { total: 0.001 },
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
    },
    emittedAt: new Date().toISOString(),
    eventId: "fusion-concurrent-event",
    outcome: { status: "success", statusCode: 200 },
    performance: { latency_ms: 100 },
    route: { method: "POST", url: "/v1/chat/completions" },
    schema: "ccr.fusion-usage.v1",
    source: { adapterKey: "openai_chat", provider: "fusion_vision" },
    target: { model: "openai-vision", providerName: "OpenAI Compatible" }
  };

  const first = synchronizer.ingest(event);
  await recordStarted;
  const second = synchronizer.ingest(event);
  releaseRecord();

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(hasRequestIdCallCount, 1);
  assert.equal(recordCallCount, 1);
});

test("UsageStore backfills missing events from request logs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-request-log-backfill-test-"));
  try {
    const requestLogDbFile = path.join(dir, "request-logs.sqlite");
    const requestLogStore = new RequestLogStore(requestLogDbFile);
    const usageStore = new UsageStore(path.join(dir, "usage.sqlite"), { requestLogDbFile });
    const createdAt = new Date().toISOString();

    await requestLogStore.record({
      client: "Claude Code",
      completedAt: createdAt,
      durationMs: 25,
      method: "POST",
      path: "/v1/messages",
      providerName: "alpha",
      requestBody: Buffer.from(JSON.stringify({ model: "alpha-model" })),
      requestHeaders: { "content-type": "application/json" },
      requestId: "req-backfill-1",
      responseBodyText: JSON.stringify({
        model: "alpha-model",
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17
        }
      }),
      responseHeaders: new Headers({ "content-type": "application/json" }),
      startedAt: createdAt,
      statusCode: 200,
      url: "http://127.0.0.1:3456/v1/messages"
    });

    const stats = await usageStore.getStats("today", { includeProxy: true });
    assert.equal(stats.totals.requestCount, 1);
    assert.equal(stats.totals.totalTokens, 17);
    assert.equal(stats.providerModels[0]?.provider, "alpha");
    assert.equal(stats.providerModels[0]?.model, "alpha-model");

    const reread = await usageStore.getStats("today", { includeProxy: true });
    assert.equal(reread.totals.requestCount, 1);
    assert.equal(reread.totals.totalTokens, 17);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore reset clears overview stats and does not backfill old request logs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-reset-test-"));
  try {
    const requestLogDbFile = path.join(dir, "request-logs.sqlite");
    const requestLogStore = new RequestLogStore(requestLogDbFile);
    const usageStore = new UsageStore(path.join(dir, "usage.sqlite"), { requestLogDbFile });
    const beforeResetAt = new Date().toISOString();

    await requestLogStore.record({
      client: "Claude Code",
      completedAt: beforeResetAt,
      durationMs: 25,
      method: "POST",
      path: "/v1/messages",
      providerName: "alpha",
      requestBody: Buffer.from(JSON.stringify({ model: "alpha-model" })),
      requestHeaders: { "content-type": "application/json" },
      requestId: "req-reset-before",
      responseBodyText: JSON.stringify({
        model: "alpha-model",
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17
        }
      }),
      responseHeaders: new Headers({ "content-type": "application/json" }),
      startedAt: beforeResetAt,
      statusCode: 200,
      url: "http://127.0.0.1:3456/v1/messages"
    });

    const before = await usageStore.getStats("today", { includeProxy: true });
    assert.equal(before.totals.requestCount, 1);

    const reset = await usageStore.resetStatistics();
    assert.equal(reset.deletedEvents, 1);

    const afterReset = await usageStore.getStats("today", { includeProxy: true });
    assert.equal(afterReset.totals.requestCount, 0);
    assert.equal(afterReset.totals.totalTokens, 0);

    const afterResetAt = new Date(Date.parse(reset.resetAt) + 1000).toISOString();
    await requestLogStore.record({
      client: "Claude Code",
      completedAt: afterResetAt,
      durationMs: 40,
      method: "POST",
      path: "/v1/messages",
      providerName: "beta",
      requestBody: Buffer.from(JSON.stringify({ model: "beta-model" })),
      requestHeaders: { "content-type": "application/json" },
      requestId: "req-reset-after",
      responseBodyText: JSON.stringify({
        model: "beta-model",
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          total_tokens: 10
        }
      }),
      responseHeaders: new Headers({ "content-type": "application/json" }),
      startedAt: afterResetAt,
      statusCode: 200,
      url: "http://127.0.0.1:3456/v1/messages"
    });

    const afterNewRequest = await usageStore.getStats("today", { includeProxy: true });
    assert.equal(afterNewRequest.totals.requestCount, 1);
    assert.equal(afterNewRequest.totals.totalTokens, 10);
    assert.equal(afterNewRequest.providerModels[0]?.provider, "beta");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore prices usage by the upstream logical model instead of the route alias", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-test-"));
  try {
    const pricedModels = [];
    const store = new UsageStore(path.join(dir, "usage.sqlite"), {
      estimateCost: async (input) => {
        pricedModels.push(input.model ?? "");
        return { amountUsd: 0.01, model: input.model ?? "", source: "models.dev" };
      }
    });

    await store.record({
      durationMs: 10,
      logicalModel: "Ctyun/deepseek-v4-flash-vision-exp-0817",
      method: "POST",
      model: "claude-opus-5",
      path: "/v1/messages",
      provider: "Ctyun",
      requestId: "req-alias",
      statusCode: 200,
      usage: { inputTokens: 10, outputTokens: 5 }
    });
    await store.record({
      durationMs: 10,
      logicalModel: "glm-5.3",
      method: "POST",
      model: "glm-5.3",
      path: "/v1/messages",
      provider: "Zhipu GLM",
      requestId: "req-same",
      statusCode: 200,
      usage: { inputTokens: 10, outputTokens: 5 }
    });

    assert.deepEqual(pricedModels, [
      "Ctyun/deepseek-v4-flash-vision-exp-0817",
      "glm-5.3"
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore repairs mispriced and unpriced historical events from the upstream model", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("models.dev")) {
      return new Response(JSON.stringify({
        deepseek: {
          models: {
            "deepseek-v4-flash-vision-exp": {
              cost: { input: 0.242, output: 0.726 },
              id: "deepseek-v4-flash-vision-exp"
            }
          }
        }
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(url.includes("openrouter") ? "{\"data\":[]}" : "{}", {
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    resetUsagePriceCatalogForTest();
  });
  resetUsagePriceCatalogForTest();

  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-test-"));
  try {
    const dbFile = path.join(dir, "usage.sqlite");
    const store = new UsageStore(dbFile, {
      estimateCost: async () => undefined
    });
    for (const requestId of ["legacy-unpriced", "legacy-mispriced"]) {
      await store.record({
        durationMs: 10,
        logicalModel: "Ctyun/deepseek-v4-flash-vision-exp-0817",
        method: "POST",
        model: "claude-opus-5",
        path: "/v1/messages",
        provider: "Ctyun",
        requestId,
        statusCode: 200,
        usage: { inputTokens: requestId === "legacy-unpriced" ? 1_000_000 : 2_000_000 }
      });
    }

    const seed = createBetterSqliteDatabase(dbFile);
    seed.exec("UPDATE usage_events SET cost_usd = 46.381, cost_source = 'models.dev' WHERE request_id = 'legacy-mispriced'");
    seed.close();

    await store.getStats("30d", { includeProxy: true });
    await store.settleUsageCostRepairForTest();

    const verify = createBetterSqliteDatabase(dbFile);
    const rows = verify.prepare("SELECT request_id, cost_usd, cost_source FROM usage_events ORDER BY request_id").all();
    verify.close();

    const unpriced = rows.find((row) => row.request_id === "legacy-unpriced");
    const mispriced = rows.find((row) => row.request_id === "legacy-mispriced");
    assert.ok(Math.abs((unpriced?.cost_usd ?? 0) - 0.242) < 1e-9);
    assert.equal(unpriced?.cost_source, "models.dev");
    assert.ok(Math.abs((mispriced?.cost_usd ?? 0) - 0.484) < 1e-9);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("UsageStore rollup path keeps totals, shares, and window edges consistent", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccr-usage-rollup-consistency-test-"));
  try {
    const store = new UsageStore(path.join(dir, "usage.sqlite"));
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    for (const [createdAt, requestId, tokens] of [
      [now, "req-rollup-now", 7],
      [threeDaysAgo, "req-rollup-mid", 11],
      [eightDaysAgo, "req-rollup-old", 500]
    ]) {
      await store.record({
        createdAt: createdAt.toISOString(),
        durationMs: 12,
        method: "POST",
        model: "rollup-model",
        path: "/v1/messages",
        provider: "alpha",
        requestId,
        statusCode: requestId === "req-rollup-now" ? 500 : 200,
        usage: { inputTokens: tokens, outputTokens: 1 }
      });
    }

    const stats = await store.getStats("7d", { includeProxy: true });
    const seriesTotal = stats.series.reduce((sum, point) => sum + point.requestCount, 0);
    assert.equal(stats.totals.requestCount, seriesTotal);
    assert.equal(stats.totals.requestCount, 2);
    assert.equal(stats.totals.errorCount, 1);

    const model = stats.models.find((row) => row.model === "rollup-model");
    assert.ok(model);
    assert.equal(model.maxShare, 1);
    assert.ok(stats.providerModels.every((row) => row.maxShare > 0));
    assert.ok(stats.clientModels.every((row) => row.maxShare > 0));
    assert.ok(stats.recentRequests.every((row) => row.model === "rollup-model"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});


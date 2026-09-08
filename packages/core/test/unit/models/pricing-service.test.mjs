import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateUsageCostUsd,
  estimateUsageCostUsdFromLoadedCatalog,
  providerModelPricingForUsage,
  resetUsagePriceCatalogForTest
} from "@ccr/core/models/pricing-service.ts";

const pricing = {
  cacheReadUsdPerMillionTokens: 0.5,
  cacheWriteUsdPerMillionTokens: 3,
  inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 8
};

test("custom model pricing is used without loading the remote catalog", async () => {
  const input = {
    cacheReadTokens: 250000,
    cacheWriteTokens: 100000,
    inputTokens: 1000000,
    model: "custom-model",
    outputTokens: 500000,
    pricing,
    provider: "Custom"
  };

  assert.deepEqual(await estimateUsageCostUsd(input), {
    amountUsd: 6.425,
    model: "custom-model",
    source: "custom"
  });
  assert.deepEqual(estimateUsageCostUsdFromLoadedCatalog(input), {
    amountUsd: 6.425,
    model: "custom-model",
    source: "custom"
  });
});

test("custom pricing requires both input and output prices", async () => {
  const result = estimateUsageCostUsdFromLoadedCatalog({
    inputTokens: 1000,
    model: "custom-model",
    pricing: { inputUsdPerMillionTokens: 2 },
    provider: "Custom"
  });

  assert.equal(result, undefined);
});

test("custom pricing applies separate 5m and 1h cache-write rates", () => {
  const result = estimateUsageCostUsdFromLoadedCatalog({
    cacheWrite1hTokens: 40000,
    cacheWrite5mTokens: 60000,
    cacheWriteTokens: 120000,
    model: "custom-model",
    pricing: {
      cacheWrite1hUsdPerMillionTokens: 6,
      cacheWrite5mUsdPerMillionTokens: 3,
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 8
    },
    provider: "Custom"
  });

  assert.ok(Math.abs((result?.amountUsd ?? 0) - 0.48) < 1e-12);
  assert.equal(result?.model, "custom-model");
  assert.equal(result?.source, "custom");
});

test("provider model pricing lookup is case-insensitive and accepts a full selector", () => {
  const config = {
    Providers: [{
      modelMetadata: { "Custom-Model": { pricing } },
      models: ["Custom-Model"],
      name: "Custom"
    }]
  };

  assert.deepEqual(providerModelPricingForUsage(config, "custom", "CUSTOM/Custom-Model"), pricing);
  assert.equal(providerModelPricingForUsage(config, "other", "custom-model"), undefined);
});

test("catalog pricing falls back to the undated entry for dated model snapshots", async (t) => {
  const previousFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async (input) => {
    fetched += 1;
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

  const result = await estimateUsageCostUsd({
    inputTokens: 1_000_000,
    model: "Ctyun/deepseek-v4-flash-vision-exp-0817",
    outputTokens: 0,
    provider: "Ctyun"
  });

  assert.ok(fetched > 0);
  assert.equal(result?.source, "models.dev");
  assert.ok(Math.abs((result?.amountUsd ?? 0) - 0.242) < 1e-12);
});

test("catalog pricing still prefers an exact match over the undated fallback", async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("models.dev")) {
      return new Response(JSON.stringify({
        alibaba: {
          models: {
            "qwen3.8-flash": {
              cost: { input: 0.15, output: 0.47 },
              id: "qwen3.8-flash"
            },
            "qwen3.8-flash-0919": {
              cost: { input: 0.3, output: 0.94 },
              id: "qwen3.8-flash-0919"
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

  const result = await estimateUsageCostUsd({
    inputTokens: 1_000_000,
    model: "qwen3.8-flash-0919",
    outputTokens: 0,
    provider: "Ctyun"
  });

  assert.ok(Math.abs((result?.amountUsd ?? 0) - 0.3) < 1e-12);
});

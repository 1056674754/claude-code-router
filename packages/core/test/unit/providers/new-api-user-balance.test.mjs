import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test, { before } from "node:test";

const root = path.join(process.env.CCR_INTERNAL_HOME_DIR || os.tmpdir(), `new-api-user-balance-${process.pid}`);
process.env.CCR_INTERNAL_HOME_DIR = path.join(root, "home");
process.env.CCR_INTERNAL_APP_DATA_DIR = path.join(root, "app-data");
process.env.CCR_INTERNAL_USER_DATA_DIR = path.join(root, "user-data");

const providerName = "New API Relay";
const relayBaseUrl = "https://relay.example/v1";
const relayApiKey = "sk-relay-key";
const accessToken = "console-access-token";
const userId = "1121";

let accountApi;
let configApi;
let newApi;

before(async () => {
  configApi = await import("@ccr/core/config/config.ts");
  accountApi = await import("@ccr/core/providers/account-service.ts");
  newApi = await import("@ccr/core/providers/new-api.ts");
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status
  });
}

// Mirrors a New API relay: the key endpoint reports an unlimited key, and the
// account endpoint only answers when the console access token is present.
function mockRelay(t, options = {}) {
  const quota = options.quota ?? 115468675;
  const usedQuota = options.usedQuota ?? 156736325;
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries({ ...(init?.headers ?? {}) }).map(([key, value]) => [key.toLowerCase(), value])
    );
    calls.push({ headers, url });
    if (url.endsWith("/api/usage/token/")) {
      return jsonResponse({
        code: true,
        data: {
          expires_at: 0,
          name: "CC",
          total_available: -153814306,
          total_granted: 615748,
          total_used: 154430054,
          unlimited_quota: true
        },
        message: "ok"
      });
    }
    if (url.endsWith("/api/user/self")) {
      if (!String(headers.authorization ?? "").includes(accessToken)) {
        return jsonResponse({ code: "AUTH_UNAUTHORIZED", message: "Unauthorized, invalid access token", success: false }, 401);
      }
      return jsonResponse({
        data: { group: "default", quota, used_quota: usedQuota },
        success: true
      });
    }
    throw new Error(`unexpected account request: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  return calls;
}

async function setRelayConnectors(connectors) {
  const config = await configApi.loadAppConfig();
  await configApi.saveAppConfig({
    ...config,
    Providers: [
      ...config.Providers.filter((provider) => provider.name !== providerName),
      {
        account: { connectors, enabled: true },
        api_base_url: relayBaseUrl,
        api_key: relayApiKey,
        models: ["claude-sonnet-5-5"],
        name: providerName,
        type: "openai_chat_completions"
      }
    ]
  });
  accountApi.invalidateProviderAccountSnapshotCache(providerName);
}

async function relaySnapshot() {
  const [snapshot] = await accountApi.getProviderAccountSnapshots(providerName, { forceRefresh: true });
  assert.ok(snapshot, "expected an account snapshot");
  return snapshot;
}

test("unlimited New API keys produce the account-balance guidance, not a quota meter", async (t) => {
  const calls = mockRelay(t);
  await setRelayConnectors([newApi.newApiKeyUsageAccountConfig(relayBaseUrl).connectors[0]]);

  const snapshot = await relaySnapshot();
  assert.deepEqual(snapshot.meters, []);
  assert.match(snapshot.message ?? "", /no dedicated quota limit/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.headers.authorization, `Bearer ${relayApiKey}`);
});

test("user balance connector reports its placeholders instead of sending them to the relay", async (t) => {
  const calls = mockRelay(t);
  await setRelayConnectors([
    newApi.newApiKeyUsageAccountConfig(relayBaseUrl).connectors[0],
    newApi.newApiUserSelfConnectorConfig(relayBaseUrl)
  ]);

  const snapshot = await relaySnapshot();
  assert.deepEqual(snapshot.meters, []);
  // The guidance from the key connector still explains what is missing, while
  // the connector error now names the two headers that must be filled in.
  assert.match(snapshot.message ?? "", /no dedicated quota limit/i);
  assert.equal(snapshot.errors?.length, 1);
  assert.match(snapshot.errors?.[0]?.message ?? "", /not configured yet/i);
  assert.match(snapshot.errors?.[0]?.message ?? "", /new-api-access-token/);
  assert.deepEqual(calls.map((call) => call.url), ["https://relay.example/api/usage/token/"]);
});

test("configured user balance connector reads the account balance in USD", async (t) => {
  const calls = mockRelay(t);
  await setRelayConnectors([
    newApi.newApiKeyUsageAccountConfig(relayBaseUrl).connectors[0],
    newApi.newApiUserSelfConnectorConfig(relayBaseUrl, { accessToken, userId })
  ]);

  const snapshot = await relaySnapshot();
  const balance = snapshot.meters.find((meter) => meter.id === "new_api_user_balance");
  assert.ok(balance, "expected the user balance meter");
  assert.equal(balance.kind, "balance");
  assert.equal(balance.unit, "USD");
  assert.equal(balance.remaining, 115468675 / 500000);
  assert.equal(balance.used, 156736325 / 500000);
  // No explicit budget: the limit is remaining + used, the account's total credit.
  assert.equal(balance.limit, (115468675 + 156736325) / 500000);
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.errors, undefined);
  // Once the balance answers, the "unlimited key" guidance must stop second
  // guessing what the user still has to configure.
  assert.equal(snapshot.message, undefined);

  const accountCall = calls.find((call) => call.url.endsWith("/api/user/self"));
  assert.ok(accountCall, "expected a call to the account endpoint");
  assert.equal(accountCall.headers.authorization, `Bearer ${accessToken}`);
  assert.equal(accountCall.headers["new-api-user"], userId);
});

test("testing a placeholder connector fails with the header guidance and no request", async (t) => {
  const calls = mockRelay(t);
  await assert.rejects(
    () => accountApi.testProviderAccountConnector({
      apiKey: relayApiKey,
      baseUrl: relayBaseUrl,
      connector: newApi.newApiUserSelfConnectorConfig(relayBaseUrl),
      providerName
    }),
    /not configured yet/i
  );
  assert.equal(calls.length, 0);
});

test("testing the configured connector returns the same USD balance", async (t) => {
  mockRelay(t);
  const result = await accountApi.testProviderAccountConnector({
    apiKey: relayApiKey,
    baseUrl: relayBaseUrl,
    connector: newApi.newApiUserSelfConnectorConfig(relayBaseUrl, { accessToken, userId }),
    providerName
  });
  const balance = result.meters.find((meter) => meter.id === "new_api_user_balance");
  assert.ok(balance);
  assert.equal(balance.unit, "USD");
  assert.equal(balance.remaining, 115468675 / 500000);
});

test("an optional budget turns the balance meter into a warning threshold", async (t) => {
  // 20000000 / 500000 = 40 USD remaining out of a 1000 USD budget: 4% left.
  mockRelay(t, { quota: 20000000, usedQuota: 0 });
  await setRelayConnectors([
    newApi.newApiKeyUsageAccountConfig(relayBaseUrl).connectors[0],
    newApi.newApiUserSelfConnectorConfig(relayBaseUrl, { accessToken, userId, limitUsd: 1000 })
  ]);

  const snapshot = await relaySnapshot();
  const balance = snapshot.meters.find((meter) => meter.id === "new_api_user_balance");
  assert.ok(balance);
  assert.equal(balance.limit, 1000);
  assert.equal(balance.remaining, 40);
  assert.equal(snapshot.status, "critical");

  // Above the 20% warning line the same budget keeps the row healthy.
  mockRelay(t, { quota: 400000000, usedQuota: 0 });
  accountApi.invalidateProviderAccountSnapshotCache(providerName);
  const healthy = await relaySnapshot();
  assert.equal(healthy.meters.find((meter) => meter.id === "new_api_user_balance")?.limit, 1000);
  assert.equal(healthy.status, "ok");
});

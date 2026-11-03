import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { loadAppConfig, saveAppConfig } from "@ccr/core/config/config.ts";
import { compileCoreGatewayConfig } from "@ccr/core/gateway/core-runtime/config-compiler.ts";
import { localAgentProviderApiKey } from "@ccr/core/agents/local-providers/shared.ts";
import { buildCcSwitchCodexProviderConfig } from "@ccr/core/agents/local-providers/service.ts";
import { codexProviderAccountConfig } from "@ccr/core/agents/local-providers/codex.ts";
import {
  codexAccountStoreFile,
  readCcSwitchCodexAccounts,
  readCodexStoredAccount,
  upsertCodexStoredAccount
} from "@ccr/core/providers/codex-account-store.ts";
import { toCoreGatewayProviders } from "@ccr/core/providers/runtime-topology.ts";
import { providerAccountTargetsForTest } from "@ccr/core/providers/account-service.ts";

// The store and cc-switch reader resolve their directories per call, so these
// overrides keep every test isolated inside one throwaway root.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "ccr-codex-oauth-credentials-"));
process.env.CCR_CODEX_ACCOUNT_STORE_DIR = path.join(testRoot, "codex-oauth-accounts");
process.env.CCR_CCSWITCH_OAUTH_FILE = path.join(testRoot, "cc-switch", "codex_oauth_auth.json");

test("codex account store persists accounts and merges token-only refreshes", () => {
  upsertCodexStoredAccount({
    accountId: "acct-1",
    email: "one@example.com",
    refreshToken: "rt-1"
  });
  const stored = readCodexStoredAccount("acct-1");
  assert.equal(stored?.email, "one@example.com");
  assert.equal(stored?.refreshToken, "rt-1");
  assert.ok(existsSync(codexAccountStoreFile("acct-1")));

  // A refresh writes back tokens only; the email written earlier must survive.
  upsertCodexStoredAccount({
    accountId: "acct-1",
    accessToken: "at-1b",
    refreshToken: "rt-1b"
  });
  const merged = readCodexStoredAccount("acct-1");
  assert.equal(merged?.email, "one@example.com");
  assert.equal(merged?.accessToken, "at-1b");
  assert.equal(merged?.refreshToken, "rt-1b");
});

test("cc-switch managed account file maps to store entries", () => {
  // cc-switch v2 writes accounts as a MAP keyed by account id.
  writeCcSwitchFile({
    version: 2,
    default_account_id: "acct-1",
    accounts: {
      "acct-1": {
        account_id: "acct-1",
        chatgpt_account_id: "workspace-1",
        email: "one@example.com",
        refresh_token: "rt-1",
        id_token: "id-1"
      },
      "acct-2": {
        account_id: "acct-2",
        email: "two@example.com",
        refresh_token: "rt-2"
      },
      // No refresh token -> unusable, must be skipped.
      "acct-3": { account_id: "acct-3", email: "three@example.com" }
    }
  });
  const accounts = readCcSwitchCodexAccounts();
  assert.deepEqual(accounts.map((account) => [account.accountId, account.email, account.refreshToken]), [
    ["acct-1", "one@example.com", "rt-1"],
    ["acct-2", "two@example.com", "rt-2"]
  ]);
});

test("cc-switch account file with legacy array shape maps to store entries", () => {
  writeCcSwitchFile({
    version: 1,
    accounts: [
      { id: "acct-a", account_id: "acct-a", email: "a@example.com", refresh_token: "rt-a" }
    ]
  });
  const accounts = readCcSwitchCodexAccounts();
  assert.deepEqual(accounts.map((account) => account.accountId), ["acct-a"]);
});

test("config parse keeps OAuth credentials without an API key", async () => {
  const config = await loadAppConfig();
  config.Providers = [
    {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      credentials: [
        {
          codexOauth: { accountId: "acct-1", refreshToken: "rt-1" },
          id: "codex-acct-acct-1",
          name: "one@example.com",
          priority: 1
        },
        // Static API-key credential on the same provider keeps working.
        { api_key: "sk-static", name: "static" }
      ],
      models: ["gpt-5-codex"],
      name: "Codex ChatGPT",
      type: "openai_responses"
    }
  ];
  const saved = await saveAppConfig(config);
  const provider = saved.Providers.find((item) => item.name === "Codex ChatGPT");
  assert.equal(provider?.credentials?.length, 2);
  assert.equal(provider?.credentials?.[0]?.codexOauth?.accountId, "acct-1");
  assert.equal(provider?.credentials?.[0]?.codexOauth?.refreshToken, "rt-1");
  assert.equal(provider?.credentials?.[1]?.api_key, "sk-static");
});

test("OAuth credentials join the internal provider topology with the sentinel key", () => {
  const provider = codexProviderWithAccounts([
    { accountId: "acct-1", refreshToken: "rt-1" },
    { accountId: "acct-2", refreshToken: "rt-2" }
  ]);
  const coreProviders = toCoreGatewayProviders(provider);
  assert.equal(coreProviders.length, 2);
  for (const [index, core] of coreProviders.entries()) {
    assert.match(core.name, /^.*::openai_responses::cred:/);
    assert.equal(core.apikey, localAgentProviderApiKey);
    assert.equal(core.type, "openai_responses");
    assert.equal(core.name.includes("acct-" + (index + 1)), true);
  }
});

test("compilation emits one OAuth plugin per credential and live auth.json does not stomp other accounts", async () => {
  const home = process.env.CCR_INTERNAL_HOME_DIR;
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  const liveAccessToken = futureJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }, 3600);
  writeFileSync(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: liveAccessToken,
        account_id: "acct-1",
        refresh_token: "live-rt-1"
      }
    })
  );
  // Seed the store so compilation resolves tokens without touching the network.
  upsertCodexStoredAccount({ accountId: "acct-1", accessToken: futureJwt({}, 3600), refreshToken: "store-rt-1" });
  upsertCodexStoredAccount({ accountId: "acct-2", accessToken: futureJwt({}, 3600), refreshToken: "store-rt-2" });
  try {
    const config = createDefaultAppConfig();
    config.Providers = [codexProviderWithAccounts([
      { accountId: "acct-1", refreshToken: "rt-1" },
      { accountId: "acct-2", refreshToken: "rt-2" }
    ])];
    const compiled = await compileCoreGatewayConfig(config, "raw-trace-token", "billing-usage-token", "core-auth-token");
    const plugins = compiled.providerPlugins.filter((item) => typeof item.key === "string" && item.key.includes("-codex-oauth-credential"));
    assert.equal(plugins.length, 2);

    const byAccount = new Map(plugins.map((plugin) => [plugin.codexOauth.accountId, plugin]));
    // Account-bound plugins resolve from the CCR account store (fresh tokens),
    // even when the live ~/.codex/auth.json holds the same account's login.
    assert.equal(byAccount.get("acct-1").codexOauth.refreshToken, "store-rt-1");
    assert.ok(byAccount.get("acct-1").codexOauth.accessToken);
    // A different account must keep its OWN tokens; the single live login may
    // not stomp every plugin (multi-account regression).
    assert.equal(byAccount.get("acct-2").codexOauth.refreshToken, "store-rt-2");
    assert.equal(byAccount.get("acct-2").codexOauth.accountId, "acct-2");
    for (const plugin of plugins) {
      assert.equal(plugin.codexOauth.required, true);
      assert.deepEqual(plugin.request.bodyRemove, ["max_output_tokens", "stop"]);
    }

    const coreProviders = compiled.providers.filter((item) => item.name.includes("::cred:"));
    assert.equal(coreProviders.length, 2);
    assert.ok(coreProviders.every((item) => item.apikey === localAgentProviderApiKey));

    // No duplicate recovery plugin for the covered provider.
    const recovered = compiled.providerPlugins.filter((item) => typeof item.key === "string" && item.key.endsWith("-codex-oauth-recovered"));
    assert.equal(recovered.length, 0);
  } finally {
    rmSync(path.join(home, ".codex"), { force: true, recursive: true });
    rmSync(process.env.CCR_CODEX_ACCOUNT_STORE_DIR, { force: true, recursive: true });
  }
});

test("cc-switch import builds one provider with per-account credentials and seeds the store", async () => {
  writeCcSwitchFile({
    version: 2,
    default_account_id: "acct-1",
    accounts: [
      { account_id: "acct-1", email: "one@example.com", refresh_token: "rt-1" },
      { account_id: "acct-2", email: "two@example.com", refresh_token: "rt-2" }
    ]
  });
  const config = createDefaultAppConfig();
  const { config: nextConfig, result } = await buildCcSwitchCodexProviderConfig(config, {});
  assert.equal(result.created, true);
  assert.equal(result.importedAccounts, 2);
  assert.equal(result.providerName, "Codex ChatGPT");

  const provider = nextConfig.Providers.find((item) => item.name === "Codex ChatGPT");
  assert.equal(provider?.type, "openai_responses");
  assert.equal(provider?.apiKey, localAgentProviderApiKey);
  assert.equal(provider?.credentials?.length, 2);
  assert.equal(provider?.credentials?.[0]?.name, "one@example.com");
  assert.equal(provider?.credentials?.[0]?.codexOauth?.refreshToken, "rt-1");
  assert.equal(provider?.credentials?.[1]?.codexOauth?.refreshToken, "rt-2");

  // The per-account store files were seeded, so the compiler can resolve and
  // refresh tokens even after cc-switch is closed.
  assert.ok(existsSync(codexAccountStoreFile("acct-1")));
  assert.ok(existsSync(codexAccountStoreFile("acct-2")));

  // Re-import refreshes the OAuth credentials but keeps static ones.
  provider.credentials = [
    { api_key: "sk-static", name: "static" },
    ...provider.credentials
  ];
  const { config: mergedConfig, result: mergedResult } = await buildCcSwitchCodexProviderConfig(nextConfig, {});
  assert.equal(mergedResult.created, false);
  const mergedProvider = mergedConfig.Providers.find((item) => item.name === "Codex ChatGPT");
  assert.equal(mergedProvider?.credentials?.length, 3);
  assert.ok(mergedProvider?.credentials?.some((credential) => credential.api_key === "sk-static"));
});

test("OAuth credentials become one account-usage snapshot target per account", () => {
  const provider = {
    ...codexProviderWithAccounts([
      { accountId: "acct-1", refreshToken: "rt-1" },
      { accountId: "acct-2", refreshToken: "rt-2" },
      { accountId: "acct-3", refreshToken: "rt-3" }
    ]),
    account: codexProviderAccountConfig(),
    credentials: [
      ...codexProviderWithAccounts([{ accountId: "acct-1", refreshToken: "rt-1" }]).credentials,
      ...codexProviderWithAccounts([{ accountId: "acct-2", refreshToken: "rt-2" }]).credentials,
      // Disabled accounts must not produce usage targets.
      { ...codexProviderWithAccounts([{ accountId: "acct-3", refreshToken: "rt-3" }]).credentials[0], enabled: false }
    ]
  };
  const targets = providerAccountTargetsForTest(provider);
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((target) => target.credential?.codexOauth?.accountId),
    ["acct-1", "acct-2"]
  );
  assert.ok(targets.every((target) => target.credential?.name));
});

function codexProviderWithAccounts(accounts) {
  return {
    apiKey: localAgentProviderApiKey,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    credentials: accounts.map((account, index) => ({
      codexOauth: { accountId: account.accountId, refreshToken: account.refreshToken },
      id: `codex-acct-${account.accountId}`,
      name: account.email || account.accountId,
      priority: index + 1
    })),
    models: ["gpt-5-codex"],
    name: "Codex ChatGPT",
    type: "openai_responses"
  };
}

function writeCcSwitchFile(payload) {
  mkdirSync(path.dirname(process.env.CCR_CCSWITCH_OAUTH_FILE), { recursive: true });
  writeFileSync(process.env.CCR_CCSWITCH_OAUTH_FILE, JSON.stringify(payload));
}

function futureJwt(claims, expiresInSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + expiresInSeconds })).toString("base64url");
  return `${header}.${payload}.signature`;
}

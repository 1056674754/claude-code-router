import type {
  AppConfig,
  CcSwitchCodexAccountsImportRequest,
  CcSwitchCodexAccountsImportResult,
  GatewayProviderConfig,
  LocalAgentProviderCandidate,
  LocalAgentProviderImportRequest,
  LocalAgentProviderImportResult,
  LocalAgentProviderProbeRequest,
  LocalAgentProviderProbeResult,
  ProviderCredentialConfig
} from "@ccr/core/contracts/app";
import { claudeCodeCandidate, importClaudeCodeProvider } from "@ccr/core/agents/local-providers/claude-code";
import { codexCandidate, codexDefaultBaseUrl, codexDefaultModels, codexProviderAccountConfig, importCodexProvider, probeCodexProvider, readCodexLocalModelCatalog } from "@ccr/core/agents/local-providers/codex";
import { grokCandidate, importGrokProvider } from "@ccr/core/agents/local-providers/grok";
import { importKimiProvider, kimiCandidates } from "@ccr/core/agents/local-providers/kimi";
import { importOpenCodeProvider, opencodeCandidates } from "@ccr/core/agents/local-providers/opencode";
import { importZcodeProvider, zcodeCandidate } from "@ccr/core/agents/local-providers/zcode";
import { readCcSwitchCodexAccounts, upsertCodexStoredAccount } from "@ccr/core/providers/codex-account-store";
import { providerCredentialSlug } from "@ccr/core/providers/runtime-topology";
import { providerPayload } from "@ccr/core/agents/local-providers/shared";

export { codexDefaultBaseUrl, readCodexAuth } from "@ccr/core/agents/local-providers/codex";
export { readClaudeCodeOauth } from "@ccr/core/agents/local-providers/claude-code";
export { grokDefaultBaseUrl, readGrokAuth, resolveGrokAuth } from "@ccr/core/agents/local-providers/grok";
export { kimiAccessTokenExpired, kimiIdentityHeaders, readKimiAuth, resolveKimiAuth } from "@ccr/core/agents/local-providers/kimi";
export { readZcodeLocalProviderCredential, zcodeDefaultBaseUrl } from "@ccr/core/agents/local-providers/zcode";
export { localAgentProviderApiKey, type OAuthTokenSet } from "@ccr/core/agents/local-providers/shared";

export function getLocalAgentProviderCandidates(): LocalAgentProviderCandidate[] {
  return [
    codexCandidate(),
    claudeCodeCandidate(),
    grokCandidate(),
    ...kimiCandidates(),
    ...opencodeCandidates(),
    zcodeCandidate()
  ].filter((candidate) => candidate.status !== "missing");
}

export async function importLocalAgentProvider(request: LocalAgentProviderImportRequest): Promise<LocalAgentProviderImportResult> {
  const candidate = getLocalAgentProviderCandidates().find((item) => item.id === request.id);
  if (!candidate) {
    throw new Error("Local agent provider was not found.");
  }
  if (!candidate.importable) {
    throw new Error(candidate.detail || "Local agent login is not importable.");
  }

  if (candidate.kind === "codex") {
    return importCodexProvider(candidate, request.providerNames ?? []);
  }
  if (candidate.kind === "claude-code") {
    return importClaudeCodeProvider(candidate, request.providerNames ?? []);
  }
  if (candidate.kind === "grok") {
    return importGrokProvider(candidate, request.providerNames ?? []);
  }
  if (candidate.kind === "kimi") {
    return importKimiProvider(candidate, request.providerNames ?? []);
  }
  if (candidate.kind === "opencode") {
    return importOpenCodeProvider(candidate, request.providerNames ?? []);
  }
  return importZcodeProvider(candidate, request.providerNames ?? []);
}

export async function probeLocalAgentProvider(request: LocalAgentProviderProbeRequest): Promise<LocalAgentProviderProbeResult> {
  const candidate = getLocalAgentProviderCandidates().find((item) => item.id === request.id);
  if (!candidate) {
    throw new Error("Local agent provider was not found.");
  }
  if (candidate.kind === "codex") {
    return probeCodexProvider(candidate);
  }
  throw new Error("Local agent provider model probing is not supported.");
}

export type { CcSwitchCodexAccountsImportRequest, CcSwitchCodexAccountsImportResult } from "@ccr/core/contracts/app";

export const ccSwitchCodexDefaultProviderName = "Codex ChatGPT";

// Imports the ChatGPT accounts that cc-switch manages (~/.cc-switch/codex_oauth_auth.json)
// as OAuth credentials of ONE codex provider, seeding CCR's per-account token store.
// The caller persists the returned config (and restarts the gateway) via saveConfig.
export async function buildCcSwitchCodexProviderConfig(
  config: AppConfig,
  request: CcSwitchCodexAccountsImportRequest = {}
): Promise<{ config: AppConfig; result: CcSwitchCodexAccountsImportResult }> {
  const accounts = readCcSwitchCodexAccounts();
  if (accounts.length === 0) {
    throw new Error("No cc-switch Codex (ChatGPT) accounts were found. Sign in to an account in cc-switch's auth center, then retry.");
  }
  for (const account of accounts) {
    upsertCodexStoredAccount(account);
  }

  const providerName = request.providerName?.trim() || ccSwitchCodexDefaultProviderName;
  const existing = config.Providers.find((provider) => provider.name.trim().toLowerCase() === providerName.toLowerCase());
  const catalog = readCodexLocalModelCatalog();
  const models = catalog.models.length > 0 ? catalog.models : codexDefaultModels;
  const candidate: LocalAgentProviderCandidate = {
    detail: "Imported from cc-switch managed ChatGPT accounts.",
    id: "codex-ccswitch",
    importable: true,
    kind: "codex",
    modelDisplayNames: catalog.modelDisplayNames,
    modelMetadata: catalog.modelMetadata,
    models,
    name: providerName,
    protocol: "openai_responses",
    sourceFile: "cc-switch",
    status: "available"
  };
  const payload = providerPayload(candidate, providerName, codexDefaultBaseUrl, codexProviderAccountConfig());
  const credentials: ProviderCredentialConfig[] = accounts.map((account, index) => ({
    codexOauth: {
      ...(account.accessToken ? { accessToken: account.accessToken } : {}),
      accountId: account.accountId,
      refreshIfMissingAccessToken: true,
      refreshToken: account.refreshToken
    },
    id: `codex-acct-${providerCredentialSlug(account.accountId)}`,
    name: account.email || account.accountId,
    priority: index + 1
  }));
  const nextProvider: GatewayProviderConfig = {
    ...(existing ?? {}),
    ...(payload.account ? { account: payload.account } : {}),
    apiKey: payload.apiKey,
    baseUrl: payload.baseUrl,
    // ChatGPT accounts share no prompt cache — the pool is sticky; switching
    // accounts is the user's manual "Use" action, never automatic failover.
    credentialFailover: false,
    type: payload.protocol,
    modelDisplayNames: payload.modelDisplayNames ?? existing?.modelDisplayNames,
    modelMetadata: payload.modelMetadata ?? existing?.modelMetadata,
    models: existing?.models && existing.models.length > 0 ? existing.models : payload.models,
    name: providerName,
    // Refresh the OAuth credential set from cc-switch; hand-maintained static
    // API-key credentials on the same provider are kept as-is.
    credentials: [...(existing?.credentials ?? []).filter((credential) => !credential.codexOauth), ...credentials]
  };
  const Providers = existing
    ? config.Providers.map((provider) => (provider === existing ? nextProvider : provider))
    : [...config.Providers, nextProvider];
  return {
    config: { ...config, Providers },
    result: {
      accounts: accounts.map((account) => ({ accountId: account.accountId, email: account.email })),
      created: !existing,
      importedAccounts: accounts.length,
      providerName
    }
  };
}

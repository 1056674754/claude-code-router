import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  LocalAgentProviderCandidate,
  LocalAgentProviderImportResult,
  ProviderAccountConfig,
  ProviderModelMetadata
} from "@ccr/core/contracts/app";
import { findProviderPresetByBaseUrl } from "@ccr/core/providers/presets/index";
import { decryptZcodeCredential, isZcodeEncryptedCredential } from "@ccr/core/agents/zcode/credential-cipher";
import {
  apiKeyAuthPlugin,
  cloneProviderAccountConfig,
  firstString,
  isLoopbackUrl,
  isRecord,
  missingCandidate,
  modelDisplayNamesForModels,
  providerInternalNamePlaceholder,
  providerPayload,
  readJsonRecord,
  readString,
  uniqueProviderName,
  uniqueStrings,
  type ApiTokenSet
} from "@ccr/core/agents/local-providers/shared";

type ZcodeConfiguredProvider = {
  apiKey: string;
  baseUrl: string;
  modelDisplayNames?: Record<string, string>;
  models: string[];
  name: string;
  providerId: string;
  sourceFile: string;
};

type ZcodeSharedLogin = ApiTokenSet & {
  encrypted: boolean;
};

type ZcodeProviderRule = {
  accountType?: string;
  accessMode?: string;
  baseUrl: string;
  inlineApiKey?: string;
  modelDisplayNames?: Record<string, string>;
  models: string[];
  providerId: string;
  providerName: string;
  sourceFile: string;
};

type LocalAgentModelCatalog = {
  modelDisplayNames?: Record<string, string>;
  models: string[];
};

const zcodeDefaultModels = ["GLM-5.3", "GLM-5.3-Flash"];
export const zcodeDefaultBaseUrl = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";

const zcodeAnthropicProviderIdSuffixes: Record<string, string> = {
  "highspeed": "highspeed-card",
  "highspeed-card": "highspeed-card",
  "idle": "offpeak-idle-plan",
  "off-peak": "offpeak-idle-plan",
  "offpeak": "offpeak-idle-plan",
  "offpeak-idle-plan": "offpeak-idle-plan"
};

/**
 * Model limits for the GLM plans ZCode signs in with. Source: models.dev
 * providers `zhipuai-coding-plan` (https://open.bigmodel.cn/api/coding/paas/v4)
 * and `zai-coding-plan` (https://api.z.ai/api/coding/paas/v4), read on
 * 2026-11-01. Keys are lowercased model ids without an `[1m]`-style suffix.
 */
const zcodeModelMetadataByModel: Record<string, ProviderModelMetadata> = {
  "glm-5.3": { contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxOutputTokens: 131_072 },
  "glm-5.3-flash": {
    capabilities: { imageInput: true },
    contextWindow: 1_000_000,
    maxContextWindow: 1_000_000,
    maxOutputTokens: 131_072
  },
  "glm-5.3-flashx": {
    capabilities: { imageInput: true },
    contextWindow: 1_000_000,
    maxContextWindow: 1_000_000,
    maxOutputTokens: 131_072
  },
  "glm-5.3-highspeed": { contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxOutputTokens: 131_072 },
  "glm-5.2": { contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxOutputTokens: 131_072 },
  "glm-5.2-highspeed": { contextWindow: 1_000_000, maxContextWindow: 1_000_000, maxOutputTokens: 131_072 },
  "glm-5.1": { contextWindow: 200_000, maxContextWindow: 200_000, maxOutputTokens: 131_072 },
  "glm-5-turbo": { contextWindow: 200_000, maxContextWindow: 200_000, maxOutputTokens: 131_072 },
  "glm-5": { contextWindow: 204_800, maxContextWindow: 204_800, maxOutputTokens: 131_072 },
  "glm-4.7": { contextWindow: 204_800, maxContextWindow: 204_800, maxOutputTokens: 131_072 },
  "glm-4.7-flash": { contextWindow: 200_000, maxContextWindow: 200_000, maxOutputTokens: 131_072 },
  "glm-4.7-flashx": { contextWindow: 200_000, maxContextWindow: 200_000, maxOutputTokens: 131_072 },
  "glm-4.6": { contextWindow: 204_800, maxContextWindow: 204_800, maxOutputTokens: 131_072 },
  "glm-4.6v": {
    capabilities: { imageInput: true },
    contextWindow: 128_000,
    maxContextWindow: 128_000,
    maxOutputTokens: 32_768
  },
  "glm-4.5": { contextWindow: 131_072, maxContextWindow: 131_072, maxOutputTokens: 98_304 },
  "glm-4.5-air": { contextWindow: 131_072, maxContextWindow: 131_072, maxOutputTokens: 98_304 },
  "glm-4.5-flash": { contextWindow: 131_072, maxContextWindow: 131_072, maxOutputTokens: 98_304 },
  "glm-4.5v": {
    capabilities: { imageInput: true },
    contextWindow: 64_000,
    maxContextWindow: 64_000,
    maxOutputTokens: 16_384
  }
};

export type ZcodeLocalProviderCredential = {
  apiKey: string;
  baseUrl: string;
};

export function zcodeCandidate(): LocalAgentProviderCandidate {
  const configuredProvider = readZcodeConfiguredProvider();
  const zcodeRuntime = readZcodeRuntime();
  const models = configuredProvider?.models.length
    ? configuredProvider.models
    : zcodeRuntime.models.length > 0 ? zcodeRuntime.models : zcodeDefaultModels;
  const modelDisplayNames = configuredProvider?.models.length
    ? configuredProvider.modelDisplayNames
    : zcodeRuntime.modelDisplayNames;
  const modelMetadata = zcodeModelMetadataForModels(models);
  if (configuredProvider) {
    return {
      detail: "ZCode provider API key detected in local ZCode config. Click Import to add it as a gateway provider.",
      id: "zcode-api",
      importable: true,
      kind: "zcode",
      modelDisplayNames,
      modelMetadata,
      models,
      name: "ZCode API",
      protocol: "anthropic_messages",
      sourceFile: configuredProvider.sourceFile,
      status: "available"
    };
  }

  const credentials = readZcodeSharedLogin();
  if (credentials?.hasSharedLogin) {
    return {
      detail: credentials.encrypted
        ? "ZCode login was detected, but its local credential is encrypted and cannot be imported automatically."
        : "ZCode login was detected, but no usable provider API key was found in ZCode config.",
      id: "zcode-api",
      importable: false,
      kind: "zcode",
      modelDisplayNames,
      modelMetadata,
      models,
      name: "ZCode API",
      protocol: "anthropic_messages",
      sourceFile: credentials.sourceFile,
      status: "locked"
    };
  }
  return missingCandidate("zcode", "zcode-api", "ZCode API", "anthropic_messages", models, modelDisplayNames);
}

export function importZcodeProvider(candidate: LocalAgentProviderCandidate, providerNames: string[]): LocalAgentProviderImportResult {
  const configuredProvider = readZcodeConfiguredProvider();
  if (!configuredProvider) {
    throw new Error("ZCode provider API key was not found in ZCode config.");
  }
  const models = configuredProvider.models.length > 0 ? configuredProvider.models : candidate.models;
  const provider = providerPayload(
    {
      ...candidate,
      modelDisplayNames: configuredProvider.models.length > 0 ? configuredProvider.modelDisplayNames : candidate.modelDisplayNames,
      modelMetadata: zcodeModelMetadataForModels(models) ?? candidate.modelMetadata,
      models
    },
    uniqueProviderName(providerNames, "ZCode API"),
    configuredProvider.baseUrl,
    zcodeProviderAccountConfig(configuredProvider.baseUrl)
  );
  return {
    candidate,
    provider,
    providerPlugins: [
      apiKeyAuthPlugin("zcode-api-key", configuredProvider.apiKey),
      apiKeyAuthPlugin("zcode-api-key-internal", configuredProvider.apiKey, providerInternalNamePlaceholder)
    ]
  };
}

export function readZcodeLocalProviderCredential(): ZcodeLocalProviderCredential | undefined {
  const provider = readZcodeConfiguredProvider();
  return provider ? { apiKey: provider.apiKey, baseUrl: provider.baseUrl } : undefined;
}

function zcodeProviderAccountConfig(baseUrl: string): ProviderAccountConfig | undefined {
  return cloneProviderAccountConfig(findProviderPresetByBaseUrl(baseUrl)?.account);
}

function readZcodeSharedLogin(): ZcodeSharedLogin | undefined {
  for (const sourceFile of zcodeCredentialFiles()) {
    const record = readJsonRecord(sourceFile);
    if (!record) {
      continue;
    }
    let hasValue = false;
    let hasPlaintextValue = false;
    let hasEncryptedValue = false;
    for (const value of Object.values(record)) {
      const text = readString(value);
      if (!text) {
        continue;
      }
      hasValue = true;
      if (isZcodeEncryptedCredential(text)) {
        hasEncryptedValue = true;
      } else {
        hasPlaintextValue = true;
      }
    }
    if (hasValue) {
      return {
        encrypted: hasEncryptedValue && !hasPlaintextValue,
        hasSharedLogin: true,
        sourceFile
      };
    }
  }
  return undefined;
}

function readZcodeConfiguredProvider(): ZcodeConfiguredProvider | undefined {
  const candidates = [
    ...readZcodeV2ConfiguredProviders(),
    ...zcodeConfigFiles().flatMap((sourceFile) => readZcodeConfiguredProviders(sourceFile))
  ];
  return candidates.find((provider) => provider.apiKey.trim() && provider.baseUrl.trim());
}

/**
 * Newer ZCode releases (3.1x) replaced the single `config.json` provider map with
 * `setting.json` provider family selections, `provider_config.json` user rules,
 * `runtime/provider/.../zcode-builtin.json` builtin rules and an encrypted
 * `credentials.json`. The API key of an account-backed provider only exists as
 * an `account-provider:coding-plan:<providerId>:account:<accountId>:api-key`
 * credential, so it has to be decrypted before it can be imported.
 */
function readZcodeV2ConfiguredProviders(): ZcodeConfiguredProvider[] {
  const rules = orderZcodeV2Rules([
    ...readZcodeV2CustomProviderRules(),
    ...readZcodeV2BuiltinProviderRules()
  ]);
  if (rules.length === 0) {
    return [];
  }
  const credentialsFile = zcodeCredentialFiles()[0];
  const credentials = readJsonRecord(credentialsFile);
  const providers: ZcodeConfiguredProvider[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.providerId)) {
      continue;
    }
    const inlineApiKey = rule.inlineApiKey?.trim();
    const apiKey = inlineApiKey || readZcodeV2CredentialApiKey(credentials, rule.providerId);
    if (!apiKey) {
      continue;
    }
    seen.add(rule.providerId);
    providers.push({
      apiKey,
      baseUrl: rule.baseUrl,
      modelDisplayNames: rule.modelDisplayNames,
      models: rule.models,
      name: rule.providerName || rule.providerId,
      providerId: rule.providerId,
      sourceFile: inlineApiKey ? rule.sourceFile : credentialsFile
    });
  }
  return providers;
}

function readZcodeV2CredentialApiKey(
  credentials: Record<string, unknown> | undefined,
  providerId: string
): string | undefined {
  if (!credentials) {
    return undefined;
  }
  const needle = `${providerId}:`;
  for (const [key, value] of Object.entries(credentials)) {
    if (!key.endsWith(":api-key") || !key.includes(needle)) {
      continue;
    }
    const text = readString(value);
    if (!text) {
      continue;
    }
    try {
      const apiKey = decryptZcodeCredential(text).trim();
      if (apiKey) {
        return apiKey;
      }
    } catch {
      // An undecryptable credential is reported as such by readZcodeSharedLogin().
    }
  }
  return undefined;
}

function orderZcodeV2Rules(rules: ZcodeProviderRule[]): ZcodeProviderRule[] {
  const selectedIds = readZcodeV2SelectedProviderIds();
  if (selectedIds.length === 0) {
    return rules;
  }
  const rank = new Map(selectedIds.map((id, index) => [id, index]));
  return rules
    .map((rule, index) => ({ index, rule, rank: rank.get(rule.providerId) ?? selectedIds.length }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.rule);
}

function readZcodeV2SelectedProviderIds(): string[] {
  const settings = readJsonRecord(path.join(zcodeV2Dir(), "setting.json"));
  const selections = isRecord(settings?.providerFamilyConnectionSelections)
    ? settings.providerFamilyConnectionSelections
    : undefined;
  if (!selections) {
    return [];
  }
  const providerIds: string[] = [];
  for (const [family, value] of Object.entries(selections)) {
    const familyName = family.trim();
    const kind = readString(isRecord(value) ? value.kind : undefined);
    if (!familyName || !kind) {
      continue;
    }
    providerIds.push(zcodeAccountProviderId(familyName, kind));
  }
  return uniqueStrings(providerIds);
}

function zcodeAccountProviderId(family: string, kind: string): string {
  const normalized = kind.trim().toLowerCase();
  const suffix = zcodeAnthropicProviderIdSuffixes[normalized] ?? normalized.replace(/[\s_]+/g, "-");
  return `account:${family}-${suffix}`;
}

function readZcodeV2CustomProviderRules(): ZcodeProviderRule[] {
  const file = path.join(zcodeV2Dir(), "provider_config.json");
  const record = readJsonRecord(file);
  const config = isRecord(record?.config) ? record.config : undefined;
  const providerConfigRules = isRecord(config?.providerConfigRules) ? config.providerConfigRules : undefined;
  const rules = Array.isArray(providerConfigRules?.providerRules) ? providerConfigRules.providerRules : [];
  return rules.flatMap((rule) => {
    const parsed = zcodeV2ProviderRule(rule, file);
    return parsed ? [parsed] : [];
  });
}

function readZcodeV2BuiltinProviderRules(): ZcodeProviderRule[] {
  for (const file of zcodeV2BuiltinProviderFiles()) {
    const record = readJsonRecord(file);
    const config = isRecord(record?.config) ? record.config : undefined;
    const providerConfigRules = isRecord(config?.providerConfigRules) ? config.providerConfigRules : undefined;
    const rules = Array.isArray(providerConfigRules?.providerRules) ? providerConfigRules.providerRules : [];
    const parsed = rules.flatMap((rule) => {
      const value = zcodeV2ProviderRule(rule, file);
      return value ? [value] : [];
    });
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
}

function zcodeV2BuiltinProviderFiles(): string[] {
  const root = path.join(zcodeV2Dir(), "runtime", "provider");
  const files: Array<{ file: string; version: string }> = [];
  for (const platformDir of safeReadDir(root)) {
    const platformPath = path.join(root, platformDir);
    for (const versionDir of safeReadDir(platformPath)) {
      const versionPath = path.join(platformPath, versionDir);
      for (const endpointDir of safeReadDir(versionPath)) {
        const file = path.join(versionPath, endpointDir, "zcode-builtin.json");
        if (existsSync(file)) {
          files.push({ file, version: versionDir });
        }
      }
    }
  }
  return files
    .sort((left, right) => compareZcodeVersions(left.version, right.version))
    .map((entry) => entry.file)
    .reverse();
}

function compareZcodeVersions(left: string, right: string): number {
  const leftParts = left.split(/[.\-+]/).map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(/[.\-+]/).map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => {
      try {
        return statSync(path.join(dir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function zcodeV2ProviderRule(value: unknown, sourceFile: string): ZcodeProviderRule | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providerId = readString(value.providerId) || readString(value.provider_id) || readString(value.id);
  if (!providerId) {
    return undefined;
  }
  const config = isRecord(value.config) ? value.config : undefined;
  const api = isRecord(config?.api) ? config.api : undefined;
  const baseUrl = firstString([
    readString(api?.baseUrl),
    readString(api?.baseURL),
    readString(config?.baseUrl),
    readString(config?.baseURL)
  ]);
  if (!baseUrl || isLoopbackUrl(baseUrl)) {
    return undefined;
  }
  const apiType = (readString(api?.type) || "").toLowerCase();
  if (apiType && !apiType.includes("anthropic")) {
    return undefined;
  }
  const access = isRecord(config?.access) ? config.access : undefined;
  return {
    accountType: readString(access?.accountType),
    accessMode: readString(access?.mode),
    baseUrl,
    inlineApiKey: firstString([
      readString(api?.apiKey),
      readString(api?.api_key),
      readString(config?.apiKey),
      readString(config?.api_key),
      readString(value.apiKey)
    ]),
    modelDisplayNames: readZcodeModelDisplayNames(config),
    models: uniqueStrings([
      ...readZcodeStringArray(config?.builtinModelIds),
      ...readZcodeStringArray(config?.builtin_model_ids),
      ...readZcodeStringArray(config?.models)
    ]),
    providerId,
    providerName: readString(value.providerName) || readString(value.provider_name) || providerId,
    sourceFile
  };
}

function readZcodeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const text = isRecord(item) ? readString(item.id) || readString(item.name) : readString(item);
    return text ? [text] : [];
  });
}

function readZcodeModelDisplayNames(config: Record<string, unknown> | undefined): Record<string, string> {
  const source = isRecord(config?.modelDisplayNames) ? config.modelDisplayNames : undefined;
  if (!source) {
    return {};
  }
  const displayNames: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const text = readString(value);
    if (text && text !== key) {
      displayNames[key] = text;
    }
  }
  return displayNames;
}

function zcodeModelMetadataForModels(models: string[]): Record<string, ProviderModelMetadata> | undefined {
  const metadata: Record<string, ProviderModelMetadata> = {};
  for (const model of models) {
    const entry = zcodeModelMetadataByModel[normalizeZcodeModelId(model)];
    if (!entry) {
      continue;
    }
    metadata[model] = {
      ...entry,
      ...(entry.capabilities ? { capabilities: { ...entry.capabilities } } : {})
    };
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeZcodeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
}

function readZcodeConfiguredProviders(sourceFile: string): ZcodeConfiguredProvider[] {
  const record = readJsonRecord(sourceFile);
  const providers = isRecord(record?.provider) ? record.provider : undefined;
  if (!providers) {
    return [];
  }

  return Object.entries(providers)
    .flatMap(([providerId, value]) => {
      if (!isRecord(value) || !isZcodeModelProvider(providerId, value)) {
        return [];
      }
      const options = isRecord(value.options) ? value.options : {};
      const apiKey = readString(options.apiKey) || readString(options.api_key) || readString(value.apiKey) || readString(value.api_key);
      const baseUrl =
        readString(options.baseURL) ||
        readString(options.baseUrl) ||
        readString(isRecord(value.endpoints) ? value.endpoints.baseURL : undefined) ||
        readString(isRecord(value.endpoints) ? value.endpoints.baseUrl : undefined);
      if (!apiKey || !baseUrl) {
        return [];
      }
      return [{
        apiKey,
        baseUrl,
        ...zcodeProviderModelCatalog(value),
        name: readString(value.name) || providerId,
        providerId,
        sourceFile
      }];
    });
}

function readZcodeRuntime(): { baseUrl: string } & LocalAgentModelCatalog {
  const cache = readJsonRecord(path.join(zcodeStorageRoot(), "v2", "bots-model-cache.v2.json"));
  const providers = Array.isArray(cache?.providers)
    ? cache.providers.filter((provider): provider is Record<string, unknown> => isRecord(provider))
    : [];
  const provider = providers.find((item) => {
    const text = [
      readString(item.id),
      readString(item.name),
      readString(isRecord(item.endpoints) ? item.endpoints.baseURL : undefined)
    ].join(" ").toLowerCase();
    return text.includes("zcode") || text.includes("z.ai") || text.includes("bigmodel");
  });
  const baseUrl = readString(isRecord(provider?.endpoints) ? provider?.endpoints.baseURL : undefined) || zcodeDefaultBaseUrl;
  const catalog = zcodeProviderModelCatalog(provider ?? {});
  const models = uniqueStrings([...catalog.models, ...zcodeDefaultModels]);
  return {
    baseUrl,
    modelDisplayNames: modelDisplayNamesForModels(catalog.modelDisplayNames, models),
    models
  };
}

function zcodeProviderModelCatalog(provider: Record<string, unknown>): LocalAgentModelCatalog {
  const models: string[] = [];
  const modelDisplayNames: Record<string, string> = {};
  if (Array.isArray(provider.models)) {
    for (const item of provider.models) {
      const model = isRecord(item)
        ? readString(item.id) || readString(item.name)
        : readString(item);
      if (!model) {
        continue;
      }
      models.push(model);
      if (isRecord(item)) {
        const displayName = readString(item.displayName) || readString(item.display_name) || readString(item.label) || readString(item.name);
        if (displayName && displayName !== model) {
          modelDisplayNames[model] = displayName;
        }
      }
    }
    const uniqueModels = uniqueStrings(models);
    return {
      modelDisplayNames: modelDisplayNamesForModels(modelDisplayNames, uniqueModels),
      models: uniqueModels
    };
  }
  if (isRecord(provider.models)) {
    for (const [key, value] of Object.entries(provider.models)) {
      const model = isRecord(value) ? readString(value.id) || key : key;
      if (!model) {
        continue;
      }
      models.push(model);
      if (isRecord(value)) {
        const displayName = readString(value.displayName) || readString(value.display_name) || readString(value.label) || readString(value.name);
        if (displayName && displayName !== model) {
          modelDisplayNames[model] = displayName;
        }
      }
    }
    const uniqueModels = uniqueStrings(models);
    return {
      modelDisplayNames: modelDisplayNamesForModels(modelDisplayNames, uniqueModels),
      models: uniqueModels
    };
  }
  return {
    models: []
  };
}

function isZcodeModelProvider(providerId: string, provider: Record<string, unknown>): boolean {
  if (provider.enabled === false || readString(provider.systemDisabledReason)) {
    return false;
  }

  const options = isRecord(provider.options) ? provider.options : {};
  const endpoints = isRecord(provider.endpoints) ? provider.endpoints : {};
  const baseUrl = firstString([
    readString(options.baseURL),
    readString(options.baseUrl),
    readString(endpoints.baseURL),
    readString(endpoints.baseUrl)
  ]);
  const baseUrlText = baseUrl.toLowerCase();
  if (isLoopbackUrl(baseUrl)) {
    return false;
  }

  const text = [
    providerId,
    readString(provider.name),
    baseUrlText
  ].join(" ").toLowerCase();
  const matchesZcodeProvider =
    text.includes("z.ai") ||
    text.includes("zai") ||
    text.includes("zcode") ||
    text.includes("bigmodel") ||
    text.includes("open.bigmodel.cn");
  if (!matchesZcodeProvider || text.includes("claude-code-router")) {
    return false;
  }

  const kind = [
    readString(provider.kind),
    readString(provider.apiFormat),
    readString(provider.defaultKind),
    readString(isRecord(endpoints.paths) ? endpoints.paths.anthropic : undefined)
  ].join(" ").toLowerCase();
  return kind.includes("anthropic") || baseUrlText.includes("/anthropic");
}

function zcodeCredentialFiles(): string[] {
  const storageRoot = zcodeStorageRoot();
  return uniqueStrings([
    path.join(storageRoot, "v2", "credentials.json"),
    path.join(storageRoot, "credentials.json")
  ]);
}

function zcodeConfigFiles(): string[] {
  const storageRoot = zcodeStorageRoot();
  return uniqueStrings([
    path.join(storageRoot, "v2", "config.json"),
    path.join(storageRoot, "cli", "config.json")
  ]);
}

function zcodeV2Dir(): string {
  return path.join(zcodeStorageRoot(), "v2");
}

function zcodeStorageRoot(): string {
  const explicitRoot = process.env.ZCODE_STORAGE_DIR?.trim() || process.env.ZCODE_HOME?.trim();
  if (explicitRoot) {
    return explicitRoot;
  }
  const homeDir = process.env.CCR_INTERNAL_HOME_DIR?.trim() || process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
  return path.join(homeDir, ".zcode");
}

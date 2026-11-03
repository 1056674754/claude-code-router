import type { ProviderAccountConfig, ProviderAccountHttpJsonConnectorConfig } from "@ccr/core/contracts/app";
import { compactProviderUrl, providerUrlWithDefaultScheme } from "@ccr/core/providers/url";

export type DetectedProviderKind = "new-api";

/** New API keeps balances in whole "quota" units; one dollar is 500000 quota unless the site overrides it. */
export const newApiQuotaPerUnit = 500000;
export const newApiAccessTokenPlaceholder = "<new-api-access-token>";
export const newApiUserIdPlaceholder = "<user-id>";

const newApiHeaderNames = ["x-new-api-version", "x-oneapi-request-id"];

export function detectedProviderFromHeaders(headers: Record<string, string | undefined>): DetectedProviderKind | undefined {
  return hasNewApiHeaders(headers) ? "new-api" : undefined;
}

export function hasNewApiHeaders(headers: Record<string, string | undefined>): boolean {
  const normalized = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
  return newApiHeaderNames.some((header) => normalized.has(header));
}

export function newApiKeyUsageAccountConfig(baseUrl: string): ProviderAccountConfig {
  return {
    connectors: [
      {
        auth: "provider-api-key",
        endpoint: newApiKeyUsageEndpoint(baseUrl),
        mapping: {
          message: "$.message",
          meters: [
            {
              id: "new_api_key_quota",
              kind: "quota",
              label: "API key quota",
              limit: "$.data.total_granted",
              remaining: "$.data.total_available",
              unit: "quota",
              used: "$.data.total_used",
            }
          ]
        },
        method: "GET",
        parser: "new-api-key-usage",
        type: "http-json"
      }
    ],
    enabled: true
  };
}

export function newApiKeyUsageEndpoint(baseUrl: string): string {
  const root = newApiRootBaseUrl(baseUrl);
  return `${root}/api/usage/token/`;
}

export type NewApiUserSelfConnectorOptions = {
  /** Console access token (personal settings -> generate access token). Not the provider API key. */
  accessToken?: string;
  /**
   * Optional account budget in USD, written as the meter limit. CCR derives the
   * status from remaining / limit, so a budget makes the balance warn below 20%
   * and go critical below 5%. Omit it to keep the balance informational.
   */
  limitUsd?: number;
  /** 1 USD = quotaPerUnit quota units. Defaults to the New API default of 500000. */
  quotaPerUnit?: number;
  /** Numeric New API user id, sent as New-Api-User. */
  userId?: string;
};

/**
 * Account balance lives on the New API *user*, not on the API key: unlimited keys
 * report `unlimited_quota: true` on /api/usage/token/ and carry no quota of their
 * own. Reading the balance therefore needs the console access token plus the
 * numeric user id, and the raw quota has to be scaled to money.
 */
export function newApiUserSelfConnectorConfig(
  baseUrl: string,
  options: NewApiUserSelfConnectorOptions = {}
): ProviderAccountHttpJsonConnectorConfig {
  const quotaPerUnit = newApiQuotaPerUnitFor(options.quotaPerUnit);
  const limitUsd = newApiLimitUsdFor(options.limitUsd);
  return {
    auth: "none",
    endpoint: newApiUserSelfEndpoint(baseUrl),
    headers: {
      Authorization: `Bearer ${options.accessToken?.trim() || newApiAccessTokenPlaceholder}`,
      "New-Api-User": options.userId?.trim() || newApiUserIdPlaceholder
    },
    mapping: {
      message: "$.message",
      meters: [
        {
          id: "new_api_user_balance",
          kind: "balance",
          label: "User balance",
          ...(limitUsd === undefined ? {} : { limit: limitUsd }),
          remaining: `$.data.quota / ${quotaPerUnit}`,
          unit: "USD",
          used: `$.data.used_quota / ${quotaPerUnit}`
        }
      ]
    },
    method: "GET",
    parser: "new-api-user-self",
    type: "http-json"
  };
}

export function newApiUserSelfEndpoint(baseUrl: string): string {
  const root = newApiRootBaseUrl(baseUrl);
  return `${root}/api/user/self`;
}

/**
 * Detects a user balance connector that still carries the generated placeholders.
 * Sending those verbatim reaches the relay and comes back as an opaque 401, so the
 * connector reports the missing fields instead.
 */
export function newApiUserSelfConnectorPlaceholderIssue(
  connector: ProviderAccountHttpJsonConnectorConfig
): string | undefined {
  const headers = connector.headers ?? {};
  const authorization = headerValue(headers, "authorization") ?? "";
  const userId = headerValue(headers, "new-api-user") ?? "";
  const missing: string[] = [];
  if (authorization.includes(newApiAccessTokenPlaceholder) || !/^bearer\s+\S/i.test(authorization.trim())) {
    missing.push(`Authorization: Bearer ${newApiAccessTokenPlaceholder}`);
  }
  if (userId.includes(newApiUserIdPlaceholder) || !userId.trim()) {
    missing.push(`New-Api-User: ${newApiUserIdPlaceholder}`);
  }
  if (missing.length === 0) {
    return undefined;
  }
  return `New API user balance connector is not configured yet: replace ${missing.join(" and ")} with the relay access token (console -> personal settings -> generate access token) and the numeric user id. The API key cannot read the account balance.`;
}

export function newApiRootBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(providerUrlWithDefaultScheme(baseUrl.trim()));
    url.pathname = url.pathname.replace(/\/+(v1|api)$/i, "").replace(/\/+$/, "") || "/";
    url.search = "";
    url.hash = "";
    return compactProviderUrl(url);
  } catch {
    return baseUrl.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\/(v1|api)$/i, "");
  }
}

function newApiQuotaPerUnitFor(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : newApiQuotaPerUnit;
}

function newApiLimitUsdFor(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value * 100) / 100;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) {
      return typeof value === "string" ? value : undefined;
    }
  }
  return undefined;
}

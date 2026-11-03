import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonRecord, readString, isRecord } from "@ccr/core/agents/local-providers/shared";
import { fetchWithSystemProxy } from "@ccr/core/proxy/system-proxy-fetch";
import { resolveRuntimeConfigDir } from "@ccr/core/runtime/app-paths";

// Multi-account Codex (ChatGPT) OAuth credential store. The shared ~/.codex/auth.json
// can only hold ONE login and is owned by the Codex CLI / cc-switch, so accounts
// imported from other tools (e.g. cc-switch managed accounts) persist here instead:
// one file per account, refreshed and persisted by CCR (mirrors the Kimi CLI store).
export type CodexStoredAccount = {
  accountId: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  updatedAt?: string;
};

export type CodexStoredAccountRef = {
  accountId?: string;
  accessToken?: string;
  refreshToken?: string;
};

const codexOauthTokenEndpoint = "https://auth.openai.com/oauth/token";
const codexOauthClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const codexOauthDefaultScope = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const codexOauthRefreshTimeoutMs = 30_000;
const refreshInFlight = new Map<string, Promise<CodexStoredAccount | undefined>>();

export function codexAccountStoreDir(): string {
  const explicit = process.env.CCR_CODEX_ACCOUNT_STORE_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(resolveRuntimeConfigDir(), "codex-oauth-accounts");
}

export function codexAccountStoreFile(accountId: string): string {
  return path.join(codexAccountStoreDir(), `${codexAccountSlug(accountId)}.json`);
}

export function readCodexStoredAccount(accountId: string | undefined): CodexStoredAccount | undefined {
  if (!accountId?.trim()) {
    return undefined;
  }
  const record = readJsonRecord(codexAccountStoreFile(accountId));
  if (!record) {
    return undefined;
  }
  const storedAccountId = readString(record.accountId);
  const refreshToken = readString(record.refreshToken);
  const accessToken = readString(record.accessToken);
  if (!storedAccountId && !refreshToken && !accessToken) {
    return undefined;
  }
  return {
    accountId: storedAccountId || accountId,
    email: readString(record.email),
    accessToken,
    refreshToken,
    idToken: readString(record.idToken),
    updatedAt: readString(record.updatedAt)
  };
}

export function upsertCodexStoredAccount(account: CodexStoredAccount): void {
  if (!account.accountId?.trim() || (!account.accessToken && !account.refreshToken)) {
    return;
  }
  // Merge over the existing entry so a token-only refresh (e.g. from the
  // account-service path) never drops fields like `email` written earlier.
  const existing = readCodexStoredAccount(account.accountId);
  const payload = {
    ...existing,
    ...account,
    accountId: account.accountId,
    updatedAt: account.updatedAt ?? new Date().toISOString()
  };
  const targetFile = codexAccountStoreFile(account.accountId);
  try {
    mkdirSync(codexAccountStoreDir(), { mode: 0o700, recursive: true });
    const temporaryFile = `${targetFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryFile, targetFile);
      chmodSync(targetFile, 0o600);
    } catch {
      try {
        rmSync(temporaryFile, { force: true });
      } catch {
        // Ignore temporary-file cleanup failures.
      }
      // Best effort: the refreshed token stays usable for this CCR run.
    }
  } catch {
    // Best effort. The in-memory token is still valid for this run.
  }
}

export function codexStoredAccountIds(): string[] {
  const dir = codexAccountStoreDir();
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json") && !name.includes(".tmp"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

// Resolves the freshest token set for a STORE-BACKED account, refreshing and
// persisting when the access token expired. Returns undefined when the account
// has no store entry, so callers fall back to their own sources (live
// ~/.codex/auth.json or the imported point-in-time plugin payload).
export async function resolveCodexStoredAccountAuth(ref: CodexStoredAccountRef): Promise<CodexStoredAccount | undefined> {
  const accountId = ref.accountId?.trim() || undefined;
  if (!accountId) {
    return undefined;
  }
  const stored = readCodexStoredAccount(accountId);
  if (!stored) {
    return undefined;
  }
  if (stored.accessToken && !codexStoredAccessTokenExpired(stored.accessToken)) {
    return stored;
  }
  const refreshToken = stored.refreshToken || ref.refreshToken;
  if (!refreshToken) {
    return stored;
  }
  const dedupeKey = `${accountId}:${refreshToken}`;
  let refresh = refreshInFlight.get(dedupeKey);
  if (!refresh) {
    refresh = refreshCodexStoredAccountTokens({
      accountId: stored.accountId || accountId,
      email: stored.email,
      refreshToken,
      accessToken: stored.accessToken
    })
      .catch((error: unknown) => adoptPeerRotatedCodexAccount(accountId, refreshToken, error))
      .finally(() => {
        refreshInFlight.delete(dedupeKey);
      });
    refreshInFlight.set(dedupeKey, refresh);
  }
  const refreshed = await refresh;
  return refreshed ?? stored;
}

export async function refreshCodexStoredAccountTokens(account: CodexStoredAccount): Promise<CodexStoredAccount> {
  if (!account.refreshToken) {
    throw new Error("Codex account refresh token was not found.");
  }
  const tokenEndpoint = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim() || codexOauthTokenEndpoint;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), codexOauthRefreshTimeoutMs);
  try {
    const response = await fetchWithSystemProxy(tokenEndpoint, {
      body: JSON.stringify({
        client_id: codexOauthClientId,
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        scope: codexOauthDefaultScope
      }),
      headers: {
        "content-type": "application/json"
      },
      method: "POST",
      signal: controller.signal
    });
    const text = await response.text();
    const payload = parseJsonRecord(text);
    if (!response.ok) {
      const message = `Codex OAuth token refresh returned HTTP ${response.status}${tokenRefreshErrorMessage(payload, text)}`;
      const error = new Error(message) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const accessToken = readString(payload?.access_token) || readString(payload?.accessToken);
    if (!accessToken) {
      throw new Error("Codex OAuth token refresh did not return an access token.");
    }
    const refreshed: CodexStoredAccount = {
      accountId: account.accountId,
      email: account.email,
      accessToken,
      refreshToken: readString(payload?.refresh_token) || readString(payload?.refreshToken) || account.refreshToken,
      idToken: readString(payload?.id_token) || readString(payload?.idToken) || account.idToken,
      updatedAt: new Date().toISOString()
    };
    upsertCodexStoredAccount(refreshed);
    return refreshed;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Codex OAuth token refresh timed out after ${codexOauthRefreshTimeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// When the stored refresh token was rotated by a peer that shares the account
// (e.g. cc-switch refreshing the same ChatGPT account), our refresh fails with
// 401/403 while the peer's device-local file already holds the newer token.
// Adopt it instead of failing the account.
async function adoptPeerRotatedCodexAccount(accountId: string | undefined, refreshToken: string, error: unknown): Promise<CodexStoredAccount> {
  const status = (error as { status?: number } | undefined)?.status;
  if (status !== 401 && status !== 403) {
    throw error;
  }
  const peer = readCcSwitchCodexAccounts().find((account) => account.accountId === accountId);
  if (!peer?.refreshToken || peer.refreshToken === refreshToken) {
    throw error;
  }
  return refreshCodexStoredAccountTokens({
    accountId: accountId || peer.accountId,
    email: peer.email,
    refreshToken: peer.refreshToken,
    idToken: peer.idToken
  });
}

// Reads cc-switch's device-local managed-account file (if present). Observed
// v2 shape: { version, default_account_id, accounts: { <accountId>: { account_id,
// chatgpt_account_id, email, refresh_token, id_token, ... } } } — accounts is a
// MAP keyed by account id; older builds may use an array instead.
export function readCcSwitchCodexAccounts(): CodexStoredAccount[] {
  const record = readJsonRecord(ccSwitchOauthFile());
  if (!record) {
    return [];
  }
  return ccSwitchAccountEntries(record)
    .map(({ key, value }): CodexStoredAccount | undefined => {
      const accountId = readString(value.account_id) || readString(value.accountId) || readString(value.id) || key;
      const refreshToken = readString(value.refresh_token) || readString(value.refreshToken);
      if (!accountId || !refreshToken) {
        return undefined;
      }
      return {
        accountId,
        email: readString(value.email),
        accessToken: readString(value.access_token) || readString(value.accessToken),
        refreshToken,
        idToken: readString(value.id_token) || readString(value.idToken)
      };
    })
    .filter((account): account is CodexStoredAccount => Boolean(account));
}

function ccSwitchAccountEntries(record: Record<string, unknown>): Array<{ key?: string; value: Record<string, unknown> }> {
  const raw = record.accounts;
  if (Array.isArray(raw)) {
    return raw.filter(isRecord).map((value) => ({ value }));
  }
  if (isRecord(raw)) {
    return Object.entries(raw)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([key, value]) => ({ key, value }));
  }
  return [];
}

function ccSwitchOauthFile(): string {
  const explicit = process.env.CCR_CCSWITCH_OAUTH_FILE?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const configDir = process.env.CCR_CCSWITCH_CONFIG_DIR?.trim() || path.join(os.homedir(), ".cc-switch");
  return path.join(configDir, "codex_oauth_auth.json");
}

export function codexStoredAccessTokenExpired(accessToken: string): boolean {
  const expiresAtMs = codexTokenExpiresAtMs(accessToken);
  return expiresAtMs !== undefined && expiresAtMs <= Date.now() + 60_000;
}

function codexTokenExpiresAtMs(accessToken: string): number | undefined {
  const payload = readJwtPayload(accessToken);
  const exp = payload && typeof payload.exp === "number" ? payload.exp : undefined;
  return exp !== undefined && Number.isFinite(exp) ? exp * 1000 : undefined;
}

function readJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }
  const segment = token.split(".")[1];
  if (!segment) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function codexAccountSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function tokenRefreshErrorMessage(payload: Record<string, unknown> | undefined, text: string): string {
  const message = readString(payload?.error_description) || readString(payload?.error) || readString(payload?.message) || text.trim().slice(0, 240);
  return message ? `: ${message}` : "";
}

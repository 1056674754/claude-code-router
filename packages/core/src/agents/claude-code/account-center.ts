import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIGDIR } from "@ccr/core/config/constants";
import { fetchWithSystemProxy } from "@ccr/core/proxy/system-proxy-fetch";
import {
  claudeCodeExpectedKeychainServices,
  claudeCodeKeychainAccount,
  claudeCodeStorageDir,
  readClaudeCodeOauth
} from "@ccr/core/agents/local-providers/claude-code";
import { isRecord, readString } from "@ccr/core/agents/local-providers/shared";
import type { ClaudeAccountEntry, ClaudeAccountRecord, ClaudeAccountUsageResult } from "@ccr/core/contracts/app";

// EXPERIMENTAL Claude official-account management, modeled on cc-switch's
// approach (services/claude_account/): each account owns a Claude-Code-shaped
// config dir under CCR's data dir; "switching" an account moves its
// credential material (the .credentials.json file and, on macOS, the
// "Claude Code-credentials" keychain item) into the live ~/.claude slot.
// Constraints, inherited from the Codex pool: switching is a MANUAL act —
// accounts are never rotated automatically (prompt caches are per-account).
//
// Keychain notes: Claude Code >= 2.1 stores claudeAiOauth in the macOS
// keychain under service "Claude Code-credentials[-<config hash>]" / account
// $USER; the file ~/.claude/.credentials.json is the plaintext fallback.
// Both are captured/restored; on non-macOS only the file exists.


const registryFile = () => path.join(CONFIGDIR, "claude-oauth-accounts.json");
const accountsRoot = () => path.join(CONFIGDIR, "claude-accounts");

export function listClaudeAccounts(): ClaudeAccountEntry[] {
  const accounts = readRegistry();
  const liveFingerprint = liveCredentialsFingerprint();
  return accounts.map((account) => {
    const hasCredentials = existsSync(path.join(account.configDir, ".credentials.json")) || existsSync(path.join(account.configDir, "keychain-backup.txt"));
    const isLive = Boolean(liveFingerprint) && accountCredentialsFingerprint(account.configDir) === liveFingerprint;
    return {
      ...account,
      isLive,
      status: isLive ? "live" : hasCredentials ? "ready" : "missing-credentials"
    };
  });
}

// Captures the CURRENT live login into a new account slot.
export function captureClaudeAccount(label: string): ClaudeAccountRecord {
  const cleanLabel = label.trim() || `account-${new Date().toISOString().slice(0, 10)}`;
  const liveDir = claudeCodeStorageDir();
  const credentialsFile = path.join(liveDir, ".credentials.json");
  if (!existsSync(credentialsFile) && !readClaudeCodeOauth()) {
    throw new Error("No live Claude Code login was found to capture. Sign in to Claude Code first.");
  }
  const id = `${slug(cleanLabel)}-${Date.now().toString(36)}`;
  const configDir = path.join(accountsRoot(), id);
  mkdirSync(configDir, { mode: 0o700, recursive: true });
  if (existsSync(credentialsFile)) {
    copyFile(credentialsFile, path.join(configDir, ".credentials.json"));
  }
  const keychainSecret = readKeychainSecret();
  if (keychainSecret) {
    writeFileSync(path.join(configDir, "keychain-backup.txt"), keychainSecret, { encoding: "utf8", mode: 0o600 });
  }
  const record: ClaudeAccountRecord = {
    configDir,
    createdAt: new Date().toISOString(),
    id,
    label: cleanLabel
  };
  const accounts = readRegistry();
  accounts.push(record);
  writeRegistry(accounts);
  return record;
}

// Switches the live ~/.claude credential slot to the given account.
export function switchClaudeAccount(id: string): void {
  const account = readRegistry().find((entry) => entry.id === id);
  if (!account) {
    throw new Error("Claude account was not found.");
  }
  const liveDir = claudeCodeStorageDir();
  const credentialsFile = path.join(account.configDir, ".credentials.json");
  const keychainBackup = path.join(account.configDir, "keychain-backup.txt");
  if (!existsSync(credentialsFile) && !existsSync(keychainBackup)) {
    throw new Error("This account has no captured credentials.");
  }
  mkdirSync(liveDir, { recursive: true });
  if (existsSync(credentialsFile)) {
    copyFile(credentialsFile, path.join(liveDir, ".credentials.json"));
  }
  if (existsSync(keychainBackup) && process.platform === "darwin") {
    writeKeychainSecret(readFileSync(keychainBackup, "utf8"));
  }
}

export function removeClaudeAccount(id: string): void {
  const accounts = readRegistry();
  const account = accounts.find((entry) => entry.id === id);
  if (!account) {
    return;
  }
  const liveFingerprint = liveCredentialsFingerprint();
  if (liveFingerprint && accountCredentialsFingerprint(account.configDir) === liveFingerprint) {
    throw new Error("This account is currently live. Switch to another account first.");
  }
  rmSync(account.configDir, { force: true, recursive: true });
  writeRegistry(accounts.filter((entry) => entry.id !== id));
}

// Per-account usage via the official OAuth usage endpoint. With no accountId,
// uses the live login's token.
export async function getClaudeAccountUsage(accountId?: string): Promise<ClaudeAccountUsageResult> {
  const accessToken = resolveAccessToken(accountId);
  if (!accessToken) {
    throw new Error("Claude OAuth access token was not found. Sign in to Claude Code first.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchWithSystemProxy("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        authorization: `Bearer ${accessToken}`
      },
      method: "GET",
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Claude usage endpoint returned HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return {
      fetchedAt: new Date().toISOString(),
      payload: JSON.parse(text) as unknown,
      source: accountId ? "account" : "live"
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Claude usage request timed out after 15000ms.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolveAccessToken(accountId: string | undefined): string | undefined {
  if (accountId) {
    const account = readRegistry().find((entry) => entry.id === accountId);
    const credentials = account ? readCredentialsFile(path.join(account.configDir, ".credentials.json")) : undefined;
    const token = credentials?.claudeAiOauth?.accessToken ?? credentials?.accessToken;
    if (token) {
      return token;
    }
  }
  return readClaudeCodeOauth()?.accessToken;
}

type CredentialsFile = {
  accessToken?: string;
  claudeAiOauth?: { accessToken?: string };
};

function readCredentialsFile(file: string): CredentialsFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const oauth = isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : {};
    return {
      accessToken: readString(parsed.accessToken),
      claudeAiOauth: { accessToken: readString(oauth.accessToken) }
    };
  } catch {
    return undefined;
  }
}

// Best-effort identity for "is this account the live one": file fingerprint
// first, then the captured keychain secret. A refreshed live token makes this
// comparison miss — acceptable, `isLive` is display sugar only.
function credentialsFingerprint(configDir: string): string | undefined {
  const fileFingerprintValue = fileFingerprint(path.join(configDir, ".credentials.json"));
  if (fileFingerprintValue) {
    return fileFingerprintValue;
  }
  const backup = readFileSyncSafe(path.join(configDir, "keychain-backup.txt"));
  return backup ? `keychain:${shortHash(backup)}` : undefined;
}

function liveCredentialsFingerprint(): string | undefined {
  return credentialsFingerprint(claudeCodeStorageDir()) ?? keychainSecretFingerprint();
}

function accountCredentialsFingerprint(configDir: string): string | undefined {
  return credentialsFingerprint(configDir) ?? keychainSecretFingerprint();
}

function fileFingerprint(file: string): string | undefined {
  try {
    if (!statSync(file).isFile()) {
      return undefined;
    }
    return `file:${shortHash(readFileSync(file, "utf8"))}`;
  } catch {
    return undefined;
  }
}

function keychainSecretFingerprint(): string | undefined {
  const secret = readKeychainSecret();
  return secret ? `keychain:${shortHash(secret)}` : undefined;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function readKeychainSecret(): string | undefined {
  if (process.platform !== "darwin") {
    // Non-macOS: the plaintext .credentials.json is the credential store.
    return undefined;
  }
  for (const service of claudeCodeExpectedKeychainServices()) {
    try {
      const stdout = execFileAsyncSafe("security", ["find-generic-password", "-s", service, "-a", claudeCodeKeychainAccount(), "-w"]);
      const secret = stdout.trim();
      if (secret) {
        return secret;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function writeKeychainSecret(secret: string): void {
  if (process.platform !== "darwin" || !secret.trim()) {
    return;
  }
  const service = claudeCodeExpectedKeychainServices()[0];
  const account = claudeCodeKeychainAccount();
  try {
    execFileAsyncSafe("security", ["delete-generic-password", "-s", service, "-a", account]);
  } catch {
    // Absent item is fine.
  }
  execFileAsyncSafe("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret]);
}

const execFileAsyncSafe = (command: string, args: string[]): string =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function copyFile(from: string, to: string): void {
  const temporaryFile = `${to}.tmp`;
  writeFileSync(temporaryFile, readFileSync(from), { mode: 0o600 });
  renameSync(temporaryFile, to);
}

function readFileSyncSafe(file: string): string | undefined {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
}

function readRegistry(): ClaudeAccountRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(registryFile(), "utf8")) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.accounts)) {
      return parsed.accounts
        .filter((entry): entry is ClaudeAccountRecord => isRecord(entry) && typeof entry.id === "string" && typeof entry.configDir === "string")
        .map((entry) => ({
          configDir: entry.configDir,
          createdAt: readString(entry.createdAt) ?? "",
          id: entry.id,
          label: readString(entry.label) ?? entry.id
        }));
    }
  } catch {
    // No registry yet.
  }
  return [];
}

function writeRegistry(accounts: ClaudeAccountRecord[]): void {
  mkdirSync(CONFIGDIR, { recursive: true });
  writeFileSync(registryFile(), `${JSON.stringify({ accounts, version: 1 }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}


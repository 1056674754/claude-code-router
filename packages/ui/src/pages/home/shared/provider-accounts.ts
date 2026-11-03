import type {
  ProviderAccountConnectorError,
  ProviderAccountMeter,
  ProviderAccountSnapshot
} from "@ccr/core/contracts/app";
import {
  formatCompactNumber
} from "./usage";

export function compareProviderAccountSnapshots(a: ProviderAccountSnapshot, b: ProviderAccountSnapshot): number {
  return (
    providerAccountStatusRank(b.status) - providerAccountStatusRank(a.status) ||
    a.provider.localeCompare(b.provider) ||
    providerAccountSnapshotCredentialLabel(a).localeCompare(providerAccountSnapshotCredentialLabel(b))
  );
}

export function providerAccountSnapshotKey(account: ProviderAccountSnapshot): string {
  return account.credentialId ? `${account.provider}::${account.credentialId}` : account.provider;
}

// Severity order surfaces failing accounts, but the account actually serving
// requests stays first: it is the one the panel points at.
export function orderProviderAccountSnapshots(snapshots: ProviderAccountSnapshot[], preferredCredentialId?: string): ProviderAccountSnapshot[] {
  const sorted = [...snapshots].sort(compareProviderAccountSnapshots);
  const preferredIndex = preferredCredentialId
    ? sorted.findIndex((snapshot) => snapshot.credentialId === preferredCredentialId)
    : -1;
  if (preferredIndex <= 0) {
    return sorted;
  }
  return [sorted[preferredIndex], ...sorted.slice(0, preferredIndex), ...sorted.slice(preferredIndex + 1)];
}

export function providerAccountSnapshotLabel(account: ProviderAccountSnapshot): string {
  const credential = providerAccountSnapshotCredentialLabel(account);
  return credential ? `${account.provider} / ${credential}` : account.provider;
}

export function providerAccountSnapshotCredentialLabel(account: ProviderAccountSnapshot): string {
  return account.credentialLabel?.trim() || account.credentialId?.trim() || "";
}

export function providerAccountStatusRank(status: ProviderAccountSnapshot["status"]): number {
  if (status === "error") return 4;
  if (status === "critical") return 3;
  if (status === "warning") return 2;
  if (status === "ok") return 1;
  return 0;
}

export function primaryProviderAccountMeter(account: ProviderAccountSnapshot): ProviderAccountMeter | undefined {
  return [...account.meters].sort((a, b) => {
    const aRatio = providerAccountMeterRemainingRatio(a) ?? 1;
    const bRatio = providerAccountMeterRemainingRatio(b) ?? 1;
    return aRatio - bRatio;
  })[0];
}

export function providerAccountMetersForDisplay(account: ProviderAccountSnapshot, maxCount: number): ProviderAccountMeter[] {
  const meters = account.meters.slice(0, maxCount);
  const manualResetMeter = account.meters.find(isProviderAccountManualResetMeter);
  if (!manualResetMeter || meters.includes(manualResetMeter) || meters.length < maxCount) {
    return meters;
  }
  return [...meters.slice(0, Math.max(0, maxCount - 1)), manualResetMeter];
}

export function providerAccountMeterRemainingRatio(meter: ProviderAccountMeter): number | undefined {
  if (!meter.limit || meter.limit <= 0 || meter.remaining === undefined) {
    return undefined;
  }
  return Math.max(0, Math.min(1, meter.remaining / meter.limit));
}

export function providerAccountMeterProgress(meter: ProviderAccountMeter): number | undefined {
  const ratio = providerAccountMeterRemainingRatio(meter);
  return ratio === undefined ? undefined : Math.max(3, Math.round(ratio * 100));
}

export function providerAccountMeterValidityProgress(meter: ProviderAccountMeter, now = Date.now()): number | undefined {
  const detail = providerAccountCurrentMeterDetail(meter, now);
  if (!detail) {
    return undefined;
  }
  const progress = providerAccountMeterDetailValidityProgress(detail, now);
  return progress && progress > 0 ? progress : undefined;
}

export function providerAccountCurrentMeterDetail(meter: ProviderAccountMeter, now = Date.now()): NonNullable<ProviderAccountMeter["details"]>[number] | undefined {
  return (meter.details ?? [])
    .filter((detail) => {
      const effectiveAt = providerAccountDetailTimestamp(detail.effectiveAt);
      const expiresAt = providerAccountDetailTimestamp(detail.expiresAt);
      return effectiveAt !== undefined && expiresAt !== undefined && effectiveAt <= now && now < expiresAt;
    })
    .sort((a, b) => (providerAccountDetailTimestamp(a.expiresAt) ?? Number.MAX_SAFE_INTEGER) - (providerAccountDetailTimestamp(b.expiresAt) ?? Number.MAX_SAFE_INTEGER))[0];
}

export function providerAccountMeterDetailValidityProgress(detail: NonNullable<ProviderAccountMeter["details"]>[number], now = Date.now()): number | undefined {
  const effectiveAt = providerAccountDetailTimestamp(detail.effectiveAt);
  const expiresAt = providerAccountDetailTimestamp(detail.expiresAt);
  if (effectiveAt === undefined || expiresAt === undefined || expiresAt <= effectiveAt) {
    return undefined;
  }
  if (now <= effectiveAt) {
    return 100;
  }
  if (now >= expiresAt) {
    return 0;
  }
  const ratio = (expiresAt - now) / (expiresAt - effectiveAt);
  return Math.max(3, Math.round(Math.max(0, Math.min(1, ratio)) * 100));
}

export function formatProviderAccountDetailDate(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}`;
}

function providerAccountDetailTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function providerAccountBadgeVariant(status: ProviderAccountSnapshot["status"]): "danger" | "outline" | "success" | "warning" {
  if (status === "critical" || status === "error") {
    return "danger";
  }
  if (status === "warning") {
    return "warning";
  }
  if (status === "ok") {
    return "success";
  }
  return "outline";
}

export function providerAccountProgressClass(status: ProviderAccountSnapshot["status"]): string {
  if (status === "critical" || status === "error") {
    return "bg-red-500";
  }
  if (status === "warning") {
    return "bg-amber-500";
  }
  return "bg-emerald-500";
}

export function formatProviderAccountMeterValue(
  meter: ProviderAccountMeter,
  translate: (value: string) => string = (value) => value
): string {
  // A percent meter's limit is only its scale (100), never a remaining amount:
  // falling back to it would render an unknown quota as a healthy 100%.
  const value = meter.remaining ?? meter.used ?? (meter.unit.trim() === "%" ? undefined : meter.limit);
  if (value === undefined) {
    return "-";
  }
  const unit = meter.unit.trim();
  const normalizedUnit = unit.toUpperCase();
  if (normalizedUnit === "USD") {
    return `$${formatProviderAccountCurrency(value)}`;
  }
  if (normalizedUnit === "CNY") {
    return `¥${formatProviderAccountCurrency(value)}`;
  }
  if (normalizedUnit === "EUR") {
    return `€${formatProviderAccountCurrency(value)}`;
  }
  if (unit === "%") {
    return `${formatProviderAccountNumber(value)}%`;
  }
  if (unit === "hours") {
    return `${formatProviderAccountNumber(value)}h`;
  }
  if (unit === "minutes") {
    return `${formatProviderAccountNumber(value)}m`;
  }
  const displayUnit = translate(unit);
  if (meter.kind === "balance") {
    return `${formatProviderAccountNumber(value)} ${displayUnit}`;
  }
  return `${formatCompactNumber(value)} ${displayUnit}`;
}

export function formatProviderAccountNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
}

// Money meters arrive as raw provider quota scaled by the connector mapping
// (New API divides by 500000), which leaves long fractional tails. Dime
// precision keeps a balance readable without pretending more accuracy.
export function formatProviderAccountCurrency(value: number): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

// A failed connector is worth surfacing even when a sibling connector produced
// a message: the message explains what is missing, the error explains what broke.
export function providerAccountConnectorErrors(account: ProviderAccountSnapshot): ProviderAccountConnectorError[] {
  const message = account.message?.trim();
  const seen = new Set<string>();
  return (account.errors ?? []).filter((error) => {
    const text = error.message?.trim();
    if (!text || text === message || seen.has(text)) {
      return false;
    }
    seen.add(text);
    return true;
  });
}

export function providerAccountConnectorErrorDetail(account: ProviderAccountSnapshot): string | undefined {
  const errors = providerAccountConnectorErrors(account);
  if (errors.length === 0) {
    return undefined;
  }
  return errors
    .map((error) => (error.connectorId ? `${error.connectorId}: ${error.message}` : error.message))
    .join("\n");
}

export function formatProviderAccountReset(value: string, translate: (value: string) => string = (item) => item): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  const minutes = Math.round((timestamp - Date.now()) / 60000);
  if (minutes <= 0) {
    return translate("expired");
  }
  const prefix = translate("expires in");
  if (minutes < 60) {
    return `${prefix} ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const leftoverMinutes = minutes % 60;
  if (hours < 48) {
    return leftoverMinutes > 0 ? `${prefix} ${hours}h ${leftoverMinutes}m` : `${prefix} ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const leftoverHours = hours % 24;
  return leftoverHours > 0 ? `${prefix} ${days}d ${leftoverHours}h` : `${prefix} ${days}d`;
}

export function formatProviderAccountMeterTitle(meter: ProviderAccountMeter, translate: (value: string) => string): string {
  const label = translate(meter.label);
  return meter.resetAt ? `${label} (${formatProviderAccountReset(meter.resetAt, translate)})` : label;
}

export function isProviderAccountManualResetMeter(meter: ProviderAccountMeter): boolean {
  const text = `${meter.id} ${meter.label} ${meter.window ?? ""}`.toLowerCase();
  return text.includes("manual_reset") || text.includes("manual reset") || text.includes("manual-reset");
}

// Legacy local-estimate meters count CCR's OWN traffic ("CCR tokens (30d)",
// "CCR requests (30d)"). They describe router activity, not a provider account
// quota, so account usage panels leave them out.
export function isProviderAccountSelfUsageMeter(meter: ProviderAccountMeter): boolean {
  const id = meter.id.trim().toLowerCase();
  const label = meter.label.trim().toLowerCase();
  return id.startsWith("codex_ccr_") ||
    label.startsWith("ccr tokens") ||
    label.startsWith("ccr requests");
}

// Usage fetches hit provider edge networks and fail transiently far more often
// than they fail for a durable reason. The UI keeps the raw message as a
// tooltip but shows a localized, actionable line and retries automatically.
const retryableUsageFailurePatterns = [
  "fetch failed",
  "failed to fetch",
  "networkerror",
  "network error",
  "socket hang up",
  "econnreset",
  "econnrefused",
  "etimedout",
  "eai_again",
  "enotfound",
  "und_err",
  "timed out",
  "timeout",
  "aborted"
];

export function providerAccountFailureDetail(account: ProviderAccountSnapshot): string | undefined {
  const detail = account.message?.trim() || account.errors?.[0]?.message?.trim();
  return detail || undefined;
}

export function isRetryableProviderAccountFailure(account: ProviderAccountSnapshot): boolean {
  if (account.status !== "error") {
    return false;
  }
  const detail = providerAccountFailureDetail(account);
  if (!detail) {
    return false;
  }
  const lower = detail.toLowerCase();
  return retryableUsageFailurePatterns.some((pattern) => lower.includes(pattern));
}

export function providerAccountFailureText(account: ProviderAccountSnapshot): string | undefined {
  const detail = providerAccountFailureDetail(account);
  if (!detail) {
    return undefined;
  }
  return isRetryableProviderAccountFailure(account) ? "Usage request failed; retrying" : detail;
}

export function providerAccountStatusTooltip(account: ProviderAccountSnapshot): string {
  if (account.status === "error") {
    return "The usage request failed.";
  }
  if (account.status === "critical") {
    return "Quota exhausted or the account is rate limited.";
  }
  if (account.status === "warning") {
    return "Quota is nearly exhausted.";
  }
  return "Quota is healthy.";
}

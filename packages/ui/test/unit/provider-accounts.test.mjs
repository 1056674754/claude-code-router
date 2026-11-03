import assert from "node:assert/strict";
import test from "node:test";
import {
  isProviderAccountSelfUsageMeter,
  isRetryableProviderAccountFailure,
  orderProviderAccountSnapshots,
  providerAccountFailureDetail,
  providerAccountFailureText
} from "@ccr/ui/pages/home/shared/provider-accounts.ts";

function snapshot({ credentialId, label, meters = [], status = "ok" }) {
  return {
    credentialId,
    credentialLabel: label,
    meters,
    provider: "Codex ChatGPT",
    source: "merged",
    status,
    updatedAt: "2026-11-02T00:00:00.000Z"
  };
}

test("the account in use sorts first, the rest keep severity order", () => {
  const critical = snapshot({ credentialId: "acct-1", label: "ai@example.com", status: "critical" });
  const healthy = snapshot({ credentialId: "acct-3", label: "devgroup@example.com", status: "warning" });
  const warning = snapshot({ credentialId: "acct-2", label: "devgroup2@example.com", status: "critical" });

  const ordered = orderProviderAccountSnapshots([critical, warning, healthy], "acct-3");
  assert.deepEqual(ordered.map((account) => account.credentialId), ["acct-3", "acct-1", "acct-2"]);
});

test("without a preferred credential the most severe account stays first", () => {
  const ok = snapshot({ credentialId: "acct-1", label: "a@example.com", status: "ok" });
  const critical = snapshot({ credentialId: "acct-2", label: "b@example.com", status: "critical" });

  const ordered = orderProviderAccountSnapshots([ok, critical]);
  assert.deepEqual(ordered.map((account) => account.credentialId), ["acct-2", "acct-1"]);
});

test("unknown preferred credentials do not reorder the list", () => {
  const first = snapshot({ credentialId: "acct-1", label: "a@example.com", status: "ok" });
  const second = snapshot({ credentialId: "acct-2", label: "b@example.com", status: "ok" });

  const ordered = orderProviderAccountSnapshots([first, second], "missing");
  assert.deepEqual(ordered.map((account) => account.credentialId), ["acct-1", "acct-2"]);
});

test("CCR self-usage counters are not account quota", () => {
  assert.equal(
    isProviderAccountSelfUsageMeter({ id: "codex_ccr_tokens_30d", label: "CCR tokens (30d)", unit: "tokens" }),
    true
  );
  assert.equal(
    isProviderAccountSelfUsageMeter({ id: "custom", label: "CCR requests (30d)", unit: "requests" }),
    true
  );
  assert.equal(
    isProviderAccountSelfUsageMeter({ id: "codex_primary_quota", label: "Primary quota", unit: "%" }),
    false
  );
  assert.equal(
    isProviderAccountSelfUsageMeter({ id: "custom", label: "Credit balance", unit: "credits" }),
    false
  );
});

test("a transient usage failure is localized and retried, not shown raw", () => {
  const failed = {
    ...snapshot({ credentialId: "acct-1", label: "a@example.com", status: "error" }),
    errors: [{ message: "fetch failed" }],
    message: "fetch failed"
  };
  assert.equal(isRetryableProviderAccountFailure(failed), true);
  assert.equal(providerAccountFailureDetail(failed), "fetch failed");
  assert.equal(providerAccountFailureText(failed), "Usage request failed; retrying");
});

test("durable usage failures keep the provider message", () => {
  const unauthorized = {
    ...snapshot({ credentialId: "acct-1", label: "a@example.com", status: "error" }),
    message: "HTTP 401 Unauthorized"
  };
  assert.equal(isRetryableProviderAccountFailure(unauthorized), false);
  assert.equal(providerAccountFailureText(unauthorized), "HTTP 401 Unauthorized");
});

test("healthy accounts have no failure text", () => {
  assert.equal(providerAccountFailureText(snapshot({ credentialId: "acct-1", label: "a@example.com" })), undefined);
});

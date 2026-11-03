import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "ccr-claude-extras-"));
process.env.CLAUDE_CONFIG_DIR = path.join(testRoot, "claude-config");
const projectsRoot = path.join(process.env.CLAUDE_CONFIG_DIR, "projects");
mkdirSync(projectsRoot, { recursive: true });
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

import { circuitAllows, circuitState, recordCircuitFailure, recordCircuitSuccess, resetCircuitBreaker } from "@ccr/core/providers/circuit-breaker.ts";
import { deleteClaudeSession, listClaudeSessions, readClaudeSession } from "@ccr/core/agents/claude-code/session-reader.ts";
import { importClaudeDirectUsage } from "@ccr/core/usage/claude-direct-import.ts";
import { captureClaudeAccount, listClaudeAccounts, switchClaudeAccount } from "@ccr/core/agents/claude-code/account-center.ts";

test("circuit breaker opens after the failure threshold and half-admits probes after the open window", () => {
  resetCircuitBreaker();
  for (let index = 0; index < 5; index += 1) {
    recordCircuitFailure("provider-a");
  }
  assert.equal(circuitState("provider-a"), "open");
  assert.equal(circuitAllows("provider-a"), false);
  // A success on another provider must not clear this circuit.
  recordCircuitSuccess("provider-b");
  assert.equal(circuitState("provider-a"), "open");
  resetCircuitBreaker();
  assert.equal(circuitAllows("provider-a"), true);
});

test("circuit breaker records success as fully closed", () => {
  resetCircuitBreaker();
  recordCircuitFailure("provider-c");
  recordCircuitSuccess("provider-c");
  assert.equal(circuitState("provider-c"), "closed");
  assert.equal(circuitAllows("provider-c"), true);
});

test("session reader lists, reads and deletes Claude transcripts", () => {
  const projectDir = path.join(projectsRoot, "-Users-song-demo");
  mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, "11111111-2222-3333-4444-555555555555.jsonl");
  writeFileSync(file, [
    JSON.stringify({ type: "summary", summary: "Fix the login flow" }),
    JSON.stringify({ type: "user", uuid: "u1", sessionId: "11111111", timestamp: "2026-11-01T10:00:00Z", message: { role: "user", content: "the login button is broken" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "11111111", timestamp: "2026-11-01T10:00:05Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "I will fix it" }, { type: "tool_use", name: "Edit", input: { file: "app.tsx" } }] } })
  ].join("\n"));

  const sessions = listClaudeSessions();
  const found = sessions.find((session) => session.sessionId === "11111111-2222-3333-4444-555555555555");
  assert.ok(found);
  assert.equal(found.title, "Fix the login flow");
  assert.equal(found.messageCount, 2);
  assert.equal(found.project, "Users/song/demo");

  const detail = readClaudeSession(file);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0].text, "the login button is broken");
  assert.equal(detail.messages[1].hasThinking, true);
  assert.deepEqual(detail.messages[1].toolUses.map((toolUse) => toolUse.name), ["Edit"]);

  deleteClaudeSession(file);
  assert.equal(existsSync(file), false);
  rmSync(projectDir, { force: true, recursive: true });
});

test("direct usage import maps JSONL usage into events with dedup", async () => {
  const projectDir = path.join(projectsRoot, "-Users-song-usage");
  mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, "99999999-8888-7777-6666-555555555555.jsonl");
  const usage = {
    input_tokens: 1000,
    cache_creation_input_tokens: 500,
    cache_read_input_tokens: 200,
    output_tokens: 300,
    cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 400 }
  };
  writeFileSync(file, JSON.stringify({
    type: "assistant", uuid: "a-1", sessionId: "99999999", timestamp: "2026-11-01T12:00:00Z",
    message: { role: "assistant", model: "claude-sonnet-5", usage }
  }) + "\n");

  const first = await importClaudeDirectUsage();
  assert.equal(first.eventsImported, 1);
  assert.equal(first.tokensTotal, 1000 + 300 + 200 + 100 + 400);

  // Re-import must be a no-op: the file offset advanced.
  const second = await importClaudeDirectUsage();
  assert.equal(second.eventsImported, 0);

  deleteClaudeSession(file);
  rmSync(projectDir, { force: true, recursive: true });
});

test("claude account center captures and switches the file-based login", () => {
  // Fake live login: a .credentials.json inside the CLAUDE_CONFIG_DIR home.
  const liveDir = process.env.CLAUDE_CONFIG_DIR;
  const secret = JSON.stringify({ claudeAiOauth: { accessToken: "acct-token-1", refreshToken: "rt-1" } });
  writeFileSync(path.join(liveDir, ".credentials.json"), secret);

  const record = captureClaudeAccount("work");
  assert.ok(existsSync(path.join(record.configDir, ".credentials.json")));

  // Overwrite the live slot with a DIFFERENT login, then switch back.
  writeFileSync(path.join(liveDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "other-account" } }));
  switchClaudeAccount(record.id);
  const restored = JSON.parse(readFileSync(path.join(liveDir, ".credentials.json"), "utf8"));
  assert.equal(restored.claudeAiOauth.accessToken, "acct-token-1");

  const accounts = listClaudeAccounts();
  const entry = accounts.find((account) => account.id === record.id);
  assert.equal(entry?.isLive, true);

  rmSync(record.configDir, { force: true, recursive: true });
});

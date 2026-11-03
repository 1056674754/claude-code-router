import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATADIR } from "@ccr/core/config/constants";
import { isRecord, readString } from "@ccr/core/agents/local-providers/shared";
import type { ClaudeDirectUsageImportResult } from "@ccr/core/contracts/app";
import { usageStore } from "@ccr/core/usage/store";

// Imports token usage from Claude Code session transcripts
// (~/.claude/projects/**/*.jsonl) into the usage DB, so DIRECT-mode traffic
// (bypassing the CCR gateway) still shows up in the usage dashboard. Files are
// append-only; a per-file byte offset in a state file makes re-imports
// incremental, and each event carries a deterministic requestId so the DB
// stays duplicate-free even if the state file is lost.


type ImportState = {
  files: Record<string, { offset: number }>;
  version: 1;
};

const stateFile = () => path.join(DATADIR, "claude-direct-usage-import-state.json");
const claudeProjectsDir = () => {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? path.join(configured, "projects") : path.join(os.homedir(), ".claude", "projects");
};

export async function importClaudeDirectUsage(maxEvents = 5000): Promise<ClaudeDirectUsageImportResult> {
  const root = claudeProjectsDir();
  if (!existsSync(root)) {
    return { eventsImported: 0, eventsSkippedExisting: 0, filesScanned: 0, tokensTotal: 0 };
  }
  const state = readState();
  const result: ClaudeDirectUsageImportResult = { eventsImported: 0, eventsSkippedExisting: 0, filesScanned: 0, tokensTotal: 0 };

  for (const file of listSessionFiles(root)) {
    result.filesScanned += 1;
    let offset = state.files[file]?.offset ?? 0;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < offset) {
      // Truncated/replaced file: start over.
      offset = 0;
    }
    if (size === offset) {
      continue;
    }
    let content = "";
    try {
      content = readFileSync(file, "utf8").slice(offset);
    } catch {
      continue;
    }
    const lines = content.split("\n");
    // The trailing fragment is an incomplete line unless the file ends with \n.
    const completeLines = content.endsWith("\n") ? lines.filter((line) => line.trim()) : lines.slice(0, -1).filter((line) => line.trim());
    let consumed = offset + completeLines.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);

    for (const line of completeLines) {
      if (result.eventsImported >= maxEvents) {
        // Persist progress up to here and stop; the next run resumes.
        state.files[file] = { offset: consumed - (Buffer.byteLength(line, "utf8") + 1) };
        writeState(state);
        return result;
      }
      const event = sessionLineToUsageEvent(line);
      if (!event) {
        continue;
      }
      try {
        if (await usageStore.hasRequestId(event.requestId)) {
          result.eventsSkippedExisting += 1;
          continue;
        }
        await usageStore.record(event);
        result.eventsImported += 1;
        result.tokensTotal += event.usage?.totalTokens ?? 0;
      } catch {
        // A malformed line must not abort the whole import.
      }
    }
    state.files[file] = { offset: consumed };
  }
  writeState(state);
  return result;
}

function sessionLineToUsageEvent(line: string) {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(record) || record.type !== "assistant" || !isRecord(record.message)) {
    return undefined;
  }
  const usageRecord = isRecord(record.message.usage) ? record.message.usage : undefined;
  if (!usageRecord) {
    return undefined;
  }
  const number_ = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
  const cacheCreation = isRecord(usageRecord.cache_creation) ? usageRecord.cache_creation : {};
  const cacheWrite1hTokens = number_(cacheCreation.ephemeral_1h_input_tokens);
  const cacheWrite5mTokens = number_(cacheCreation.ephemeral_5m_input_tokens) || number_(usageRecord.cache_creation_input_tokens);
  const inputTokens = number_(usageRecord.input_tokens);
  const outputTokens = number_(usageRecord.output_tokens);
  const cacheReadTokens = number_(usageRecord.cache_read_input_tokens);
  const sessionId = readString(record.sessionId) || "unknown";
  const uuid = readString(record.uuid) || `${readString(record.timestamp) || ""}:${inputTokens}:${outputTokens}`;
  const model = readString(record.message.model) || "unknown";
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWrite1hTokens + cacheWrite5mTokens;
  if (totalTokens === 0) {
    return undefined;
  }
  return {
    createdAt: readString(record.timestamp) || undefined,
    client: "claude-code",
    credentialId: "",
    durationMs: 0,
    method: "POST",
    model,
    modelIsRouteSelector: false,
    path: "/v1/messages",
    provider: "claude-code-direct",
    requestId: `ccr-claude-direct:${sessionId}:${uuid}`,
    statusCode: 200,
    usage: {
      cacheReadTokens,
      cacheWrite1hTokens,
      cacheWrite5mTokens,
      inputTokens,
      outputTokens,
      totalTokens
    }
  };
}

function listSessionFiles(root: string): string[] {
  const files: string[] = [];
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return files;
  }
  for (const projectDir of projectDirs) {
    try {
      for (const name of readdirSync(path.join(root, projectDir))) {
        if (name.endsWith(".jsonl")) {
          files.push(path.join(root, projectDir, name));
        }
      }
    } catch {
      continue;
    }
  }
  return files;
}

function readState(): ImportState {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as unknown;
    if (isRecord(parsed) && isRecord(parsed.files)) {
      const files: ImportState["files"] = {};
      for (const [file, entry] of Object.entries(parsed.files)) {
        if (isRecord(entry) && typeof entry.offset === "number") {
          files[file] = { offset: entry.offset };
        }
      }
      return { files, version: 1 };
    }
  } catch {
    // Missing/corrupt state: full re-import (requestId dedup guards the DB).
  }
  return { files: {}, version: 1 };
}

function writeState(state: ImportState): void {
  try {
    mkdirSync(DATADIR, { recursive: true });
    writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best effort: worst case the next import replans from scratch and the
    // requestId dedup keeps the DB clean.
  }
}

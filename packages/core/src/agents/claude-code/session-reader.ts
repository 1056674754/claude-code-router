import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord, readString } from "@ccr/core/agents/local-providers/shared";
import type { ClaudeSessionDetail, ClaudeSessionMessage, ClaudeSessionSummary } from "@ccr/core/contracts/app";

// Read-only viewer for Claude Code session transcripts (~/.claude/projects/**/*.jsonl).
// JSONL is append-only: one JSON object per line, mostly {type: "user"|"assistant",
// message: {...}, timestamp, uuid, sessionId, cwd}, plus {"type":"summary"} lines.

const sessionReadByteCap = 24 * 1024 * 1024;
const sessionMessageCap = 400;
const titleTextCap = 120;

export function claudeProjectsRoot(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? path.join(configured, "projects") : path.join(os.homedir(), ".claude", "projects");
}

function claudeProjectsRootSafe(): string | undefined {
  const root = claudeProjectsRoot();
  return existsSync(root) ? root : undefined;
}

function textFromContent(content: unknown): { text: string; toolUses: Array<{ name: string; input: string }>; hasThinking: boolean; hasImage: boolean } {
  const result = { text: "", toolUses: [] as Array<{ name: string; input: string }>, hasThinking: false, hasImage: false };
  if (typeof content === "string") {
    result.text = content;
    return result;
  }
  if (!Array.isArray(content)) {
    return result;
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const type = readString(block.type);
    if (type === "text") {
      textParts.push(readString(block.text) ?? "");
    } else if (type === "thinking") {
      result.hasThinking = true;
    } else if (type === "image") {
      result.hasImage = true;
    } else if (type === "tool_use") {
      result.toolUses.push({
        input: JSON.stringify(block.input ?? {}).slice(0, 600),
        name: readString(block.name) || "tool"
      });
    }
  }
  result.text = textParts.filter(Boolean).join("\n").trim();
  return result;
}

function firstUserText(record: unknown): string {
  if (!isRecord(record) || record.type !== "user" || !isRecord(record.message)) {
    return "";
  }
  return textFromContent(record.message.content).text.slice(0, titleTextCap);
}

function sessionTitle(firstLine: unknown, firstUser: string): string {
  if (isRecord(firstLine) && firstLine.type === "summary") {
    return readString(firstLine.summary) || "Untitled session";
  }
  return firstUser || "Untitled session";
}

function projectLabel(file: string): string {
  const dir = path.basename(path.dirname(file));
  return dir.replace(/^-+/g, "").replace(/-/g, path.sep === "/" ? "/" : "-");
}

export function listClaudeSessions(limit = 300): ClaudeSessionSummary[] {
  const root = claudeProjectsRootSafe();
  if (!root) {
    return [];
  }
  const summaries: ClaudeSessionSummary[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  for (const projectDir of projectDirs) {
    const projectPath = path.join(root, projectDir);
    let files: string[] = [];
    try {
      files = readdirSync(projectPath).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const fullPath = path.join(projectPath, file);
      try {
        const stats = statSync(fullPath);
        if (stats.size > sessionReadByteCap) {
          summaries.push({
            file: fullPath,
            messageCount: 0,
            project: projectLabel(fullPath),
            sessionId: file.replace(/\.jsonl$/, ""),
            sizeBytes: stats.size,
            title: "(session too large to index)",
            updatedAt: stats.mtime.toISOString()
          });
          continue;
        }
        const content = readFileSyncSafe(fullPath);
        if (content === undefined) {
          continue;
        }
        const lines = content.split("\n").filter((line) => line.trim());
        let title = "";
        let firstUser = "";
        let startedAt: string | undefined;
        let messageCount = 0;
        for (const line of lines) {
          const record = parseLine(line);
          if (!record) {
            continue;
          }
          if (!title) {
            title = sessionTitle(record, firstUser);
          }
          if (record.type === "summary") {
            title = readString(record.summary) || title;
            continue;
          }
          if (record.type !== "user" && record.type !== "assistant") {
            continue;
          }
          messageCount += 1;
          if (!firstUser && record.type === "user") {
            firstUser = firstUserText(record);
            if (!title) {
              title = firstUser;
            }
          }
          startedAt = startedAt ?? readString(record.timestamp);
        }
        summaries.push({
          file: fullPath,
          messageCount,
          project: projectLabel(fullPath),
          sessionId: file.replace(/\.jsonl$/, ""),
          sizeBytes: stats.size,
          startedAt,
          title: (title || firstUser || "Untitled session").slice(0, titleTextCap),
          updatedAt: stats.mtime.toISOString()
        });
      } catch {
        // Unreadable session file: skip it rather than failing the listing.
      }
    }
  }
  return summaries
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export function readClaudeSession(file: string): ClaudeSessionDetail {
  const root = claudeProjectsRootSafe();
  const resolved = path.resolve(file);
  if (!root || !resolved.startsWith(root + path.sep) || !existsSync(resolved)) {
    throw new Error("Session file was not found.");
  }
  const stats = statSync(resolved);
  const content = readFileSyncSafe(resolved);
  if (content === undefined) {
    throw new Error("Session file could not be read.");
  }
  const lines = content.split("\n").filter((line) => line.trim());
  const withinCap = lines.length <= sessionMessageCap;
  const selectedLines = withinCap ? lines : lines.slice(-sessionMessageCap);
  const messages: ClaudeSessionMessage[] = [];
  let title = "";
  for (const line of selectedLines) {
    const record = parseLine(line);
    if (!record) {
      continue;
    }
    if (!title && record.type === "summary") {
      title = readString(record.summary) || "";
    }
    if (record.type !== "user" && record.type !== "assistant") {
      continue;
    }
    const message = isRecord(record.message) ? record.message : {};
    const extracted = textFromContent(message.content);
    messages.push({
      hasImage: extracted.hasImage,
      hasThinking: extracted.hasThinking,
      model: readString(message.model),
      role: readString(message.role) || record.type,
      text: extracted.text,
      timestamp: readString(record.timestamp),
      toolUses: extracted.toolUses
    });
  }
  return {
    file: resolved,
    messages,
    project: projectLabel(resolved),
    sessionId: path.basename(resolved).replace(/\.jsonl$/, ""),
    sizeBytes: stats.size,
    title: title || (messages.find((message) => message.role === "user")?.text ?? "Untitled session").slice(0, titleTextCap),
    truncated: !withinCap
  };
}

export function deleteClaudeSession(file: string): void {
  const root = claudeProjectsRootSafe();
  const resolved = path.resolve(file);
  if (!root || !resolved.startsWith(root + path.sep)) {
    throw new Error("Session path is outside the Claude projects directory.");
  }
  rmSync(resolved, { force: true });
}

export function claudeSessionResumeCommand(sessionId: string): string {
  return `claude --resume ${sessionId}`;
}

function readFileSyncSafe(file: string): string | undefined {
  try {
    return statSync(file).isFile() ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

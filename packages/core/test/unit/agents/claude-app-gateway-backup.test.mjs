import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { backupFile, fakeHome } from "./claude-app-gateway-backup-env.mjs";
import { applyClaudeAppGatewayConfig } from "@ccr/core/agents/claude-app/gateway-service.ts";

const configLibraryFile = "8f69f2f1-3275-4ad8-9317-4aa7e972f311.json";

function createConfig() {
  return {
    APIKEY: "existing-test-key",
    APIKEYS: [],
    HOST: "0.0.0.0",
    PORT: 3456,
    Providers: [{ models: ["test-model"], name: "test-provider" }],
    gateway: { enabled: false, host: "0.0.0.0", port: 3456 },
    profile: { profiles: [] },
    virtualModelProfiles: []
  };
}

function seedProfile(dir) {
  mkdirSync(path.join(dir, "configLibrary"), { recursive: true });
  writeFileSync(
    path.join(dir, "configLibrary", configLibraryFile),
    JSON.stringify({ coworkEgressAllowedHosts: ["*"], inferenceModels: [] }),
    "utf8"
  );
}

test("a poisoned exists:false backup self-heals once the profile exists", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ccr-gateway-backup-test-"));
  const activeDataDir = `${dataDir}-3p`;
  try {
    seedProfile(dataDir);
    seedProfile(activeDataDir);
    mkdirSync(path.dirname(backupFile), { recursive: true });
    writeFileSync(backupFile, JSON.stringify({
      configLibraryFile: { exists: false },
      createdAt: "2026-09-11T00:00:00.000Z",
      metaFile: { exists: false },
      rootConfigFile: { exists: false },
      version: 1
    }), "utf8");

    applyClaudeAppGatewayConfig(createConfig(), { dataDir });

    const backup = JSON.parse(readFileSync(backupFile, "utf8"));
    assert.equal(backup.configLibraryFile.exists, true);
    const recorded = JSON.parse(backup.configLibraryFile.content);
    assert.deepEqual(recorded.coworkEgressAllowedHosts, ["*"]);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(activeDataDir, { force: true, recursive: true });
  }
});

test("a healthy backup is never overwritten by later applies", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ccr-gateway-backup-keep-test-"));
  const activeDataDir = `${dataDir}-3p`;
  try {
    seedProfile(dataDir);
    mkdirSync(path.dirname(backupFile), { recursive: true });
    writeFileSync(backupFile, JSON.stringify({
      configLibraryFile: { content: "{\"inferenceModels\":[]}", exists: true },
      createdAt: "2026-09-11T00:00:00.000Z",
      metaFile: { exists: false },
      rootConfigFile: { exists: false },
      version: 1
    }), "utf8");

    applyClaudeAppGatewayConfig(createConfig(), { backup: false, dataDir });

    const backup = JSON.parse(readFileSync(backupFile, "utf8"));
    assert.equal(backup.createdAt, "2026-09-11T00:00:00.000Z");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(activeDataDir, { force: true, recursive: true });
  }
});

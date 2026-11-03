import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { spawnGatewayProcess } from "@ccr/core/gateway/core-runtime/supervisor.ts";
import { gatewayEntryOverrideEnv } from "@ccr/core/gateway/internal/shared.ts";

// The supervisor ships the compiled gateway config to the child over the
// child_process IPC channel and waits for the child to acknowledge it. The
// channel must stay independent of the child runtime's V8 serializer version
// (CCR_NODE_BIN / a system node picked for its native-module ABI), otherwise
// the parent throws "Unable to deserialize cloned data" and the gateway never
// reaches config-accepted. This exercises the real bootstrap end to end.
test("gateway child accepts the runtime config over the IPC channel", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "ccr-gateway-ipc-"));
  const deliveredConfigPath = path.join(workDir, "delivered-config.json");
  const entryPath = path.join(workDir, "stub-gateway-entry.cjs");
  writeFileSync(entryPath, [
    "\"use strict\";",
    "const fs = require(\"node:fs\");",
    `fs.writeFileSync(${JSON.stringify(deliveredConfigPath)}, fs.readFileSync(process.env.GATEWAY_CONFIG_PATH, "utf8"));`,
    "module.exports = {};",
    ""
  ].join("\n"));

  const previousEntry = process.env[gatewayEntryOverrideEnv];
  process.env[gatewayEntryOverrideEnv] = entryPath;
  const gatewayConfig = {
    flag: true,
    nested: { list: [1, 2, 3], text: "value" },
    providers: []
  };
  let child;
  try {
    const spawned = spawnGatewayProcess(
      createDefaultAppConfig(),
      gatewayConfig,
      undefined,
      "gateway-ipc-test",
      "test-core-gateway-auth-token"
    );
    child = spawned.child;
    await withTimeout(spawned.configAccepted, 20_000, "gateway child never accepted the runtime config");
    assert.deepEqual(JSON.parse(readFileSync(deliveredConfigPath, "utf8")), gatewayConfig);
  } finally {
    child?.kill();
    if (previousEntry === undefined) {
      delete process.env[gatewayEntryOverrideEnv];
    } else {
      process.env[gatewayEntryOverrideEnv] = previousEntry;
    }
    rmSync(workDir, { force: true, recursive: true });
  }
});

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

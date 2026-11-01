import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  importZcodeProvider,
  readZcodeLocalProviderCredential,
  zcodeCandidate
} from "@ccr/core/agents/local-providers/zcode.ts";
import { zcodeCredentialCipherKey } from "@ccr/core/agents/zcode/credential-cipher.ts";

const accountId = "12345678901234567";
const apiKey = "test-zcode-coding-plan-api-key";

function encryptCredential(value, secret) {
  const previous = process.env.ZCODE_CREDENTIAL_SECRET;
  if (secret === undefined) {
    delete process.env.ZCODE_CREDENTIAL_SECRET;
  } else {
    process.env.ZCODE_CREDENTIAL_SECRET = secret;
  }
  try {
    const key = zcodeCredentialCipherKey();
    const nonce = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const part = (buffer) => buffer.toString("base64url");
    return `enc:v1:${part(nonce)}.${part(tag)}.${part(payload)}`;
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_CREDENTIAL_SECRET;
    } else {
      process.env.ZCODE_CREDENTIAL_SECRET = previous;
    }
  }
}

function withStorageRoot(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccr-zcode-"));
  const previous = process.env.ZCODE_STORAGE_DIR;
  process.env.ZCODE_STORAGE_DIR = root;
  try {
    return run(root);
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_STORAGE_DIR;
    } else {
      process.env.ZCODE_STORAGE_DIR = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeV2Fixture(root, options = {}) {
  const family = options.family ?? "bigmodel";
  const kind = options.kind ?? "individual-coding-plan";
  writeJson(path.join(root, "v2", "setting.json"), {
    locale: "zh-CN",
    providerFamilyDomain: family,
    providerFamilyConnectionSelections: { [family]: { kind } }
  });
  writeJson(path.join(root, "v2", "provider_config.json"), {
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { manualProviderModelRules: [], providerModelRules: [] }
    },
    schemaVersion: 1
  });
  writeJson(path.join(root, "v2", "runtime", "provider", "darwin-arm64", "3.17.1", "endpoint-test", "zcode-builtin.json"), {
    config: {
      providerConfigRules: {
        providerRules: [
          {
            config: {
              access: { accountType: "bigmodel", mode: "individual-coding-plan", type: "zhipu-account" },
              api: { baseUrl: "https://open.bigmodel.cn/api/anthropic", type: "anthropic-messages" },
              builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"],
              group: "bigmodel-family"
            },
            providerId: "account:bigmodel-individual-coding-plan",
            providerName: "BigModel Individual Coding Plan"
          },
          {
            config: {
              access: { accountType: "zai", mode: "start-plan", type: "zhipu-account" },
              api: { baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic", type: "anthropic-messages" },
              builtinModelIds: ["GLM-5.3"]
            },
            providerId: "account:zai-start-plan",
            providerName: "Start Plan"
          }
        ]
      }
    },
    revision: 43,
    schemaVersion: 1
  });
  writeJson(path.join(root, "v2", "credentials.json"), {
    "account-provider:coding-plan:account:zai-start-plan:account:99:api-key": encryptCredential("zai-start-plan-key", options.secret),
    [`account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:${accountId}:api-key`]: encryptCredential(apiKey, options.secret),
    "oauth:active_provider": encryptCredential(family, options.secret),
    "zcodejwttoken": encryptCredential("eyJhbGciOi-test-token", options.secret)
  });
}

test("imports the selected provider from the ZCode 3.1x credential store", () => {
  withStorageRoot((root) => {
    writeV2Fixture(root);
    const candidate = zcodeCandidate();
    assert.equal(candidate.status, "available");
    assert.equal(candidate.importable, true);
    assert.equal(candidate.name, "ZCode API");
    assert.equal(candidate.protocol, "anthropic_messages");
    assert.deepEqual(candidate.models, ["GLM-5.3", "GLM-5.3-Flash"]);
    assert.equal(candidate.sourceFile, path.join(root, "v2", "credentials.json"));
    assert.deepEqual(candidate.modelMetadata["GLM-5.3"], {
      contextWindow: 1_000_000,
      maxContextWindow: 1_000_000,
      maxOutputTokens: 131_072
    });
    assert.deepEqual(candidate.modelMetadata["GLM-5.3-Flash"], {
      capabilities: { imageInput: true },
      contextWindow: 1_000_000,
      maxContextWindow: 1_000_000,
      maxOutputTokens: 131_072
    });

    const credential = readZcodeLocalProviderCredential();
    assert.deepEqual(credential, { apiKey, baseUrl: "https://open.bigmodel.cn/api/anthropic" });

    const imported = importZcodeProvider(candidate, []);
    assert.equal(imported.provider.baseUrl, "https://open.bigmodel.cn/api/anthropic");
    assert.deepEqual(imported.provider.models, ["GLM-5.3", "GLM-5.3-Flash"]);
    assert.deepEqual(imported.provider.modelMetadata, candidate.modelMetadata);
    const keyPlugin = imported.providerPlugins.find((plugin) => plugin.key === "ccr-local-agent-__CCR_PROVIDER_NAME_SLUG__-zcode-api-key");
    assert.equal(keyPlugin.auth.headers["x-api-key"], apiKey);
  });
});

test("prefers the family selected in setting.json when several credentials exist", () => {
  withStorageRoot((root) => {
    writeV2Fixture(root, { family: "zai", kind: "start-plan" });
    const credential = readZcodeLocalProviderCredential();
    assert.deepEqual(credential, {
      apiKey: "zai-start-plan-key",
      baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic"
    });
  });
});

test("reports the encrypted credential instead of claiming the key is missing", () => {
  withStorageRoot((root) => {
    writeV2Fixture(root, { secret: "some-other-machine-secret" });
    const candidate = zcodeCandidate();
    assert.equal(candidate.status, "locked");
    assert.equal(candidate.importable, false);
    assert.match(candidate.detail, /encrypted/);
    assert.doesNotMatch(candidate.detail, /no usable provider API key/);
  });
});

test("still imports the legacy config.json provider map", () => {
  withStorageRoot((root) => {
    writeJson(path.join(root, "v2", "config.json"), {
      provider: {
        "builtin:bigmodel-coding-plan": {
          enabled: true,
          models: { "GLM-5.3": {} },
          name: "BigModel Coding Plan",
          options: {
            apiKey: "legacy-plaintext-key",
            baseURL: "https://open.bigmodel.cn/api/anthropic"
          }
        }
      }
    });
    const candidate = zcodeCandidate();
    assert.equal(candidate.status, "available");
    assert.equal(candidate.sourceFile, path.join(root, "v2", "config.json"));
    assert.deepEqual(readZcodeLocalProviderCredential(), {
      apiKey: "legacy-plaintext-key",
      baseUrl: "https://open.bigmodel.cn/api/anthropic"
    });
  });
});

test("reports missing when the machine has no ZCode state at all", () => {
  withStorageRoot(() => {
    const candidate = zcodeCandidate();
    assert.equal(candidate.status, "missing");
    assert.equal(candidate.importable, false);
    assert.equal(readZcodeLocalProviderCredential(), undefined);
  });
});

test("maps GLM plans to models.dev limits and ignores unknown models", () => {
  withStorageRoot((root) => {
    writeJson(path.join(root, "v2", "config.json"), {
      provider: {
        "builtin:bigmodel-coding-plan": {
          enabled: true,
          models: {
            "GLM-5.2": {},
            "GLM-5.3": { limit: { context: 128_000, output: 4_096 } },
            "GLM-5.3[1m]": {},
            "glm-4.5-air": {},
            "some-unknown-model": {}
          },
          name: "BigModel Coding Plan",
          options: {
            apiKey: "legacy-plaintext-key",
            baseURL: "https://open.bigmodel.cn/api/anthropic"
          }
        }
      }
    });
    const candidate = zcodeCandidate();
    assert.deepEqual(Object.keys(candidate.modelMetadata).sort(), [
      "GLM-5.2",
      "GLM-5.3",
      "GLM-5.3[1m]",
      "glm-4.5-air"
    ]);
    assert.equal(candidate.modelMetadata["GLM-5.3[1m]"].contextWindow, 1_000_000);
    assert.equal(candidate.modelMetadata["GLM-5.2"].contextWindow, 1_000_000);
    assert.equal(candidate.modelMetadata["glm-4.5-air"].maxOutputTokens, 98_304);
  });
});

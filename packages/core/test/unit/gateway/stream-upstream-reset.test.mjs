import assert from "node:assert/strict";
import http from "node:http";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import {
  ccrCodexApplyPatchBridgeHeader,
  ccrCodexBridgeStreamHookKey,
  ccrCodexMultiAgentBridgeHeader,
  ccrLiveTokenRateConfigMessageType,
  ccrLiveTokenRateStreamHookKey
} from "@ccr/core/gateway/core-runtime/router-plugin-contract.ts";
import { createGatewayPlugin } from "@ccr/core/gateway/core-runtime/router-plugin.ts";
import { codexMultiAgentBridgeResponseStream } from "@ccr/core/gateway/features/codex-multi-agent-bridge.ts";
import { codexApplyPatchBridgeResponseStream } from "@ccr/core/gateway/features/codex-patch-bridge.ts";
import { GatewayRequestPipeline } from "@ccr/core/gateway/request/pipeline.ts";

// An upstream that sends response headers and one chunk, then resets the
// socket (RST) mid-body, the way a provider drop or a laptop sleep does.
async function withResettingUpstream(contentType, run) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": contentType });
    response.write(contentType.includes("json") ? '{"output":[' : 'data: {"type":"response.created"}\n\n');
    setTimeout(() => request.socket.resetAndDestroy(), 50);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    return await run(url);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

// Without error propagation the consumer never settles, so bound each test.
const options = { timeout: 5_000 };

// Before the fix the reset surfaced as an unhandled 'error' event on the
// Readable.fromWeb() source, which kills the process. Record any instead.
async function assertNoUncaughtException(run) {
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.deepEqual(uncaught, []);
}

for (const [name, bridge] of [
  ["apply-patch", codexApplyPatchBridgeResponseStream],
  ["multi-agent", codexMultiAgentBridgeResponseStream]
]) {
  for (const contentType of ["text/event-stream", "application/json"]) {
    test(`${name} bridge (${contentType}) forwards an upstream reset to its consumer`, options, async () => {
      await assertNoUncaughtException(() => withResettingUpstream(contentType, async (url) => {
        const upstream = await fetch(url, { method: "POST" });
        const stream = bridge(Readable.fromWeb(upstream.body), new Headers({ "content-type": contentType }));
        await assert.rejects(async () => {
          for await (const _chunk of stream) {
            // drain
          }
        }, /terminated/);
      }));
    });
  }
}

test("core plugin live token rate stream hook survives an upstream reset", options, async () => {
  const originalSend = process.send;
  process.send = () => true;
  try {
    const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: createDefaultAppConfig() } } });
    const streamHook = plugin.streamHooks.find((item) => item.key === ccrLiveTokenRateStreamHookKey);
    process.emit("message", { enabled: true, protocolVersion: 1, type: ccrLiveTokenRateConfigMessageType });
    await assertNoUncaughtException(() => withResettingUpstream("text/event-stream", async (url) => {
      const metered = await streamHook.transformResponse({
        request: { headers: {}, id: "upstream-reset-rate", method: "POST", url: "/v1/chat/completions" },
        targetProvider: "openai",
        targetProviderConfig: { provider: "openai_chat_completions", type: "openai_chat_completions" },
        upstreamResponse: await fetch(url, { method: "POST" })
      });
      assert.ok(metered instanceof Response);
      await assert.rejects(metered.text(), /terminated/);
    }));
  } finally {
    process.emit("message", { enabled: false, protocolVersion: 1, type: ccrLiveTokenRateConfigMessageType });
    process.send = originalSend;
  }
});

test("core plugin Codex bridge stream hook survives an upstream reset", options, async () => {
  const plugin = await createGatewayPlugin({ plugin: { config: { appConfig: createDefaultAppConfig() } } });
  const streamHook = plugin.streamHooks.find((item) => item.key === ccrCodexBridgeStreamHookKey);
  await assertNoUncaughtException(() => withResettingUpstream("text/event-stream", async (url) => {
    const bridged = await streamHook.transformResponse({
      request: {
        headers: { [ccrCodexApplyPatchBridgeHeader]: "1", [ccrCodexMultiAgentBridgeHeader]: "1" },
        id: "upstream-reset-codex-bridge",
        method: "POST",
        url: "/v1/responses"
      },
      upstreamRequest: { body: {}, headers: {}, method: "POST", url: "https://provider.test/v1/responses" },
      upstreamResponse: await fetch(url, { method: "POST" })
    });
    assert.ok(bridged instanceof Response);
    await assert.rejects(bridged.text(), /terminated/);
  }));
});

test("gateway pipeline closes the client response when the upstream resets mid-stream", options, async () => {
  const config = createDefaultAppConfig();
  config.observability.requestLogs = false;
  config.contextArchive.enabled = false;
  const pipeline = new GatewayRequestPipeline({
    getBrowserWebSearchMcpIntegration: () => undefined,
    getConfig: () => config,
    getCoreAuthToken: () => "test-core-token",
    getPlugin: () => ({ routeRequest: async (input) => ({ body: input.body, decision: { diagnostics: [], reason: "passthrough", rewrites: [], source: "default" } }) }),
    getStatus: () => ({ coreEndpoint: "http://127.0.0.1:3457", endpoint: "http://127.0.0.1:3456" })
  });
  const originalFetch = globalThis.fetch;
  try {
    await assertNoUncaughtException(() => withResettingUpstream("text/event-stream", async (url) => {
      globalThis.fetch = (_input, init) => originalFetch(url, { method: "POST", signal: init?.signal });
      const request = Readable.from([]);
      request.method = "GET";
      request.url = "/v1/responses/resp-reset";
      request.headers = {};
      const response = new Writable({ write(_chunk, _encoding, done) { done(); } });
      response.writeHead = () => response;
      const closed = new Promise((resolve) => response.once("close", resolve));
      await pipeline.proxyRequest(request, response, "/v1/responses/resp-reset");
      // Without the fix the response is never ended or destroyed and the
      // client waits until its own timeout.
      const outcome = await Promise.race([
        closed.then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000))
      ]);
      assert.equal(outcome, "closed");
      assert.equal(response.writableFinished, false);
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A relay 400 whose body another consumer already disturbed before the
// pipeline could buffer it (2026-11-01: "Body is unusable: Body has already
// been read" on relay 4xx responses).
async function withPreDisturbedUpstream(run) {
  const body = JSON.stringify({ error: { message: "upstream rejected the request" } });
  const disturbed = new Response(body, {
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
    status: 400
  });
  await disturbed.text();
  const server = http.createServer(() => {
    throw new Error("upstream should never be reached; fetch is mocked");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    return await run(url, disturbed);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a disturbed upstream error body still yields a fallback error response", async () => {
  const config = createDefaultAppConfig();
  config.observability.requestLogs = false;
  config.contextArchive.enabled = false;
  const pipeline = new GatewayRequestPipeline({
    getBrowserWebSearchMcpIntegration: () => undefined,
    getConfig: () => config,
    getCoreAuthToken: () => "test-core-token",
    getPlugin: () => ({ routeRequest: async (input) => ({ body: input.body, decision: { diagnostics: [], reason: "passthrough", rewrites: [], source: "default" } }) }),
    getStatus: () => ({ coreEndpoint: "http://127.0.0.1:3457", endpoint: "http://127.0.0.1:3456" })
  });
  const originalFetch = globalThis.fetch;
  const chunks = [];
  try {
    await assertNoUncaughtException(() => withPreDisturbedUpstream(async (url, disturbed) => {
      globalThis.fetch = async () => disturbed;
      const request = Readable.from([]);
      request.method = "GET";
      request.url = "/v1/messages/resp-disturbed";
      request.headers = {};
      const response = new Writable({
        write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); }
      });
      response.writeHead = () => response;
      await pipeline.proxyRequest(request, response, "/v1/messages/resp-disturbed");
      console.error("DBG chunks:", JSON.stringify(chunks));
      const payload = chunks.join("");
      // A body disturbed by another consumer is unrecoverable; the executor
      // rebuilds a diagnostic envelope so the client still sees a real 400
      // error message instead of an empty body or a reset socket.
      assert.ok(payload.includes("could not be relayed"), `unexpected payload: ${payload.slice(0, 160)}`);
      assert.ok(payload.includes("Upstream returned 400"), "envelope must carry the upstream status");
      assert.equal(response.writableEnded, true);
      assert.equal(response.destroyed, false);
    }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Reproduces the 2026-11-04 Codex ChatGPT failure shape: anthropic /v1/messages,
// openai_responses provider, non-stream upstream 400 with a JSON error body —
// something consumed that body before the buffered aggregate branch, so the
// client got the fallback envelope instead of the real upstream error.
test("openai_responses provider 400 bodies relay without a double read", async () => {
  const config = createDefaultAppConfig();
  config.observability.requestLogs = false;
  config.contextArchive.enabled = false;
  config.Providers = [{
    api_base_url: "https://chatgpt.backend.test/backend-api/codex",
    id: "codex-chatgpt",
    models: ["gpt-6.1-terra"],
    name: "Codex ChatGPT",
    type: "openai_responses"
  }];
  config.profile = {
    profiles: [{
      agent: "claude-code",
      enabled: true,
      scope: "global",
      id: "claude-code-global",
      model: "Codex ChatGPT/gpt-6.1-terra",
      name: "Claude Code",
      sonnetModel: "Codex ChatGPT/gpt-6.1-terra"
    }]
  };
  const pipeline = new GatewayRequestPipeline({
    getBrowserWebSearchMcpIntegration: () => undefined,
    getConfig: () => config,
    getCoreAuthToken: () => "test-core-token",
    getPlugin: () => ({ routeRequest: async (input) => ({ body: input.body, decision: { diagnostics: [], reason: "passthrough", rewrites: [], source: "default" } }) }),
    getStatus: () => ({ coreEndpoint: "http://127.0.0.1:3457", endpoint: "http://127.0.0.1:3456" })
  });
  const originalFetch = globalThis.fetch;
  const readers = [];
  try {
    const realBody = JSON.stringify({ error: { message: "real upstream rejection: bad thinking effort" } });
    globalThis.fetch = async () => {
      const response = new Response(realBody, {
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(realBody)) },
        status: 400
      });
      // Probe every consumption path with a stack capture.
      const originalText = response.text.bind(response);
      response.text = async () => {
        readers.push(new Error("text() stack").stack?.split("\n").slice(1, 4).join(" | "));
        return originalText();
      };
      const originalJson = response.json.bind(response);
      response.json = async () => {
        readers.push(new Error("json() stack").stack?.split("\n").slice(1, 4).join(" | "));
        return originalJson();
      };
      return response;
    };
    const request = Readable.from([Buffer.from(JSON.stringify({
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-5"
    }))]);
    request.method = "POST";
    request.url = "/v1/messages";
    request.headers = { "content-type": "application/json" };
    const chunks = [];
    let status;
    const response = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } });
    response.writeHead = (value) => { status = value; return response; };
    await pipeline.proxyRequest(request, response, "/v1/messages");
    const payload = chunks.join("");
    console.error("DBG status:", status, "readers:", JSON.stringify(readers, null, 1), "payload:", payload.slice(0, 200));
    assert.ok(payload.includes("real upstream rejection"), "the real upstream error body must reach the client");
    assert.equal(status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

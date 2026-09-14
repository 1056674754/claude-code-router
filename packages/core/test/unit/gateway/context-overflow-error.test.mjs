import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import {
  contextOverflowErrorResponseStream,
  rewriteContextOverflowErrorBody,
  shouldRewriteContextOverflowErrorResponse
} from "@ccr/core/gateway/features/context-overflow-error.ts";

const envelope = {
  error: {
    attempts: [
      {
        details: {
          error: {
            code: "400001",
            message: "The request is invalid: This model's maximum context length is 1048576 tokens. However, you requested 2692002 tokens (2628002 in the messages, 64000 in the completion). Please reduce the length of the messages or completion..",
            type: "invalid_request_error"
          }
        },
        message: "Upstream request failed.",
        provider: "openai",
        provider_name: "provider-deepseek-6b115730d6",
        stage: "upstream_response",
        status: 400
      }
    ],
    message: "All target providers failed.",
    target_provider_names: ["provider-deepseek-6b115730d6"],
    target_providers: ["openai"]
  }
};

test("context overflow errors are surfaced as the message the client matches on", () => {
  const rewritten = rewriteContextOverflowErrorBody(JSON.stringify(envelope), "anthropic_messages");
  assert.ok(rewritten);
  const parsed = JSON.parse(rewritten);
  assert.equal(parsed.type, "error");
  assert.equal(parsed.error.type, "invalid_request_error");
  assert.match(parsed.error.message, /^prompt is too long: /);
  assert.match(parsed.error.message, /maximum context length is 1048576/);
  // the routing envelope stays available for logs/clients that inspect it
  assert.deepEqual(parsed.error.attempts, envelope.error.attempts);
});

test("the openai envelope keeps its shape and only gains the upstream reason", () => {
  const rewritten = rewriteContextOverflowErrorBody(JSON.stringify(envelope), "openai_chat_completions");
  assert.ok(rewritten);
  const parsed = JSON.parse(rewritten);
  assert.equal(parsed.type, undefined);
  assert.match(parsed.error.message, /^prompt is too long: /);
  assert.deepEqual(parsed.error.target_providers, ["openai"]);
});

test("a flat envelope shape is recognised too", () => {
  const flat = {
    attempts: [{ details: { error: { message: "maximum context length is 200000 tokens" } }, message: "Upstream request failed." }],
    error: { message: "All target providers failed." }
  };
  const rewritten = rewriteContextOverflowErrorBody(JSON.stringify(flat), "anthropic_messages");
  assert.ok(rewritten);
  assert.match(JSON.parse(rewritten).error.message, /^prompt is too long: maximum context length/);
});

test("non-overflow upstream errors are left untouched", () => {
  const other = {
    error: {
      attempts: [{ details: { error: { message: "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]." } }, message: "Upstream request failed.", status: 400 }],
      message: "All target providers failed."
    }
  };
  assert.equal(rewriteContextOverflowErrorBody(JSON.stringify(other), "anthropic_messages"), undefined);
  assert.equal(rewriteContextOverflowErrorBody("not json", "anthropic_messages"), undefined);
  assert.equal(rewriteContextOverflowErrorBody("[]", "anthropic_messages"), undefined);
});

test("a top-level prompt-is-too-long message is recognised too", () => {
  const rewritten = rewriteContextOverflowErrorBody(
    JSON.stringify({ error: { message: "prompt is too long: 1200000 tokens > 1000000 maximum" } }),
    "anthropic_messages"
  );
  assert.ok(rewritten);
  assert.match(JSON.parse(rewritten).error.message, /^prompt is too long: prompt is too long/);
});

test("shouldRewriteContextOverflowErrorResponse only fires for JSON error responses", () => {
  assert.equal(shouldRewriteContextOverflowErrorResponse({ contentType: "application/json", status: 400 }), true);
  assert.equal(shouldRewriteContextOverflowErrorResponse({ contentType: "application/json; charset=utf-8", status: 502 }), true);
  assert.equal(shouldRewriteContextOverflowErrorResponse({ contentType: "text/event-stream", status: 400 }), false);
  assert.equal(shouldRewriteContextOverflowErrorResponse({ contentType: "application/json", status: 200 }), false);
  assert.equal(shouldRewriteContextOverflowErrorResponse({ contentType: undefined, status: 400 }), false);
});

test("the stream rewrite rewrites an error body end to end", async () => {
  const source = Readable.from([Buffer.from(JSON.stringify(envelope), "utf8")]);
  const chunks = [];
  for await (const chunk of contextOverflowErrorResponseStream(source, "anthropic_messages")) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString("utf8");
  assert.match(text, /"prompt is too long: The request is invalid: This model's maximum context length/);
  assert.equal(JSON.parse(text).error.type, "invalid_request_error");
});

test("the stream rewrite passes non-overflow bodies through byte for byte", async () => {
  const payload = JSON.stringify({ error: { message: "All target providers failed." }, attempts: [{ message: "Upstream request failed." }] });
  const chunks = [];
  for await (const chunk of contextOverflowErrorResponseStream(Readable.from([Buffer.from(payload, "utf8")]), "anthropic_messages")) {
    chunks.push(chunk);
  }
  assert.equal(Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))).toString("utf8"), payload);
});

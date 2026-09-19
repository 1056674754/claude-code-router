import assert from "node:assert/strict";
import test from "node:test";
import {
  isContentPolicyRejection,
  isContentPolicyStatus,
  readFailedAttemptBody
} from "@ccr/core/gateway/upstream/content-policy.ts";

test("zhipu 1301 content-filter bodies are recognized on 4xx statuses", () => {
  const body = JSON.stringify({
    code: 1301,
    msg: "系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容"
  });
  assert.equal(isContentPolicyRejection(400, body), true);
  assert.equal(isContentPolicyRejection(403, body), true);
  assert.equal(isContentPolicyRejection(422, body), true);
});

test("content rejections are not detected on other statuses or bodies", () => {
  assert.equal(isContentPolicyRejection(429, '{"code":1301}'), false);
  assert.equal(isContentPolicyRejection(400, JSON.stringify({ code: 1261, msg: "prompt exceeds max length" })), false);
  assert.equal(isContentPolicyRejection(400, ""), false);
});

test("1301 inside larger numbers does not false-positive", () => {
  assert.equal(isContentPolicyRejection(400, JSON.stringify({ tokens: 13014, msg: "ok" })), false);
});

test("readFailedAttemptBody swallows read errors and bounds length", async (t) => {
  const dead = new Response("ok", { status: 400 });
  await dead.text();
  assert.equal(await readFailedAttemptBody(dead), "");
  const big = new Response("x".repeat(20_000), { status: 400 });
  assert.equal((await readFailedAttemptBody(big)).length, 8192);
});

test("content-policy statuses are exactly the 4xx filter shapes", () => {
  assert.equal(isContentPolicyStatus(400), true);
  assert.equal(isContentPolicyStatus(403), true);
  assert.equal(isContentPolicyStatus(422), true);
  assert.equal(isContentPolicyStatus(429), false);
  assert.equal(isContentPolicyStatus(200), false);
});

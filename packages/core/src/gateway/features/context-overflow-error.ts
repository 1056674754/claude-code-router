import { Readable, Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { GatewayProviderProtocol } from "@ccr/core/contracts/app";
import { isRecord, stringValue } from "@ccr/core/gateway/internal/value";

// Claude Desktop / Claude Code only recognizes a context overflow when the
// error text says so: it classifies `prompt is too long` / `prompt too long`
// (see Claude.app: category "prompt_too_long", kind "api_prompt_too_long").
// CCR's gateway runtime answers a failed route with a generic envelope
// ("All target providers failed.") and buries the upstream message in
// attempt details, so the client never learns why the request failed and never
// compacts. Surface the upstream reason in the client-facing message.

const maxRewriteBytes = 512 * 1024;

const contextOverflowPatterns: RegExp[] = [
  /prompt is too long/i,
  /prompt too long/i,
  /maximum context length/i,
  /context length is/i,
  /exceeds? (?:the )?(?:maximum )?(?:context|token)/i,
  /too many (?:input )?tokens/i,
  /requested \d+ tokens/i,
  /input token(?:s)? (?:count )?(?:is )?too (?:large|long)/i
];

export function shouldRewriteContextOverflowErrorResponse(input: {
  contentType: string | undefined;
  status: number;
}): boolean {
  if (input.status < 400) {
    return false;
  }
  return (input.contentType ?? "").toLowerCase().includes("application/json");
}

export function contextOverflowErrorResponseStream(
  input: Readable,
  protocol: GatewayProviderProtocol | undefined
): Readable {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let overflowed = false;
  return input.pipe(new Transform({
    transform(chunk, _encoding, callback) {
      if (overflowed) {
        this.push(chunk);
        callback();
        return;
      }
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (pending.length > maxRewriteBytes) {
        overflowed = true;
        this.push(pending);
        pending = "";
      }
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      if (!overflowed && pending.length > 0) {
        this.push(rewriteContextOverflowErrorBody(pending, protocol) ?? pending);
      }
      pending = "";
      callback();
    }
  }));
}

/** Returns the rewritten body, or undefined when the body carries no overflow error. */
export function rewriteContextOverflowErrorBody(
  bodyText: string,
  protocol: GatewayProviderProtocol | undefined
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const reason = findUpstreamOverflowMessage(parsed);
  if (!reason) {
    return undefined;
  }
  const message = `prompt is too long: ${reason}`;
  if (protocol === "anthropic_messages") {
    const error = isRecord(parsed.error) ? parsed.error : {};
    return `${JSON.stringify({
      ...parsed,
      error: { ...error, message, type: "invalid_request_error" },
      type: "error"
    })}\n`;
  }
  const error = isRecord(parsed.error) ? parsed.error : {};
  return `${JSON.stringify({ ...parsed, error: { ...error, message } })}\n`;
}

function findUpstreamOverflowMessage(envelope: Record<string, unknown>): string | undefined {
  const candidates: string[] = [];
  // The gateway envelope nests the routing detail: {error:{message, attempts:[
  // {message, details:{message, error:{message}}}]}} - but be tolerant of a
  // flat shape too.
  const errorObject = isRecord(envelope.error) ? envelope.error : undefined;
  collectOverflowCandidates(envelope, candidates);
  if (errorObject) {
    collectOverflowCandidates(errorObject, candidates);
  }
  for (const candidate of candidates) {
    const text = candidate.trim();
    if (text && contextOverflowPatterns.some((pattern) => pattern.test(text))) {
      return text;
    }
  }
  return undefined;
}

function collectOverflowCandidates(source: Record<string, unknown>, candidates: string[]): void {
  candidates.push(stringValue(source.message) ?? "");
  const attempts = source.attempts;
  if (!Array.isArray(attempts)) {
    return;
  }
  for (const attempt of attempts) {
    if (!isRecord(attempt)) {
      continue;
    }
    candidates.push(stringValue(attempt.message) ?? "");
    const details = attempt.details;
    if (!isRecord(details)) {
      continue;
    }
    candidates.push(stringValue(details.message) ?? "");
    if (isRecord(details.error)) {
      candidates.push(stringValue(details.error.message) ?? "");
    }
  }
}

// Some providers run content-safety filters that reject requests with 4xx
// responses (zhipu 1301: "输入或生成内容可能包含不安全或敏感内容"). The
// rejection is a property of THIS provider's filter, not of the request
// itself — a standby provider with a different filter can serve it, so the
// attempt chain treats these like a provider failure instead of a client
// error.

const contentPolicyStatuses = new Set([400, 403, 422]);

const contentPolicyBodyPattern =
  /(^|[^\d])1301([^\d]|$)|敏感内容|不安全|content[\s_-]?(filter|policy|moderation)|inappropriate|violates? (our )?usage (policy|guidelines)/i;

export function isContentPolicyStatus(statusCode: number): boolean {
  return contentPolicyStatuses.has(statusCode);
}

export function isContentPolicyRejection(statusCode: number, bodyText: string): boolean {
  return isContentPolicyStatus(statusCode) && contentPolicyBodyPattern.test(bodyText);
}

/** Bounded read of a failed attempt's body for classification. */
export async function readFailedAttemptBody(response: Response, maxBytes = 8192): Promise<string> {
  try {
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    return "";
  }
}

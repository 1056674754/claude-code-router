import { applyResponsesSessionAffinity } from "@ccr/core/gateway/core-runtime/responses-session-affinity";
import type { ResponsesSessionAffinityInput } from "@ccr/core/gateway/core-runtime/responses-session-affinity";

type UpstreamRequest = {
  body: unknown;
  bodyEncoding?: "bytes" | "form" | "json" | "none" | "text";
  headers: Record<string, string>;
  method?: string;
  url: string;
};

type ProviderPluginRequestInput = {
  config?: {
    anthropicBaseUrl?: string;
  };
  request?: {
    body?: unknown;
    headers?: Record<string, string | string[] | undefined>;
  };
  targetProviderConfig?: {
    baseurl?: string;
    type?: string;
  };
  upstreamRequest: UpstreamRequest;
};

const ccrAuthHeaderNames = new Set([
  "x-auth-api-key-id",
  "x-auth-sub"
]);

const ccrRoutingHeaderNames = new Set([
  "x-gateway-target-provider",
  "x-gateway-target-provider-name",
  "x-target-model",
  "x-target-provider",
  "x-target-providers"
]);

const clientAuthHeaderNames = new Set([
  "api-key",
  "authorization",
  "x-api-key"
]);

const proxyMetadataHeaderNames = new Set([
  "forwarded",
  "via",
  "x-real-ip"
]);

const transportHeaderNames = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

/**
 * Removes CCR-owned routing, authentication and observability metadata at the
 * final provider boundary. Provider credentials and non-CCR custom X-Auth
 * headers are deliberately preserved.
 */
export function sanitizeUpstreamProviderHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (normalized.startsWith("x-ccr-") || ccrAuthHeaderNames.has(normalized)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

/**
 * Restores client headers after the core protocol adapter has rebuilt the
 * provider request. Provider-generated auth and content headers win on name
 * collisions, while transport, proxy metadata and CCR-owned headers never
 * cross the boundary.
 */
export function mergeUpstreamProviderHeaders(
  requestHeaders: Record<string, string | string[] | undefined> | undefined,
  upstreamHeaders: Record<string, string>
): Record<string, string> {
  const connectionHeaders = new Set(transportHeaderNames);
  for (const value of headerValues(requestHeaders?.connection)) {
    for (const name of value.split(",")) {
      const normalized = name.trim().toLowerCase();
      if (normalized) connectionHeaders.add(normalized);
    }
  }

  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(requestHeaders ?? {})) {
    const normalized = name.trim().toLowerCase();
    if (
      !normalized ||
      value === undefined ||
      normalized.startsWith("x-ccr-") ||
      ccrAuthHeaderNames.has(normalized) ||
      ccrRoutingHeaderNames.has(normalized) ||
      clientAuthHeaderNames.has(normalized) ||
      proxyMetadataHeaderNames.has(normalized) ||
      normalized.startsWith("x-forwarded-") ||
      connectionHeaders.has(normalized)
    ) {
      continue;
    }
    merged[normalized] = Array.isArray(value) ? value.join(",") : value;
  }

  for (const [name, value] of Object.entries(sanitizeUpstreamProviderHeaders(upstreamHeaders))) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || connectionHeaders.has(normalized)) continue;
    merged[normalized] = value;
  }
  return merged;
}

export function rewriteUpstreamProviderUrl(
  upstreamUrl: string,
  targetProviderConfig: ProviderPluginRequestInput["targetProviderConfig"],
  config: ProviderPluginRequestInput["config"]
): string {
  const providerType = targetProviderConfig?.type?.trim().toLowerCase();
  if (providerType !== "anthropic_messages" && providerType !== "anthropic") {
    return upstreamUrl;
  }

  return rewriteUrlBase(upstreamUrl, config?.anthropicBaseUrl, targetProviderConfig?.baseurl);
}

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function rewriteUrlBase(upstreamUrl: string, fromBaseUrl: string | undefined, toBaseUrl: string | undefined): string {
  if (!fromBaseUrl || !toBaseUrl) {
    return upstreamUrl;
  }

  try {
    const upstream = new URL(upstreamUrl);
    const from = new URL(fromBaseUrl);
    const to = new URL(toBaseUrl);
    if (upstream.protocol !== from.protocol || upstream.host !== from.host) {
      return upstreamUrl;
    }

    const fromPath = basePath(from.pathname);
    if (fromPath && upstream.pathname !== fromPath && !upstream.pathname.startsWith(`${fromPath}/`)) {
      return upstreamUrl;
    }

    const remainderPath = fromPath ? upstream.pathname.slice(fromPath.length) || "/" : upstream.pathname;
    to.pathname = joinUrlPath(basePath(to.pathname), remainderPath);
    to.search = upstream.search;
    to.hash = upstream.hash;
    return to.toString();
  } catch {
    return upstreamUrl;
  }
}

function basePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized === "/" ? "" : normalized;
}

function joinUrlPath(base: string, remainder: string): string {
  const normalizedRemainder = remainder.replace(/^\/+/, "");
  if (!base) {
    return `/${normalizedRemainder}`;
  }
  if (!normalizedRemainder) {
    return base;
  }
  return `${base}/${normalizedRemainder}`;
}

type JsonRecordLike = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collects image content from anthropic and openai block shapes (including
 * images nested in tool_result content) as data-url / url image parts.
 */
function collectImageParts(value: unknown, parts: Array<{ type: "image_url"; image_url: { url: string } }>, depth = 0): void {
  if (!isJsonRecord(value) || depth > 6) {
    return;
  }
  if (value.type === "image") {
    const source = isJsonRecord(value.source) ? value.source : undefined;
    const url = typeof source?.url === "string" && source.url.trim()
      ? source.url
      : typeof source?.data === "string" && typeof source?.media_type === "string"
        ? `data:${source.media_type};base64,${source.data}`
        : undefined;
    if (url) {
      parts.push({ type: "image_url", image_url: { url } });
    }
    return;
  }
  if (value.type === "image_url") {
    const image_url = isJsonRecord(value.image_url) ? value.image_url : undefined;
    const url = typeof image_url?.url === "string" ? image_url.url : undefined;
    if (url) {
      parts.push({ type: "image_url", image_url: { url } });
    }
    return;
  }
  if (Array.isArray(value.content)) {
    value.content.forEach((nested) => collectImageParts(nested, parts, depth + 1));
  }
}

/**
 * The bundled gateway translates anthropic text and tool blocks for openai
 * targets but turns image blocks into text placeholders — strict openai
 * upstreams then never see the image. Restore the image parts from the
 * request the core received into the upstream body, positionally.
 */
function restoreUpstreamImages(request: unknown, upstreamRequest: UpstreamRequest): unknown | undefined {
  const upstreamMessages = isJsonRecord(upstreamRequest.body) && Array.isArray(upstreamRequest.body.messages)
    ? upstreamRequest.body.messages
    : undefined;
  const requestMessages = isJsonRecord(request) && Array.isArray(request.messages)
    ? request.messages
    : undefined;
  if (!upstreamMessages || !requestMessages || upstreamMessages.length !== requestMessages.length) {
    return undefined;
  }
  const upstreamBody = upstreamRequest.body as JsonRecordLike;
  let changed = false;
  const messages = upstreamMessages.map((message: unknown, index: number) => {
    if (!isJsonRecord(message) || message.role !== "user") {
      return message;
    }
    const images: Array<{ type: "image_url"; image_url: { url: string } }> = [];
    collectImageParts(requestMessages[index], images);
    if (images.length === 0) {
      return message;
    }
    changed = true;
    if (typeof message.content === "string") {
      return { ...message, content: [{ type: "text", text: message.content }, ...images] };
    }
    if (Array.isArray(message.content) && !message.content.some((part) => isJsonRecord(part) && part.type === "image_url")) {
      return { ...message, content: [...message.content, ...images] };
    }
    return message;
  });
  return changed ? { ...upstreamBody, messages } : undefined;
}

export function createGatewayPlugin() {
  return {
    providerHooks: [{
      key: "ccr-upstream-header-sanitizer",
      transformRequest(input: ProviderPluginRequestInput) {
        const restoredBody = restoreUpstreamImages(
          isJsonRecord(input.request) ? input.request.body : undefined,
          input.upstreamRequest
        );
        return {
          ok: true as const,
          value: {
            ...input.upstreamRequest,
            ...(restoredBody ? { body: restoredBody } : {}),
            headers: mergeUpstreamProviderHeaders(input.request?.headers, input.upstreamRequest.headers),
            url: rewriteUpstreamProviderUrl(input.upstreamRequest.url, input.targetProviderConfig, input.config)
          }
        };
      }
    }, {
      key: "ccr-responses-session-affinity",
      transformRequest(input: ResponsesSessionAffinityInput) {
        return {
          ok: true as const,
          value: applyResponsesSessionAffinity(input)
        };
      }
    }]
  };
}

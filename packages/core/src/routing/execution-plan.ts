import {
  ROUTER_FALLBACK_MAX_RETRY_COUNT,
  type RouterFallbackConfig
} from "@ccr/core/contracts/app";
import type { RouteAttemptPlan, RouteExecutionPlan } from "@ccr/core/routing/contracts";
import { type ModelRegistry, normalizeRouteSelector, providerRuntimeId } from "@ccr/core/routing/model-registry";

export function createRouteExecutionPlan(input: {
  bodyModel?: string;
  fallback: RouterFallbackConfig;
  hasRequestBody: boolean;
  modelRegistry?: ModelRegistry;
  primaryModel?: string;
}): RouteExecutionPlan {
  const primaryModel = normalizeRouteSelector(input.bodyModel) ?? normalizeRouteSelector(input.primaryModel);
  if (input.fallback.mode === "off" || !input.hasRequestBody) {
    return {
      attempts: [routeAttempt(0, primaryModel, input.modelRegistry)],
      fallback: input.fallback,
      primaryModel
    };
  }

  let attempts: RouteAttemptPlan[];
  if (input.fallback.mode === "retry") {
    const retryCount = clamp(input.fallback.retryCount, 0, ROUTER_FALLBACK_MAX_RETRY_COUNT);
    attempts = Array.from(
      { length: retryCount + 1 },
      (_unused, index) => routeAttempt(index, primaryModel, input.modelRegistry)
    );
  } else {
    const models = uniqueStrings([
      primaryModel,
      ...input.fallback.models.map((model) => normalizeRouteSelector(model))
    ]);
    attempts = (models.length ? models : [undefined])
      .map((model, index) => routeAttempt(index, model, input.modelRegistry));
  }

  // A provider-declared standby chain replaces same-target retry padding: once
  // the plan has somewhere to hand off, re-attempting the failing provider is
  // wasted wall-clock; the final attempt keeps the rate-limit hold instead.
  attempts = expandProviderFallbackAttempts(attempts, input.fallback.mode === "retry", input.modelRegistry);

  return {
    attempts,
    fallback: input.fallback,
    primaryModel
  };
}

// Provider-plan-level failover: when the primary attempt resolves to a provider
// that declares fallbackProviders, append an attempt for each standby that
// serves the SAME model id. Bound to the provider (the plan), so every route
// that lands on it inherits the chain; flat expansion only, never recursive.
function expandProviderFallbackAttempts(
  attempts: RouteAttemptPlan[],
  collapseRetryPadding: boolean,
  modelRegistry: ModelRegistry | undefined
): RouteAttemptPlan[] {
  const primaryTarget = attempts[0]?.target;
  if (primaryTarget?.kind !== "provider") {
    return attempts;
  }
  const fallbackNames = (primaryTarget.provider.fallbackProviders ?? [])
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name));
  const model = primaryTarget.model;
  if (fallbackNames.length === 0 || !model) {
    return attempts;
  }

  const seenProviders = new Set(
    attempts.flatMap((attempt) => attempt.target?.kind === "provider" ? [providerRuntimeId(attempt.target.provider)] : [])
  );
  const chain: RouteAttemptPlan[] = [];
  for (const name of fallbackNames) {
    const target = modelRegistry?.resolve(model, { providerName: name });
    if (target?.kind !== "provider") {
      continue;
    }
    const fallbackId = providerRuntimeId(target.provider);
    if (seenProviders.has(fallbackId)) {
      continue;
    }
    seenProviders.add(fallbackId);
    chain.push(routeAttempt(chain.length, target.canonicalSelector, modelRegistry));
  }
  if (chain.length === 0) {
    return attempts;
  }
  const expanded = collapseRetryPadding ? [attempts[0]] : [...attempts];
  return expanded.concat(chain.map((attempt, index) => ({ ...attempt, index: expanded.length + index })));
}

function routeAttempt(index: number, model: string | undefined, modelRegistry: ModelRegistry | undefined) {
  const target = modelRegistry?.resolve(model);
  return {
    index,
    model,
    ...(target ? { target } : {})
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

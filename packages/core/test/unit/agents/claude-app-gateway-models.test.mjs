import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeAppDesktopInferenceModels,
  buildClaudeAppGatewayInferenceModels,
  buildClaudeAppGatewayModelRoutes,
  buildClaudeAppTierSlotRoutes,
  inferClaudeAppGatewayTargetModel,
  isClaudeAppDesktopSafeModelId,
  resolveClaudeAppGatewayRouteModel,
  resolveClaudeAppTierSlotModel
} from "@ccr/core/agents/claude-app/gateway-routes.ts";
import {
  createClaudeCliBootstrapResponse,
  createGatewayModelsResponse,
  prepareClaudeAppDiscoveredModelRequest,
  shouldServeClaudeCliBootstrapResponse,
  shouldServeGatewayModelsResponse
} from "@ccr/core/gateway/features/model-discovery.ts";
import { profileApiKeyId } from "@ccr/core/profiles/api-key.ts";
import { ModelRegistry } from "@ccr/core/routing/model-registry.ts";

function createConfig({ profileModel, providers = [], virtualModelProfiles = [] } = {}) {
  return {
    Providers: providers.map((provider) => ({ ...provider })),
    profile: {
      enabled: true,
      profiles: profileModel === undefined
        ? []
        : [{
            agent: "claude-code",
            enabled: true,
            id: "claude-code-global",
            model: profileModel,
            name: "Claude Code",
            scope: "global"
          }]
    },
    virtualModelProfiles
  };
}

function createClaudeModelsResponse(config) {
  return createGatewayModelsResponse(
    config,
    { "user-agent": "claude-app/1.0" },
    { name: "Claude App" }
  );
}

function createClaudeCodeModelsResponse(config) {
  return createGatewayModelsResponse(config, { "user-agent": "claude-cli/2.1.215" });
}

function assertPublishedRoutesResolveUniquely(config) {
  const registry = new ModelRegistry(config);
  const routes = buildClaudeAppGatewayModelRoutes(config);
  const response = createClaudeModelsResponse(config);

  assert.deepEqual(response.data.map((model) => model.id), routes.map((route) => route.id));
  for (const route of routes) {
    assert.equal(resolveClaudeAppGatewayRouteModel(route.id, config), route.targetModel);
    assert.equal(registry.resolve(route.targetModel)?.canonicalSelector, route.targetModel);
  }
}

test("gateway model discovery supports the /models alias", () => {
  assert.equal(shouldServeGatewayModelsResponse("GET", "/models"), true);
  assert.equal(shouldServeGatewayModelsResponse("GET", "/v1/models"), true);
  assert.equal(shouldServeGatewayModelsResponse("POST", "/models"), false);
});

test("Claude CLI bootstrap is exposed at the first-party bootstrap path", () => {
  assert.equal(shouldServeClaudeCliBootstrapResponse("GET", "/api/claude_cli/bootstrap"), true);
  assert.equal(shouldServeClaudeCliBootstrapResponse("GET", "/api/claude_cli/bootstrap/"), true);
  assert.equal(shouldServeClaudeCliBootstrapResponse("POST", "/api/claude_cli/bootstrap"), false);
});

test("issue 1535 Claude App discovery defaults to the first configured provider model", () => {
  const config = createConfig({
    providers: [
      { models: ["gpt-4.1"], name: "Provider-1" },
      { models: ["claude-sonnet-4-5"], name: "Provider-2" }
    ]
  });
  const routes = buildClaudeAppGatewayModelRoutes(config);
  const response = createClaudeModelsResponse(config);

  assert.equal(inferClaudeAppGatewayTargetModel(config), "Provider-1/gpt-4.1");
  assert.equal(routes[0].targetModel, "Provider-1/gpt-4.1");
  assert.equal(response.first_id, routes[0].id);
  assert.equal(routes.some((route) => route.targetModel === "claude-sonnet-4-5"), false);
  assertPublishedRoutesResolveUniquely(config);
});

test("issue 1535 the discovered default is routable and the bare fallback resolves to a provider", () => {
  const config = createConfig({
    providers: [
      { models: ["AED"], name: "provider-1" },
      { models: ["claude-sonnet-4-5"], name: "provider-2" },
      { models: ["deepseek-v4-flash"], name: "provider-3" }
    ]
  });
  const response = createClaudeModelsResponse(config);

  assert.equal(
    response.data.some((model) => model.id === "claude-sonnet-4-5"),
    false,
    "the unroutable bare fallback must never be published by GET /v1/models"
  );
  assert.ok(response.first_id, "discovery must publish a routable default model");

  const rewritten = prepareClaudeAppDiscoveredModelRequest(
    config,
    "POST",
    "/v1/messages",
    Buffer.from(JSON.stringify({ messages: [], model: response.first_id }))
  );
  assert.equal(
    rewritten?.routedModel,
    "provider-1/AED",
    "the discovered default must round-trip to a provider-prefixed selector instead of model-chain fallback"
  );

  const registry = new ModelRegistry(config);
  assert.equal(
    registry.resolve("claude-sonnet-4-5")?.canonicalSelector,
    "provider-2/claude-sonnet-4-5",
    "a bare fallback model id must resolve to a provider rather than going unroutable"
  );
});

test("issue 1535 Claude App discovery canonicalizes a uniquely configured bare profile model", () => {
  const config = createConfig({
    profileModel: "claude-sonnet-4-5",
    providers: [
      { models: ["gpt-4.1"], name: "Provider-1" },
      { models: ["claude-sonnet-4-5"], name: "Provider-2" }
    ]
  });
  const routes = buildClaudeAppGatewayModelRoutes(config);

  assert.equal(inferClaudeAppGatewayTargetModel(config), "Provider-2/claude-sonnet-4-5");
  assert.equal(routes[0].targetModel, "Provider-2/claude-sonnet-4-5");
  assertPublishedRoutesResolveUniquely(config);
});

test("Claude App discovery prioritizes the authenticated profile default model", () => {
  const config = createConfig({
    providers: [
      { models: ["gpt-4.1"], name: "Provider-1" },
      { models: ["claude-sonnet-4-5"], name: "Provider-2" }
    ]
  });
  const profile = {
    agent: "claude-code",
    enabled: true,
    id: "claude-code-work",
    model: "claude-sonnet-4-5",
    name: "Work",
    scope: "ccr"
  };
  config.profile.profiles = [profile];
  const apiKey = {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: profileApiKeyId(profile),
    key: "profile-key",
    name: "Profile: Work"
  };
  const routes = buildClaudeAppGatewayModelRoutes(config, {
    defaultTargetModel: profile.model
  });
  const response = createGatewayModelsResponse(config, { "user-agent": "claude-app/1.0" }, apiKey);

  assert.equal(inferClaudeAppGatewayTargetModel(config, { defaultTargetModel: profile.model }), "Provider-2/claude-sonnet-4-5");
  assert.equal(routes[0].targetModel, "Provider-2/claude-sonnet-4-5");
  assert.equal(response.first_id, routes[0].id);

  const rewritten = prepareClaudeAppDiscoveredModelRequest(
    config,
    "POST",
    "/v1/messages",
    Buffer.from(JSON.stringify({ messages: [], model: response.first_id })),
    { profile }
  );
  assert.equal(rewritten?.routedModel, "Provider-2/claude-sonnet-4-5");
});

test("issue 1535 duplicate provider model names keep distinct deterministic Claude App routes", () => {
  const config = createConfig({
    profileModel: "claude-sonnet-4-5",
    providers: [
      { models: ["claude-sonnet-4-5"], name: "Provider-1" },
      { models: ["claude-sonnet-4-5"], name: "Provider-2" }
    ]
  });
  const routes = buildClaudeAppGatewayModelRoutes(config);

  assert.equal(inferClaudeAppGatewayTargetModel(config), "Provider-1/claude-sonnet-4-5");
  assert.deepEqual(
    routes.map((route) => route.targetModel),
    ["Provider-1/claude-sonnet-4-5", "Provider-2/claude-sonnet-4-5"]
  );
  assert.equal(new Set(routes.map((route) => route.id.toLowerCase())).size, 2);
  assertPublishedRoutesResolveUniquely(config);
});

test("issue 1535 historical fallback IDs are never special-cased", () => {
  const configuredLegacyModel = createConfig({
    providers: [
      { models: ["gpt-4.1"], name: "Provider-1" },
      { models: ["claude-sonnet-4-5"], name: "Provider-2" }
    ]
  });
  const unconfiguredLegacyModel = createConfig({
    providers: [{ models: ["gpt-4.1"], name: "Provider-1" }]
  });
  const body = Buffer.from(JSON.stringify({ messages: [], model: "claude-sonnet-4-5" }));

  assert.equal(prepareClaudeAppDiscoveredModelRequest(
    configuredLegacyModel,
    "POST",
    "/v1/messages",
    body
  ), undefined);
  assert.equal(prepareClaudeAppDiscoveredModelRequest(
    unconfiguredLegacyModel,
    "POST",
    "/v1/messages",
    body
  ), undefined);
  assert.equal(
    buildClaudeAppGatewayModelRoutes(unconfiguredLegacyModel)
      .some((route) => route.id === "claude-sonnet-4-5" || route.targetModel === "claude-sonnet-4-5"),
    false
  );
});

test("issue 1535 Claude App discovery publishes no synthetic model without configured providers", () => {
  const config = createConfig();
  const response = createClaudeModelsResponse(config);

  assert.equal(inferClaudeAppGatewayTargetModel(config), undefined);
  assert.deepEqual(buildClaudeAppGatewayModelRoutes(config), []);
  assert.deepEqual(buildClaudeAppGatewayInferenceModels(config), []);
  assert.deepEqual(response.data, []);
  assert.equal(response.first_id, null);
  assert.equal(response.last_id, null);
  assert.equal(
    prepareClaudeAppDiscoveredModelRequest(
      config,
      "POST",
      "/v1/messages",
      Buffer.from(JSON.stringify({ messages: [], model: "claude-sonnet-4-5" }))
    ),
    undefined
  );
});

test("issue 1535 canonical profile resolution preserves the Claude App 1M context variant", () => {
  const config = createConfig({
    profileModel: "claude-opus-4-1[1m]",
    providers: [{ models: ["claude-opus-4-1"], name: "Anthropic" }]
  });
  const routes = buildClaudeAppGatewayModelRoutes(config);

  assert.equal(inferClaudeAppGatewayTargetModel(config), "Anthropic/claude-opus-4-1[1m]");
  assert.equal(routes[0].targetModel, "Anthropic/claude-opus-4-1");
  assert.equal(routes[0].oneMillionContext, true);
  assertPublishedRoutesResolveUniquely(config);
});

test("Claude App marks a custom model with a configured 1M context window", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          aaa: {
            contextWindow: 1_000_000,
            maxContextWindow: 1_000_000
          }
        },
        models: ["aaa"],
        name: "Zhipu AI (China) - Coding Plan",
        type: "openai_chat_completions"
      }
    ]
  });
  const route = buildClaudeAppGatewayModelRoutes(config)[0];
  const inferenceModel = buildClaudeAppGatewayInferenceModels(config)[0];
  const discoveredModel = createClaudeModelsResponse(config).data[0];

  assert.equal(route.oneMillionContext, true);
  assert.equal(inferenceModel.supports1m, true);
  assert.equal(discoveredModel.max_input_tokens, 1_000_000);
  assert.equal(discoveredModel.capabilities.context_window.max_input_tokens, 1_000_000);
  assert.equal(discoveredModel.capabilities.context_window.supports_1m_context, true);
  assert.equal(discoveredModel.capabilities.context_window.one_million_context_variant, true);
});

test("Claude App keeps a pinned 1M context window above the advertised effective percent", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          "gpt-5.6-sol": {
            contextWindow: 1_000_000,
            contextWindowPinned: true,
            effectiveContextWindowPercent: 95,
            maxContextWindow: 1_000_000
          }
        },
        models: ["gpt-5.6-sol"],
        name: "Codex API",
        type: "openai_responses"
      }
    ]
  });
  const route = buildClaudeAppGatewayModelRoutes(config)[0];
  const discoveredModel = createClaudeModelsResponse(config).data[0];

  assert.equal(route.oneMillionContext, true);
  assert.equal(discoveredModel.max_input_tokens, 1_000_000);
  assert.equal(discoveredModel.capabilities.context_window.supports_1m_context, true);
});

test("Claude App applies the advertised effective percent when the context window is not pinned", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          "gpt-5.6-sol": {
            contextWindow: 1_000_000,
            effectiveContextWindowPercent: 95,
            maxContextWindow: 1_000_000
          }
        },
        models: ["gpt-5.6-sol"],
        name: "Codex API",
        type: "openai_responses"
      }
    ]
  });
  const route = buildClaudeAppGatewayModelRoutes(config)[0];
  const discoveredModel = createClaudeModelsResponse(config).data[0];

  assert.equal(route.oneMillionContext, false);
  assert.equal(discoveredModel.max_input_tokens, 950_000);
});

test("Claude Code exposes a configured 1M context window as a visible model variant", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          aaa: {
            contextWindow: 1_000_000,
            maxContextWindow: 1_000_000
          }
        },
        models: ["aaa"],
        name: "Zhipu AI (China) - Coding Plan",
        type: "openai_chat_completions"
      }
    ]
  });
  const discoveredModel = createClaudeCodeModelsResponse(config).data[0];

  assert.match(discoveredModel.id, /\[1m\]$/);
  assert.equal(discoveredModel.display_name, "Zhipu AI (China) - Coding Plan/aaa (1M context)");
  assert.equal(discoveredModel.max_input_tokens, 1_000_000);
  assert.equal(discoveredModel.capabilities.context_window.one_million_context_variant, true);

  const bootstrap = createClaudeCliBootstrapResponse(config);
  assert.equal(bootstrap.auto_compact_windows[discoveredModel.id], 1_000_000);
  assert.equal(bootstrap.client_data.rowan_thicket[discoveredModel.id], 1_000_000);
  assert.equal(bootstrap.additional_model_options[0].description, "1M context window");
  assert.equal(bootstrap.additional_model_options[0].display_name, "Zhipu AI (China) - Coding Plan/aaa (1M context)");
  assert.equal(bootstrap.additional_model_options[0].id, discoveredModel.id);
  assert.equal(bootstrap.additional_model_options[0].max_input_tokens, 1_000_000);
  assert.equal(bootstrap.additional_model_options[0].model, discoveredModel.id);
  assert.equal(bootstrap.additional_model_options[0].name, "Zhipu AI (China) - Coding Plan/aaa (1M context)");
  assert.equal(bootstrap.additional_model_options[0].type, "model");
  assert.equal(bootstrap.additional_model_options[0].capabilities.context_window.max_input_tokens, 1_000_000);
  assert.equal(bootstrap.additional_model_options[0].capabilities.context_window.one_million_context_variant, true);

  const rewrite = prepareClaudeAppDiscoveredModelRequest(
    config,
    "POST",
    "/v1/messages",
    Buffer.from(JSON.stringify({ messages: [], model: discoveredModel.id }))
  );
  assert.equal(rewrite?.routedModel, "Zhipu AI (China) - Coding Plan/aaa");
});


test("issue 1632 Claude discovery inherits Fusion fixed model provider context", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          "glm-5.2": {
            contextWindow: 1_000_000,
            maxContextWindow: 1_000_000
          }
        },
        models: ["glm-5.2"],
        name: "Zhipu AI (China) - Coding Plan",
        type: "openai_chat_completions"
      }
    ],
    virtualModelProfiles: [
      {
        baseModel: { fixedModel: "Zhipu AI (China) - Coding Plan/glm-5.2", mode: "fixed" },
        displayName: "GLM 5.2 Fusion",
        enabled: true,
        execution: { clientToolsPolicy: "allow", mode: "tool_loop", streamMode: "optimistic" },
        id: "glm-5-2-fusion",
        key: "glm-5.2-fusion",
        match: { exactAliases: ["glm-5.2-fusion"], prefixes: [], suffixes: [] },
        materialization: { enabled: true, includeInGatewayModels: true },
        tools: []
      }
    ]
  });
  const route = buildClaudeAppGatewayModelRoutes(config).find((item) => item.targetModel === "Fusion/glm-5.2-fusion");
  const inferenceModel = buildClaudeAppGatewayInferenceModels(config).find((item) => item.name === route?.id);
  const appModel = createClaudeModelsResponse(config).data.find((item) => item.id === route?.id);
  const codeModel = createClaudeCodeModelsResponse(config).data.find((item) =>
    item.display_name === "Fusion/glm-5.2-fusion (1M context)"
  );

  assert.ok(route);
  assert.equal(route.oneMillionContext, true);
  assert.equal(inferenceModel?.supports1m, true);
  assert.equal(appModel?.max_input_tokens, 1_000_000);
  assert.equal(appModel?.capabilities.context_window.max_input_tokens, 1_000_000);
  assert.equal(appModel?.capabilities.context_window.supports_1m_context, true);
  assert.ok(codeModel);
  assert.match(codeModel.id, /\[1m\]$/);
  assert.equal(codeModel.max_input_tokens, 1_000_000);

  const rewrite = prepareClaudeAppDiscoveredModelRequest(
    config,
    "POST",
    "/v1/messages",
    Buffer.from(JSON.stringify({ messages: [], model: codeModel.id }))
  );
  assert.equal(rewrite?.routedModel, "Fusion/glm-5.2-fusion");
});

test("Claude Code discovery marks Fusion vision aliases as image capable", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          "base-model": {
            capabilities: { imageInput: false },
            contextWindow: 128000
          }
        },
        models: ["base-model"],
        name: "Text",
        type: "openai_chat_completions"
      }
    ],
    virtualModelProfiles: [
      {
        baseModel: { fixedModel: "Text/base-model", mode: "fixed" },
        displayName: "Vision Fusion",
        enabled: true,
        execution: {
          clientToolsPolicy: "allow",
          matchMultimodal: true,
          mode: "tool_loop",
          streamMode: "optimistic"
        },
        id: "vision-fusion",
        key: "vision",
        match: { exactAliases: ["vision"], prefixes: [], suffixes: [] },
        materialization: { enabled: true, includeInGatewayModels: true },
        metadata: {
          fusionVision: { modelSelector: "Vision/vision-model", toolName: "vision_understand_vision" }
        },
        tools: [{ name: "vision_understand_vision", visibility: "internal" }]
      }
    ]
  });

  const response = createClaudeCodeModelsResponse(config);
  const baseModel = response.data.find((item) => item.display_name === "Text/base-model");
  const fusionModel = response.data.find((item) => item.display_name === "Fusion/vision");
  const bootstrap = createClaudeCliBootstrapResponse(config);
  const fusionOption = bootstrap.additional_model_options.find((item) => item.display_name === "Fusion/vision");

  assert.ok(baseModel);
  assert.equal(baseModel.capabilities.image_input.supported, false);
  assert.ok(fusionModel);
  assert.equal(fusionModel.capabilities.image_input.supported, true);
  assert.ok(fusionOption);
  assert.equal(fusionOption.capabilities.image_input.supported, true);
});

test("Claude Code discovery only marks valid prefixed and suffixed Fusion vision models as image capable", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          "fast-model": {
            capabilities: { imageInput: false },
            contextWindow: 128000
          },
          "model-fast": {
            capabilities: { imageInput: false },
            contextWindow: 128000
          }
        },
        models: ["fast-model", "model-fast"],
        name: "Text",
        type: "openai_chat_completions"
      }
    ],
    virtualModelProfiles: [
      {
        baseModel: { mode: "strip_prefix" },
        displayName: "Vision Prefix",
        enabled: true,
        execution: {
          clientToolsPolicy: "allow",
          matchMultimodal: true,
          mode: "tool_loop",
          streamMode: "optimistic"
        },
        id: "vision-prefix",
        key: "vision-prefix",
        match: { exactAliases: [], prefixes: ["fast-"], suffixes: [] },
        materialization: { enabled: true, includeInGatewayModels: true },
        metadata: {
          fusionVision: { modelSelector: "Vision/vision-model", toolName: "vision_understand_prefix" }
        },
        tools: [{ name: "vision_understand_prefix", visibility: "internal" }]
      },
      {
        baseModel: { mode: "strip_suffix" },
        displayName: "Vision Suffix",
        enabled: true,
        execution: {
          clientToolsPolicy: "allow",
          matchMultimodal: true,
          mode: "tool_loop",
          streamMode: "optimistic"
        },
        id: "vision-suffix",
        key: "vision-suffix",
        match: { exactAliases: [], prefixes: [], suffixes: ["-fast"] },
        materialization: { enabled: true, includeInGatewayModels: true },
        metadata: {
          fusionVision: { modelSelector: "Vision/vision-model", toolName: "vision_understand_suffix" }
        },
        tools: [{ name: "vision_understand_suffix", visibility: "internal" }]
      }
    ]
  });

  const response = createClaudeCodeModelsResponse(config);
  const byDisplayName = new Map(response.data.map((item) => [item.display_name, item]));

  assert.equal(byDisplayName.get("Text/fast-model")?.capabilities.image_input.supported, false);
  assert.equal(byDisplayName.get("Text/model-fast")?.capabilities.image_input.supported, false);
  assert.equal(byDisplayName.get("Text/fast-fast-model")?.capabilities.image_input.supported, true);
  assert.equal(byDisplayName.get("Text/model-fast-fast")?.capabilities.image_input.supported, true);
});

test("Claude App discovery publishes the effective provider context for uncatalogued models", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          "gpt-5.6-sol": {
            contextWindow: 272000,
            effectiveContextWindowPercent: 95,
            maxContextWindow: 272000
          }
        },
        models: ["gpt-5.6-sol"],
        name: "Codex API",
        type: "openai_responses"
      }
    ]
  });
  const route = buildClaudeAppGatewayModelRoutes(config)[0];
  const response = createClaudeModelsResponse(config);
  const model = response.data.find((item) => item.id === route.id);

  assert.ok(model);
  assert.equal(model.max_input_tokens, 258400);
  assert.equal(model.capabilities.context_management.max_input_tokens, 258400);
  assert.equal(model.capabilities.context_window.max_input_tokens, 258400);

  const bootstrap = createClaudeCliBootstrapResponse(config);
  assert.equal(bootstrap.auto_compact_windows[model.id], 258400);
  assert.equal(bootstrap.client_data.rowan_thicket[model.id], 258400);
});

test("Claude CLI bootstrap includes suffixed compact window keys for uncatalogued 1M models", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          long: {
            contextWindow: 1_000_000
          }
        },
        models: ["long"],
        name: "Provider",
        type: "openai_responses"
      }
    ]
  });
  const bootstrap = createClaudeCliBootstrapResponse(config);

  assert.equal(bootstrap.auto_compact_windows["Provider/long"], 1_000_000);
  assert.equal(bootstrap.auto_compact_windows["provider/long"], 1_000_000);
  assert.equal(bootstrap.auto_compact_windows["Provider/long[1m]"], 1_000_000);
  assert.equal(bootstrap.auto_compact_windows["provider/long[1m]"], 1_000_000);
  assert.equal(bootstrap.client_data.rowan_thicket["Provider/long[1m]"], 1_000_000);
});

test("Claude CLI bootstrap clamps compact windows to Claude Code's accepted range", () => {
  const lowConfig = createConfig({
    providers: [
      {
        modelMetadata: {
          "custom-model": {
            contextWindow: 64000
          }
        },
        models: ["custom-model"],
        name: "Custom",
        type: "openai_responses"
      }
    ]
  });
  const lowModel = createClaudeCodeModelsResponse(lowConfig).data[0];
  const lowBootstrap = createClaudeCliBootstrapResponse(lowConfig);
  assert.equal(lowBootstrap.auto_compact_windows[lowModel.id], 100000);

  const highConfig = createConfig({
    providers: [
      {
        modelMetadata: {
          huge: {
            contextWindow: 1_500_000
          }
        },
        models: ["huge"],
        name: "Huge",
        type: "openai_responses"
      }
    ]
  });
  const highModel = createClaudeCodeModelsResponse(highConfig).data[0];
  const highBootstrap = createClaudeCliBootstrapResponse(highConfig);
  assert.equal(highBootstrap.auto_compact_windows[highModel.id], 1_000_000);
});

test("Claude App discovery honors configured reasoning levels for uncatalogued models", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          "custom-model": {
            capabilities: { imageInput: false },
            contextWindow: 64000,
            supportedReasoningLevels: [
              { description: "Low", effort: "low" },
              { description: "High", effort: "high" },
              { description: "Ultra", effort: "ultra" }
            ],
            supportsReasoningSummaries: true
          }
        },
        models: ["custom-model"],
        name: "Custom",
        type: "openai_responses"
      }
    ]
  });
  const response = createClaudeModelsResponse(config);
  const model = response.data[0];

  assert.ok(model);
  assert.equal(model.max_input_tokens, 64000);
  assert.equal(model.capabilities.image_input.supported, false);
  assert.equal(model.capabilities.thinking.supported, true);
  assert.equal(model.capabilities.effort.low.supported, true);
  assert.equal(model.capabilities.effort.medium.supported, false);
  assert.equal(model.capabilities.effort.high.supported, true);
  assert.equal(model.capabilities.effort.xhigh.supported, false);
  assert.equal(model.capabilities.effort.max.supported, false);
  assert.equal(model.capabilities.effort.ultra.supported, true);
});

test("Claude CLI bootstrap honors configured provider metadata over defaults", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          "custom-model": {
            capabilities: { imageInput: false },
            contextWindow: 500000,
            maxOutputTokens: 12345,
            supportedReasoningLevels: [
              { description: "Low", effort: "low" },
              { description: "High", effort: "high" }
            ]
          }
        },
        models: ["custom-model"],
        name: "Custom",
        type: "openai_responses"
      }
    ]
  });
  const response = createClaudeModelsResponse(config);
  const bootstrap = createClaudeCliBootstrapResponse(config);
  const option = bootstrap.additional_model_options[0];

  assert.equal(response.data[0].max_input_tokens, 500000);
  assert.equal(response.data[0].max_tokens, 12345);
  assert.equal(option.max_input_tokens, 500000);
  assert.equal(option.max_tokens, 12345);
  assert.equal(option.capabilities.context_window.max_input_tokens, 500000);
  assert.equal(option.capabilities.context_management.max_input_tokens, 500000);
  assert.equal(option.capabilities.image_input.supported, false);
  assert.equal(option.capabilities.thinking.supported, true);
  assert.equal(option.capabilities.effort.low.supported, true);
  assert.equal(option.capabilities.effort.medium.supported, false);
  assert.equal(option.capabilities.effort.high.supported, true);
  assert.equal(option.capabilities.effort.ultra.supported, false);
});

test("Claude App discovery prefers provider context metadata over the static catalog", () => {
  const config = createConfig({
    providers: [
      {
        modelMetadata: {
          "gpt-5-codex": {
            contextWindow: 272000,
            effectiveContextWindowPercent: 90,
            maxContextWindow: 272000
          }
        },
        models: ["gpt-5-codex"],
        name: "Codex API",
        type: "openai_responses"
      }
    ]
  });
  const route = buildClaudeAppGatewayModelRoutes(config)[0];
  const response = createClaudeModelsResponse(config);
  const model = response.data.find((item) => item.id === route.id);

  assert.ok(model);
  assert.equal(model.max_input_tokens, 244800);
  assert.equal(model.capabilities.context_management.max_input_tokens, 244800);
  assert.equal(model.capabilities.context_window.max_input_tokens, 244800);
});

test("claudeAppDesktop slots narrow the Claude App menu to declared entries", () => {
  const base = createConfig({
    providers: [
      { models: ["glm-5.3", "glm-5.3-flash"], name: "Zhipu" },
      { models: ["deepseek-v4-vision"], name: "Ctyun" }
    ]
  });
  const all = buildClaudeAppGatewayInferenceModels(base);
  assert.ok(all.length >= 3);

  const route = buildClaudeAppGatewayModelRoutes(base).find((item) =>
    item.targetModel.toLowerCase().endsWith("glm-5.3")
  );
  assert.ok(route);

  const config = {
    ...base,
    claudeAppDesktop: {
      models: [
        "claude-fable-5",
        { label: "GLM 5.3", name: "Zhipu/glm-5.3" }
      ]
    }
  };
  const models = buildClaudeAppDesktopInferenceModels(config);
  assert.deepEqual(models.map((item) => item.name), ["claude-fable-5", route.id]);
  assert.deepEqual(models.map((item) => item.labelOverride), ["claude-fable-5", "GLM 5.3"]);

  // Unknown selectors pass through as bare slots instead of being dropped.
  const passthrough = buildClaudeAppDesktopInferenceModels({
    ...base,
    claudeAppDesktop: { models: ["claude-fable-5", "claude-fable-5"] }
  });
  assert.deepEqual(passthrough.map((item) => item.name), ["claude-fable-5"]);
});

test("claudeAppDesktop without declared models keeps the full menu", () => {
  const base = createConfig({
    providers: [{ models: ["glm-5.3"], name: "Zhipu" }]
  });
  const config = { ...base, claudeAppDesktop: { models: [] } };
  assert.deepEqual(
    buildClaudeAppDesktopInferenceModels(config),
    buildClaudeAppGatewayInferenceModels(base)
  );
});

test("claudeAppDesktop slots emit prefer1m alongside supports1m and omit it otherwise", () => {
  const base = createConfig({
    providers: [{ models: ["glm-5.3"], name: "Zhipu" }]
  });
  const models = buildClaudeAppDesktopInferenceModels({
    ...base,
    claudeAppDesktop: {
      models: [
        "claude-fable-5",
        { label: "GLM 5.3", name: "Zhipu/glm-5.3" },
        { label: "GLM 5.3 1M", name: "Zhipu/glm-5.3[1m]", supports1m: true }
      ]
    }
  });
  // glm-5.3's catalog entry already declares 1M support, so its route publishes
  // supports1m and the [1m] selector dedupes onto the same slot.
  const route = buildClaudeAppGatewayModelRoutes(base).find((item) => item.targetModel === "Zhipu/glm-5.3");
  assert.ok(route);
  assert.deepEqual(models.map((item) => item.name), ["claude-fable-5", route.id]);
  assert.deepEqual(models.map((item) => item.supports1m ?? false), [false, true]);
  assert.deepEqual(models.map((item) => item.prefer1m ?? false), [false, true]);
});

test("isClaudeAppDesktopSafeModelId accepts native and anthropic ids and rejects foreign shapes", () => {
  // Native claude-* role names (Desktop 1.12603.1+ whitelist: sonnet/opus/haiku/fable).
  assert.equal(isClaudeAppDesktopSafeModelId("claude-sonnet-5"), true);
  assert.equal(isClaudeAppDesktopSafeModelId("claude-opus-4-6"), true);
  assert.equal(isClaudeAppDesktopSafeModelId("claude-haiku-4-5"), true);
  assert.equal(isClaudeAppDesktopSafeModelId("claude-fable-5"), true);
  assert.equal(isClaudeAppDesktopSafeModelId("claude-sonnet-4-5-20250929"), true);
  // anthropic/claude-* prefix, including CCR's encoded gateway route ids.
  assert.equal(isClaudeAppDesktopSafeModelId("anthropic/claude-sonnet-5"), true);
  assert.equal(isClaudeAppDesktopSafeModelId("anthropic/claude-ccr-h646565707365656b2d63686174"), true);
  assert.equal(isClaudeAppDesktopSafeModelId("anthropic/claude-ccr2-h646565707365656b2d63686174"), true);
  // The [1m] suffix must not flip the verdict.
  assert.equal(isClaudeAppDesktopSafeModelId("claude-sonnet-5[1m]"), true);
  // Everything else risks Desktop's fail-all validator.
  assert.equal(isClaudeAppDesktopSafeModelId("deepseek-v4.1-flash"), false);
  assert.equal(isClaudeAppDesktopSafeModelId("glm-5.3"), false);
  assert.equal(isClaudeAppDesktopSafeModelId("openai/gpt-5"), false);
  assert.equal(isClaudeAppDesktopSafeModelId("claude-unknownrole-9"), false);
  assert.equal(isClaudeAppDesktopSafeModelId(""), false);
  assert.equal(isClaudeAppDesktopSafeModelId("   "), false);
});

test("provider modelDisplayNames override the catalog label without the provider prefix", () => {
  const config = createConfig({
    providers: [
      {
        modelDisplayNames: { "glm-5.3": "GLM 5.3 Custom" },
        models: ["glm-5.3"],
        name: "Zhipu"
      }
    ]
  });
  const route = buildClaudeAppGatewayModelRoutes(config).find((item) => item.targetModel === "Zhipu/glm-5.3");
  assert.ok(route);
  assert.equal(route.displayName, "GLM 5.3 Custom");
});

test("claude app tier slots derive from the active global claude-code profile", () => {
  const config = {
    Providers: [
      { models: ["glm-5.3", "glm-5.3-flash"], name: "Zhipu" },
      { models: ["deepseek-v4.1"], name: "Ctyun" }
    ],
    profile: {
      enabled: true,
      profiles: [{
        agent: "claude-code",
        enabled: true,
        scope: "global",
        id: "claude-code-global",
        name: "Claude Code",
        model: "Zhipu/glm-5.3-flash",
        fableModel: "Zhipu/glm-5.3",
        opusModel: "Zhipu/glm-5.3",
        sonnetModel: "Ctyun/deepseek-v4.1",
        haikuModel: ""
      }]
    },
    virtualModelProfiles: []
  };

  const tierRoutes = buildClaudeAppTierSlotRoutes(config);
  // Order is fable → opus → sonnet → haiku; opus collapses onto fable (same
  // target) and the empty haiku field is skipped — no padding to four.
  assert.deepEqual(tierRoutes.map((route) => route.id), ["claude-fable-5", "claude-sonnet-5"]);
  assert.deepEqual(tierRoutes.map((route) => route.targetModel), ["Zhipu/glm-5.3", "Ctyun/deepseek-v4.1"]);

  const menu = buildClaudeAppDesktopInferenceModels(config);
  // Tier slots first, then the remaining routed models minus tier targets
  // (glm-5.3 is covered by the fable slot, deepseek by sonnet).
  assert.deepEqual(menu.map((item) => item.name), [
    "claude-fable-5",
    "claude-sonnet-5",
    ...buildClaudeAppGatewayModelRoutes(config)
      .filter((route) => route.targetModel === "Zhipu/glm-5.3-flash")
      .map((route) => route.id)
  ]);

  // Request resolution maps tier ids back to the profile's tier models.
  assert.equal(resolveClaudeAppTierSlotModel("claude-fable-5", config), "Zhipu/glm-5.3");
  assert.equal(resolveClaudeAppTierSlotModel("Claude-Sonnet-5 ", config), "Ctyun/deepseek-v4.1");
  assert.equal(resolveClaudeAppTierSlotModel("claude-opus-5", config), "Zhipu/glm-5.3");
  assert.equal(resolveClaudeAppTierSlotModel("claude-haiku-4-5", config), undefined);
  assert.equal(resolveClaudeAppTierSlotModel("claude-unknown-9", config), undefined);
});

test("claude app tier slots are skipped without an enabled global claude-code profile", () => {
  const config = {
    Providers: [{ models: ["glm-5.3"], name: "Zhipu" }],
    profile: {
      enabled: true,
      profiles: [{
        agent: "codex",
        enabled: true,
        scope: "global",
        id: "codex-global",
        name: "Codex",
        model: "Zhipu/glm-5.3"
      }]
    },
    virtualModelProfiles: []
  };
  assert.deepEqual(buildClaudeAppTierSlotRoutes(config), []);
  assert.equal(resolveClaudeAppTierSlotModel("claude-fable-5", config), undefined);
  // Menu falls back to the full routed list.
  assert.deepEqual(
    buildClaudeAppDesktopInferenceModels(config).map((item) => item.name),
    buildClaudeAppGatewayInferenceModels(config).map((item) => item.name)
  );
});

test("claude app tier slots keep the non-declared menu composition intact", () => {
  // Without tier fields the derived menu equals the legacy full menu —
  // existing installations see no change.
  const base = {
    Providers: [{ models: ["glm-5.3"], name: "Zhipu" }],
    profile: { enabled: true, profiles: [] },
    virtualModelProfiles: []
  };
  assert.deepEqual(
    buildClaudeAppDesktopInferenceModels(base).map((item) => item.name),
    buildClaudeAppGatewayInferenceModels(base).map((item) => item.name)
  );
});

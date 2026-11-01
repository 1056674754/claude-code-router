import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaudeAppDesktopModelsCard } from "@ccr/ui/pages/home/components/claude-app-desktop.tsx";
import { AppI18nContext, appCopy } from "@ccr/ui/pages/home/shared/i18n.tsx";

test("ClaudeAppDesktopModelsCard collapsed shows the full-menu hint and no rows", () => {
  const html = renderToStaticMarkup(
    <ClaudeAppDesktopModelsCard models={undefined} onChange={() => undefined} />
  );

  assert.match(html, /Claude Desktop model slots/);
  assert.match(html, /Every routed model is written to the Claude Desktop menu\./);
  assert.doesNotMatch(html, /Slot name/);
});

test("ClaudeAppDesktopModelsCard renders declared slots with label and 1M controls", () => {
  const html = renderToStaticMarkup(
    <ClaudeAppDesktopModelsCard
      models={[
        "claude-fable-5",
        { label: "DeepSeek V4.1", name: "deepseek-v4.1-flash" }
      ]}
      onChange={() => undefined}
    />
  );

  assert.match(html, /Only the declared slots are written to the Claude Desktop menu\./);
  assert.match(html, /Slot name/);
  assert.match(html, /Display label/);
  assert.match(html, /1M context/);
  assert.match(html, /Add slot/);
  // Declared values are echoed into the inputs.
  assert.match(html, /claude-fable-5/);
  assert.match(html, /DeepSeek V4\.1/);
  // The passthrough slot name is flagged as unsafe for Desktop's validator.
  assert.match(html, /Claude Desktop may reject this name/);
  assert.match(html, /Add slot/);
});

test("ClaudeAppDesktopModelsCard renders the Chinese copy", () => {
  const html = renderToStaticMarkup(
    <AppI18nContext.Provider value={appCopy.zh}>
      <ClaudeAppDesktopModelsCard
        models={[{ name: "claude-sonnet-5", supports1m: true }]}
        onChange={() => undefined}
      />
    </AppI18nContext.Provider>
  );

  assert.match(html, /Claude Desktop 模型槽位/);
  assert.match(html, /仅将声明的槽位写入 Claude Desktop 菜单。/);
  assert.match(html, /槽位名称/);
  assert.match(html, /1M 上下文/);
  // Native claude-* names must not trigger the fail-all warning.
  assert.doesNotMatch(html, /Claude Desktop 可能拒收该名称/);
});

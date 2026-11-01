# CCR 需要修的问题清单（给 coding agent）

仓库: ~/dev_ai/claude-code-router（fork of musistudio/claude-code-router, 现基于 v3.1.3, 2026-11-01 已合并上游 v3.1.2+v3.1.3 共 46 个提交）
当前分支: fix/tool-result-images-and-overflow-errors

## #1 Desktop profile 被 CCR 全量重生成, 手工定制被抹 —— ✅ 已修复（2026-09, 22ee578 + 5088830）
`claudeAppDesktop.models` 配置项（string 或 {name, label?, supports1m?}）声明
Desktop 菜单槽位; apply 时只写声明的槽位, coworkEgressAllowedHosts 由合并写保留
（claude-app-gateway-service.test.mjs "preserves coworkEgressAllowedHosts"）。
2026-11-01 起 Profiles 页有 UI 编辑卡片（components/claude-app-desktop.tsx）,
支持 name/label/supports1m/排序/防呆警告; 序列化会在 supports1m 时成对输出
prefer1m（Desktop ≥1.21459 单行显示）。
**fix-desktop-model-names.py 已可退休**——在 UI 里声明同样的 4 个槽位即可。
注意: 槽位名匹配到路由时复用路由 id（原生 claude-* 名解锁思考档位 UI）;
透传名由 Router rules 请求时决定; 非法名有 fail-all 风险, UI 会警告。

## #2 菜单显示名不可控 —— ✅ 已修复（2026-09, 22ee578）
provider `modelDisplayNames` 优先于内置 catalog displayName 且不加 provider 前缀;
UI 槽位卡片的 label 直写 labelOverride。

## #3 Codex CLI 被静默接管
现象: `profile.profiles` 里 `default-codex`（enabled:true）导致 CCR 每次
sync 都向 `~/.codex/config.toml` 写入 "BEGIN CCR managed profile" 块
（model_provider/model/model_catalog_json）和
"[model_providers.claude-code-router]" 段, Codex 的 /model 菜单变成 CCR 的
上游模型列表。
代码位置: packages/core/src/profiles/service.ts:461 `applyCodexProfile`
（调用点 209/369）。
已做: CCR 配置里 default-codex profile `enabled:false` + 手工清理 toml。
期望改进: 接管前明示; 或提供"只接管 claude 不碰 codex"的安装选项。
风险: 若用户再开启任何 codex profile, 写回会复发。

## #4 anthropic 入站 → openai_chat 出站时图片丢失（v3.0.22 缺口）
现象: 入站请求是 anthropic /v1/messages 格式（带 {"type":"image","source":
{type:"base64",media_type,data}} 块）, 目标 provider 是 openai_chat 协议
（如 Ctyun ai.ctaigw.cn）时, 图片块被静默丢弃——上游说"无图"。
期望: 协议转换时把 anthropic image block 转成 openai
{"type":"image_url","image_url":{url:"data:<media_type>;base64,<data>"}}。
Workaround: ctaigw 其实有 anthropic 兼容端点（https://ai.ctaigw.cn +
x-api-key）, 已加 provider `CtyunA`（type anthropic_messages）让 deepseek/qwen
槽位直通; 故 #4 目前不疼了, 但转换缺口仍在, 换其他 openai-only 供应商还会踩。

## 已做的 workaround 脚本（理解现状用）
- ~/.claude-code-router/fix-desktop-model-names.py — **已可退休**（#1/#2 修复后不再需要;
  若仍要用, 注意它写的 4 个槽位现在可直接在 Profiles 页 UI 配置）。
- ~/.claude-code-router/route-scripts/claude-alias-map.js — 伪装槽位路由:
  fable→Zhipu/glm-5.3; sonnet→Zhipu/glm-5.3-flash（额度耗尽才切 CtyunA/glm-5.3-flash）;
  opus→CtyunA/deepseek-v4-flash-vision-exp-0817; haiku→CtyunA/qwen3.8-flash。
  注意: 一个 script reroute 会终结规则链, 多个 script 规则不会串联。
- 另有退避补丁: bin/ccr-cli.js 内 429 重试退避基值 1s→5s（升级会丢）。

## 验证方式
- 改 profile/模型后: `applyClaudeAppGateway` RPC → 跑 fix 脚本 → 检查
  profile 只剩 4 槽 + egress → curl :3456/v1/models 应只见 4 个裸 claude-* id。
- 图片: 32x32 纯红 PNG base64 发 /v1/messages, 4 槽都应答"红色"。
- 额度门: zhipu-quota-policy.json {"forceExhausted":true} 时 sonnet 槽应切
  CtyunA（响应 id 为 2026 开头而非 msg_ 开头）。

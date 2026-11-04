# P4 计划：累加式应用接一个网关供应商

> 状态：**被两个决定卡住**，先把事实写清楚，避免瞎做。

## 1. 事实（已核对）

网关现在只服务有专属入口的 app（`proxy/server.rs`）：

| 路由 | handler | 归到哪个 app |
| --- | --- | --- |
| `/v1/messages`、`/claude/v1/messages` | `handle_messages` | Claude Code |
| `/codex/v1/*`（含 `/chat/completions`） | `handle_codex_*` / `handle_chat_completions` | Codex |
| `/claude-desktop/*` | `handle_claude_desktop_*` | Claude Desktop |
| `/grokbuild/v1/*` | `handle_grok*` | Grok Build |
| `/v1beta/*`、`/gemini/*` | `handle_gemini` | Gemini |
| `/v1/models`、`/health`、`/status` | 发现/探活 | — |

**没有 opencode / hermes / pi / omp / dsh / openclaw 的入口**。它们的协议（chat completions 形状）会
落到 Codex 的 handler 上，被当成 Codex 请求处理：系统提示词、工具协议、统计都会错。

## 2. 卡点一：归属（P0 曾列的三个选项，没有拍板）

- **A. 路径前缀归属**：`/opencode/v1/chat/completions` → 识别为 opencode。要改 `AppType` 的
  入口映射，并让每个累加式 app 写各自的 base URL 前缀。
- **B. 每 app 一个网关端口**：实现简单、归属明确，但端口会变多（用户可能不接受）。
- **C. 不归属**：模型 id 全局唯一，网关只按模型找上游，不关心谁发的。改动最小，但 Codex 专属的
  请求改造（提示词注入、工具适配、统计归因）会对 opencode 请求也生效，行为不可控。

推荐 **A**，因为只有它同时满足「一个网关端口」和「行为按 app 分开」。

## 3. 卡点二：CCR 式的单供应商写法

CCR 里累加式 app 只需要一个 provider（指向网关）+ 若干模型 id。落到每个 app 的配置格式：

- **opencode**：`opencode.json` 的 `provider` 里加一条 `cc-switch`，`options.baseURL` 指向网关，
  `models` 用目录里该 app 来源的引用（`opencode_config::provider_fragment` 已经能读现有格式，
  写路径是 `services/provider/live.rs::import_opencode_providers_from_live` 的反向）
- **hermes / pi / omp / dsh / openclaw**：各自的配置文件，逐一看格式再写

这一块是纯机械工作，**等归属方式定了再动**，否则写完还要返工。

## 4. 不受卡点影响、可以先做的部分

1. 目录里按 app 来源分组已经有了（`sources: ["opencode:CTYun", ...]`），可以直接筛出
   「opencode 能用的模型引用」
2. `gateway_config` 已经有 per-app `AppModelConfig`，累加式 app 也能存（只是还没人读）
3. 前端 `AppEditorPage` 对任意 appType 都能渲染，只是槽位为空

## 5. 已决定：A（路径前缀）

用户 2026-11-04 选定 **A：路径前缀归属**。落地方式：

1. 每个累加式 app 一个前缀：`/opencode/v1/*`、`/hermes/v1/*`、`/pi/v1/*`、`/omp/v1/*`、`/dsh/v1/*`、`/openclaw/v1/*`
2. `proxy/server.rs` 加这些前缀路由，handler 里按前缀判定 `AppType`（和 `/grokbuild/v1/*`、`/claude-desktop/*` 同一套做法）
3. 各 app 的配置文件里，base URL 写带前缀的地址（网关地址 + 前缀）
4. 每个 app 真机验证（opencode 是 CLI，可直接跑）

## 6. 待定：§3 的单供应商写法细节

按 A 落地后，每个累加式 app 只需要一个 provider 指向网关 + 模型引用列表；配置文件格式逐个 app 核对（opencode 先做）。

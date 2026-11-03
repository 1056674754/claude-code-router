# CCR → CCS 迁移差异分析

> **分析对象**
> - CCR fork: `1056674754/claude-code-router` v3.1.3 · Electron 42 + TypeScript monorepo（1059 commits / 76 contributors）
> - CCS: `farion1231/cc-switch` v4.0.22+diy1 · Tauri 2 + Rust（本地 `cc-switch-src`）
>
> **生成时间**：2026-11-03 · 全部结论基于本地源码与数据库实测，非文档推断

---

## 0. 结论先行

**CCS 的社区与代理吞吐确实优于 CCR，但根因不是"缺功能"，而是 Provider 的归属权放反了层。**

一句话：**CCR 的 provider 属于网关，CCS 的 provider 属于 agent。**

| | CCR（WAN 级） | CCS（VLAN 级倒置） |
|---|---|---|
| Provider 归属 | 网关全局一份（`AppConfig.Providers[]`） | 每个 agent 一份（`PRIMARY KEY (id, app_type)`） |
| Agent 侧配什么 | **模型 id 白名单**（`availableModels: string[]`） | 一整套上游 + key + 端点 |
| 加一个 agent 的代价 | 选模型 | **把 N 个上游重录一遍** |
| 熔断 / 配额状态 | 网关内按 provider 共享 | 按 `(app_type, provider_id)` 各一份，互不共享 |

四点概括：

1. **CCR 是路由面（WAN）**：`Providers` + `Router` + 凭证全部网关侧配一次；agent（profile）只持有模型白名单，不碰上游、不碰 key、不碰路由规则。
2. **CCS 是每个 agent 各配一遍（VLAN 反向）**：`providers` 主键 `(id, app_type)`，`provider_endpoints` 外键也带 `app_type`，`proxy_config` 主键就是 `app_type`。
3. **实测重复度**：6 个真实上游 → 10 行 endpoint（4 个上游在 `claude`/`claude-desktop` 各存一份，`added_at` 时间戳完全相同，证明是"建一次然后克隆"）；40 行 provider 仅 34 个唯一名字。**运营成本随 agent 数量线性增长。**
4. **因此迁移不是"加功能"，而是把 provider 的作用域从 agent 提升到网关。** 这是 schema 迁移 + 代理层改造。

---

## 1. 社区与工程基线

| 维度 | CCS | CCR |
|---|---|---|
| Stars | **151,363** | 37,966 |
| Forks | **9,954** | 3,188 |
| Watchers | 263 | 134 |
| Open issues | 1,090 | 1,185 |
| 创建 | 2025-08-04 | 2025-02-25 |
| 最后推送 | **2026-11-03（当天）** | 2026-10-10（滞后 24 天） |
| Release tag | 79 | — |
| 主语言 | Rust | TypeScript |
| 安装包 | **41 MB** | 278 MB |
| 静态内存 | （未实测） | **998 MB** |

**结论：社区维度 CCS 完胜（star 4 倍、fork 3 倍、当天在推）。这一点你判断正确。**

CCS 后端模块体量（`src-tauri/src/`）：

| 模块 | 行数 |
|---|---|
| `proxy/` | **92,415** |
| `services/` | 87,123 |
| `commands/` | 23,468 |
| `session_manager/` | 23,321 |
| `database/` | 14,426 |
| `mode/` | 12,708 |

**CCS 是货真价实的常驻流式代理**：`proxy/forwarder.rs` 8,679 行、`handlers.rs` 4,670 行、`server.rs` 1,397 行；依赖 `axum 0.7` + `hyper 1.0` + `tokio` + `reqwest(stream)` + `hyper-rustls`；覆盖 `/v1/messages`、`/v1/chat/completions`、`/v1/responses`、`/v1/images/*`、`/v1/alpha/search`，协议含 `anthropic / anthropic_beta / openai_chat / openai_responses / gemini_native / codex / codex_oauth`。

> 任一 agent 若据项目名 `cc-switch` 断言它是"纯配置读写"，都是没读代码。**本报告已纠正该误判。**

---

## 2. 核心差异：Provider 数据模型

### 2.0 根因：Provider 的归属权放错了层（WAN vs VLAN）

这是比"没有 model 维度"更根本的问题。**CCS 把 provider 定义在 agent 的作用域里，CCR 定义在网关的作用域里。**

**CCR（路由面 / WAN）** —— 网关配一次，agent 只订阅：

```ts
export type AppConfig = {
  Providers: GatewayProviderConfig[];   // ← 全局一份上游清单
  Router: RouterConfig;                 // ← 全局一份路由规则
  profile: ProfileRuntimeConfig;        // ← agent 侧只持有白名单
  preferredProvider: string;
  // ... 没有任何 per-agent 的 provider 列表
};

export type ProfileRuntimeConfig = {
  claudeCode: ClaudeCodeProfileConfig;
  codex: CodexProfileConfig;
  enabled: boolean;
  profiles: ProfileConfig[];            // ← 每个 profile 里只有 model / availableModels
};

// profiles/model-allowlist.ts
export function profileAllowedModels(profile): string[] | undefined  // 返回的是 model id
export function filterModelIdsForProfile(config, ids, profile): string[]
```

**agent（profile）侧配的是 `model` + `availableModels: string[]`——模型 id 字符串，没有 provider 引用。** 上游、凭证、路由解析全部封在网关里。这正是你说的：WAN 一次配齐，各 VLAN 吃路由好的东西。

**CCS（所有权倒置）** —— provider 属于 agent：

```sql
-- 主键把 provider 切给 agent
CREATE TABLE providers (... PRIMARY KEY (id, app_type));

-- 连一个 URL 都要按 agent 存一份
CREATE TABLE provider_endpoints (
    provider_id TEXT NOT NULL,
    app_type    TEXT NOT NULL,
    url         TEXT NOT NULL,
    FOREIGN KEY (provider_id, app_type) REFERENCES providers(id, app_type)
);

-- 按 app 的策略表：重试/超时/熔断参数各一份
-- 注意：监听端口是共享的（单个 ProxyServer），且只对 supports_local_proxy() 的 4 个 app
-- 存在 proxy_config 行 —— 后者是 CCS 的**有意设计**，非缺陷（见文末更正记录 R1）
CREATE TABLE proxy_config (app_type TEXT PRIMARY KEY, ... auto_failover_enabled, max_retries ...);
```

**实测重复度**（`~/.cc-switch/cc-switch.db`）：

| 上游 URL | 副本数 | 出现在 |
|---|---|---|
| `https://wishub-x1.ctyun.cn/v1` | **2** | claude, claude-desktop |
| `https://open.bigmodel.cn/api/anthropic` | **2** | claude, claude-desktop |
| `https://api.moonshot.cn/anthropic` | **2** | claude, claude-desktop |
| `https://api.kimi.com/coding` | **2** | claude, claude-desktop |
| `https://kpzhu.com` | 1 | claude-desktop |
| `https://chatgpt.com/backend-api/codex` | 1 | claude-desktop |

**6 个真实上游 → 10 行 endpoint。** 4 个上游在 `claude` 与 `claude-desktop` 下各存一份，且两行 `added_at` **完全相同**（`1777741261628`）——说明是"建一次、然后按 agent 克隆"，而不是分别配置。

provider 表同理：**40 行只有 34 个唯一名字**。

**这个设计为什么是"糟糕"而不是"取舍"：**

1. **运营成本随 agent 数量线性增长。** 加一个 agent = 把 N 个上游重录一遍。8 个 agent × 6 个上游 = 最多 48 行。
2. **凭证跟着复制。** 同一个 key 在 2 个 app 下存 2 份，轮换时改 2 处，漏一处就是 401。
3. **健康状态不共享。** 熔断器 key 是 `app_type:provider_id`（`proxy/provider_router.rs:27`、`:277`），所以同一上游在 `claude` 与 `claude-desktop` 下是**两个独立的熔断器**——A 家挂了，一边熔断，另一边还在重试。这才是"所有权倒置"造成的真实损害。
4. **只能靠补丁打洞。** `provider_type` 是后补的一列；`claude_base_url_contains("githubcopilot.com")` 用 URL 子串猜类型。

### 2.1 CCS：Provider ≡ app 配置快照

`src-tauri/src/provider.rs:10-45`：

```rust
pub struct Provider {
    pub id: String,
    pub name: String,
    #[serde(rename = "settingsConfig")]
    pub settings_config: Value,     // ← 无类型 JSON blob
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub meta: Option<ProviderMeta>, // ← 类型信息的"补丁口袋"
    pub icon: Option<String>,
    #[serde(rename = "inFailoverQueue")]
    pub in_failover_queue: bool,    // ← 故障转移 = 一个布尔
}
```

数据库 schema（`~/.cc-switch/cc-switch.db`）：

```sql
CREATE TABLE providers (
    id TEXT NOT NULL,
    app_type TEXT NOT NULL,
    name TEXT NOT NULL,
    settings_config TEXT NOT NULL,      -- 整个 app 配置文件塞进来
    ...
    meta TEXT NOT NULL DEFAULT '{}',
    is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
    "cost_multiplier" TEXT NOT NULL DEFAULT '1.0',
    "limit_daily_usd" TEXT,
    "limit_monthly_usd" TEXT,
    "provider_type" TEXT,               -- 列顺序在最后 → 后期 ALTER TABLE 补的
    PRIMARY KEY (id, app_type)          -- ← 身份被 app 切碎
);
```

**真实数据行**（实测，已脱敏截断）：

```
codex  | default      | default        | {"auth":{"auth_mode":"chatgpt","OPENAI_API_KEY":null,
                                          "tokens":{"id_token":"eyJhbGciOiJSUzI1NiIs..."}}}
claude | claude-official | Claude Official | {"env":{}}
codex  | codex-official | OpenAI Official | {"auth":{},"config":""}
```

**看到问题了吗：JWT 凭证直接躺在 `settings_config` 里。** `settings_config` 是目标 app 配置文件（Claude Code 的 `settings.json`、Codex 的 `auth.json`）的**逐字镜像**。

### 2.2 由此派生的四个结构性缺陷

| # | 缺陷 | 证据 |
|---|---|---|
| D1 | **凭证与路由配置耦合**。1 个 provider 行 = 1 套 app 配置 = 1 个凭证，无法做凭证池 | `provider.rs:874` 单字段 `"ANTHROPIC_AUTH_TOKEN": self.api_key`；无 credential pool 语义 |
| D2 | **Provider 身份被 `app_type` 切碎，且跨 app 命名会漂移**，同一上游被当成几个不同的东西 | `PRIMARY KEY (id, app_type)`；实测最刺眼的一例：`https://ai.ctaigw.cn/v1/chat/completions` 在 4 个 app 下叫 **4 个不同名字**——`claude`→`DeepSeek`、`claude-desktop`→`CTYun`、`codex`→`自定义网关`、`omp`→`ctaigw` |
| D3 | **类型靠字符串启发式判定**，非建模 | `provider_type()` 读 `meta.provider_type`；`claude_base_url_contains("githubcopilot.com")` 用 URL 子串猜是不是 Copilot（`provider.rs:120`） |
| D4 | **故障转移只是扁平队列**，无优先级语义、无模型感知 | `in_failover_queue BOOLEAN` + `sort_index`；`provider_router.rs:select_providers()` 返回 `Vec<Provider>` 顺序尝试 |

### 2.3 CCR：Provider 是"上游端点 + 凭证池 + 模型目录 + 计量"的复合体

```
packages/core/src/providers/
├── presets/              # 每个上游一个目录，强类型 ProviderPreset
├── credential-pool.ts    # 凭证池：多 key + 冷却 + 窗口限流
├── model-catalog.ts      # 模型目录
├── model-auto-refresh.ts # 模型自动刷新
├── probe.ts              # 能力探测
├── circuit-breaker.ts    # 熔断
└── runtime-topology.ts   # 运行时拓扑（provider ↔ credential 运行时 id）
```

**计量是声明式的，不是写死的代码**（`presets/moonshot/index.ts`）：

```ts
const moonshotGlobalProviderAccountConfig: ProviderAccountConfig = {
  connectors: [{
    auth: "provider-api-key",
    endpoint: "https://api.moonshot.ai/v1/users/me/balance",
    mapping: { meters: [
      { id: "balance", kind: "balance", label: "Balance",
        remaining: "$.data.available_balance", unit: "CNY" },
      { id: "voucher_balance", kind: "balance", label: "Voucher balance",
        remaining: "$.data.voucher_balance", unit: "CNY" }
    ]},
    type: "http-json"
  }]
};
```

新增一个上游的余额面板 = **加一个 preset 文件**，不碰核心代码。对比 CCS：新上游要写 Rust + 重编译。

**凭证池**（`credential-pool.ts`）：

- 多凭证 per provider，`providerCredentialRuntimeId` / `findProviderCredentialBySlug`
- 单凭证冷却 60s（`providerCredentialCooldownMs`）
- 按窗口的请求限额（`limitRules` / `readWindowCounter`）
- 实时利用率（`providerCredentialLimitState` 返回 `{ blocked, utilization }`）

**这是 CCS 完全不具备的能力**：CCS 一个 provider 只能挂一个 key，想轮询多个 key 就只能复制多行配置。

---

## 3. 路由能力差异（"全局路由"）

### 3.1 CCS：app 级扁平队列

`proxy_config` 单表，**按 app_type 一行**：

```sql
CREATE TABLE proxy_config (
    app_type TEXT PRIMARY KEY,           -- 粒度：整个 app
    proxy_enabled INTEGER,
    auto_failover_enabled INTEGER,
    max_retries INTEGER DEFAULT 3,
    circuit_failure_threshold INTEGER DEFAULT 4,
    circuit_timeout_seconds INTEGER DEFAULT 60,
    ...
);
```

真实配置（实测 2 行）：`claude|...|auto_failover=0|max_retries=6`、`codex|...|auto_failover=0|max_retries=6`。

**`provider_router.rs` 全文 `grep -c model` = 0。**

即：CCS 能表达的最复杂路由是——*"对 claude 这个 app，按 sort_index 依次试这些 provider，失败就轮到下一个，熔断阈值 8 次"*。

**它无法表达**：
- opus 走 A 家、sonnet 走 B 家、haiku 走 C 家
- 长上下文请求走长窗口模型、短请求走便宜模型
- 带图片的请求走视觉模型、纯文本走文本模型
- 按 system prompt / agent 类型分流
- 按 token 数阈值降级

### 3.2 CCR：策略引擎 + 执行计划 + 可编程路由

`RouterConfig`（`contracts/app.ts:860`）：

```ts
export type RouterConfig = {
  builtInRules: RouterBuiltInRulesConfig;   // claude-code / codex 内置规则
  fallback: RouterFallbackConfig;
  rules: RouterRule[];                      // 用户规则表
};

export type RouterRule = {
  condition?: RouterRuleCondition;
  enabled: boolean;
  fallback?: RouterFallbackConfig;
  id: string; name: string;
  pattern?: string;            // ← 匹配
  rewrite?: RouterRuleRewrite; // ← 改写
  rewrites?: RouterRuleRewrite[];
  script?: RouterRuleScript;   // ← 可编程
  target?: string;
  threshold?: number;          // ← 阈值降级
  type: RouterRuleType;
};

export type RouterFallbackMode = "off" | "retry" | "model-chain";
```

**三层能力，CCS 一层都没有：**

**(a) 模型链回退**：`RouterFallbackMode` 含 `"model-chain"`，回退不是"换同样的人再试"，而是"换一个模型继续"。

**(b) 执行计划**（`routing/execution-plan.ts`）：

```ts
export function createRouteExecutionPlan(input: {
  bodyModel?: string;
  fallback: RouterFallbackConfig;
  hasRequestBody: boolean;
  modelRegistry?: ModelRegistry;
  primaryModel?: string;
}): RouteExecutionPlan
```

从**请求体里的 model** 出发，结合 `modelRegistry`（`normalizeRouteSelector` / `providerRuntimeId`）、熔断状态（`circuitAllows`）、provider 声明的备用链（`expandProviderFallbackAttempts`）生成整条尝试序列。

**(c) 全局路由脚本**（`routing/route-script-runtime.ts`，400 行）：用户用 JS 写路由函数，跑在 `worker_threads` 里，**能读到完整请求体**：

```
ROUTER_SCRIPT_API_VERSION = 1
maxPendingRequests = 64
circuitFailureThreshold = 3 / circuitWindowMs = 60_000 / circuitOpenMs = 30_000
workerOldGenerationMb = 1024   // 源码注释：长上下文请求序列化后几十 MB
```

这是真正的"全局路由"——**任意请求 → 任意判定 → 任意重写**，而不是选个 provider 序号。

---

## 4. Fusion（虚拟模型融合）

CCR 的 Fusion 不是"多模型投票"，而是**给任意模型外挂能力**：

`packages/ui/src/pages/home/shared/virtual-models.ts`（1,232 行）导入的融合工具：

```
BUILTIN_FUSION_VISION_TOOL_NAME          // 视觉
BUILTIN_FUSION_WEB_SEARCH_TOOL_NAME      // 联网
BUILTIN_FUSION_IMAGE_GENERATION_TOOL_NAME // 生图
BUILTIN_FUSION_VIDEO_GENERATION_TOOL_NAME // 生视频
BUILTIN_FUSION_GROK_MEDIA_TOOL_NAME       // Grok 媒体
```

配套契约 `VirtualModelProfileConfig`（`contracts/app.ts:1246`）与
`VirtualModelFusionVisionConfig / WebSearchConfig / MediaConfig / CustomToolConfig`。

**语义**：定义一个虚拟模型 id → 映射到某条路由 → 自动挂载 vision / web-search / image-gen 等 MCP 工具。于是**一个纯文本的便宜模型，在客户端看来就是"能看图、能联网、能生图"的模型**。

`ProfileRoutingConfig = { enabled, enhancedRoute, rules }` 则把路由下沉到 profile 级——不同 profile（不同项目/不同 agent）可以用不同的路由表。

**CCS 对应物：无。** CCS 的 `mcp_servers` 表只是"配了哪些 MCP server"，与"虚拟模型 + 能力融合 + 路由组合"是两个概念；`mode/` 模块做的是 app 模式切换。

---

## 5. 功能对照矩阵

| 能力 | CCR | CCS | 迁移工作量 |
|---|---|---|---|
| 流式代理 | Node/TS | **Rust/hyper，更强** | 无需迁移 |
| 协议覆盖 | 较广 | **anthropic/openai_chat/openai_responses/gemini/codex_oauth/images** | 无需迁移 |
| 熔断器 | ✅ provider 级 | ✅ provider 级（`circuit_breaker.rs`，参数更细） | 无需迁移 |
| 故障转移 | ✅ 模型链 | ⚠️ 扁平队列 | **改造** |
| **类型化 Provider** | ✅ preset 目录 | ❌ JSON blob + 字符串启发式 | **重构** |
| **凭证池（多 key 轮询）** | ✅ | ❌ 单 key | **新增** |
| **model 级路由** | ✅ | ❌ 无 model 维度 | **新增** |
| **全局路由脚本** | ✅ worker_threads + 全请求体 | ❌ | **新增** |
| **Fusion 虚拟模型** | ✅ | ❌ | **新增** |
| 声明式余额/配额计量 | ✅ JSONPath meters | ⚠️ 有 quota/balance 但绑定内置 provider | **改造** |
| 模型目录/自动刷新/探测 | ✅ | ⚠️ `codex-official-models.json` 等散落文件 | **改造** |
| 动态插件 / marketplace | ✅ `plugins/marketplace.ts` | ❌ 全编译进 Rust | **重大** |
| Profile 体系 | ✅ 4,284 行 `profiles/service.ts` | ✅ 87 文件提及 profile | 对齐即可 |
| 会话管理 | 部分 | **✅ 23,321 行，覆盖 claude/codex/dsh/kimi/hermes** | CCS 更强，保留 |
| 内存占用 | 998 MB | 预期 150–300 MB | CCS 更优 |

---

## 6. 迁移方案

### 方案 A：就地改造 CCS 数据模型（推荐）

**核心是一次 schema 迁移，把"配置快照"解耦成三层：**

```
Layer 1  Provider（上游端点）
         id, name, base_url, protocol, capabilities[]
         ← 与 app_type 解耦，一上游一行

Layer 2  Credential（凭证池）
         provider_id FK, key, limits{}, cooldown_until, health
         ← 1:N，支撑轮询与限流

Layer 3  Binding（app × 路由绑定）
         app_type, provider_id, credential_strategy, route_rules
         ← 把 is_current / in_failover_queue 提升为规则表
```

**分阶段（工作量估算基于当前代码体量，非承诺）：**

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 | **上游去重映射**：按 `base_url` 判定 40 行 provider 里哪些是真重复、哪些是同名异构，产出 P1 的映射输入（只读，不改 schema） | 0.5 天 |
| P1 | **Provider 作用域从 agent 提升到网关** + Credential / Binding 三层 schema + 迁移脚本（实测需兼容 40 行 provider / 8 个 app_type，去重后约 34 个上游） | ✅ **已落地**（schema + 回填，见 §6.1） |
| P2 | 代理层接三层模型：`provider_router.rs` 引入 model 维度 | 5–8 天 |
| P3 | 凭证池：轮询策略 + 冷却 + 窗口限流（移植 `credential-pool.ts` 语义） | 3–5 天 |
| P4 | 模型链回退（对齐 `RouterFallbackMode`） | 2–3 天 |
| P5 | 全局路由脚本：Rust 侧做 sandbox（等价 worker_threads 的隔离/超时/熔断） | 8–15 天 |
| P6 | Fusion 虚拟模型：虚拟 id → 路由 + MCP 工具挂载 | 8–12 天 |

**P1–P4 是"让 CCS 达到 CCR 现有路由水平"的最小路径，约 2–3 周。**
**P5–P6 是真正难的部分，且没有 Rust 现成方案**（JS 脚本沙箱要自己造）。

### 6.1 P1 落地状态（2026-11-03）

**已完成**：schema（4 张新表）+ 从 `providers` 的回填 + 单元测试 + 真实副本验证。

| 项 | 结果 |
|---|---|
| 改动 | `database/schema.rs` +582 行、`database/mod.rs` 版本号 +1 |
| `SCHEMA_VERSION` | 24 → **25** |
| 真实副本 | 40 provider 行 → 23 upstream / 28 endpoint / **40 binding（一行未丢）** |
| 兼容性 | 全量 lib 测试 **4280 通过**；2 个失败为既有问题（已在干净 HEAD 复现），1 个为网络类 flaky |
| 破坏性 | **零**——只加表，`providers` 不删不改（仅用户确认的改名）；凭证 `secret` 留空不搬运 |

**P1 剩余（原计划含、本次未做）**：把 `provider_router.rs` 改为**读新表**而不是 `providers`。
这是 P2 的第一步，也是唯一能改变运行时行为的动作，建议单独一个提交以便回滚。

#### 6.1.1 增量回填（2026-11-04）

回填原本是一次性的。合并上游 v4.0.25 后暴露了缺口：该版本新增了 `AppType::Dsh`
（第 9 个 app 类型），应用启动时的 live-import 会写进 `providers`，但这行**永远拿不到绑定**，
只能回落旧熔断键——即"以后新建的网关永远不参与上游去重"。

**做法：把搬运逻辑抽成幂等函数，挂在读路径上对账。**

| 项 | 决策 |
|---|---|
| 触发点 | `get_provider_upstream_keys`（路由器唯一取键入口，已有 30s 缓存） |
| 为什么不挂 `save_provider` | 直接写 `providers` 的 SQL 有二十多处（导入/恢复备份/启动同步/故障转移开关），漏一处就重演 |
| 漂移判定 | 重新派生 `endpoint_id` 与库中绑定比对；不一致即"换绑" |
| 换绑语义 | 绑定用 `INSERT OR REPLACE`；凭证用 `ON CONFLICT DO UPDATE SET endpoint_id`——**secret/limits 只保留不覆盖** |
| 孤儿清理 | 每次写事务内清掉无绑定引用的 credential → endpoint → upstream |
| 删除联动 | `delete_provider` 同步删绑定并清理孤儿 |
| 真源 | 绑定表的 `is_current` / `in_failover_queue` / `sort_index` 只是**快照**，选路以 `providers` 为准（用户决策 (i)） |

上游显示名必须**跨 app** 计算（`p1_canonical_names`），否则增量补出来的名字会与整库迁移不一致。

**验证**：

| 项 | 结果 |
|---|---|
| 等价性 | 同一份库，"整库迁移"与"清空后逐个 app 对账"产出**逐行相同**（含上游名） |
| 幂等 | 连续读多次不产生重复行 |
| 换绑 | 改 base_url 后绑定跟着换，旧 endpoint / upstream 被清理，凭证重指而非丢失 |
| 删除 | 删 provider 后绑定 / 凭证 / 端点 / 上游全清 |
| 真实副本 | 41 provider → 40 绑定补齐为 **41**；上游仍 23、端点仍 30（`dsh` 并入已有 `up-ai.ctaigw.cn`，未新建） |
| 全量测试 | **4420 通过**；2 个既有失败 + 1 个网络 flaky（单独跑通过） |

> 估算原写 3–5 天，实际一轮做完——因为去重规则确定后，回填逻辑比预估简单；真正的复杂点在 P2（协议分派）与 P5（脚本沙箱）。

### 6.2 P2 第一步：熔断键提升到网关级（2026-11-03）

**目标**：让同一上游的健康状态跨 app 共享——此前 `claude` 侧熔断不影响 `claude-desktop` 侧，
同一个网关挂了，两个 agent 会各自把失败重试一遍。

| 项 | 内容 |
|---|---|
| 键格式 | `up:{upstream_id}:{protocol}:{密钥指纹}`（三段缺一不可，见 §6.3） |
| 灰度开关 | 环境变量 `CCS_CIRCUIT_KEY_MODE` = `off` / `shadow`（默认）/ `on` |
| `off` | 完全旧行为 `{app_type}:{provider_id}` |
| `shadow` | 仍用旧键，启动时打一份「哪些键会合并」的报告，零行为变化 |
| `on` | 使用网关级键，跨 app 复用同一 `CircuitBreaker` 实例 |

**改动**：`database/dao/providers.rs` 新增 `get_provider_upstream_keys`；
`proxy/provider_router.rs` 新增 `CircuitKeyMode`、30s TTL 缓存、`circuit_key_for`、
`log_upstream_key_diagnostics`，并把 6 处键构造点统一；`proxy/server.rs` 启动时打诊断。

**踩到的坑**：`get_or_create_circuit_breaker` 原本靠 `key.split(':').next()` 反推 app_type，
换成 `up:...` 后会取到 `"up"` 并静默用默认熔断配置。已改为**显式传 `app_type`**。
同理 `update_app_configs` 原本按 key 前缀过滤，网关级键不再以 app_type 开头，
改为记录 `键 → 归属 app 集合` 来判断。

**真实数据上的合并报告**（迁移副本，`shadow` 模式启动时打印）——**6 组，全部是同一把 key**：

| 网关级键 | 成员 |
|---|---|
| `up:up-api.kimi.com:anthropic:<fp>` | `claude:Kimi` + `claude-desktop:Kimi` |
| `up:up-api.kimi.com:anthropic:<fp'>` | `claude:Kimi For Coding` + `claude-desktop:Kimi For Coding` |
| `up:up-ai.ctaigw.cn:anthropic:<fp>` | `claude:DeepSeek` + `claude-desktop:CTYun` |
| `up:up-ai.ctaigw.cn:openai_chat:<fp>` | `opencode:CTYun AI Gateway` + `omp:ctaigw` |
| `up:up-open.bigmodel.cn:anthropic:<fp>` | `claude` + `claude-desktop` |
| `up:up-kpzhu.com:anthropic:<fp>` | `claude:My Claude` + `claude-desktop:kpzhu` |

**已知未覆盖（P3 再处理）**：数据库里的 `provider_health` 仍按 `(provider_id, app_type)` 记录，
所以内存熔断共享了、UI 上的健康状态仍可能两个 app 各显示一套。
**用户决定：不做**——理由是收益不足且要区分更多失败类型。已确认 `is_healthy` 无任何路由消费者，
仅 `ProviderCard.tsx` 显示，属纯展示滞后。

**建议的启用顺序**：先 `shadow` 跑一段时间看日志 → 确认合并清单无误 → `on`。

### 6.2b P2 第一步：请求侧 base_url 改读网关表（2026-11-04）

**目标**：让请求地址只有一个真源——`upstream_endpoints`。这是"网关一次配齐、各 agent 直接吃"
的前置条件：只要请求侧还在解析各 agent 自己的 `settings_config`，改网关就永远改不彻底。

**回退规则**（关键设计）：

```
端点有 base_url  → 用端点的
端点没有        → 回落适配器
```

为什么不能一刀切：`codex-official` 这类托管 OAuth 的 URL 不是配置里的字符串，而是适配器
**按身份算出来**的（`https://chatgpt.com/backend-api/codex`），端点表里根本没有。反过来
`opencode` 的配置形状是 `options.baseURL`，`CodexAdapter` 读不出来（它只认 TOML /
`base_url`），端点表反而有值。

**切换前先证明安全**（真实库副本，38 行有适配器的 provider）：

| 情形 | 行数 | 含义 |
|---|---|---|
| 端点与适配器一致 | 13 | 完全等价 |
| 仅端点有值 | 14 | 全是 `opencode`，适配器本就解析失败 |
| 仅适配器有值 | 1 | `codex-official` 托管 OAuth，走回退 |
| **两者都有但不一致** | **0** | ← 唯一危险情形，为空才允许切换 |

这条已固化成 `endpoint_base_url_safely_replaces_adapter`（`#[ignore]`，需
`CCS_RECONCILE_VERIFY_DB`），以后谁改动派生规则都会被它拦下。

**过程中修掉的真 bug**：`p1_normalize_url` 原先把 query 整段抹掉。真实库里没有带 query 的
URL，所以回填时看不出来；但请求侧一旦改读端点表，`https://host/v1?api-version=xxx` 就会
悄悄丢掉查询参数（Azure 风格网关全靠它）。已改为保留 query、丢弃 fragment，并因此让
`endpoint_id` 把 query 计入身份——不同 `api-version` 是不同端点，不该合并。

**开关**：`CCS_GATEWAY_BASE_URL=off` 整体回退到适配器解析（应急处置）。

**测试**：全量 **4422 通过**；2 个既有失败（与本次无关）。真实副本复核：41 provider →
40 绑定补齐为 41，`dsh` 并入 `up-ai.ctaigw.cn`，冲突仍为 0。

### 6.3 关键修正：熔断键必须带密钥指纹

初版键只用 `up:{upstream_id}:{protocol}`，**会误伤**。实测同一上游下不同 provider 可能用不同 key：

| 上游 | provider 数 | 不同 key 数 | 只用 (上游, 协议) 的后果 |
|---|---|---|---|
| `www.omnai.xyz` | 3 | **3** | 一把 key 配额耗尽 → 另外两把也被熔断 |
| `api.kimi.com` | 4 | **2** | `Kimi` 与 `Kimi For Coding` 互相误伤 |
| `10.10.49.36` | 2 | 2（其中一条无鉴权） | 本地服务被误伤 |

这正是用户指出的「**要区分不同的挂了的情况**」：

| 挂法 | 影响范围 | 正确的共享粒度 |
|---|---|---|
| DNS/连接/TLS 失败、5xx、超时 | 整个 host | **host 级**（跨 key、跨 app 都该共享） |
| 401/402/403、429、配额耗尽 | **单个 key** | **key 级**（绝不能跨 key 共享） |
| 404/400、模型不可用 | 单条路径 | 上游 + 协议级 |

当前实现是**两级熔断**：

| 层级 | 键 | 计入的失败 | 作用范围 |
|---|---|---|---|
| host 级 | `host:{host}` | `Transport`（DNS/连接/TLS/超时）、`ServerError`（5xx） | 整个网关，跨 key、跨 app |
| 凭证级 | `up:{上游}:{协议}:{密钥指纹}` | 全部失败（含 401/429/配额） | 单把 key，跨 app 同 key 共享 |

选路时**两级都必须是 Closed** 才纳入候选；记录结果时按 `FailureKind` 决定污染哪一级。
`FailureKind` 由 `ProxyError` 归类（`forwarder::record_provider_failure` 处传入），
与既有的「本家出问题 → 换下一家」判定保持一致。

host 级刻意**不参与 HalfOpen 许可协议**：`is_available()` 在 HalfOpen 返回 true、
`record_*(false)` 只计数不碰许可，所以它能靠超时自行恢复，不需要探测名额。

指纹只对**密钥值**取 SHA-256 前 4 字节，不含字段名——同一把 key 在不同 app 里可能分别存在
`ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` / `options.apiKey`，按字段名算会被错误拆开。
指纹不落库、不打印、不可逆。



### 方案 B：双持（性价比最高）

- **CCS 做主代理**（性能、社区、会话管理）
- **CCR 保留为"路由层"**：全局路由脚本 + Fusion 仍跑在 CCR，CCS 作为其中一个上游 provider

零重构成本，当天可用。代价是维持两套常驻进程。

### 方案 C：关系型反了——把 CCS 的能力搬到 CCR

社区证据不支持（CCS 4 倍 star、当天在推，长期看 CCS 是更可能活下来的那个）。**不推荐。**

---

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **D2 身份漂移**：`ai.ctaigw.cn` 一个上游在 4 个 app 下叫 4 个名字（DeepSeek / CTYun / 自定义网关 / ctaigw） | 迁移脚本按名字 join 会分裂成 4 个假上游；按 id join 又会串错 | 必须**按 base_url 归一**，人工确认同名异构 |
| **D1 凭证在 blob 里**：JWT/API key 埋在 `settings_config` JSON | 拆表时易漏、易明文落库 | 迁移脚本要按已知 schema 抽取并加密 |
| 上游合流冲突 | 每次 sync upstream 都要 rebase | 改造尽量做成新文件 + 新表，少动 `forwarder.rs` |
| P5 脚本沙箱 | Rust 里跑用户 JS 无成熟等价物，安全面大 | 要么降级为声明式 DSL，要么引入 `deno_core`/`boa` |
| CCS 上游演进快（79 tags） | 你的 patch 会持续漂移 | 优先走 upstream PR 而非长期 DIY fork |

---

## 8. 建议

1. **先做 P0**（按 `base_url` 的上游去重映射），只读、零风险，且是 P1 的必要输入。
2. **把命名漂移钉死**（D2）：`ai.ctaigw.cn` 那 4 个名字必须归并成 1 个网关级 provider，并给 `claude` 侧那个叫 `DeepSeek` 的行改名。
3. **P5 先想清楚要不要**：如果"全局路由"需求其实只是"按模型名/请求大小分流"，用声明式规则表（P2 的延伸）就能满足，能省掉 8–15 天的沙箱工程。
4. **Fusion 评估**：如果只是少数几个场景需要 vision/web-search，CCS 的 `mcp_servers` 可能已够用——先确认你的实际用法再决定要不要 P6。

---

## 更正记录

本报告在写作过程中修正了三处早期误判。记录在此，避免后续读者（包括 AI agent）重复犯错：

| # | 早期误判 | 实际情况 | 依据 |
|---|---|---|---|
| **R1** | `proxy_config` 的 `CHECK (app_type IN ('claude','codex','gemini','grokbuild'))` 只允许 4 类，是"缺陷"，应扩到 8 类 | **是有意设计。** `AppType::supports_local_proxy()` 精确返回这 4 类；`commands/proxy.rs:15` 的 `require_proxy_app()` 与之对应；注释明确写"Desktop 经同一个路由服务转发，但没有 `proxy_config` 行、不做故障转移"（`app_config.rs:534-539`）。**不要改。** | `app_config.rs:530-539`、`commands/proxy.rs:11-18` |
| **R2** | 8 个 agent = 8 套独立监听端口 / 独立路由域 | **错。** 只有一个 `ProxyServer`、一个 `listen_port`（实测两行都是 15721）。`proxy_config` 是**按 app 的策略表**（重试/超时/熔断参数），不是独立路由域。 | `proxy/server.rs:109`、实测 `proxy_config` 行 |
| **R3** | `provider_endpoints` 的 url 与 `settings_config` 里的 `base_url` 不一致，属"双写漂移" | **错。** `provider_endpoints` 是用户可增删的**自定义端点列表**（`add_custom_endpoint` / `remove_custom_endpoint`，按 `added_at` 排序），不是当前 base_url 的镜像。两者本来就可以不同。 | `database/dao/providers.rs:539-562` |

**仍然成立的核心结论**（经数据与源码双重验证）：D1 凭证耦合、D2 身份切碎与命名漂移、D3 字符串启发式判型、D4 扁平故障转移队列；以及 CCR 侧 `AppConfig.Providers` 全局单例 + profile 只持 `availableModels` 白名单这一 WAN/VLAN 结构差异。

---

## 附：关键文件索引

**CCS**
- `src-tauri/src/provider.rs:10-45` — Provider 结构体
- `src-tauri/src/provider.rs:120` — `claude_base_url_contains` 启发式
- `src-tauri/src/provider.rs:874` — 单 key 注入
- `src-tauri/src/proxy/provider_router.rs:27` — 熔断器 key = `app_type:provider_id`
- `src-tauri/src/app_config.rs:530-539` — `supports_local_proxy` / `has_route_mode`（R1 依据）
- `src-tauri/src/commands/proxy.rs:11-18` — `require_proxy_app` 守卫
- `~/.cc-switch/cc-switch.db` — `providers` / `provider_endpoints` / `proxy_config` 表

**CCR**
- `packages/core/src/contracts/app.ts:1963-1972` — `AppConfig.Providers` 全局单例
- `packages/core/src/contracts/app.ts:1684-1689` — `ProfileRuntimeConfig`
- `packages/core/src/profiles/model-allowlist.ts` — profile 的模型白名单
- `packages/core/src/contracts/app.ts:816-884` — RouterRule / RouterFallbackConfig
- `packages/core/src/contracts/app.ts:1246` — VirtualModelProfileConfig
- `packages/core/src/routing/execution-plan.ts:9-45` — 执行计划
- `packages/core/src/routing/policy-engine.ts` — 策略引擎
- `packages/core/src/routing/route-script-runtime.ts:1-40` — 全局路由脚本沙箱
- `packages/core/src/providers/credential-pool.ts` — 凭证池
- `packages/core/src/providers/presets/moonshot/index.ts` — 声明式计量
- `packages/ui/src/pages/home/shared/virtual-models.ts:1-40` — Fusion 工具集

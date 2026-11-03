# CCS Provider 去重映射（P0 交付物）

> **数据源**：`~/.cc-switch/cc-switch.db`（只读快照，2026-11-03）
> **方法**：从每行 `providers.settings_config` 按其所属 app 的 config 形状提取 base_url，按 host 归组
> **结论**：**40 行 provider → 13 个上游 host**，其中 4 个 host 存在真正的跨 app 重复

---

## 1. 总览

| 指标 | 值 |
|---|---|
| provider 行数 | **40** |
| app_type 数 | 8 |
| 去重后上游 host | **13**（含 1 个"无显式 URL"桶） |
| 跨 app 真重复的 host | **4** |
| 同 app 内多预设（非重复，需人工判定） | 3 组 |

### 各 app 的 config 形状（提取器依赖）

| app_type | base_url 位置 |
|---|---|
| `claude` / `claude-desktop` | `env.ANTHROPIC_BASE_URL` |
| `codex` | `config`（TOML 文本）里的 `base_url = "..."` |
| `opencode` | `options.baseURL` |
| `hermes` | 顶层 `base_url` |
| `omp` | 顶层 `baseUrl` |
| `gemini` | `env`（当前为空） |
| `kimi` | `provider`（托管，无显式 URL） |

---

## 2. 跨 app 真重复组（这是 D2 的实体）

### 2.1 `ai.ctaigw.cn` —— 一个上游，五个名字，五行

| app_type | 名称 | provider id | base_url |
|---|---|---|---|
| `claude` | **DeepSeek** ← 陈旧错名 | `f829d5c5-8d05-…` | `https://ai.ctaigw.cn/v1/chat/completions` |
| `claude-desktop` | **CTYun** | `f829d5c5-8d05-…` ← 同一 id | `https://ai.ctaigw.cn/v1/chat/completions` |
| `codex` | **自定义网关** | `universal-code…` | `https://ai.ctaigw.cn/v1/chat/completions` |
| `omp` | **ctaigw** | `ctaigw` | `https://ai.ctaigw.cn/v1` |
| `opencode` | **CTYun AI Gateway** | `ctyun-aigw` | `https://ai.ctaigw.cn/v1` |

**判定为 1 个上游（天翼云 CTYun 网关）。** 这是全库最刺眼的一处：同一个地址、同一套网关，被 5 个 agent 各记一遍，且名字有 `DeepSeek / CTYun / 自定义网关 / ctaigw / CTYun AI Gateway` 五种写法。

⚠️ **注意路径差异**：`claude`/`claude-desktop`/`codex` 用 `/v1/chat/completions`，`omp`/`opencode` 用 `/v1`。前者是 Anthropic 兼容入口，后者是 OpenAI 兼容入口——**同一 host 需要两个协议适配器**（见 §4）。

### 2.2 `api.kimi.com` —— 六行、三名字、三种路径写法

| app_type | 名称 | provider id | base_url |
|---|---|---|---|
| `claude` | Kimi | `a0869b5e-…` | `https://api.kimi.com/coding/` |
| `claude` | Kimi For Coding | `300ff84e-…` | `https://api.kimi.com/coding/` |
| `claude-desktop` | Kimi | `a0869b5e-…` | `https://api.kimi.com/coding/` |
| `claude-desktop` | Kimi For Coding | `81586c11-…` | `https://api.kimi.com/coding` |
| `kimi` | Kimi Official · 松松 | `managed:kimi-c…` | `https://api.kimi.com/coding/v1` |
| `opencode` | Kimi | `kimi-for-codin…` | `https://api.kimi.com/coding/v1` |

⚠️ **三种路径写法**：`/coding/`、`/coding`、`/coding/v1`。归一化时必须先做 URL 规范化，否则按字符串比对会分裂成 3 个假上游。

**建议**：`claude` 下这 **两行（Kimi / Kimi For Coding）同 URL、同 app**，是同一上游的重复录入，应合并。`kimi` 的托管行是 CCS 的账号体系，单独保留。

### 2.3 `kpzhu.com` —— 两行两 app

| app_type | 名称 | provider id | 状态 |
|---|---|---|---|
| `claude` | My Claude | `myclaude-17926…` | **current** |
| `claude-desktop` | kpzhu | `287a0f83-…` | — |

判定为 1 个上游，2 条 binding。

### 2.4 `open.bigmodel.cn` —— 两行两 app

| app_type | 名称 | provider id | 状态 |
|---|---|---|---|
| `claude` | Zhipu GLM | `b5bc54b7-…` | — |
| `claude-desktop` | Zhipu GLM | `c5034989-…` | **current** |

判定为 1 个上游，2 条 binding。注意两个 app 各有一个 `current`，正是"每个 agent 一套指针"的体现。

---

## 3. 同 app 内多预设（**不是重复**，需人工确认）

这三组 URL 相同但语义不同，**不应盲目合并**：

| host | 行数 | 名称 | 判断依据 |
|---|---|---|---|
| `www.omnai.xyz` | 4 | OmnAI / (Kiro 限时特价) / (Windsurf) / OpenAI(OmnAI) | 同一网关的**不同计费通道**，价格与额度不同 |
| `dashscope.aliyuncs.com` | 2 | 阿里云百炼 (Alibaba AI SDK) / (OpenAI 兼容) | **不同协议适配器**（native vs OpenAI-compat） |
| `10.10.49.36:1234` vs `:8100` | 3 | rtx6000pro-lmstudio / LM Studio / Qwen3.8 Flash | `:1234` 两行（hermes+opencode）是真重复；`:8100` 是另一个服务 |

**建议**：`omnai` 与 `dashscope` 保留为独立 provider，但在网关层挂在同一"上游组"下以便统一统计配额。

---

## 4. 关键设计输入：Provider 的身份 = (host, protocol)，不是 host

审计暴露了一个 P1 必须先定的问题：

**同一个 host 可能同时需要多个协议适配器。**

- `ai.ctaigw.cn`：`claude` 走 `/v1/chat/completions`（Anthropic 兼容），`omp`/`opencode` 走 `/v1`（OpenAI 兼容）
- `dashscope.aliyuncs.com`：用户自己就建了 native 与 OpenAI-compat 两个 provider
- `10.10.49.36`：不同端口是不同服务

**所以"去重"的正确键不是 `host`，而是 `(host, protocol)`。**

如果 P1 只按 host 去重，会把两个不同协议入口合成一个，代理层就无法为不同 agent 选择正确的转换器——这正好是 CCS `streaming_*` / `transform_*` 那 9.2 万行在做的事。

**建议的三层实体：**

```
Upstream          (host, 显示名)              ← 去重单位，1 个 ai.ctaigw.cn
   └── Endpoint   (upstream_id, protocol, base_url)   ← 协议维度在这层
          └── Credential (endpoint_id, key, limits, cooldown)
                 └── Binding (app_type, endpoint_id, allowed_models[])
```

---

## 5. 归并预期

| 项 | 现状 | P1 后 |
|---|---|---|
| provider 行 | 40 | — |
| 网关级 Upstream | 13（含 1 个无 URL 桶） | **≈ 13** |
| Endpoint（含协议分化） | — | **≈ 16–18** |
| Binding（app × endpoint） | — | **40**（一行不丢） |

**结论：40 行不会被减到 13 行——而是拆成"13 个上游 + 40 条绑定"。** 数据量不减，但归属层级更正：上游配一次，agent 只绑定。

---

## 6. 需要你确认的三件事

1. **`claude` 下的 `DeepSeek`（`f829d5c5-…`）应改名为 `CTYun`**，与 `claude-desktop` 一致。它在 `claude` 侧不是 current，改名无风险。
2. **`claude` 下 `Kimi` 与 `Kimi For Coding` 是否合并为一条**（同 app、同 URL）。
3. **`www.omnai.xyz` 的 4 条** 是否算 4 个独立上游（我倾向是，因为计费通道不同）。

---

## 7. 附：完整 host 分组

| host | 行数 | app 数 | 名称 |
|---|---|---|---|
| `(无显式 URL)` | 11 | 6 | Claude Official / Claude Desktop Official / OpenAI Official / Google Official / default / CCR 本地网关 / Jetson Thor sglang / Qwen3.8 Flash Next / 天翼云 Ctyun (SUISQP) / Imported 2026-04-27 / zhipuai-coding-plan |
| `api.kimi.com` | **6** | 4 | Kimi / Kimi For Coding / Kimi Official · 松松 |
| `ai.ctaigw.cn` | **5** | 5 | CTYun / CTYun AI Gateway / DeepSeek / ctaigw / 自定义网关 |
| `www.omnai.xyz` | 4 | 1 | OmnAI / OmnAI (Kiro 限时特价) / OmnAI (Windsurf) / OpenAI(OmnAI) |
| `10.10.49.36` | 3 | 2 | LM Studio / Qwen 3.8 Flash Next (AI Lab) / rtx6000pro-lmstudio |
| `dashscope.aliyuncs.com` | 2 | 1 | 阿里云百炼 (Alibaba AI SDK) / 阿里云百炼 (OpenAI 兼容) |
| `kpzhu.com` | 2 | 2 | My Claude / kpzhu |
| `open.bigmodel.cn` | 2 | 2 | Zhipu GLM |
| `api.deepseek.com` | 1 | 1 | DeepSeek |
| `chatgpt.com` | 1 | 1 | Codex |
| `coding.dashscope.aliyuncs.com` | 1 | 1 | Model Studio Coding Plan |
| `tokenhub.tencentmaas.com` | 1 | 1 | Tencent TokenHub |
| `wishub-x6.ctyun.cn` | 1 | 1 | CTYun（opencode，与 ctaigw.cn 是**不同**的 CTYun 实例） |

> `(无显式 URL)` 桶里前三/五个是官方托管 provider（无用户 URL，不参与去重）；`CCR 本地网关`、`Jetson Thor sglang` 等 3 条 hermes 行与 1 条 opencode 行因 config 形状不同未提取到 URL，需单独复核。

---

## 8. P1 实现与真实数据验证（2026-11-03）

### 8.1 落地位置

| 文件 | 改动 |
|---|---|
| `src-tauri/src/database/schema.rs` | 新增 `create_upstream_tables` / `p1_protocol_for` / `p1_extract_base_url` / `p1_normalize_url` / `p1_fnv1a_hex` / `migrate_v24_to_v25`；迁移调度加 `24 => v25` 分支 |
| `src-tauri/src/database/mod.rs` | `SCHEMA_VERSION` 24 → **25** |
| 测试 | `migrate_v24_to_v25_lifts_providers_into_gateway_upstreams`（CI 跑）+ `migrate_v24_to_v25_on_real_copy`（`#[ignore]`，需 `CCS_P1_VERIFY_DB` 指向副本） |

**安全边界**：只新增 4 张表，**不删、不改 `providers` 任何行**（唯一例外是用户确认的
`claude/DeepSeek → CTYun` 改名，精确匹配三元组才生效）；凭证 `secret` 留空，**不搬运密钥**。

### 8.2 真实副本运行结果

```text
providers(before/after) = 40/40        ← 一行未丢
upstreams = 23（按 host 去重 12，无 URL 各自成家 11）
```

| 上游名 | host | 协议 | base_url | 绑定 |
|---|---|---|---|---|
| rtx6000pro-lmstudio | 10.10.49.36 | openai_chat | `http://10.10.49.36:1234/v1` | 2 |
| rtx6000pro-lmstudio | 10.10.49.36 | openai_chat | `http://10.10.49.36:8100/v1` | 1 |
| **CTYun** | ai.ctaigw.cn | **anthropic** | `https://ai.ctaigw.cn/v1/chat/completions` | 2 |
| **CTYun** | ai.ctaigw.cn | **openai_chat** | `https://ai.ctaigw.cn/v1` | 2 |
| **CTYun** | ai.ctaigw.cn | **openai_responses** | `https://ai.ctaigw.cn/v1/chat/completions` | 1 |
| DeepSeek | api.deepseek.com | anthropic | `https://api.deepseek.com/anthropic` | 1 |
| Kimi | api.kimi.com | anthropic | `https://api.kimi.com/coding` | **4** |
| Kimi | api.kimi.com | kimi_managed | `https://api.kimi.com/coding/v1` | 1 |
| Kimi | api.kimi.com | openai_chat | `https://api.kimi.com/coding/v1` | 1 |
| Codex | chatgpt.com | anthropic | `https://chatgpt.com/backend-api/codex` | 1 |
| Model Studio Coding Plan | coding.dashscope.aliyuncs.com | anthropic | `…/apps/anthropic/v1` | 1 |
| 阿里云百炼 | dashscope.aliyuncs.com | **alibaba** | `…/compatible-mode/v1` | 1 |
| 阿里云百炼 | dashscope.aliyuncs.com | **openai_chat** | `…/compatible-mode/v1` | 1 |
| My Claude | kpzhu.com | anthropic | `https://kpzhu.com` | 2 |
| Zhipu GLM | open.bigmodel.cn | anthropic | `https://open.bigmodel.cn/api/anthropic` | 2 |
| Tencent TokenHub | tokenhub.tencentmaas.com | openai_chat | `https://tokenhub.tencentmaas.com/v1` | 1 |
| CTYun | wishub-x6.ctyun.cn | openai_chat | `https://wishub-x6.ctyun.cn/v1` | 1 |
| OmnAI | www.omnai.xyz | **anthropic** | `https://www.omnai.xyz/v1` | 3 |
| OmnAI | www.omnai.xyz | **openai_chat** | `https://www.omnai.xyz/v1` | 1 |

**结论：29 条带 URL 的绑定 + 11 条无 URL = 40，与 provider 行数严格相等。**

### 8.3 关键发现：每个多行 host 都分裂在不同协议上

| host | 分裂出的协议 |
|---|---|
| `ai.ctaigw.cn` | anthropic / openai_chat / openai_responses |
| `api.kimi.com` | anthropic / kimi_managed / openai_chat |
| `dashscope.aliyuncs.com` | alibaba / openai_chat |
| `www.omnai.xyz` | anthropic / openai_chat |

**如果按 host 去重，这 4 个 host 会各被压成 1 个端点，代理层就无法为不同 agent 选对转换器。** `(host, protocol)` 是必需维度，不是洁癖。

### 8.4 实现过程中修正的一处自身错误

初版把 `opencode` 硬编码为 `openai_chat`，**错的**。opencode 的协议写在 `settings_config.npm`：

| npm | 条数 | → 协议 |
|---|---|---|
| `@ai-sdk/openai-compatible` | 11 | openai_chat |
| `@ai-sdk/anthropic` | 4 | anthropic |
| `@ai-sdk/alibaba` | 1 | alibaba |
| （缺失） | 2 | unknown |

修正前 `api.deepseek.com/anthropic` 与 `coding.dashscope…/apps/anthropic/v1` 被误标成 openai_chat，看起来像"用户配错了"。**实际是两条配置都对，是我的派生逻辑错了。** 修正后两条均正确归为 anthropic。

### 8.5 遗留待你确认

1. **`Codex`（claude-desktop）→ `https://chatgpt.com/backend-api/codex`**，配置声明的是 `ANTHROPIC_BASE_URL`，故标为 `anthropic`。但该地址是 OpenAI Codex 端点，若实际需要协议转换，这条应在 P2 用 `provider_type`/专用 adapter 标注，而非依赖 app 推断。
2. **两个上游都叫 `CTYun`**（`ai.ctaigw.cn` 与 `wishub-x6.ctyun.cn`）。它们确实是不同实例，但同名在 UI 上会混淆，建议其中一个改名 `CTYun (x6)`。
3. **`www.omnai.xyz`** 按你的决定未合并：4 条绑定全部保留，仅共享 upstream 身份（不删行、不并 key）。

# CCS P0：现状清单与替换映射

> 交付物性质：**只读调查 + 处置方案**，不含代码改动。
> 目标来自用户（不可再讨论）：模式清零；app 页换成 CCR profile 编辑器的界面与逻辑；
> 供应商 = 全局池 + 模型目录，模型引用 `<供应商>/<模型>`。
> 每一条结论后面是 `文件:行`；标「未核实」的条目在写代码前必须先补。

---

## 1. 现状 A：三个模式的状态机与依赖面

### 1.1 数据结构（`src-tauri/src/mode/state.rs`）

| 结构 | 位置 | 内容 |
|---|---|---|
| `LiveState` | `state.rs:29` | `apps: BTreeMap<String, AppLiveState>`，设备本地文件 `live-state.json`（0600，不同步） |
| `Mode` | `state.rs:51` | **只有两个值**：`Direct` / `Proxy`。聚合不是独立 mode，是 `Proxy + StackState.enabled` |
| `Contract` | `state.rs:60` | `version` + `key`（内容摘要，相同则不重写客户端文件）+ `exclusive`（退出代理时按值删除的独有字段） |
| `ModeState` | `state.rs:73` | `mode?` / `attached`（客户端是否指向代理，退出 CCS 时分离、启动接回）/ `proxy_route`（路由到哪家，与直连指针互相独立）/ `contract` |
| `Written` | `state.rs:100` | 上次写进客户端、之后要按记录删除的东西（目前只有 Grok 的模型表 `tables`） |
| `StackState` | `state.rs:119` | `enabled` + `members: Vec<String>`（按加入顺序）+ `keys: BTreeMap<key, provider_id>`（**永久归属**，删除不回收） |

### 1.2 聚合（Stack）到底是什么

- 只在 `Proxy` 模式下有意义；与「路由模式」在界面上二选一（`mode/controller.rs:1145` 拒绝叠加）
- 成员 = 该 app 的供应商 id 列表；每个成员贡献的模型：
  - 配了 `meta.stackModels`（自由列表）→ 发列表里的（`mode/stack.rs:224-232`）
  - 没配 → 回落到模型映射：`ANTHROPIC_MODEL` + `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`
  - 所以默认形态是 **4 档 × M 家 = 4×M**；`stackModels` 只是让单家可以不是 4 个
- 发布 id 按 app 各自规则生成（`mode/stack.rs:34-49`）：
  - Claude `ccs-claude-<key>--<model>`（id 里必须有 `claude` 才进 `/model`）
  - Codex `ccs-<key>/<model>`
  - Desktop `claude-fable-ccs-<6 位数字>`（选择器只收含 `claude`、不含厂商名、末尾 8 位数字会被当日期剥掉）
- 解析是**严格失败**：解不出来（不在 Stack、成员已移除、供应商已删除、key 未登记）一律报错，
  不回落到默认路由（`mode/stack.rs:1-20` 设计注释）
- Stack 请求**不参与**熔断器 / 故障转移 / 使用统计（`routing_state_enabled`）

### 1.3 模式的生命周期与锁

- 进入/退出：`mode::controller::enter/exit`；每次进入按用户选的模式写定 `StackState.enabled`
- 切换锁：`controller::lock_settled_blocking(app)`，拿锁之后才读当前供应商（`services/provider/live.rs:806-812` 注释里写明原因）
- 契约摘要在 `Contract.key`：切路由时摘要相同就不动客户端文件；退出时按 `Contract.exclusive` 删字段
- 漂移检测：Desktop 的 `expected_base_url` / `actual_base_url`（`claude_desktop_config.rs:116`）

### 1.4 删掉模式会牵动的面

| 面 | 现在依赖模式 | 处置 |
|---|---|---|
| `proxy_config` 表（per app 的 `proxy_enabled` / `enabled` / 监听地址） | 代理模式的开关 | 保留，改成网关的全局开关 |
| `proxy_route`（`mode.proxy_route`）+ `mode::current::provider_in_use` | 路由到哪家 | 删除：路由改由模型决定 |
| 故障转移 / 熔断器 / 使用统计 | 路由模式专属 | 保留为网关能力，作用对象从「当前上游」变成「解析出来的上游」 |
| `Contract.exclusive` | 代理契约字段回收 | 保留（网关入口仍需要写入/回收） |
| `live-state.json` 的 `stack` 段 | 聚合 | **迁移**：上提为网关模型目录 + 每 app 的 profile |
| `Written.tables` | Grok 模型表 | 保留（入口写入仍需要） |
| 侧边栏「聚合」徽标、三页签、per-app 供应商卡片 | 三种模式的 UI | 删除 |
| `is_additive_mode()` / `supports_local_proxy()` / `has_route_mode()` | 模式能力判定 | 重写为「有无入口」判定 |

---

## 2. 现状 B：模型发布的四种形态（保留写入器，换数据源）

| 载体 | 写入器 | id 规则 | 触发 |
|---|---|---|---|
| Claude `modelPicker` + 四档环境变量 | `mode/controller.rs:226` 附近 `with_stack_models` | `ccs-claude-<key>--<model>` | 进入代理/增删成员 |
| Claude Desktop `inferenceModels[]` | `claude_desktop_config.rs:1480-1497` | `claude-fable-ccs-<6 位数字>` + `labelOverride` | 同上 |
| Codex app-server 模型目录 | `services/provider/codex_client_catalog.rs`（含代次 `codex-catalog-history.json`、重启检测） | `ccs-<key>/<model>` | 同上 + 用户确认重启 |
| Grok `[model."<名>"]` 表 | `live/project/grok.rs` + `Written.tables` | 表名=模型名 | 直连切换（Grok 不支持 Stack） |

**结论**：发布机制成熟且有兼容性约束（Codex 目录代次、Desktop 选择器黑名单、Claude 的 `claude` 字样）。
替换只需把「数据源 = 该 app 的 stack」换成「数据源 = 网关目录 + 本 app 的 profile」，id 规则保留。

---

## 3. 现状 C：14 个 app 的入口矩阵

列含义：客户端配置文件 / 指向字段 / 协议旋钮 / 写入方式 / 今天有无代理入口。
「累加」= 所有供应商同时存在（无当前供应商概念，`services/provider/mod.rs:5551-5557`）。

| # | app | 客户端配置 | 指向字段 | 协议旋钮 | 写入 | 代理入口 |
|---|---|---|---|---|---|---|
| 1 | claude | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL` | 固定 Anthropic Messages | 切换 | ✅ 裸 origin |
| 2 | claude-desktop | `~/Library/Application Support/Claude-3p/configLibrary/<profile>.json` | `inferenceGatewayBaseUrl` + token | 固定 Anthropic Messages | 切换 | ✅ `/claude-desktop` |
| 3 | codex | `~/.codex/config.toml` + `auth.json` | `[model_providers.custom].base_url` | `wire_api="responses"` | 切换 | ✅ `proxy_origin/v1` |
| 4 | gemini | `~/.gemini/settings.json` + `.env` | `GOOGLE_GEMINI_BASE_URL` | 固定 Gemini | 切换 | ✅ 裸 origin `/v1beta` |
| 5 | grokbuild | `~/.grok/config.toml` | 模型表 `base_url`（`grok_config.rs:16`） | 固定 OpenAI Responses | 切换 | ✅ `/grokbuild/v1` |
| 6 | opencode | `~/.config/opencode/opencode.json(c)` | `options.baseURL` / `providers[].baseURL` | `npm`/`package`（V1/V2），带 `api` | 累加 | ❌ |
| 7 | openclaw | `~/.openclaw/openclaw.json` | `baseUrl` | `api`：`anthropic-messages` / `openai-completions` | 累加 | ❌ |
| 8 | hermes | `~/.hermes`（`hermes_config.rs:82`） | `base_url` | `api` | 累加 | ❌ |
| 9 | pi | `<pi agent>/models.json` + `settings.json` | `providers[].baseUrl` | `api`：`openai-completions` / `anthropic-messages`（`pi.rs:594-600`） | 累加 | ❌ |
| 10 | kimi | `~/.kimi-code/config.toml` | `provider.base_url` | `type=kimi` + `protocol`（官方目录管理，`kimi_config.rs:705-740`） | 累加（特殊） | ❌ |
| 11 | mcode | `~/.minimax/config.yaml` | `options.baseURL` | `api`：`anthropic-messages` / `openai-completions` / `openai-responses`（`mcode_config.rs:125-137`） | 累加 | ❌ |
| 12 | dsh | `~/.dsh`（`cordis.patch.yml` / profiles） | `options.baseURL` | `api`：如 `openai-responses`（`dsh_config.rs:1563`） | 累加 | ❌ |
| 13 | omp | omp agent 目录 `models.yml` | `baseUrl` | `api`（枚举校验，`omp_config.rs:346-357`） | 累加 | ❌ |
| 14 | agy | `~/.gemini/antigravity-cli/settings.json` | `env.GOOGLE_GEMINI_BASE_URL`（`agy_config.rs:113`） | 固定 Gemini | 累加? | ❌ |

### 3.1 这张表的三个结论

1. **所有 14 个 app 都有 base URL 指向字段**，也就是说「指向网关」在配置层面全都可行；
   缺的只是代理侧对它们协议面的服务与 app 归属。
2. 6–13 号（除 5 之外）的协议是**每个供应商条目自己的字段**（`api` / `npm`），不是全局固定的——
   这比 claude/codex 更适合「网关给什么就吃什么」。
3. 今天代理只服务 4 个协议面，且 handler 硬编码 AppType：
   `/v1/messages`→Claude（`handlers.rs:250`）、`/claude-desktop/*`→ClaudeDesktop（`:261`）、
   `/v1/chat/completions`→Codex（`:1003`）、`/v1/responses`→Codex、`/grokbuild/*`→GrokBuild、`/v1beta/*`→Gemini。
   **模式清零后仍需要 app 归属**（同一个协议面被多个 app 使用），归属方式要从「handler 写死」
   改成「入口 token / 路径命名空间」，这是 P2 的核心改动。

### 3.2 app 归属的现成先例

Desktop 已经用 token 做归属，不需要发明：`handlers.rs:472-501` 用
`claude_desktop_config::get_or_create_gateway_token(db)` 校验 `Authorization`，
token 就是 `ccs-<32 位>`（写进 profile 的 `inferenceGatewayApiKey`）。
P2 把它推广成「每个入口一个 token → app/profile」，其余 app 的入口 token 也照这个签发。

---

## 4. 现状 D：不可路由与不可达的例外

| 例外 | 证据 | 处置建议 |
|---|---|---|
| Claude Desktop 官方账号 | `claude_desktop_config.rs:1213-1221` 明确拒绝路由到官方（`official_not_routable`） | 变成网关里的托管供应商（OAuth 刷新走现有凭据层）；P3 验证 |
| Kimi OAuth 账号 | `kimi_config.rs` 的 provider 由官方目录管理，`protocol`/`capabilities` 等字段归官方 | 只读引用，不接管字段；网关侧按 `type=kimi` 转发 |
| 无入口 app（3.1 第 6–14 号里的 9 个） | 无代理入口，只有配置写入器 | P2 起逐个补入口；本 P0 不承诺全部一次做完，先做 opencode（用户已知的最干净目标） |
| Codex app-server 模型目录缓存 | `codex_client_catalog.rs` 只在启动时读一次 | 入口迁移必须复用它现有的代次 + 重启确认，不能绕过 |

---

## 5. 逐条处置（保留 / 上提 / 删除 / 迁移）

| 现有物 | 处置 |
|---|---|
| `Mode` / `ModeState` / `proxy_route` | **删除**（网关永远按模型路由；`attached` 语义并入入口写入器） |
| `StackState.members` | **上提**：网关供应商池的成员 |
| `StackState.keys` | **上提**：网关模型目录的 id 分配（仍永久归属） |
| `StackState.enabled` | **删除**（没有聚合模式） |
| `mode/stack.rs` 的 id 生成与 `resolve` | **保留**（客户端约束决定的规则不变），数据源换成网关目录 |
| 四类模型发布写入器 | **保留**，输入换成「网关目录 + 本 app profile」 |
| `live-state.json` | **迁移**：旧 `stack` 段一次性转成网关目录 + profile；带 schema 版本与回滚 |
| `proxy_config` 表 | **保留**：改成网关全局监听配置 |
| 故障转移 / 熔断 / 统计 | **保留**：作用对象改成解析出来的上游 |
| 三页签 + per-app 供应商卡片 + 聚合徽标 | **删除**，换成 profile 编辑器 |
| `is_additive_mode` / `supports_local_proxy` / `has_route_mode` | **重写**为入口能力判定 |

---

## 6. 风险与验证

| 风险 | 验证方式 |
|---|---|
| 旧 `stack` 数据迁移丢 key 归属 | 迁移前后对 `keys` 做全量等价比对；真实库副本先跑 |
| 客户端文件被重写导致用户丢注释 | 沿用 `JsoncDocument` + 原子写；golden 对比（迁移前后逐字节等价，除预期字段） |
| Codex 目录代次错乱 | 复用 `codex_client_catalog.rs` 的代次与确认流程；单测覆盖「迁移后仍在旧代次」 |
| Desktop 选择器 id 黑名单 | 沿用 `claude-fable-ccs-<6 位>` 规则，不改生成器 |
| 代理侧 app 归属丢失 | P2 引入入口命名空间（路径前缀或 token），对 14 app × 4 协议面出矩阵测试 |
| 一次性删模式导致不可回滚 | 每阶段独立提交；P1 迁移脚本带 `--rollback`，真实库副本验证 |

---

## 7. 未核实项（写代码前必须补）

1. `hermes` / `pi` / `agy` / `omp` 的**累加语义细节**（谁写 `defaults`、谁写成员表）——只看了字段，没读全写入路径
2. `kimi` 的 OAuth 托管字段在网关侧如何刷新（凭据层是否已覆盖 `type=kimi`）
3. 14 app × 4 协议面的**真实客户端协议**（尤其 omp/dsh/agy 是否只支持单一协议）
4. `proxy_config` 表与 `has_route_mode` 在「网关全局开关」下的最小改动面

---

## 8. 对 P1–P4 的输入

- P1（网关模型目录）：用 §2 的四类写入器做消费端；用 §5 的 keys 做 id 分配；迁移 §1.1 的 `stack` 段
- P2（profile 编辑器）：删 §1.4 的 UI 面；用 §3.1 第 3 条的入口命名空间解决 app 归属
- P3（采用/解除）：复用 §1.3 的锁、`Contract`、漂移检测；处理 §4 的两个例外
- P4（additive app）：用 §3 表里 6–14 号各自的 `api`/`npm` 字段直接指向网关

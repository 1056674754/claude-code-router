# CC Switch 信息架构倒置设计：以「供应商」为一级公民

> 2026-11-04 · 基于本地源码与真实库（41 provider / 23 上游 / 30 端点 / 40 凭据）实测

---

## 0. 先回答那个问题

**「你对于 provider 的定义是否完成了转换？」——没有。**

只完成了数据层，没完成语义层。按层摊开：

| 层 | 现状 | 完成度 |
|---|---|---|
| 存储模型 | `upstreams` / `upstream_endpoints` / `upstream_credentials` / `provider_bindings` 四表 | ✅ 完成 |
| 运行时路由 | 熔断键升到网关级、`base_url` 改读端点表 | ✅ 完成 |
| 写入路径 | 仍按 app 写 `providers` 行，再**派生**出绑定 | ⚠️ 派生，不是真源 |
| 配置渲染 | 每个 app 一张**手工表单**，key 人手填 | ❌ 未动 |
| 导航 / 信息架构 | app 在最外层，点进去才是它自己的供应商列表 | ❌ 未动 |
| 用户心智 | 「我的 Claude Code 有几个供应商」 | ❌ 未动 |

后端眼里 provider 已经是 `(host, protocol, credential)` 三元组；
用户眼里它还是「某个 app 下面的一条配置」。

**只要表单还长在每个 app 里，定义就没转换。** 界面是定义的外化——界面不改，定义就没变。

---

## 1. 概念重构：拆成四个东西

旧世界里「一个 provider」= 服务商 + 地址 + 密钥 + 属于哪个 app，四合一，所以每接一个 app 就复制一遍。

拆开：

| 概念 | 定义 | 真源表 | 归属 |
|---|---|---|---|
| **供应商** Upstream | 一个上游域名，= 一家服务商 | `upstreams` | 网关（WAN） |
| **端点** Endpoint | 协议 + `base_url` | `upstream_endpoints` | 网关 |
| **凭据** Credential | 一把密钥 + 限额 + 冷却 | `upstream_credentials` | 网关 |
| **接入** Binding | 某 app 选用某端点（+ 启用 / 排在故障转移第几位） | `provider_bindings` | app（VLAN） |

一句话概括新规则：

> **配置归网关，选择归 app。**

- 网关负责：这家里程碑用哪个域名、走什么协议、有几把 key、哪把还有额度。
- app 负责：我要用哪几家、优先顺序是什么。

旧的 `providers` 行是上面四个概念的**压扁版**——这就是为什么 41 行只对应 23 个真上游。

---

## 2. 为什么必须倒置（用你自己的数据说话）

真实库现状：

```
providers            41 行
provider_bindings    41 条（补齐后）
upstreams            23 个
upstream_endpoints   30 个
upstream_credentials 40 条
跨 app 共享的熔断键   6 组，覆盖 12 条绑定
```

- **41 → 23**：43% 是重复录入。
- `ctaigw` 的同一把 key，在 `claude` 和 `claude-desktop` 各填了一遍，界面两处维护。
- `kimi` 在两个 app 下各有一份，改名时要改两处（这次迁移就撞上了）。
- 上游 `v4.0.25` 新增 `dsh` app，立刻多一条要手工补的配置——增量回填只能补**绑定**，补不了**人的动作**。

倒置之后：

- 新增一家服务商 → 建 1 次。
- 新增一个 app → 从现有池子里挑，填 0 次 key。
- 换 key → 改 1 处，所有 app 跟着变。
- 一家挂了 → 熔断状态天然跨 app 一致（这点运行时已经做到了，界面还没有可视化）。

---

## 3. 缺的那一层：配置渲染器（Renderer）

这是整个设计的枢纽，也是最容易被忽略的。

真正的转换不是"把 provider 列表挪个位置"，而是：

```
        供应商（host + base_url + 协议 + key）
                       │
                       │  渲染器 R(app)
                       ▼
        该 app 原生配置文件
        ~/.claude/settings.json  /  ~/.codex/config.toml  /  opencode.json ...
```

现在这个渲染器是**人肉**的：每个 app 给你一张表单，让你把 base_url 和 key 自己填进去。所谓"逐个 app 配 provider"，本质是把渲染器的活外包给了用户。

倒置后必须变成程序：

| App | 目标配置形状 | 当前状态 | 需要 |
|---|---|---|---|
| `claude` / `claude-desktop` | `settings.json` 的 `env.{ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN}` | 有表单，无渲染器 | 实现 |
| `codex` | `config.toml` 的 `model_providers.*` | 有表单，无渲染器 | 实现 |
| `gemini` | `settings.json` env | 有表单，无渲染器 | 实现 |
| `opencode` | `opencode.json` 的 `provider.*.options` | 有表单，无渲染器 | 实现 |
| `hermes` / `openclaw` | 混合 | 有表单 | 实现 |
| `kimi` / `omp` / `dsh` / `pi` / `mcode` / `agy` | 托管账号 / 特殊 | **`get_adapter` 返回 `None`** | 先补适配器，否则只能生成配置、不能走代理 |

> 诚实提醒：后 6 个 app 连代理适配器都没有，光倒置 UI 它们也用不上网关路由。这一条要在设计里说清楚，否则做完了会被问"为什么我的 Kimi 还是直连"。

**渲染器一旦存在，表单就可以退场**：新增 app 接入 = 选一个供应商 + 点"生成配置"。

---

## 4. 新信息架构

### 4.1 导航模型改写

现在（`src/lib/navigation.ts`）：

```ts
type View = AppPage | GlobalPage | "settings";   // app 在最外层
// 侧栏：9 个 app 行 + 7 个全局页 + 设置
```

改成：

```ts
type View =
  | "workbench"      // 工作台：总览
  | "suppliers"      // ★ 一级主入口
  | "bindings"       // 接入端：各 app 用了谁
  | "routing"        // 路由策略
  | "logs"           // 监控日志
  | "advanced"       // 密钥 / 模型 / Fusion / 扩展
  | "settings";
```

侧栏（对应你截图右侧那套，顺序也顺）：

```
工作台
├ 概览
供应商          ← 原来的核心，从"每个 app 一份"变成"全局一份"
接入端          ← 原"Agent 配置档案"
路由策略        ← 原"全局路由"
监控
├ 日志
高级
├ 模型 / API 密钥 / Fusion / 扩展
```

app 不再是导航的一级，而是**接入端页面里的行**。

### 4.2 三个核心页面

**① 供应商列表（主入口）**

```
┌───────────────────────────────────────────────┐
│ 供应商                        [+ 新增供应商]  │
│ 搜索…                                          │
├───────────────────────────────────────────────┤
│ ▸ CTYun       ai.ctaigw.cn                     │
│    端点 2 · 凭据 3 · 被 3 个 app 使用   ● 健康 │
│ ▸ Kimi        api.kimi.com                     │
│    端点 2 · 凭据 4 · 被 2 个 app 使用   ◐ 半开 │
│ ▸ 百炼        dashscope.aliyuncs.com           │
│    端点 3 · 凭据 2 · 被 1 个 app 使用   ● 健康 │
└───────────────────────────────────────────────┘
```

一行 = 一家服务商。**这才叫"一次配齐"。**

**② 供应商详情**

```
CTYun
├ 端点
│  ├ anthropic      https://ai.ctaigw.cn/v1
│  │   被：claude, claude-desktop
│  └ openai_chat    https://ai.ctaigw.cn/v1
│      被：opencode:ctyun-aigw, omp:ctaigw, dsh:ctyun
├ 凭据
│  ├ sk-…a1b2   剩余额度 62%   冷却中（3 分钟）  [测试]
│  └ sk-…c3d4   剩余额度 —     正常               [测试]
└ 健康
   Host 级：正常   凭证级：1 把冷却中
```

把已经算好的两层熔断（host / credential）第一次**显示出来**。之前它只在日志里。

**③ 接入端（原 app 页）**

```
Claude Code                    [接入供应商 +]
├ CTYun         优先 1   ● 健康     [调序] [解绑]
├ Kimi          优先 2   ◐ 半开     [调序] [解绑]
└ Zhipu         已停用              [启用] [解绑]
```

这里**没有 base_url、没有 key**——只有选择和顺序。用户想改地址会点进供应商详情，改一处，三个 app 一起变。

### 4.3 关键流程对照

| 动作 | 现在 | 倒置后 |
|---|---|---|
| 接一家新服务商 | 每个 app 各填一遍 | 建 1 次，全部 app 可见 |
| 给 app 加供应商 | 填表（含 key） | 从池里勾选 |
| 换 key | 每个 app 各改一遍 | 改 1 处 |
| 看服务商是否健康 | 翻日志 | 列表页 + 详情页 |
| 删除供应商 | 各 app 各自删 | 一处删除，提示「3 个 app 在用」 |

---

## 5. 改造清单（落到文件）

### 前端

| 文件 | 改动 |
|---|---|
| `src/lib/navigation.ts` | `View` 模型重写；`AppPage` 退化为接入端内部子视图 |
| `src/components/shell/Sidebar.tsx` | 条目重组：app 行移出侧栏 |
| `src/App.tsx`（1927 行） | 拆出 `providers` 页与 `activeApp` 状态，避免继续膨胀 |
| 新增 `components/suppliers/` | `SupplierList` / `SupplierDetail` / `EndpointEditor` / `CredentialEditor` / `HealthBadge` |
| `components/providers/*` | 降级为 `components/bindings/`：`BindingPicker`（从池里选）、`BindingOrderList` |
| `components/providers/forms/*` | **删除**，其职责由后端渲染器接管 |

### 后端

| 项 | 改动 |
|---|---|
| 命令层 | 新增 supplier CRUD（现在只有 per-app provider CRUD） |
| 渲染器 | 新增 `renderer::<app>(binding) -> 配置文件内容`，替代 `ProviderForm` 的手工字段 |
| 密钥真源 | `upstream_credentials.secret` 从 NULL 转为真源（见 §7.1） |
| `providers` 表 | 阶段 3 后可退化为"接入记录"，或直接删除（见 §6） |

---

## 6. 迁移与回滚（不能一次性推倒）

三阶段，每阶段可独立发布、独立回滚：

| 阶段 | 界面 | 数据 | 回滚 |
|---|---|---|---|
| **P-A 只读聚合**（1–2 天） | 新增只读「供应商」页，展示 23 个上游 / 端点 / 凭据 / 被谁用 | 不动 | 删页面即可 |
| **P-B 可编辑 + 接入端**（4–6 天） | 供应商可增删改；app 页变成"勾选 + 排序"，旧表单折叠进「高级」 | `providers` 仍是写入真源，绑定派生 | 开关切回旧布局 |
| **P-C 切换真源**（3–5 天） | 移除 app 内表单 | 供应商为真源，`providers` 变为接入记录 | 保留只读快照 |

为什么必须从只读开始：先让人看到「原来我只配了 23 家，不是 41 家」，认知先转变，再谈操作迁移。直接换操作方式会引发"我的配置去哪了"的恐慌。

**数据安全底线**（沿用已完成迁移的约束）：

- 任何阶段都**不删 provider 行**，只加新读法。
- 每个阶段上线前跑完整库副本 dry-run，比对四张表快照。
- 备份：`~/.cc-switch/cc-switch.db.pre-v25.bak` 已有；P-C 前再打一次。

---

## 7. 两个待定技术点（各给方案）

### 7.1 密钥归属：`upstream_credentials.secret` 怎么变成真源

现在是 NULL，key 还躺在 `providers.settings_config` 里。三条路：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 双写过渡** | 写供应商时同时写 credential 和 settings_config | 老版本可回滚 | 两份数据会漂移，必须有校验器 |
| **B. 单向真源**（推荐） | credential 为唯一真源；`settings_config` 只保留 base_url 等非敏感字段，key 读取时从 credential 注入 | 无漂移 | 老版本降级后拿不到 key |
| **C. 加密快照** | credential 真源 + settings_config 保留加密副本 | 可回滚 | 复杂度最高，要引入密钥管理 |

**建议 B**，理由是：这个仓库已经是 `diy` 分支、版本自管，回滚到官方原版的概率很低；而双写漂移是必然发生的慢性病。若担心回滚，用 §6 的 P-C 前备份兜底，而不是靠双写。

配套：迁移时把现有 40 条 credential 的 `secret` 从对应 `settings_config` 里解出来填入，解不出（托管 OAuth）的保持 NULL，并标记 `managed`。

### 7.2 选路去重：同一 app 内两个 provider 指向同一网关

现状：`select_providers_with_current` 把 app 下的 provider 逐条当候选，若两条指向同一端点，会白撞两次。

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 选路按 endpoint 去重** | 候选列表按 `endpoint_id` 折叠，同端点只留首选一条 | 简单、5–10 行，立刻消除白撞 |
| B. 按 upstream 折叠 | 同上游不同端点也折叠 | 过度折叠，会丢掉协议回退能力 |
| C. 加权重排序 | 按健康分/额度排序候选 | 属于 P3，先不做 |

**建议 A**，且放在渲染器之前做——它是纯内部逻辑，零 UI 依赖，可独立验收。

---

## 8. 分期与验收

| 期 | 内容 | 验收标准 |
|---|---|---|
| **P-A** | 只读供应商页 | 展示 23 上游 / 30 端点 / 40 凭据 / 每个被哪些 app 使用；数字与库一致 |
| **P-2.5** | 选路去重（§7.2 A） | 同端点两条候选只尝试一次；单测覆盖 |
| **P-B** | 供应商可编辑 + 接入端选择器 | 改一处 base_url，两个 app 同时生效；旧表单折叠可回退 |
| **P-C** | 渲染器 + 密钥真源切换（§7.1 B） | 新增 app 接入零填 key；删旧表单后全量测试通过 |
| **P-D** | 健康可视化 + 路由策略页 | 熔断状态在界面可见，跨 app 一致 |

---

## 9. 风险清单

1. **`App.tsx` 1927 行**：导航倒置必然要拆，不拆会在 P-B 阶段失控。
2. **6 个 app 没有适配器**（kimi/omp/dsh/pi/mcode/agy）：倒置后它们只能"生成配置"，不能"走代理"——必须在界面上明确标注，否则等于承诺了做不到的事。
3. **`providers` 表语义漂移**：P-C 之后它既是接入记录、又留着旧配置字段，容易被两边同时写。需要明确"谁来写"。
4. **模型映射归属未定**：现在的模型映射跟着 provider 走。倒置后应挂在上游（一份）还是接入（每个 app 一份）？**这是下一个必须拍板的点**，会在 P-B 暴露。

---

## 10. 一页总结

```
旧：  App  →  Provider（地址+key+顺序，四合一）
      每个 app 复制一遍

新：  供应商（地址 + 协议 + key）        ← 配一次
        ↑ 渲染器
      接入（某 app 选谁 + 顺序）         ← 每个 app 只做选择

导航： 应用在最外层  →  供应商在最外层，应用变成"接入端"里的一行
```

---

## 11. 决策与执行记录（2026-11-04）

| # | 决策 | 状态 |
|---|---|---|
| 1 | 密钥：**B 单向真源** | ⏳ 写入侧完成，读取侧待切换 |
| 2 | 选路去重：**A 折叠** | ✅ 完成 |
| 3 | 模型映射：**挂接入**（per-app） | ⏳ 待做（需 schema v26） |

### 11.1 去重落地时的一处修正

原方案写的是「按 endpoint 折叠」，落地时改为**按「上游 + 协议 + 密钥」折叠**。

原因：同一端点换一把 key 仍然值得重试——那正是凭证级故障转移存在的意义
（实测 `api.kimi.com` 有 2 把 key、`www.omnai.xyz` 有 3 把）。按 endpoint 折叠会把
「A 的 key 配额耗尽 → 换 B 的 key」这条路径直接掐死。

另外去重身份取自绑定，**与熔断键模式无关**：即使还在 shadow 模式，
两条完全相同的路由也没有重试价值。

### 11.2 密钥回填的真实覆盖率：27 / 41

对账后 41 条凭证里 27 条拿到明文密钥。剩下 14 条不是漏了，是**配置里本来就没有**：

| 类别 | 例子 | 说明 |
|---|---|---|
| 托管 OAuth | `codex-official`、`gemini-official`、`claude-official`、`kimi:managed` | 凭的是账号令牌，不是可搬的字符串 |
| 本地推理 | `hermes:rtx6000pro-lmstudio`、`*:qwen38-local` | 无鉴权 |
| **环境变量引用** | `hermes:天翼云 Ctyun (SUISQP)` | 配置里存的是 `key_env: "CTYUN_API_KEY"`，密钥根本不在库里 |

第三条是设计缺口：`upstream_credentials` 只表达了「明文密钥」，表达不了
「引用某个环境变量」。**P4（凭证池/额度/冷却）之前必须先补 `secret_kind`**
（literal / env_ref / managed_oauth / none），否则这 14 条在凭证池里是黑洞。

### 11.3 密钥「缺了要补」也算漂移

最初只把「端点对不上」当漂移，结果老库升级后一条密钥都补不上——绑定全对，
就没理由重搬。已改为：**能解出密钥但库里没有**同样触发一次搬运。

`COALESCE(excluded.secret, secret)` 保证重跑永远不抹掉已存值
（托管账号以后手工写入的令牌不会被对账清空）。

### 11.4 决策 3 的硬约束

模型映射挂接入需要：

1. `provider_bindings` 加 `model_map` 列 → **SCHEMA_VERSION 25 → 26**；
2. 派生阶段把现有 `env` 里的 `ANTHROPIC_DEFAULT_*_MODEL` 搬进 `model_map`
   （保证行为不变）；
3. `model_mapper::apply_model_mapping` 的取值来源从 `Provider` 改为「绑定的
   `model_map` 优先，缺失回落 provider」——这需要把绑定一路传到 `forward()`。

第 3 步是热路径改动，必须先有 1、2 的数据打底才能切。

---

## 12. 执行记录 · 第二轮（2026-11-04，v26）

### 12.1 已落地

| 项 | 内容 | 验证 |
|---|---|---|
| **SCHEMA_VERSION 25 → 26** | 加两列，纯加列不动既有读写 | 迁移测试 + 真实库副本 |
| `provider_bindings.model_map` | 模型映射归**接入**（决策 3） | 真实库 7 条非空 |
| `upstream_credentials.secret_kind` | 凭证形态，凭证池的前提 | 真实库口径见下 |
| `commands::get_suppliers_overview` | 供应商总览（只读聚合） | 2 个单测 |

### 12.2 真实库副本（v25 → v26 自动迁移 + 对账）

```
secret_kind: literal=27, managed=6, env_ref=5, none=3
model_map 非空绑定: 7
providers/bindings: (41, 40) -> (41, 41)
dsh:ctyun -> up-ai.ctaigw.cn [openai_chat]
```

`env_ref=5` 比预想的多——不止 hermes，说明**「配置里只存环境变量名」是普遍形态**，
凭证池如果不区分形态，这 5 条会被当成「没密钥」而永远无法参与额度调度。

### 12.3 总览命令的设计取舍

`get_suppliers_overview` 在**读之前先对账**（`reconcile_provider_bindings`）。
原因：绑定是路由读路径派生出来的，从未走过代理的 app 在库里没有绑定，
直接查会让总览漏掉它们——第一次打开页面就会显得"少了几家"。

### 12.4 下一步（尚未开始）

1. **供应商编辑**：改 base_url / 名称 / 凭据 → 写 `upstreams` / `upstream_endpoints`，
   需要新增命令层（当前只有 per-app provider CRUD）。
2. **模型映射读路径切换**：`apply_model_mapping` 改为「绑定优先、provider 回落」，
   把绑定传进 `forward()`（热路径，需谨慎）。
3. **前端「供应商」页**：列表 + 详情（端点 / 凭据形态 / 被哪些 app 使用），
   导航从 app 优先改为供应商优先。

---

## 13. 执行记录 · 第三轮（2026-11-04）

### 13.1 路由级写操作：改一处，所有 agent 跟着变

`update_supplier_base_url(endpointId, baseUrl)`：

1. 找到该端点上的**所有**接入（跨 app）；
2. 逐个改写 `providers.settings_config` 里「当前生效的那个 base_url 字段」；
3. 立即对账 → 绑定指向新端点，旧端点被清理。

关键约束：**改地址与读地址必须对称**。`p1_set_base_url` 的字段顺序与
`p1_extract_base_url` 逐一对齐（env.* / options.baseURL / 顶层 baseUrl / codex TOML /
provider.baseUrl / hermes api），并有测试锁死「改完必须能读回新值」——
两边一旦漂移就会出现「改了地址，下次派生又读回旧值」的鬼故事。

改不了的行（URL 由适配器按 OAuth 身份算出）**如实回报 skipped，不假装成功**。

### 13.2 顺带补上的真实缺口：hermes 的地址提取不到

hermes 把地址直接放在顶层 `api`（**字符串**，不是对象），提取器原先不认，
导致 5 家 hermes 供应商全部退化成 `up-provider-*` 空 host。

补上之后真实库副本：

```
upstreams  23 → 21
endpoints  30 → 28
hermes:天翼云 Ctyun (SUISQP) -> up-ai.ctaigw.cn [openai_chat]
hermes:Qwen3.8 Flash Next / rtx6000pro-lmstudio -> up-10.10.49.36
```

也就是说 hermes 侧那家 CTYun 现在和 claude / opencode / dsh / omp **共享同一个网关与熔断器**。

### 13.3 模型映射读路径已切到绑定

`forward()` 不再直接 `ModelMapping::from_provider`，而是「绑定优先、provider 回落」。
现阶段绑定里的值是**从 provider 派生**的，所以行为不变——这是有意的分步：
读路径先切，等界面能编辑模型映射时再按 base_url 那套把写源翻过来。

> 踩到的坑：手工改 `provider_bindings.model_map` 会被下一次对账按 provider 覆盖回去。
> 这不是 bug，是「写源还在 provider」的必然结果，测试里已写明。

### 13.4 前端「供应商」页

| 文件 | 内容 |
|---|---|
| `src/lib/api/suppliers.ts` | 类型 + `overview()` / `updateBaseUrl()` |
| `src/components/suppliers/SupplierPage.tsx` | 供应商卡片 → 展开端点 → 就地编辑地址 |
| `src/lib/navigation.ts` / `Sidebar.tsx` / `App.tsx` | 全局页新增「供应商」入口 |
| `src/i18n/locales/{zh,en,ja,zh-TW}.json` | 文案 |

验证：`pnpm typecheck` 通过；`pnpm test:unit` **275 文件 / 3541 用例全过**
（新增 6 个组件用例）。未跑真机（未构建 Tauri），视觉未肉眼验证。

### 13.5 下一步

1. **导航真正倒置**：现在「供应商」只是全局页里的一个入口，侧栏仍是 app 在前。
2. **接入端页面**：每个 app 显示「用了哪些供应商 + 排序」，而不是编辑 base_url/密钥。
3. **凭证编辑**：改密钥 → 写 `upstream_credentials.secret` 并向下传播。

---

## 14. 执行记录 · 第四轮（2026-11-04）

### 14.1 「采用」：填 0 次 key

`adopt_supplier(appType, endpointId)` —— 从网关把地址和密钥取出来，
在 agent 侧生成一条配置。用户在新 agent 上接入一家已有供应商时，**一个字符都不用填**。

这是整个倒置的兑现点：以前每接一个 agent 就要重填一遍 base_url + key，
现在 supplier 是网关的，agent 侧只是"选用"。

### 14.2 三道明确的拒绝

宁可拒绝，也不给半成品配置（渲染错了比不渲染更糟）：

| 情况 | 行为 |
|---|---|
| app 没有忠实的渲染器（opencode 要 per-supplier models、codex 要 TOML+auth） | 拒绝，提示去应用页手配 |
| 协议不匹配（openai_chat 端点接进只吃 anthropic 的 claude） | 拒绝，说明协议 |
| 密钥不在库里（`env_ref` 只存变量名 / `managed` 托管登录） | 拒绝，说明原因 |

`secret_kind` 在这里第一次派上实战用途——没有它，这三种情况会被混成一句"没有密钥"。

### 14.3 为什么只有 claude / claude-desktop

因为它们的配置形状是 `{"env": {"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"}}`，
可以**忠实地**从网关渲染出来。opencode 的配置里带着该供应商专属的 `models` 列表，
codex 是 TOML + auth.json，凭空生成只能是错的。要支持它们，得先让网关也管模型清单
（这是后面「模型映射」那块的自然延伸）。

---

## 15. 执行记录 · 第五轮（2026-11-04）

### 15.1 第三个路由级操作：换密钥

`update_supplier_secret(endpointId, secret)` —— 与改地址共用同一套骨架
（找到该端点上的所有接入 → 改配置 → 提交 → 对账）。

两个要点：

1. **只改 `settings_config`，不改 `upstream_credentials`**。凭据由随后的对账
   从配置重新派生，指纹跟着变——新 key 天然拿到一套干净的熔断状态，
   不会沿用旧 key 的失败计数。
2. **`env_ref` 的接入换不了**：配置里只有环境变量名，没有明文。
   如实报 `skipped`，不假装成功。

### 15.2 真实数据：这项改动到底影响多少

迁移后的真实库副本里：

| 指标 | 数值 |
|---|---|
| 被多个 app 共享的端点 | **8 个** |
| 这些端点覆盖的接入 | **21 条** |

例如：

```
CTYun   https://ai.ctaigw.cn/v1        [openai_chat]  dsh, hermes, omp, opencode
Kimi    https://api.kimi.com/coding    [anthropic]    claude, claude-desktop
Zhipu   https://open.bigmodel.cn/api/anthropic  [anthropic]  claude, claude-desktop
```

也就是说 Kimi 轮换一次 key，claude 和 claude-desktop 两处一起换——
以前要改两遍，且很容易漏掉一处，然后得到 401。

### 15.3 路由级操作三件套（已完成）

| 操作 | 命令 | 影响面 |
|---|---|---|
| 改地址 | `update_supplier_base_url` | 该端点所有接入 |
| 换密钥 | `update_supplier_secret` | 该端点所有接入（env_ref 除外） |
| 接新 agent | `adopt_supplier` | 从网关生成配置，填 0 次 key |

模型映射的读路径已切到绑定，但**编辑**还没开（写源仍是 provider）。

---

## 16. 执行记录 · 第六轮（2026-11-04）

### 16.1 模型映射真正挂到「接入」

决策 3 的兑现。到此为止三个路由级操作才闭环：

| 操作 | 归谁 | 写哪里 | 影响面 |
|---|---|---|---|
| 地址 | **网关** | 该端点所有 provider 配置 | 全 app |
| 密钥 | **网关** | 该端点所有 provider 配置 | 全 app |
| 模型映射 | **接入** | 该 app 自己的 provider 配置 | 只有这一个 app |

最后一行是关键区别：同一个网关，claude 里映射成 `kimi-k2`，claude-desktop 里
可以映射成别的——因为它们各自有一条 provider 记录。这在旧模型里是"每家供应商一套
模型名"，在 CCR 里也是按 provider 配的，现在按「接入」配，语义更准。

`p1_set_model_map` 与 `p1_model_map` **共用同一份槽位表**（haiku/sonnet/opus/fable/
subagent/default → 六个 env 键）。写的时候槽位为空就**删除**对应 env 键，而不是留空串——
否则 `ANTHROPIC_DEFAULT_SONNET_MODEL=""` 会被上游当成模型名传下去。

### 16.2 闭环测试

`editing_binding_model_map_changes_what_router_reads`：
改接入的映射 → 断言 provider 配置被改写（写源翻转）→ 新路由器实例读出来的就是新值。
这条测试保住了"改了以后真的生效"，而不是只改了一个没人读的字段。

### 16.3 总览多返回一份接入明细

`SupplierEndpoint.bindings: [{appType, providerId, modelMap}]`。
前端编辑器要靠它预填，否则用户每次打开都得重敲一遍当前映射。

> 顺带记一笔：`consumers`（字符串 `"app:providerId"`）保留不动，
> 新字段是**加法**，老调用方不受影响。

---

## 17. 执行记录 · 第七轮（2026-11-04）

### 17.1 界面侧补齐两个编辑器

| 位置 | 能力 |
|---|---|
| 供应商页 · 端点行 | 「换密钥」（密码框 + 显隐切换，**永不回显已存密钥**） |
| 接入端页 · 在用的供应商 | 「模型映射」六槽位编辑器（仅 claude 系），预填当前值 |

提交时只带非空槽位——后端对「缺省」和「空串」都是删 env 键，语义一致。

### 17.2 验证

```
cargo test --lib        4439 passed / 2 failed（均为既有失败）
pnpm typecheck          ok
pnpm test:unit          279 files / 3577 tests passed
pnpm build:renderer     ok（仅既有 chunk 体积警告）
```

### 17.3 尚未闭合的坑（按重要性）

1. **从未真机验证过界面**。所有页面只有 jsdom 测试。Tauri 构建慢且会与正在运行的
   已安装实例争同一个 `~/.cc-switch/cc-switch.db`，所以一直没敢跑。
   这一条建议单独排一次：停下来、构建、重启应用，肉眼过一遍。
2. **旧的应用页仍是"配置表单"**。新界面是"选用/网关"，但每个 app 页里那套
   provider 表单没删——用户仍可能从旧路进去配。真正的倒置收尾要把表单降级为
   "只读 + 跳转到供应商页"。
3. **非 claude 系的模型映射不支持**（opencode 的 models 列表、codex 的 TOML）。
4. **`env_ref` 的凭据无法在界面里轮换**（库里没有明文），只能改环境变量本身。

---

## 18. 真机验收（2026-11-04，第一次真正跑起来）

构建 `pnpm tauri build --bundles app`（Rust 侧首次 2m45s，之后增量约 1m40s），
装到 `/Applications`，用 AppleScript 驱动点击、`screencapture` 截图逐页核对。

### 18.1 结论：页面结构与数据都对

- 侧栏顺序正确：【网关】供应商 / 接入端 → 【应用】9 个 app → 全局页 → 设置
- 供应商页：每行「N 个端点 · N 个应用 · N 个凭据」，展开后有凭据形态、
  协议徽标、base_url、被哪些 app 使用，以及三个操作「编辑地址 / 换密钥 / 采用到…」
- 接入端页：每张 app 卡片列出在用的供应商（名称 + 协议 + 地址 + 模型映射摘要），
  底部是「选择供应商端点…」下拉
- 数据吻合：CTYun 3 个端点 / 7 个应用 / 7 个凭据，Kimi 3 / 4 / 6，与库里一致

### 18.2 只有真机才能发现的三个问题（已修）

| 问题 | 现象 | 修法 |
|---|---|---|
| 托管账号污染网关列表 | Claude Official / OpenAI Official / `default` / `Imported 2026-04-27 18:57` 全被当成供应商，真正的网关被挤到下面 | 默认只显示有 host 的；其余折叠进「显示 N 个托管登录账号（没有网关地址）」，实测 7 个 |
| 同一 app 内重复接入 | Claude 里两条 Kimi 看起来像渲染出错 | 加「重复接入 ×2」琥珀色徽标（数据本身确实有两条旧配置指向同一网关） |
| i18n 占位符写错 | 按钮上直接显示 `显示 {count} 个托管登录账号` | 项目是 i18next 的 `{{count}}`，且需要 `_one`/`_other` 复数形态 |

第三条尤其说明问题：**jsdom 测试里 i18n 是 mock 的，所以这类"字面量漏到界面上"的 bug
永远不会被单测抓到**。这就是真机验收不可替代的价值。

### 18.3 启动踩的坑（给下次留个记录）

- 裸二进制与 `.app` 共存时，`tauri-plugin-single-instance` 会让后启动的那个直接退出，
  于是"装好了却没生效"——本次因此误截了两轮旧界面
- `silentStartup=true` + `minimizeToTrayOnClose=true` 时启动不开窗口，
  验证期间临时改成 false，验完已还原
- 窗口位置被 `window-state.json` 记成负坐标（-585），需手动摆回可见区域

### 18.4 线上状态

`/Applications/CC Switch.app` 已替换为新版（旧版备份在 `/tmp/CC Switch.app.bak`），
用户数据库已迁移到 v26（备份 `~/.cc-switch/cc-switch.db.pre-v26.bak`）。

---

## 19. 网关侧新建供应商（2026-11-04，第八轮）

### 19.1 之前缺的那一环

倒置之后，"选用"是通了：接入端能给 app 挑供应商，供应商页能改地址/密钥/模型映射。
但**新建**还是老路子——必须先钻进某个 app 里加一条 provider，再回来「采用」给别的 app。
这仍然是"以 agent 为中心"的残留：**网关侧不能凭空长出一家供应商**。

### 19.2 现在

```
供应商页「新增供应商」
  ├─ 名称 / 地址 / 密钥      ← 网关级，填一次
  └─ ☑ claude  ☑ claude-desktop  ← 勾谁，谁就接上
```

后端 `create_supplier(name, base_url, api_key, apps)`：
- 先全部校验（名称、密钥、http(s) 地址、app 白名单、至少一个），**校验不过一条都不落库**，
  避免"建了一半"的半成品供应商
- 每个 app 落一条 provider，id 是 `sup-{fnv1a(name|url|app)}`——**确定性 id**，
  同一家供应商重复提交只会覆盖，不会堆行（可安全重试）
- 落库后对每个 app 跑对账，再返回完整总览，前端直接替换缓存

服务端渲染的配置和「采用」完全一致：`{"env":{"ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN"}}`。
`codex`/`opencode`/`hermes`/`omp` 等仍然拒绝——它们的配置要按供应商维护模型列表/认证，
凭空生成会得到一份跑不起来的配置，宁可不给这个入口。

### 19.3 测试

- `create_supplier_wires_every_selected_app`：两个 app 都落配置，地址尾部斜杠被规范化，
  总览里是一家供应商 / 一个端点 / 两个使用者
- `create_supplier_is_idempotent`：重复提交只有一条，后提交的密钥生效
- `create_supplier_rejects_without_partial_writes`：混入 codex 时整体拒绝，
  `providers` 表计数为 0；空名字/空密钥/非法地址/空 app 列表逐个拦住

### 19.4 真实库副本验证（比单测更硬的一次）

单测用的是内存库，形状是造出来的。这次把线上库做个一致性快照
（`sqlite3 file:...?mode=ro ".backup copy.db"`，175M），用临时测试跑真链路：

```
建之前：21 家供应商
建之后：22 家供应商
命中：name=Verify Gateway host=verify.example.com apps=2 endpoints=1
  端点 ep-5645f69ab172dd56 [anthropic] base_url=https://verify.example.com/v1
       apps=["claude", "claude-desktop"] creds=2
claude:         {"env":{"ANTHROPIC_BASE_URL":"https://verify.example.com/v1","ANTHROPIC_AUTH_TOKEN":"sk-verify-real"}}
claude-desktop: {"env":{"ANTHROPIC_BASE_URL":"https://verify.example.com/v1","ANTHROPIC_AUTH_TOKEN":"sk-verify-real"}}
重复提交后同名声明的供应商数：1
```

从 21 起跳、地址尾部斜杠被吃掉、两个 app 各落一条能读出地址和密钥的配置、
重复提交不堆行——全部在真数据形状上成立。

这条测试留在代码里（`#[ignore]` + `CCS_VERIFY_DB` 环境变量），
下次要验真实数据时直接：

```
CCS_VERIFY_DB=/path/to/copy.db cargo test --lib manual_create_against_real_db_copy -- --ignored --nocapture
```

### 19.5 真机上没做到的

对话框在真机里渲染正确（截图确认：三个输入框、两个默认勾选的 app、取消/创建按钮）。
但**往 WebView 的输入框里写字**这件事，AppleScript 的 `keystroke`/`click at`
在 Tauri 的 WKWebView 上不可靠：焦点跳转和点击落点都抓不准，
填到第二格就开始串行。所以"点创建 → 看到 toast"这一段没有真机证据，
只有 jsdom 用例。等有更靠谱的 GUI 自动化手段再补。

## 20. 上游协议 vs 下游协议（这一轮最重要的修正）

### 20.1 两段协议

一条请求穿过代理时有两段协议，之前被我混成了一回事：

```
Claude Code ──下游: Anthropic Messages──▶ CCS 代理 :15721 ──上游: OpenAI Chat──▶ /v1/chat/completions
Codex       ──下游: OpenAI Responses  ──▶ CCS 代理 :15721 ──上游: OpenAI Chat──▶ /v1/chat/completions
opencode    ──下游: 自己配的          ──▶ 直连或代理         ──上游: OpenAI Chat──▶ /v1
```

- **下游协议**由客户端决定，是 app 的固有属性（claude→Anthropic Messages，codex→Responses）。
- **上游协议**由 `provider.meta.apiFormat` 决定，是供应商的属性。
- 代理就是两段之间的转换器；两者不同正是路由模式存在的理由。
- **直连模式下没有代理**，下游必须等于上游，否则跑不通。

### 20.2 派生错在哪

`p1_protocol_for(app_type, config)` 是**按 app 类型**推协议的——那是**下游**协议，却被写进了
`upstream_endpoints.protocol`（上游协议的位置）。后果：

- CTYun：claude/claude-desktop 的 provider 其实 `apiFormat = openai_chat`，被标成 `anthropic`
- codex 那条 `apiFormat = openai_responses` 但 CTYun 只有 `/v1/chat/completions`（已修成 `openai_chat`）
- 同一个上游 API，因为使用者不同，被拆成"三个端点"

### 20.3 新规则

**供应商身份 = 规范化服务根 + 上游协议。**

- 服务根 = 去掉 `/chat/completions` `/responses` `/messages` 这类完整接口后缀，
  于是 `.../v1` 与 `.../v1/chat/completions` 归到同一家
- 上游协议：`meta.apiFormat` → `settings_config.api_format/apiFormat` → codex TOML 的
  `wire_api` → 回落到端点自己的协议列
- 界面上一家供应商只有**一个地址**；"这个地址被谁用"放在接入列表里
- 同地址不同上游协议 = 两个 API 面，算两家（例如 Kimi 的 `kimi_managed` 与 `openai_chat`）

真实库副本跑出来的效果（26 家，CTYun 从 3 行并成 1 行挂 7 个 app）见 §19.4 的工具：

```
CTYun   openai_chat  https://ai.ctaigw.cn/v1  apps=[dsh,hermes,omp,opencode,claude,claude-desktop,codex] creds=7
```

### 20.4 数据修正记录

`~/.cc-switch/cc-switch.db`（备份 `cc-switch.db.pre-apiformat.bak`）：

```
codex / universal-codex-2634078d… : meta.apiFormat openai_responses → openai_chat
```

理由：CTYun 只提供 `/v1/chat/completions`，没有 Responses 端点。改后 codex 的
Responses 请求会被转成 chat completions 再发出去。

### 20.5 还没有做的

`p1_protocol_for` 本身仍是"下游协议推导"，`upstream_endpoints.protocol` 里存的历史值
也还是旧语义。供应商总览已经绕过它（优先读 `meta.apiFormat`），但这一列的语义统一
要单独一轮做迁移 + 回滚，不和纳管混在一起。

## 21. 网关入口到底是什么（读代码后的更正）

### 21.1 入口 = 两侧之间的那张契约

「入口」不是一个单侧概念，它是**客户端配置里指向代理的那一条**（app 侧写什么）
加上**网关收到后把请求认成谁**（网关侧怎么选上游）。两侧缺一不可。

### 21.2 今天五个 app 的入口，形状各不相同

| app | 客户端配置里写什么 | 网关路径 | 代码 |
|---|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:15721`（裸 origin，无路径）+ `PROXY_MANAGED` + 四档模型别名 | `/v1/messages` | `live/project/claude.rs:249` |
| Claude Desktop | profile 里 `inferenceGatewayBaseUrl=http://127.0.0.1:15721/claude-desktop`、`inferenceGatewayApiKey=<token>`、`inferenceModels=[…]` | `/claude-desktop/v1/messages` | `claude_desktop_config.rs:1194/1212/1480` |
| Codex | `[model_providers.cc-switch] base_url="http://127.0.0.1:15721/v1"`、`wire_api="responses"`、`experimental_bearer_token` | `/v1/responses`、`/v1/chat/completions` | `live/project/codex.rs:505`、`services/proxy.rs:271` |
| Gemini | `.env` 里 `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:15721`、`GEMINI_API_KEY=PROXY_MANAGED` | `/v1beta/*` | `mode/controller.rs:3289` |
| Grok Build | `base_url="http://127.0.0.1:15721/grokbuild/v1"` | `/grokbuild/v1/responses` | `mode/controller.rs:473` |

所以「写进配置的就是一条 127.0.0.1:15721 的条目」只在 Claude Code 上成立。其余分别是
带路径的 origin、TOML 里的一张 provider 表、环境变量、Desktop 的 profile 块（还带模型列表）。

### 21.3 网关侧：入口和 app 被写死成一对一

`proxy/handlers.rs` 的每个 handler 里硬编码 `AppType`（`/v1/messages`→Claude、
`/claude-desktop/*`→ClaudeDesktop、`/v1/chat/completions` 与 `/v1/responses`→Codex、
`/v1beta/*`→Gemini、`/grokbuild/*`→GrokBuild），然后
`ProxyContext::new(app_type, …)` 走 `get_proxy_config_for_app(app)` +
`mode::current::provider_in_use(db, app)` 取**该 app 的当前上游**（`proxy/handler_context.rs:96`）。

结论：路径 → app → 该 app 的队列，这条链是写死的。所以不存在「任意 app 引用同一个网关」，
今天只有这 5 个 app 有入口，另外 9 个（opencode/openclaw/hermes/kimi/pi/mcode/dsh/omp/agy）
连入口写入器都没有，只能直连。

### 21.4 真正的机会：路径本身已经编码了下游协议

代理的路由表里协议面是**平的**，不依赖 app：

- `/v1/messages` → Anthropic Messages
- `/v1/chat/completions` → OpenAI Chat
- `/v1/responses` → OpenAI Responses
- `/v1beta/*` → Gemini native

也就是说，任何会说这四种协议的客户端**今天就能连上**，唯一卡住的地方是 handler 把
「这条请求用谁的队列」写死成了 app。纳管要拆的正是这一处：

```
路径 → 下游协议 → 网关上游            （纳管后）
路径 → app      → 该 app 的当前上游    （现在）
```

app 只剩下两个用途：**写哪个文件**（入口形状）和**显示/统计**。选上游与它无关。

### 21.5 纳管在代码里的最小改动面

1. `gateway_target`：网关级的当前上游（先一张表：协议面 → 上游 id，之后加按模型规则）
2. `handler_context`：取上游时先问网关，未配置时回落 app 队列（现有 5 个 app 行为不变）
3. 入口写入器已有 5 个；其余 9 个 each 一个文件格式，按需补（opencode 优先）
4. 纳管动作：备份 app 配置 → 写入口 → 该 app 的 provider 列表收成一条（网关）→ 上游挂网关
5. 解除：还原备份（已确认）

### 21.6 边界

「provider 只配一次」的前提是那个 app **有入口**。5 个 app 成立；其余 9 个要么各补一个
写入器（每家一个文件格式 + 协议验证），要么明确标成「直连，不参与纳管」。

### 21.7 Claude Desktop 的入口是可见的（设置 → Connection → Gateway）

> **这段是 CCS 已有功能，不是待建项。** 面板属于 Claude Desktop 自己的 Desktop 3P 部署设置页
> （文案在 `Claude.app/Contents/Resources/ion-dist.asar` 里），面板上显示的值是 **CCS 写进
> profile 的**：地址 = `proxy_origin + /claude-desktop`，key = `get_or_create_gateway_token()`
> 生成的 `ccs-…`，模型列表 = 路由那家的 `inferenceModels`。漂移检测也已经在
> `ClaudeDesktopStatus.expected_base_url / actual_base_url` 里。
> 结论：**入口这一层不用再造**，纳管复用它。

Desktop 的入口不是"藏在文件里"：它在 Claude Desktop 自己的设置面板里就是
**Connection → Gateway**，用户能看见也能改。面板背后是
`~/Library/Application Support/Claude-3p/configLibrary/00000000-0000-4000-8000-000000157210.json`。

| 面板字段 | profile 字段 | 当前真实值 |
|---|---|---|
| Gateway base URL | `inferenceGatewayBaseUrl` | `http://127.0.0.1:15721/claude-desktop` |
| Gateway API key | `inferenceGatewayApiKey` | `ccs-91f8…`（CCS 生成的 gateway token，不是 `PROXY_MANAGED`） |
| Credential kind: Static API key | `inferenceProvider=gateway` + `inferenceGatewayAuthScheme=bearer` | — |
| （模型下拉） | `inferenceModels` | 路由那家的模型，`claude-*` id + `labelOverride` |

三点推论：

1. **URL 里的 `/claude-desktop` 不是装饰**，它是入口契约的一部分：同一个端口上，Claude Code 写裸
   origin（走 `/v1/messages`），Desktop 写带前缀的 origin（走 `/claude-desktop/v1/messages`）。
   前缀就是网关用来区分"这段流量是谁"的东西。
2. **Desktop 的"一条条目"其实是三件套**：URL + Key + 模型列表。模型列表 = 「模型映射」在
   Desktop 里的可见形态。
3. **用户会在面板里改它**，所以写入器不能盲写。CCS 已经在防这个：`ClaudeDesktopStatus` 里有
   `expected_base_url` 和 `actual_base_url` 的漂移检测（`claude_desktop_config.rs:116`）。

对纳管的影响：入口写入器必须是**读-改-写 + 漂移检测**，不能"我写我的"。Desktop 这套机制
可以复制给其它 app。

## 22. 用 CCR 的模型中心配置替换 CCS 的「聚合」（用户判定：聚合是垃圾设计）

### 22.1 CCS 现在是什么

聚合（Stack）是 per-app 的：成员、key 登记簿、发布清单都存在该 app 的 `live-state.json`
（`mode/state.rs:395` `stack(store, app)`）。加入一家供应商后，它贡献的模型是：

- 该行配了 `meta.stackModels`（自由列表）→ 发列表里的
- 没配 → 回落到模型映射：`ANTHROPIC_MODEL` + `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`
  （`mode/stack.rs:224-232`）

所以默认形态是「4 档 × M 家」（4×M），界面上 CTYun 显示 1 个模型、kpzhu 显示 4 个模型，
就是这句话的两种情形。**provider 是被加入的单位，模型是被带出来的结果。**

CCR 反过来：**模型是被直接配置的单位，provider 只是模型的来源。**

### 22.2 CCR 是什么（`packages/core/src/contracts/app.ts:1651` `ProfileConfig`）

```
model          默认模型（必填）
fableModel?    opusModel?    sonnetModel?    haikuModel?     4 个槽位，全部可选
smallFastModel?
availableModels?: string[]                                   允许模型列表（N，任意多）
providerId?/providerName?                                    只是默认来源
routing?                                                     增强路由（策略，不是模式）
```

模型引用的格式是 `<provider 名>/<model id>`（截图里 `Ctyun/deepseek-v4.1-flash-1017`、
`Codex ChatGPT/gpt-6.1-sol`）。**没有 直连/路由/聚合 三选一**：网关永远按模型路由，选模型就是选上游。

### 22.3 差异的本质

| | CCS 聚合 | CCR |
|---|---|---|
| 配置单位 | 供应商（加入 → 带出它的模型） | 模型（直接选，跨供应商） |
| 数量 | 4 × M（默认）；有 `stackModels` 才能任意 | 模型任意：4 个可选槽位 + 默认 + N |
| 范围 | per-app：每个 app 各自一份成员与发布清单 | 全局：供应商池一次配齐，每个 agent 只配自己的模型 |
| 模式 | 直连 / 路由 / 聚合 三选一 | 无模式 |

### 22.4 替换设计（照 CCR，不发明）

**全局（一次）：**

1. 供应商池：供应商 + 凭据 + 上游协议，数量自由（已有 `upstreams/endpoints/credentials` 三层可用）
2. 模型目录：每个模型 = `供应商/模型 id` + 显示名 + 窗口 + 能力；目录来自供应商池

**每个 app 一份接入配置（对应 CCR 的 profile）：**

1. 默认模型
2. 该 app 支持的槽位，全部可选：Claude 是 fable/opus/sonnet/haiku；Codex 是 model/review_model
   （`live/project/codex.rs:54-55`）；Grok 只有 models.default（`live/project/grok.rs`）；Desktop 是模型列表
3. 允许模型列表：N 个，进 app 自己的模型选择器

**模式收缩为两种**：直连 / 网关。聚合并入网关的模型目录；不再有「聚合」这个模式。

### 22.5 这条替换动到哪些现有机制

| 现有 | 处理 |
|---|---|
| `mode/stack.rs` 整套（成员/keys/id 生成/`resolve`） | id 生成与严格解析保留；成员与目录上提到网关 |
| per-app `live-state.json` 的 `stack` 段 | 迁移成网关目录 + 每 app 的 profile；旧数据一次性搬运 |
| 模型发布（claude `modelPicker`、desktop `inferenceModels`、codex 目录、grok 表） | 写入器保留，数据源从「该 app 的 stack」换成「网关目录 + 本 app 的 profile」 |
| 路由模式（单一上游 + 故障转移） | 合并进网关：上游集合 = 供应商池，选择按模型 |
| 直连模式 | 保留（无入口的 app 仍走它） |

### 22.6 验收标准（按用户的三个场景）

1. 一家供应商只有 1 个模型时，界面上就是 1 个，不会为了凑 4 档补三个空位
2. 一家供应商有 4 个模型时，4 个都出现；4×M 的乘法关系消失
3. claude 的 `/model` 里能同时看到不同供应商的模型，选中哪个就用哪个，不用切"当前供应商"
4. 每个 app 的配置互不影响：给 claude 加的模型不会出现在 codex 里

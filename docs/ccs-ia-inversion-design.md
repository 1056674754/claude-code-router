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

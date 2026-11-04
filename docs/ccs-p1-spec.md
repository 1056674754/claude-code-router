# CCS P1：网关模型目录与 per-app 模型配置（规格）

> 上游依赖：`docs/ccs-p0-inventory.md`（下称 P0）。
> 本阶段**只做数据与命令**：建目录、迁移旧 stack、读写 per-app 模型配置。
> 不改代理转发（P2）、不改客户端入口写入（P3）。

---

## 1. 目标

1. 网关有一份**全局模型目录**：每个模型 = `供应商 / 模型 id`，带显示名、窗口、能力、来源
2. 每个 app 有一份**模型配置**：默认模型 + 该 app 支持的槽位（可空）+ 允许模型列表 + 路由策略
3. 旧数据无损迁移：`live-state.json` 的 `stack`（成员 + key 登记簿 + 发布清单）搬进目录与配置
4. 目录可增量、可重放：导入幂等；同 (供应商, 模型) 只出现一次

---

## 2. 复用已有表，不新建供应商层

P0 §1.4/§7 已核实，网关级上游四张表在 v24→v25 就建好了（`database/schema.rs:2024-2078`）：

| 表 | 用途 | P1 动作 |
|---|---|---|
| `upstreams` | 供应商（host、name、icon） | 不动 |
| `upstream_endpoints` | 协议 + base_url | 不动 |
| `upstream_credentials` | 凭据（endpoint + app_type + provider_id + secret） | 不动 |
| `provider_bindings` | app×provider → endpoint + is_current + model_map | 不动 |

**P1 新增两张表**（建议，见 §6 决策 1）：

```sql
CREATE TABLE upstream_models (
  id           TEXT PRIMARY KEY,          -- 稳定 id，不随模型名改
  endpoint_id  TEXT NOT NULL,
  model_id     TEXT NOT NULL,             -- 规范模型名（已剥 [1M]）
  display_name TEXT,                      -- 目录里显示的名字
  context_window INTEGER,
  capabilities TEXT,                      -- JSON：modalities / reasoning / tool_call
  source       TEXT NOT NULL,             -- 'stack' | 'slot' | 'app-config' | 'manual' | 'fetched'
  one_m        INTEGER NOT NULL DEFAULT 0, -- 是否 1M 窗口
  created_at   INTEGER NOT NULL,
  UNIQUE (endpoint_id, model_id)
);
-- 目录视图按上游合并：CTYun 有 anthropic / openai_responses 两条端点，
-- 同一个模型不能因为写到哪条端点而出现两次。

CREATE TABLE gateway_app_profiles (
  app_type TEXT PRIMARY KEY,
  payload  TEXT NOT NULL,                 -- AppModelConfig JSON
  updated_at INTEGER NOT NULL
);
```

`AppModelConfig`（对齐 CCR `ProfileConfig`，P0 §3.4 给出每个 app 的落点）：

```jsonc
{
  "default": "ctyun/deepseek-v4.1-flash-1017",
  "slots": { "fable": "...", "opus": "...", "sonnet": "...", "haiku": "..." },  // 该 app 支持哪些由代码定
  "allowed": ["ctyun/...", "kimi/..."],   // 空 = 不限制
  "routing": { "enabled": false, "rules": [] }
}
```

> 「项目（profiles 表）」语义不动：它是跨 app 的选择快照（P0 §3.5），
> 与本表的 per-app 模型配置是两层；是否合并见 §6 决策 2。

---

## 3. 模型引用与解析

- 格式：`<供应商名>/<模型 id>`，供应商名取 `upstreams.name`；重名时加后缀 `（2）`
- 目录的键是 **(上游, 规范模型名)**，不是 (端点, 模型)：真实库副本实测 CTYun 有两条端点
  （`anthropic` 与 `openai_responses`），按端点去重会让 `deepseek-v4.1-flash-1017` 出现两次
- 解析：`供应商名` → `upstreams` → 在它的端点里选**当前 app 绑定协议**的那条
  （`provider_bindings.endpoint_id`；没有绑定时按 `upstream_endpoints.protocol` 选）
- 发往上游的模型名：`upstream_models.model_id` 原值（`[1M]` 标记照 P0 §2 的规则处理）
- 解析失败**必须报错**，不回落（沿用 stack 的严格失败语义，`mode/stack.rs` 设计注释）

---

## 4. 迁移（P1 的唯一一次写操作）——已实现 `services/gateway_migration.rs`

输入：`live-state.json` 的每 app `stack{enabled, members, keys}` + `proxy_route` + 各 app 的 provider 行。
输出：`gateway_app_profiles` 行（目录不落库，见 §2 决策 1 改判）。

翻译规则（纯函数 `build_app_config`，测试直接喂 `Member`）：

1. 默认 = **路由那家**（`mode.proxy_route`，Stack 里占默认的成员）的第一个模型，
   按目录引用写。路由那家不在名单里时退回名单第一家。
2. 槽位 = 路由那家的 `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL`（只有 claude 有槽位），
   值先剥 `[1M]` 再查目录引用。
3. 允许列表 = Stack 名单里**所有成员**发布的模型（去重）——就是聚合时能选的那批。
4. 目录里查不到的模型直接丢弃，不编造；成员全查不到 → `NothingToMigrate`，不写。
5. `keys` 登记簿不动：它只存在于 `live-state.json`，新设计不再需要，但也不删（回滚要用）。

幂等：已配过该 app 的不覆盖（`AlreadyConfigured`），重跑安全。**不写** `settings` 标记：
「已配置」本身就是标记，少一处状态。

**回滚**：只新增 `gateway_app_profiles` 行、不改客户端文件；回滚 = 删行，旧 `stack` 数据仍在
`live-state.json`，不丢。

**真实库副本 + 本机 live-state 实测**（`manual_migrate_against_real_db_copy`）：

| app | 结果 | 说明 |
| --- | --- | --- |
| claude-desktop | `Migrated` | 默认 `Codex/gpt-6.1-terra`，允许列表 9 条（Codex 4 + kpzhu 4 + CTYun 1） |
| claude | `NoStack` | 没有 Stack |
| codex | `NoStack` | Stack 开着但模式是直连（Stack 未生效） |
| 第二次运行 | 全部 `AlreadyConfigured` / `NoStack` | 幂等验证 |

---

## 5. 命令与验收

| 命令 | 作用 |
|---|---|
| `get_gateway_catalog` | 目录 + 每 app 的模型配置（一次取全，UI 直接用） |
| `refresh_gateway_catalog` | 从现有 provider 行增量重扫（幂等） |
| `add_gateway_model` / `remove_gateway_model` | 手工增删（`source='manual'`） |
| `get_app_model_config` / `set_app_model_config` | 读写 per-app 配置 |

**验收**（全部对着真实库副本跑，`CCS_VERIFY_DB` 门控的 `#[ignore]` 测试）：

1. 迁移后：每条 stack 发布模型在目录里恰好 1 行；`keys` 归属不变
2. 幂等：连续跑两次 `refresh_gateway_catalog`，行数不变
3. `default`/`slots` 反解与迁移前客户端文件一致（golden 对比）
4. 非法引用（不存在的供应商 / 模型）解析报错，不静默
5. 真实库实测（`services::gateway_catalog::manual_derive_against_real_db_copy`）：
   **50 个模型 / 16 个上游 / 23 条端点**。分 app 贡献（含重复来源）：
   opencode 28、claude-desktop 14、claude 13、hermes 9、kimi 6、dsh 2、codex 2、omp 1。
   早期只覆盖三个 app 时的 19 条差异（历史记录，保留说明）：
   - 预估 20 → 实测 19：按端点去重时 CTYun 的 `deepseek-v4.1-flash-1017` 出现两次，
     改成按上游合并后只剩一条
   - `kimi-k2.6` 与 `kimi-k3` 在 `api.kimi.com` 下各一条（Kimi 与 Kimi For Coding 同主机）
   - `My Claude`（claude）与 `kpzhu`（desktop）合并到 `kpzhu.com`：同一家中转
   - `通用网关/default` 是空地址的官方行，保留为一条

---

## 6. 需要拍板的三件事

1. **目录存储**：物化表 `upstream_models`（推荐，可手工增删、可排序、可缓存）vs 每次从 provider 行派生
2. **per-app 模型配置存储**：新表 `gateway_app_profiles`（推荐，语义干净）vs 扩展 `ProfilePayload`（复用项目机制）
3. **模型引用命名**：`<供应商名>/<模型 id>`（推荐，与 CCR 一致）vs 用供应商 id

---

## 7. 本阶段不做

- 不改代理的任何路由/转发（P2）
- 不改客户端文件（P3）
- 不删 `直连/路由/聚合`（P2 与 UI 一起删）
- 不处理 Kimi OAuth 刷新（P4，复用 `kimi_oauth::account::refresh`）

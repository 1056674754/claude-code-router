# P3 盘查：模式（直连 / 路由 / 聚合）的暴露面与删除清单

目标（用户原话）：**模式不剩**，只留 CCR 那种编辑界面的内容；客户端始终指向网关，
选上游就是选模型。P3 = 删掉模式状态机，换成「一次性接管 / 释放」。

## 1. 三层现状（file:line 均已核对）

### 1.1 状态（设备本地 `live-state.json`）

| 内容 | 位置 |
| --- | --- |
| `Mode` 只有 `Direct` / `Proxy` 两个值 | `mode/state.rs:51` |
| `ModeState{mode, attached, proxy_route, contract}` | `mode/state.rs:73` |
| `Contract`（写进客户端文件的内容摘要、版本、key digest） | `mode/state.rs:60` |
| `StackState{enabled, members, keys}`，按 app 存 | `mode/state.rs:119` |
| 聚合模型 id 保留前缀（`ccs-claude-*` / `ccs-*` / `claude-fable-ccs-*`） | `mode/stack.rs:34-49` |

### 1.2 控制（都是 `mode/controller.rs`）

| 函数 | 作用 |
| --- | --- |
| `enter` :719 / `enter_with_route` :726 | 接管客户端文件，进代理 |
| `exit` :863 / `exit_all` :976 / `detach_all` :1008 | 还原客户端文件 |
| `exit_apps_in_mode` :878 | 按「直连/聚合」批量退出 |
| `set_route` :1156 / `switch_route` :1116 / `switch_route_locked` :1046 | 换路由那家 |
| `set_stack_member` :1278 / `sync_stack_order` :1367 | 聚合成员开关与排序 |
| `stack_views` :1392 / `stack_view_with_clients` :1429 | 给前端的聚合视图 |
| `adopt_codex_stack_catalog` :1486 / `resync_codex_stack_catalog` :1509 | Codex 目录接管 |
| `startup` :1701 / `resync_routes` :1634 | 启动时恢复模式 |
| `record_failover_route` :1654 / `switch_route_for_failover` :1126 | 故障转移切路由 |

### 1.3 命令（`commands/proxy.rs`）

`set_proxy_takeover_for_app` :77、`get_app_mode` :100、`set_proxy_route` :116、
`exit_proxy_apps_in_mode` :138、`get_proxy_stack` :162、`set_proxy_stack_member` :198、
`adopt_codex_stack_catalog` :218。

### 1.4 前端

- API：`src/lib/api/proxy.ts:54`（接管）、`:68`（换路由）、`:96`（聚合视图）、`:106`（成员开关）
- 组件：`src/components/providers/mode/` 下 `ModeTabs.tsx`（193 行）、`ModeDialog.tsx`（568）、
  `SwitchModePanel.tsx`（703）、`StackSettingsSheet.tsx`（165）、`StackSubagentFields.tsx`（222）、
  `RouteSettingsSheet.tsx`（58）
- Hook：`src/hooks/useModeActions.ts`（120 行）
- 设置页：「聚合」文案在 `src/components/settings/sections/RoutingSection.tsx:405`

## 2. 删除清单

**删**（模式/聚合专属）：

1. `ModeTabs` / `ModeDialog` / `SwitchModePanel` / `RouteSettingsSheet` /
   `StackSettingsSheet` / `StackSubagentFields` 六个组件
2. `useModeActions.ts`
3. 命令：`get_app_mode`、`set_proxy_takeover_for_app`、`set_proxy_route`、
   `exit_proxy_apps_in_mode`、`get_proxy_stack`、`set_proxy_stack_member`
4. `mode/state.rs` 的 `Mode` / `Contract` / `StackState`（连同 `live-state.json` 里的字段）
5. `mode/stack.rs` 整套 id 编码/解码（`encode` / `decode` / `allocate_key` / `keys`）

**留/改**（把「进模式」换成一次性动作）：

| 现在 | 改成 |
| --- | --- |
| `enter` / `exit` | **接管（adopt）/ 释放（release）** 一次性动作，不是可切换状态 |
| `set_route`（换默认供应商） | 删；默认 = 每 app 模型配置的 `default` |
| `set_stack_member`（聚合成员） | 删；可选项 = 模型配置的 `allowed` 列表 |
| `startup`（恢复模式） | 只校验「客户端文件还是不是我们写的」，不是就提示重新接管 |
| 故障转移 `switch_route_for_failover` | 保留语义，但只对「没点名模型」的请求生效 |
| Codex 目录接管 `adopt_codex_stack_catalog` | 换成交付目录引用（见 §3） |

## 3. 尚未完成、需要单独设计的一件

Codex 的模型目录条目带**每条模型自己的工具 profile 与协议**（`plan_codex_stack_catalog`
里调 `codex_stack_third_party_rows`，并写 `use_responses_lite`），slug 现在编成
`ccs-<key>/<model>`。要改成模型引用 `schema` 直写 `<供应商名>/<模型 id>` 需要：

1. 确认 Codex CLI 接受含 `/` 的 slug（目前只见过 `provider/model` 形式的第三方 slug）
2. 每条引用的工具 profile 仍从它所属的那家 provider 行生成（现在的 `member.row` 已经带）
3. 目录里同时保留路由那家的明文 slug（默认模型）与成员引用（冲突时以后者为准）

风险：改错会让 Codex 的模型选择器读不到目录或选到错的协议。所以放在 P3 最后，
先跑真实 Codex 验证。

## 4. 删除顺序（每步单独可回滚）

1. 建「接管 / 释放」事务（含备份与失败回滚，已批准的设计）
2. 代理与前端改用新命令；旧 enter/exit 保留但不再被调用
3. 删 `StackState` 与 `mode/stack.rs` 的编码；Stack 迁移已在 P1 做过（`gateway_migration`）
4. 删六个 UI 组件与 `useModeActions`
5. 最后删 `ModeState.mode/attached/contract`，`live-state.json` 只留「接管记录」

## 5. 进度（按轮更新）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 模型引用 → Claude Code env（默认 + 四档 + 回落 + 1M 标记） | ✅ | `live/project/claude.rs` `ModelConfigSlots` / `proxy_projection_from_model_config`；3 个单测 |
| 接进 `mode::controller` 的 Claude 分支（Stack 为空才用） | ✅ | `claude_contract(..., model_config)`；controller 测试 `claude_enters_with_model_references_from_app_model_config` |
| 保存配置后立刻重写已接管的客户端 | ✅ | `set_app_model_config` → `resync_route`；测试 `resync_rewrites_the_client_when_the_model_config_changes` |
| Claude Desktop profile 发布模型引用 | ✅ | `desktop_model_config_publications`；测试 `claude_desktop_publishes_model_references_from_app_model_config` |
| Codex `config.toml` 的 `model` 写引用 | ✅ | `Target::Proxy.model`；测试 `codex_enter_writes_the_model_reference_from_app_model_config` |
| 前端编辑器（ModelPicker / SlotFields / AllowedModelsEditor / AppEditorPage） | ✅ 组件级，未挂载 | `src/components/gateway/`，22 个前端测试 |
| Codex 模型目录发布引用（`model_catalog_json` 的 slug） | ✅ | `codex_direct::reference_catalog`；测试断言目录含 `B/gpt-b`。真实 Codex 验证已做：CLI 0.166.0，`CODEX_HOME=<临时目录> codex debug models`，config 里 `model = "B/gpt-b"`、目录里 slug `B/gpt-b`（含 `/`）→ 正常渲染，无报错|
| 「接管 / 释放」命令替代 `enter` / `exit` 对外语义 | 🟡 后端 + 前端 API 已加（`adopt_app_to_gateway` / `release_app_from_gateway`、`gatewayApi.adopt/release`）；调用方仍是旧的 `set_proxy_takeover_for_app`，等 UI 切换 | 见 §4 第 2 步 |
| 删模式 UI 与状态机 | ❌ | 见 §2；六个组件全部经 `SwitchModePanel` 使用，删之前必须先替换应用页主体（需要确认布局）|

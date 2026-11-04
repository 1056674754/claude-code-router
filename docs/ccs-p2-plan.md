# P2 计划：按模型路由 + 前端换成 CCR 的编辑界面

前提（已交付）：P1 的目录、每 app 模型配置、Stack 迁移都在 backend 可用；v27 迁移已建表。

## 1. 代理按模型路由（本阶段第一步，已开始）

规则：

1. 请求 `model` 形如 `<供应商名>/<模型 id>` → 发往那家供应商，上游模型名换成 `/` 后面那段
   （`[1M]` 剥掉）；**不回落**：供应商名认识但模型不在目录 → 400，沿用 Stack 的错误信封
2. 其它模型名（含客户端自己的 `anthropic/claude-x` 这类别名）→ 现有默认路由，这一层不猜
3. 解出来的目标用现成的 `StackTarget` 形状（单家、不转移、无熔断），`RequestContext`
   已经按这个语义处理，不新写一套转发

已实现：

- `services/gateway_route.rs::resolve_reference_target`：目录解析 → 反查该 app 的 provider 行
- `proxy/handlers.rs::resolve_stack_target`：Stack 保留前缀解不出来时先尝试按引用解析
  （旧的 `ccs-*` id 仍走原路径，P3 再删）

已知待办：

- 每次请求都派生目录（~50 行）——先量耗时，必要时按「provider 行版本号」加缓存
- Desktop 的 `/v1/models` 目录还只发布 Stack 模型，要改成发布目录引用（`handlers.rs::handle_claude_desktop_models`）

## 2. 前端：应用页换成 CCR 的编辑内容（不弹 modal）

目标是 CCR `packages/ui/src/pages/home/components/profiles.tsx:711-1150` 那份表单的内联版：

| 区块 | 控件 | 数据来源 |
| --- | --- | --- |
| Agent | 固定当前 app，不选 | 路由参数 |
| 配置档案名称 | 文本框 | `gateway_app_profiles.payload`（新增 name 字段） |
| 作用范围 | 全局 / 本 app | 沿用项目机制（P0 §3.5） |
| 入口模式 | CLI / APP / both | 沿用现有入口设置 |
| 默认模型 | 下拉（可搜） | `get_gateway_catalog` |
| 槽位（claude 四档） | 下拉 ×4，可空 | 同上 |
| 允许模型列表 | 多选 | 同上；非空时默认必须在列表内（后端已校验） |
| 高级：增强路由 / 配置级路由 | 开关 + 规则表 | `AppModelConfig.routing` |

页面结构（React，复用现有 shadcn 组件）：

```
AppEditorPage            // 替换现有应用页的供应商卡片列表
├── ModelPicker          // 下拉 + 搜索 + 分组（按供应商）
├── SlotFields           // 按 app 渲染槽位（claude 4 / codex 2 / 其它无）
├── AllowedModelsEditor  // 多选 chips
└── AdvancedRouting      // 折叠区，先只读展示
```

删除的东西（用户明确不要）：

- 模式选择（直连 / 路由 / 聚合）及其状态机 UI
- 「聚合/Stack」成员列表、`ccs-*` 模型展示
- 每个 app 各自配 provider 的表单（供应商在全局「供应商」页配一次）

## 3. 顺序

1. 代理按模型路由 + 测试（进行中）
2. 前端 `ModelPicker` + 应用页只读展示（先接 `get_gateway_catalog`，能看不能改）
3. 编辑与保存（接 `set_app_model_config`）
4. 删模式 UI、删 Stack UI、删旧 provider 表单
5. Desktop `/v1/models` 发布目录引用

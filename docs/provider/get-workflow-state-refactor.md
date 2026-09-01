# Provider 侧 MCP 稳定性审计与 `get_workflow_state` 重构方案

本文只讨论 **Provider 侧** MCP 工具，不讨论本插件本地包装逻辑。证据来自 2026-09-01 对 live Provider `https://mcp.eshypdata.com/mcp` 的只读 `initialize`、`tools/list` 和 `get_workflow_state` 探针调用。

## 一句话结论

当前最危险的问题不是单个工具报错，而是 **Provider 的工具契约表达不足**：多个工具缺少 `description`，大量 schema 没写清类型或是否拒绝额外字段，`get_workflow_state` 又没有明确状态模型、对象边界和恢复动作定义。结果是 Agent 很难稳定判断“现在处于哪一步、下一步能做什么、失败后能否安全恢复”。

## 已验证的 live 事实

### 1. live MCP 基本信息

- `initialize` 成功，`serverInfo.name = "YP Local Business MCP"`
- `serverInfo.version = "1.9.4"`
- transport 为 Streamable HTTP SSE
- live 暴露工具数：`19`

### 2. 缺少 description 的工具

以下工具在 live `tools/list` 中没有 `description`：

- `create_submission_batch`
- `ingest_mcn_submissions`
- `get_ingest_job`
- `sync_mcn_inquiry_status`
- `record_client_feedback`
- `audit_manual_adjustment`
- `get_recommendation_run_detail`
- `get_workflow_state`

这不是“文档不美观”问题，而是稳定性问题：Agent 在多工具同链路串行调用时，会更依赖 description 判断调用时机、副作用和恢复边界。

### 3. schema 表达明显不足

#### 3.1 所有 live 工具都没有显式 `additionalProperties`

`19/19` 个工具的 `inputSchema` 都没有显式声明 `additionalProperties: false`。

这会带来两个问题：

- 对 Agent 而言，无法从 schema 判断“未知字段一定报错”还是“会被忽略”。
- 对后端而言，若不同工具有的严格拒绝、有的静默忽略，就会出现**相同行为模式在不同工具上不一致**。

已验证：`get_workflow_state` 传入额外字段 `project_id` 会直接报 Pydantic `Unexpected keyword argument`。也就是说，**运行时是严格的，但 schema 没表达出来**。

#### 3.2 `validate_requirement` 的 64 个字段全部没有明确 type

live `tools/list` 里，`validate_requirement.inputSchema.properties` 有 `64` 个字段，但 `64/64` 都没有显式 `type`、`anyOf` 或 `enum`。例如：

- `status`
- `platform`
- `rebate`
- `quantityTotal`
- `submissionDeadlineAt`
- `rawMessagesJson`
- `contentTag`
- 所有报价、CPM、CPE、标签字段

这会直接影响流程稳定性，因为 `validate_requirement` 是整个业务入口的第一道 Provider 写入工具：

- Agent 无法仅靠 schema 判断字符串、数组、对象的合法形态。
- 上游一旦提示词退化，最容易出现“先盲试参数类型，再根据报错修”的不稳定行为。
- 本地插件不得不补一大层前置规范化和防呆，说明 Provider 契约没有起到足够的自解释作用。

### 4. `create_with_distributions` 的 schema 与业务真实约束不一致

live schema 里：

- required 只有 `requirement_id`、`description`、`wechat_notification_message`
- `supplierIds` / `supplier_name` 不是 required

但真实业务约束是：

- 两个数组字段必须显式存在
- 至少一侧非空
- 两侧都空会报 `INVALID_PAYLOAD`

也就是说这里存在 **“schema 允许，但业务必错”** 的契约裂缝。它会让 Agent 误以为“我可以先只传 requirement 和消息，再看后端怎么报”，从而增加无效调用和未知发送状态风险。

### 5. `rank_creators` 输入存在歧义

live schema 允许：

- `inquiry_ids` 可空
- `requirement_id` 可空
- 没有 required 字段

这意味着 schema 层允许以下不稳定输入：

- 两者都不传
- 两者同时传
- 传混合上下文 ID

如果后端没有再做严格语义校验，这会直接造成“精排是基于哪批数据做的”无法解释。

### 6. `sync_mcn_inquiry_status` 恢复能力不足

live schema 要求：

- `requirement_id`
- `project_id`
- `supplierIds`

但 `get_workflow_state` 当前只接受 `requirement_id`。这会造成一个恢复盲区：

- 当会话只记得 `requirement_id`，但丢了 `project_id` 或实际发送成功的 supplier ID 集合时
- Agent 无法靠 `get_workflow_state` 一次性取回继续回收所需的最小闭包

这正是 `get_workflow_state` 应该解决但目前没有解决的问题。

### 7. `get_workflow_state` 当前返回“成功”，但信息不足以安全恢复

已验证调用：`get_workflow_state({ requirement_id: "req-nonexistent-audit" })`

返回形态为：

```json
{
  "success": true,
  "trace_id": "...",
  "data": {
    "workflow_state": null,
    "allowed_actions": [],
    "known_facts": {
      "resolved_requirement_id": null
    },
    "recent_errors": []
  },
  "error": null,
  "workflow_state": null,
  "allowed_actions": []
}
```

这里有四个稳定性问题：

1. **未知 requirement 仍返回 `success=true`**。这会把“没找到状态”和“成功查到了空状态”混在一起。
2. **顶层和 `data` 内重复放 `workflow_state`、`allowed_actions`**，增加消费歧义。
3. `known_facts` 只有 `resolved_requirement_id`，无法支持恢复后续动作。
4. 没有说明“为什么 allowed_actions 为空”。是 requirement 不存在、项目未创建、字段未选择、发送失败、还是链路已结束，外部无法区分。

## 对流程稳定性的威胁分级

### P0：直接威胁链路可恢复性

#### 1. `get_workflow_state` 没有可恢复的状态模型

影响：当发送、回收、异步轮询任一步中断时，Agent 不能可靠恢复。

具体后果：

- 无法回答“现在是否已经创建项目”
- 无法回答“是否已经选过字段”
- 无法回答“下一步是回收 inquiry 还是继续等 job”
- 无法恢复 `project_id`、`supplierIds`、`inquiry_ids`、`job_id`、`batch_id`

#### 2. 业务必填字段没有在 schema 层表达

重点是 `create_with_distributions`、`rank_creators`。

影响：调用前无法静态阻断错误参数，导致多次无效请求、部分成功、状态未知。

### P1：高概率诱发错误调用

#### 3. 缺少 description 的工具太多

尤其是：

- `sync_mcn_inquiry_status`
- `ingest_mcn_submissions`
- `get_ingest_job`
- `get_workflow_state`

这几个正好覆盖**发送后回收链路**，属于最需要说明“什么时候调、拿什么 ID、成功代表什么、不成功怎么办”的位置。

#### 4. `validate_requirement` schema 完全不自解释

影响：入口写入工具强依赖外部 prompt 补契约，一旦模型偏航，错误会集中出现在最上游。

### P2：增加长期维护和兼容成本

#### 5. schema 严格性靠运行时，不靠声明

当前现状像是：

- schema 没写 `additionalProperties: false`
- 运行时却严格拒绝未知字段

这会让不同客户端做出不同假设，造成兼容碎片。

#### 6. 命名和结构不统一

例如：

- `submission_batche_page` 有拼写噪声
- `supplierIds` / `supplier_name` 混用 camelCase + snake_case
- 有的工具返回顶层状态摘要，有的只在 `data` 里放

这类问题单点不致命，但会持续侵蚀自动化稳定性。

## `get_workflow_state` 重构目标

目标不是做一个“大而全查询工具”，而是做一个 **单 requirement 的权威恢复入口**：

- 输入只需要稳定身份键
- 输出足以判断当前阶段、最近副作用、可安全继续的下一步
- 能恢复所有后续工具所需的最小真实 ID 集
- 能明确区分“未开始 / 进行中 / 已完成 / 已失败 / 信息不足”

## 新版 `get_workflow_state`：建议输入契约

### 设计原则

1. **单一主键优先**：默认只允许 `requirement_id`
2. **不让 Agent 猜 selector**：不要要求外部同时提供 `project_id` / `run_id` / `batch_id`
3. **查询维度由 Provider 自己回表补齐**
4. **允许 detail level，但不允许模糊条件搜索**

### 建议 input schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["requirement_id"],
  "properties": {
    "requirement_id": {
      "type": "string",
      "minLength": 1,
      "description": "当前业务 requirement 的唯一 ID"
    },
    "detail_level": {
      "type": "string",
      "enum": ["summary", "recovery", "debug"],
      "default": "recovery",
      "description": "summary 只看阶段；recovery 返回继续流程所需最小闭包；debug 追加最近事件与错误"
    },
    "include_history_limit": {
      "type": "integer",
      "minimum": 0,
      "maximum": 20,
      "default": 5,
      "description": "debug 模式下返回最近事件条数"
    }
  }
}
```

### 为什么不加 `project_id`

因为它本来就是恢复目标，不该是恢复前提。

只要 requirement 是当前业务主键，Provider 就应该能回表找出：

- 当前最新 project
- 最近一次字段配置提交
- 最近一次发送尝试
- 最近一次回收任务
- 最近一次手动拓展 batch
- 最近一次达人详情补全 batch

## 新版 `get_workflow_state`：建议输出契约

### 顶层 envelope

```json
{
  "success": true,
  "trace_id": "...",
  "data": {
    "requirement_id": "req_xxx",
    "workflow_kind": "inquiry",
    "phase": "awaiting_submission_sync",
    "status": "in_progress",
    "summary": "项目已创建并已发送询价，等待回收机构反馈。",
    "next_action": {
      "tool": "sync_mcn_inquiry_status",
      "reason": "用户要求回收在线表格结果时，从当前 project 和已发送机构继续同步。"
    },
    "recovery": { ... },
    "artifacts": { ... },
    "recent_errors": [],
    "history": []
  },
  "error": null
}
```

### 禁止再出现的设计

- 顶层重复的 `workflow_state`
- 顶层重复的 `allowed_actions`
- `success=true` 但 requirement 不存在且没有明确状态码

### requirement 不存在时

建议返回：

```json
{
  "success": false,
  "trace_id": "...",
  "data": null,
  "error": {
    "code": "WORKFLOW_NOT_FOUND",
    "message": "No workflow state found for requirement_id=req_xxx",
    "details": {
      "requirement_id": "req_xxx"
    }
  }
}
```

这样 Agent 才能稳定区分：

- requirement 不存在
- requirement 存在，但链路还没开始到某一步
- requirement 存在，但某一步失败

## 建议状态模型

### 一级字段

- `workflow_kind`: `inquiry | manual_source | unknown`
- `phase`: 当前阶段枚举
- `status`: `not_started | in_progress | waiting_user | waiting_provider | completed | failed | blocked`
- `summary`: 给 Agent/人读的一句话摘要

### inquiry 分支 phase

- `requirement_validated`
- `awaiting_field_selection`
- `ready_to_search`
- `searched_creators`
- `ranked_mcns`
- `awaiting_recipient_confirmation`
- `ready_to_send_distribution`
- `distribution_sent_partial`
- `distribution_sent_all`
- `awaiting_submission_sync`
- `submissions_synced`
- `ingest_job_running`
- `creator_preview_ready`
- `creators_ranked`
- `submission_batch_ready`
- `creator_detail_batch_running`
- `creator_detail_export_ready`
- `completed`

### manual_source 分支 phase

- `requirement_validated`
- `awaiting_field_selection`
- `ready_to_start_manual_source`
- `manual_source_batch_running`
- `manual_source_export_ready`
- `completed`

### blocked / failed 的语义

- `blocked`：需要用户动作或缺少外部前置，例如字段未选、用户未确认发送
- `failed`：Provider 侧已知失败，不能自动继续

## recovery 字段：必须返回什么

`get_workflow_state` 真正的价值在 `recovery`。建议最少返回：

```json
{
  "recovery": {
    "project_id": "proj_xxx",
    "platform": "xiaohongshu",
    "business_mode": "询价机构",
    "selected_supplier_ids": ["sup_1", "sup_2"],
    "unresolved_supplier_names": ["某机构"],
    "inquiry_ids": ["inq_1", "inq_2"],
    "ingest_job_id": "job_xxx",
    "manual_source_batch_id": 123,
    "creator_detail_batch_id": 456,
    "submission_batch_id": 789,
    "safe_resume_tools": [
      {
        "tool": "sync_mcn_inquiry_status",
        "arguments": {
          "requirement_id": "req_xxx",
          "project_id": "proj_xxx",
          "supplierIds": ["sup_1", "sup_2"]
        }
      }
    ]
  }
}
```

要求：

- 只返回 **真实可继续调用** 的工具和参数
- 不返回模糊候选、不返回猜测 ID
- 一个阶段最多给 `1-2` 个安全恢复动作

## 建议新增 `facts_completeness`

当前最大问题之一是“查到了部分信息，但不知道够不够继续”。建议增加：

```json
{
  "facts_completeness": {
    "project_id": true,
    "selected_supplier_ids": true,
    "inquiry_ids": false,
    "ingest_job_id": false,
    "manual_source_batch_id": false
  }
}
```

这样外部可以稳定判断：

- 是“没有走到这一步”
- 还是“理论上走到了，但状态表漏记了”

## recent_errors 字段建议

建议统一为：

```json
[
  {
    "at": "2026-09-01T04:00:00Z",
    "tool": "create_with_distributions",
    "code": "PROJECT_NOT_ACTIVE",
    "message": "只有进行中的项目才能创建供应商分发",
    "retryable": false,
    "scope": "business"
  }
]
```

不要只给原始 message；至少补齐：

- 来源工具
- 错误码
- 时间
- 是否可重试
- 属于 schema / business / infra 哪类错误

## Provider 侧落库设计

如果要把 `get_workflow_state` 做稳定，核心不是这个查询接口本身，而是 **先有统一状态写入表**。

建议最少拆三层：

### 1. `workflow_runs`

一条 requirement 对应一个当前 workflow 主记录。

建议字段：

- `id`
- `requirement_id` unique
- `workflow_kind`
- `platform`
- `business_mode`
- `phase`
- `status`
- `project_id` nullable
- `current_distribution_id` nullable
- `current_ingest_job_id` nullable
- `current_manual_source_batch_id` nullable
- `current_creator_detail_batch_id` nullable
- `current_submission_batch_id` nullable
- `summary`
- `created_at`
- `updated_at`

### 2. `workflow_events`

每次关键工具成功或失败都写事件流。

建议字段：

- `id`
- `workflow_run_id`
- `tool_name`
- `event_type`：`call_succeeded | call_failed | state_transition | artifact_ready`
- `phase_before`
- `phase_after`
- `status_after`
- `request_json`
- `response_json`
- `error_code`
- `error_message`
- `created_at`

### 3. `workflow_refs`

存恢复需要的外部 ID 集，避免散落在不同业务表里临时拼。

建议字段：

- `workflow_run_id`
- `ref_type`：`supplier_id | inquiry_id | ingest_job_id | project_id | manual_source_batch_id | creator_detail_batch_id | submission_batch_id`
- `ref_value`
- `source_tool`
- `is_current`
- `created_at`

如果想更稳一点，再拆一个 `workflow_artifacts`：

- `artifact_type`
- `provider_url`
- `local_delivery_url`
- `source_tool`
- `is_final`

## 各工具应该如何写状态表

### `validate_requirement`

成功时：

- upsert `workflow_runs(requirement_id)`
- 写 `workflow_kind`、`platform`、`business_mode`
- `phase = requirement_validated`
- `status = in_progress`

### `select_inquiry_form_fields`

打开链接成功时：

- `phase = awaiting_field_selection`
- `status = waiting_user`

字段提交回调成功时：

- inquiry 分支：`phase = ready_to_search`
- manual_source 分支：`phase = ready_to_start_manual_source`
- `status = in_progress`

### `search_creators`

成功时：

- `phase = searched_creators`

### `rank_mcns`

成功且有机构：

- `phase = ranked_mcns`
- 记录当前 rank 结果关联的 supplier IDs
- `status = waiting_user`

### `create_with_distributions`

成功时：

- 记录 `project_id`
- 记录实际 resolved supplier IDs
- 全发成功：`phase = awaiting_submission_sync`
- 部分成功：`phase = distribution_sent_partial`
- `status = in_progress`

若报“项目非进行中”：

- `status = failed`
- recent_errors 写 `PROJECT_NOT_ACTIVE`

### `sync_mcn_inquiry_status`

成功时：

- 回写实际 `inquiry_ids`
- `phase = submissions_synced`

### `ingest_mcn_submissions`

成功时：

- 回写 `job_id`
- `phase = ingest_job_running`
- `status = waiting_provider`

### `get_ingest_job`

处理中：

- 保持 `phase = ingest_job_running`
- `status = waiting_provider`

完成且有 Excel：

- `phase = creator_preview_ready`
- 记录 artifact

### `rank_creators`

成功时：

- `phase = creators_ranked`

### `create_submission_batch`

成功时：

- 记录 `submission_batch_id`
- `phase = submission_batch_ready`

### `get_creator_detail`

成功时：

- 记录 `creator_detail_batch_id`
- `phase = creator_detail_batch_running`
- `status = waiting_provider`

### `get_creator_detail_export`

完成时：

- `phase = creator_detail_export_ready`

### `manual_source_creators`

同步 Excel：

- `phase = manual_source_export_ready`
- `status = completed`

异步 batch：

- 记录 `manual_source_batch_id`
- `phase = manual_source_batch_running`
- `status = waiting_provider`

### `manual_source_creators_status`

处理中：

- 保持 `manual_source_batch_running`

完成 Excel：

- `phase = manual_source_export_ready`
- `status = completed`

## `allowed_actions` 建议保留，但降级为派生字段

`allowed_actions` 可以保留，但不应该再是主输出。它应该是由 `phase + facts_completeness + recent_errors` 派生出来的结果。

建议改成结构化数组：

```json
[
  {
    "tool": "sync_mcn_inquiry_status",
    "available": true,
    "reason": "已存在 project_id 和已发送 supplierIds，可继续回收",
    "arguments": {
      "requirement_id": "req_xxx",
      "project_id": "proj_xxx",
      "supplierIds": ["sup_1", "sup_2"]
    }
  }
]
```

不要只返回字符串列表，因为字符串列表没有解释力，也不能直接恢复。

## 推荐的 Provider 改造顺序

### 第一阶段：先补契约表达

1. 给所有 live 工具补 `description`
2. 所有工具 schema 显式补 `additionalProperties: false`
3. 给 `validate_requirement` 所有字段补明确 `type`
4. 修正 `create_with_distributions` 和 `rank_creators` 的输入约束表达

这是最低成本、立刻能降错误率的一步。

### 第二阶段：引入统一 workflow 状态写入

1. 建 `workflow_runs`
2. 建 `workflow_events`
3. 关键工具 success/failure 全量写事件
4. 补 requirement → project / inquiry / batch 的 refs

### 第三阶段：重写 `get_workflow_state`

1. 只保留 `requirement_id + detail_level`
2. 输出单一 `data` 状态对象
3. requirement 不存在时改为 `success=false`
4. 返回结构化 `next_action` / `safe_resume_tools`

## 建议验收标准

`get_workflow_state` 重构完成后，至少要满足这 6 条：

1. 仅凭 `requirement_id` 就能恢复 inquiry 或 manual_source 的当前阶段。
2. 能明确区分 `not found / waiting_user / waiting_provider / failed / completed`。
3. 能恢复 `project_id`、`supplierIds`、`inquiry_ids`、`job_id`、各类 `batch_id` 中已真实存在的部分。
4. 返回的下一步动作必须是**可直接调用**的真实工具参数，而不是描述性建议。
5. 未知 requirement 不再返回 `success=true`。
6. `allowed_actions`、`summary`、`recent_errors` 与底层状态机一致，不再出现重复顶层字段。

## 可直接复跑的审计脚本

仓库内已新增脚本：

- `scripts/audit-provider-tools.mjs`

用途：

- 读取 live Provider `initialize`
- 读取 live Provider `tools/list`
- 输出缺少 description、未声明 `additionalProperties`、字段未声明类型等元数据问题

运行：

```bash
node scripts/audit-provider-tools.mjs
```

如需切到别的环境：

```bash
YPSCAN_PROVIDER_URL=https://your-provider/mcp node scripts/audit-provider-tools.mjs
```

## 结论

现在 Provider 侧最该优先修的不是某个单一业务逻辑，而是 **把工具契约和 workflow 状态模型补成可恢复、可推断、可验证**。其中 `get_workflow_state` 应该从“一个模糊诊断接口”升级成“单 requirement 的权威恢复入口”。只要这一步做好，发送失败、回收中断、异步 batch 继续查这几类最伤稳定性的场景都会立刻收敛很多。

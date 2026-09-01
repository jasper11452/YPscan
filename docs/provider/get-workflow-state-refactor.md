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

这里建议改一下思路：**第一阶段不要急着新建一套完整的 workflow 表**。当前数据库里已经有一批在工作的业务表，`get_workflow_state` 应该先尽量复用这些现有表，把 requirement → project → inquiry → job → batch 的链路串起来。能用现表解决的，先不要新建表。

### 先复用哪些现有表

- `customer_demands`：requirement 主表；用 `id`、`status`、`platform`、`columns`、`updatedAt` 作为需求状态和字段选择的事实源。
- `core_project`：项目主表；已存在 `requirement_id`、`status`、`platform`，用来归属 project。当前问题不是没有这个字段，而是覆盖率不够，需要先补齐新写入并回填历史可确定数据。
- `mcn_recommendation_items`：机构排名事实表；已经有 `mcn_recommendation_id`、`mcn_run_id`、`requirement_id`、`supplier_id`、`rank_no`，先直接复用。
- `mcn_inquiries`：询价事实表；已经有 `requirement_id`、`project_id`、`inquiry_id`、`supplierId`，可以直接拿来恢复回收链路。
- `mcn_ingest_jobs`：入库任务表；已经有 `job_id`、`status`、`inquiry_ids_json`、`results_json`、`export_data_json`。
- `submission_batches`：提报批次表；已经有 `batch_id`、`requirement_id`、`status`。
- `manual_sourced_creators` / `manual_sourced_creator_full_rankings`：手动拓展批次和结果事实表；已经有 `requirement_id`、`batch_id`、`platform`。
- `core_creatorprofiletask` / `core_creatorprofiletaskitem`：达人详情补全任务状态表；先直接复用任务状态，不单独复制一份 workflow 批次表。
- `core_distribution` / `core_ratecarddistribution` / `core_submissionstatesnapshot`：分发和回收状态事实表；继续作为发送、打开、提交等状态来源。
- `mcp_tool_call_ledger`：调用账本；表已经有了，只是现在还是空的，应该优先启用，而不是再造第二张账本表。

### 先补最少的字段和索引，不急着造大表

优先只做这些最小补强：

1. `core_project.requirement_id`：对新项目改成必写，并补索引；历史数据能回填的回填，补不上的保留空值。
2. `mcp_tool_call_ledger`：正式启用，把关键工具的 `started / succeeded / failed / result_unknown` 写进去。
3. 如果现有 summary 字段还不够用，优先在 `mcp_tool_call_ledger` 上补最少字段，比如 `error_code`、`operation_id`、`payload_ref`，不要先建一整套新账本。
4. 只有当“超长原文无处可挂”这个问题确实用现表解决不了时，再考虑补一张很薄的 `workflow_payloads`；它只管挂长输出，不管承载整套业务状态。

### `get_workflow_state` 先怎么拼现有事实

第一阶段先按 requirement 维度回表，不急着引入新的 workflow 主表：

- 需求和字段选择：查 `customer_demands`
- project 和发送归属：查 `core_project`、`core_distribution`、`core_ratecarddistribution`
- 机构排名：查 `mcn_recommendation_items`
- inquiry 和回收：查 `mcn_inquiries`、`core_submissionstatesnapshot`
- 入库状态：查 `mcn_ingest_jobs`
- 达人精排：查 `recommendation_runs`、`creator_recommendation_items`
- 提报批次：查 `submission_batches`
- 手动拓展：查 `manual_sourced_creators`、`manual_sourced_creator_full_rankings`
- 达人详情补全：查 `core_creatorprofiletask`、`core_creatorprofiletaskitem`
- 调用历史和最近错误：查 `mcp_tool_call_ledger`

这套方案的重点是：**先把已有事实源串起来，再看还有哪些洞必须补字段，不要一开始就复制一整层 workflow 数据。**

## 各工具应该如何写入现有表

### `validate_requirement`

- requirement 主事实继续写 `customer_demands`
- `get_workflow_state` 从 `customer_demands.id / status / platform / columns / updatedAt` 判断“需求是否创建”“字段是否已配置”
- 同时补一条 `mcp_tool_call_ledger` 摘要，记录这次创建 requirement 是成功、失败还是结果未知

### `select_inquiry_form_fields`

- 字段配置继续写 `customer_demands.columns`
- 不额外新建“字段选择状态表”
- 打开页面、提交成功、超时失败这些过程摘要写 `mcp_tool_call_ledger`

### `search_creators`

- 第一阶段不额外造状态表
- 如果需要保留“最近一次搜索是否成功、是否为空”，优先写进 `mcp_tool_call_ledger.response_summary_json`

### `rank_mcns`

- 机构排名事实继续写 `mcn_recommendation_items`
- `mcn_recommendation_id`、`mcn_run_id`、`requirement_id`、`supplier_id`、`rank_no` 已经足够支撑“是否排过、排了多少家、最新一轮是谁”
- 关键摘要再写进 `mcp_tool_call_ledger`，避免 `get_workflow_state` 只能扫全表猜状态

### `create_with_distributions`

- project 归属继续写 `core_project`
- 分发事实继续写 `core_distribution` / `core_ratecarddistribution`
- 机构询价映射继续写 `mcn_inquiries`
- 必须补强的是：新写入的 `core_project` 要稳定带 `requirement_id`
- 发送结果摘要、部分成功、结果未知、错误码统一写 `mcp_tool_call_ledger`

### `sync_mcn_inquiry_status`

- inquiry 主事实继续看 `mcn_inquiries`
- 打开、填写、提交、回收完成等状态继续看 `core_submissionstatesnapshot`
- 本次同步拿回了哪些真实 `inquiry_id`，写入 `mcp_tool_call_ledger.response_summary_json`

### `ingest_mcn_submissions`

- 入库任务继续写 `mcn_ingest_jobs`
- `job_id`、状态、涉及哪些 inquiry，直接复用现有字段
- 同时写 ledger，明确这次是 `started`、`succeeded`、`failed` 还是 `result_unknown`

### `get_ingest_job`

- 继续更新和读取 `mcn_ingest_jobs.status / results_json / export_data_json`
- 不再单独造“ingest workflow 表”
- 超长结果不回 Agent 全文，优先写 summary，必要时留 `payload_ref`

### `rank_creators`

- run 事实继续用 `recommendation_runs`
- 明细继续用 `creator_recommendation_items`
- `get_workflow_state` 只汇总“有没有跑、最近 run 是哪次、当前状态是什么”，不复制一份 creator ranking 状态表

### `create_submission_batch`

- 提报批次继续写 `submission_batches`
- `batch_id`、`requirement_id`、`status` 已经够用
- 生成成功与否、导出链接摘要继续写 ledger

### `get_creator_detail`

- 达人详情补全任务继续写 `core_creatorprofiletask`
- 单个 item 状态继续写 `core_creatorprofiletaskitem`
- `get_workflow_state` 只需要汇总任务级状态，不再另造 creator detail workflow 表

### `get_creator_detail_export`

- 继续从 `core_creatorprofiletask` / `core_creatorprofiletaskitem` 读取完成态
- 导出结果只保留摘要和引用，避免把长明细塞回上下文

### `manual_source_creators`

- 手动拓展结果继续写 `manual_sourced_creators`
- 如果已经同步拿到最终结果，不新增状态表，直接从现表汇总 `requirement_id`、`batch_id`、`platform`
- 异步 batch 的提交摘要写 ledger

### `manual_source_creators_status`

- 手动拓展批次状态继续看 `manual_sourced_creators` 和 `manual_sourced_creator_full_rankings`
- 是否已经产出结果、是否已经可导出，先从现表判断
- 最近一次轮询结果、错误和继续查询建议写 ledger

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

### 第二阶段：先复用现有表，把 requirement 链路串起来

1. 先补齐 `core_project.requirement_id` 的新写入和历史可回填数据
2. 正式启用 `mcp_tool_call_ledger`
3. 让 `get_workflow_state` 先从 `customer_demands`、`core_project`、`mcn_recommendation_items`、`mcn_inquiries`、`mcn_ingest_jobs`、`submission_batches`、`manual_sourced_*`、`core_creatorprofiletask` 读取状态
4. 只有当现有表确实承载不了长输出引用或最近错误摘要时，再补最小字段或一张很薄的 payload 表

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

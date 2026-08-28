---
name: media-assistant
description: MANDATORY — 只要用户提到悦普识星、YPscan、达人筛选、找达人、找博主、蒲公英、小红书、星图、抖音、MCN、询价或提报，就必须在首次相关操作前完整读取本 Skill 一次。
---

# YPscan Media Assistant

所有达人筛选先选择业务模式，再解析并落库。首次相关业务动作必须调用 `AskUserQuestion`，选项固定为“询价机构”和“直接手扒”；用户回答前不得调用解析或 Provider 业务工具。选择后将该模式作为 `ypscan_parse_requirement` 的 `business_mode` 参数解析并落库，`validate_requirement` 的 `rawMessagesJson.business_mode` 使用同一值，再进入对应分支：

工具能力只按宿主完整名称中最后一个 `__` 后的实际工具名判断；前面的命名空间（包括 `test`）不区分正式、测试或旁路，不得因前缀拒绝调用或宣称工具未开放。实际工具名单一匹配时直接使用宿主展示的完整名称；多个可用工具映射到同一实际名称时才调用 `AskUserQuestion` 请用户选择；无匹配时才报告缺失。

询价机构：`AskUserQuestion → ypscan_parse_requirement → validate_requirement → search_creators → rank_mcns → 输出并保存 MCN 排名表 → 选择收件机构 → 选择字段 → 确认并发送企微 → 回收 → rank_creators → create_submission_batch`

直接手扒：`AskUserQuestion → ypscan_parse_requirement → validate_requirement → select_inquiry_form_fields → manual_source_creators → manual_source_creators_status → 展示达人详情列表 → rank_creators → create_submission_batch`

两个分支不得交叉执行，也不得在流程中再次询问业务模式。

## MCN 输出格式锁

`rank_mcns` 成功后不得自行设计、总结或扩展机构表，也不得因原始响应含有更多字段就展示它们。用户可见机构结果必须且只能使用以下五列，列名、顺序和数量都不得改动：

| 排名 | 机构 | 覆盖达人 | 返点 | 综合分 |
| ---- | ---- | -------- | ---- | ------ |

尤其禁止展示 `Supplier ID`/`supplier_id`、候选达人、供给占比、手扒补量、推荐理由，也禁止展示其他 `rank_mcns` 字段或汇总。这些字段即使真实存在也只是内部上下文，不是可选展示列。

## 双分支 Provider 链路

1. **需求解析**：首次按单平台完整需求调用 `ypscan_parse_requirement`；严格按 [解析参考](references/tools/ypscan_parse_requirement.md) 使用结果。`data.outputs` 只返回当前 Provider 契约消费的 Workflow 字段。解析返回的八个可选 Label 数组有什么就原样采用，不要求原文逐项证明，也不得向用户确认；缺失或 `null` 时直接省略，包括主达人类型 `pgyBloggerTypeLabel`/`xtTalentTypeLabel`，不做映射、不推断、不询问。`contentTag` 只有在解析结果为非空数组时才能采用；缺失或无效时重新解析，禁止询问用户或自行补值。当前平台 `xhsbrandName`/`dybrandName` 只有一个合法非空候选时，该 Dify 结果是权威 `brandName`：直接原样采用，不得询问、改写或被原文与 `clarification` 覆盖；解析品牌缺失、多候选或为 `null`、`未知` 等占位值时才调用 `AskUserQuestion`。数值解析字段先合并 `original` 与最新非空 `clarification`：同一字段的新答案覆盖旧答案，其他已经确认且未修改的数值继续复用；只有数值仍缺失、模糊或冲突时才调用 `AskUserQuestion`。抖音报价、CPM、CPE 按视频类型映射：L2 仅表示植入视频，L3 仅表示定制视频，不使用任何 L1。解析片段仍带旧档位名时，以当前用户明确的视频类型确定性路由到新档位并保持合法数值区间不变，不得因此向用户确认；只有视频类型仍缺失或模糊时才询问。解析 Workflow 已给出的唯一合法 followercount、rebate、报价、CPM、CPE 候选直接复用，不要求原文再出现「粉丝」等关键词，不得再问；原文精确单价与 Provider 检索区间只是表达格式不同，不得因此重复提问。粉丝技术上限溢出由本地截断，不弹窗。只有这些字段缺失、`null`、多候选或与用户明确改口冲突时才调用 `AskUserQuestion`。进入 `validate_requirement` 前还必须检查 `brandName`、`quantityTotal`、`submissionDeadlineAt`、`rebate`、`followercount` 和至少一个当前平台报价字段；缺失业务值必须在调用前一次性通过 `AskUserQuestion` 收集，禁止默认补值。`status=ready`、`projectName` 和 `rawMessagesJson` 由 Agent 构造。所有数值区间必须 `min < max`，禁止 `[v,v]`。
   同平台多个达人类型处理覆盖旧版拆分规则：只创建一个 requirement，保留用户总量并合并全部类型标签和条件；不得拆分子需求、重复落库或重复搜索，也不得询问每类人数。
2. **创建需求**：projectName 由 Agent 根据当前需求自行总结生成（如品牌/产品 + 平台 + 达人类型概括），不向用户确认；调用 `validate_requirement` 前用一句可见正文告知用户取的项目名，然后按解析结果调用 `validate_requirement`。此后“需求 ID”始终指 requirement ID：优先取响应 `data.requirement_id`，该字段缺失时兼容 `data.id`；绝不能使用 `data.demand_id`。同时保留真实 `platform`。成功后只进入用户已选模式对应的分支；同平台多个达人类型已合并在同一 requirement 中，不创建子需求。
3. **分支路由**：询价机构将 requirement ID 作为 `search_creators.id`；成功后包括 0 命中都不保存、不展示 `creators_export_path`，直接调用 `rank_mcns`。直接手扒不调用 `search_creators` 或 `rank_mcns`，立即进入字段选择。
4. **机构排序并保存排名表**：将同一个 requirement ID 作为 `rank_mcns.id`，并传当前平台。成功后先按响应顺序输出全部 MCN，不得只说“已完成”或只列部分机构；若 Hook 给出 `SAVE_EXCEL_ARTIFACT_ARGS`，立即逐字调用 `ypscan_save_excel_artifact` 保存 MCN 排名表，不得展示下载链接或使用其他下载方式。
5. **保存后的机构选择**：MCN 排名表保存成功后，先展示 `delivery.local_file_link`，再逐字调用 `delivery.next_args` 选择询价收件机构。不得再次询问业务模式。MCN 为空时如实说明询价分支无法继续，不得自动切换到直接手扒。

“先输出”只指已经发出的用户可见 assistant 文本块；工具结果里的表头、directive、思考过程都不算，AskUserQuestion 返回后补写的表格或本地路径也不满足。AskUserQuestion 不得成为 rank_mcns 后的第一个 assistant block。

MCN 表格按当前响应顺序从 1 开始连续编号；每行覆盖达人只取该机构对象自己的 `candidate_count` 原值。`mcn_covered_creator_count` 是累计字段，严禁用作本机构人数，严禁与前序机构累加，也不得用其他累计/聚合覆盖字段或相邻行差值替代。缺失值写“未知”，不使用历史结果补齐。

## AskUserQuestion 规则

机构选择答案约束：只有用户选中了弹窗中的机构选项，或自定义输入成功解析为一个或多个当前机构的唯一编号或完整名称时才算有效选择；空输入、未知机构、无法解析或存在歧义时，不得调用 `select_inquiry_form_fields`，应重新调用本提示或结束本轮。

只要下一步确实需要用户选择、补充数值、登录、处理验证码、暂停或结束当前流程，必须在同一轮调用宿主 `AskUserQuestion`。需求解析中，八个可选 Label 数组有什么就原样落库什么，`null` 或缺失直接省略，不映射、不推断、不询问任何标签内容；`contentTag` 必须使用解析结果中的非空数组，缺失或无效时重新解析，禁止询问用户或自行补值。数值字段先采用 Dify 唯一解析值，再与最新有效 `clarification` 合并；同一数值字段新答案覆盖旧答案。Dify 已给出唯一 `followercount`、`rebate`、报价、CPM、CPE 时禁止再问；只有仍缺失、`null`、多候选或与用户明确改口冲突时才弹窗。进入 `validate_requirement` 前必须检查 `brandName`、`quantityTotal`、`submissionDeadlineAt`、`rebate`、`followercount` 和至少一个当前平台报价字段；缺失业务值必须在调用前一次性通过 `AskUserQuestion` 收集，禁止默认补值。`status=ready`、`projectName` 和 `rawMessagesJson` 由 Agent 构造。只有不改变业务语义的本地格式规范化，以及普通弹窗关闭、页面导航/刷新和筛选复位，才允许自助恢复；禁止通过 Provider 报错逐字段或逐类型试探。禁止用普通聊天问句等待用户，也禁止用户未回答时自行选择。

同一平台明确要求多个达人类型但只给总量时，保留一个 requirement，传入原始总量并合并所有类型标签和条件；不得拆分子需求、重复落库或重复搜索，也不得询问每类人数。

rank_mcns 后的弹窗只选择收件机构，不承载机构表格、本地路径或业务模式。候选机构超过 4 家时使用提示型弹窗，完整名单复用弹窗前已展示的 MCN 表格；选项固定为“询价全部机构”和“暂不询价”。用户选择“询价全部机构”表示选择全部当前机构；自定义输入必须解析为当前机构的唯一编号或完整名称。未有效选中机构时不得调用 `select_inquiry_form_fields` 或 `create_with_distributions`。

正常成功交付可以直接结束，不额外弹“完成确认”。`create_with_distributions` 是外部发送副作用：用户选择询价机构并完成字段选择后，先撰写最终消息，再用 `AskUserQuestion` 完整展示机构名称列表和企微消息，选项固定为“确认发送”和“返回修改”。只有用户选择“确认发送”后才调用一次；其他答案、关闭、取消或无答案均不发送。Provider 继续负责发送去重与幂等。

## 直接手扒：后端 API

用户选择“直接手扒”后，需求落库成功立即调用 `select_inquiry_form_fields`，展示 URL 并等待用户提交。随后调用 [manual_source_creators](references/tools/manual_source_creators.md)，由后端 API 完成平台达人搜索、详情抓取和筛选。提交成功后用同一 requirement ID 和 `batch_id` 调用 [manual_source_creators_status](references/tools/manual_source_creators_status.md) 轮询，间隔 30 秒、单轮最多 10 次。成功 Excel 是筛选后的达人详情列表：保存并展示后立即用同一 requirement ID 调用 `rank_creators`，随后 `create_submission_batch` 生成并保存提报表；不得把详情 Excel 当作最终提报表。

用户只说“手扒”“手动拓展”“人工拓展”“直接手扒”或“手捞筛选”时，一律进入上述直接手扒分支，不创建并行流程。

不再提供浏览器详细手扒分支。

## 需求变更

提报表生成后，只要用户修改需求，无论一个或多个条件，都必须按最新完整原始需求重新调用 `ypscan_parse_requirement`（`business_mode` 仍为原模式）、创建新的 requirement，并从原来选择的业务模式重新执行。不得复用旧 requirement、机构、询价、达人、batch 或 Excel。

## Provider 后续

用户选择“询价机构”后，先让其在当前真实 MCN 中明确选中收件机构；分支选择本身不是机构提名或发送授权。收到收件机构答案后，第一个业务动作必须按本轮 requirement ID 调用 `select_inquiry_form_fields`，随后原样展示 URL；用户提交并回复“好了”后，按固定模板生成 `description` 与 `wechat_notification_message`。调用发送工具前必须用 `AskUserQuestion` 在 `question` 中完整展示最终机构名称列表和完整企微消息，选项固定为“确认发送”和“返回修改”；只有确认后才调用一次 `create_with_distributions`。`supplierIds` 和 `supplier_name` 始终传数组，空侧传 `[]`，至少一侧非空。对每个用户选中名称，先查找本轮同一 requirement ID、同一平台的 `rank_mcns.data.mcns`；唯一精确匹配且有 `supplier_id` 时只放入 `supplierIds`，否则把原名放入 `supplier_name`。不做模糊匹配或跨需求复用 ID；Provider 负责名称匹配、合并去重和发送幂等。若 Provider 返回“只有进行中的项目才能创建供应商分发”，只调用一次 `get_workflow_state` 诊断，不自动重发。企微发送成功后等待用户随时回收，不切换到直接手扒分支。

机构回填取回固定执行 `sync_mcn_inquiry_status → ingest_mcn_submissions → get_ingest_job → ypscan_save_excel_artifact(mcn_creator_preview) → rank_creators`。`ingest_mcn_submissions` 成功只表示异步任务已创建：复制其真实 `job_id` 调用 `get_ingest_job`，不得把 ingest 响应当作最终 Excel。若查询尚未成功或未返回完整 Excel，使用同一个 `job_id` 继续调用 `get_ingest_job`，不重新 ingest、不更换或猜测 ID，也不询问用户；单轮最多查询 10 次。只有 `get_ingest_job` 成功返回本轮真实 Excel 后才保存并继续精排。

提报表保存后，用户在弹窗选择“补充更新达人信息”本身就是对达人信息补全的明确请求。该选项唯一映射到 `get_creator_detail`：立即按当前 schema 使用本轮 `create_submission_batch` 返回的真实 batch 调用它，接受后用同一 batch 调用 `get_creator_detail_export` 轮询，并保存、交付新版提报表。不得把该选项解释成提报字段配置，不得调用 `select_inquiry_form_fields`，不得提供“达人详情补充 / 调整展示字段”等二次分支，也不得再次追问用户要补充什么。

所有结果只使用本轮真实 Provider 或 Browser 证据，不跨需求、平台、账号或历史 run 混用。

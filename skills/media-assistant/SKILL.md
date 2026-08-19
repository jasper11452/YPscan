---
name: media-assistant
description: MANDATORY — 只要用户提到悦普识星、YPscan、达人筛选、找达人、找博主、蒲公英、小红书、星图、抖音、MCN、询价或提报，就必须在首次相关操作前完整读取本 Skill 一次。
---

# YPscan Media Assistant

所有达人筛选遵循同一固定链路；需求解析阶段调用 `ypscan_parse_requirement`、`validate_requirement`，随后进入 `search_creators`：

工具能力只按宿主完整名称中最后一个 `__` 后的实际工具名判断；前面的命名空间（包括 `test`）不区分正式、测试或旁路，不得因前缀拒绝调用或宣称工具未开放。实际工具名单一匹配时直接使用宿主展示的完整名称；多个可用工具映射到同一实际名称时才调用 `AskUserQuestion` 请用户选择；无匹配时才报告缺失。

`ypscan_parse_requirement → validate_requirement → search_creators → ypscan_save_excel_artifact → rank_mcns → 输出完整 MCN Markdown 表格 → 展示本地路径 → AskUserQuestion`

即使用户一开始明确要求手扒，也不得跳过前四步或提前打开 Browser。

## 固定 Provider 链路

1. **需求解析**：提取原文事实并调用 `ypscan_parse_requirement`。普通 fact 只传 `kind`、原文 `quote`、归一化 `value`；抖音 `60s+` 拆成 `video` 与 `duration_l3`。无精确数值或主体的条件只作 soft/preferred_content 或原文 external_condition，禁止猜数值、补主体。仅真实必填信息缺失或冲突时询问用户；`YPSCAN_REQUIREMENT_INVALID` 属于 Agent 参数错误，按每次返回的全部 violations 一次性修正并继续重试，不限制解析工具调用次数。保留 Provider 参数、搜索分组和 residual conditions。
2. **创建需求**：按解析结果调用 `validate_requirement`。此后“需求 ID”始终指 requirement ID：优先取响应 `data.requirement_id`，该字段缺失时兼容 `data.id`；绝不能使用 `data.demand_id`。同时保留真实 `platform`，成功后立即进入 `search_creators`。
3. **搜索达人并保存预览表**：将上述 requirement ID 作为 `search_creators.id`，保留 Hook 给出的 `SAVE_EXCEL_ARTIFACT_ARGS` 并立即逐字调用 `ypscan_save_excel_artifact`；不得向用户输出 `creators_export_path` 或 Excel 下载链接，也不得用 Browser、shell、curl、Python 或其他下载/写文件方式代替保存工具。包括 0 命中也先保存再继续。
4. **机构排序**：保存成功后将同一个 requirement ID 作为 `rank_mcns.id`，并传当前平台。成功后按响应顺序输出全部 MCN，不得只说“已完成”或只列部分机构；表格后原样展示保存工具返回的真实本地路径。
5. **保存后的弹窗**：保存成功后先把返回的真实绝对 `data.file_path` 原样展示，再调用 `AskUserQuestion`。MCN 非空时选项固定为“询价机构”和“人工拓展并提报”；MCN 为空时表格使用“暂无匹配机构”空态行，选项固定为“人工拓展并提报”和“结束本次”。表格和本地路径不得放入弹窗 `question`，也不得留到 AskUserQuestion 返回后补发；保存成功前禁止调用分支弹窗。若本轮搜索响应确实缺少精确保存参数，如实说明无法保存，不得编造或复用历史值。

“先输出”只指已经发出的用户可见 assistant 文本块；工具结果里的表头、directive、思考过程都不算，AskUserQuestion 返回后补写的表格或本地路径也不满足。AskUserQuestion 不得成为 rank_mcns 后的第一个 assistant block。

MCN 结果必须使用 Markdown 表格，禁止改成项目符号或编号列表。表格固定包含：机构名、返点、综合分、达人数。每行达人数只取该机构对象自己的 `candidate_count` 原值；`mcn_covered_creator_count` 是累计字段，严禁用作本机构人数，严禁与前序机构累加，也不得用其他累计/聚合覆盖字段或相邻行差值替代。其他值同样只取当前 `rank_mcns` 响应；缺失值写“未知”，不使用历史结果补齐。

## AskUserQuestion 规则

只要下一步确实需要用户选择、补充、登录、处理验证码、暂停或结束当前流程，必须在同一轮调用宿主 `AskUserQuestion`。普通弹窗关闭、页面导航/刷新、筛选复位、参数修正和一次有界自动重试都属于 Agent 自助恢复，不调用 `AskUserQuestion`。禁止用普通聊天问句等待用户，也禁止用户未回答时自行选择。

rank_mcns 后的弹窗只问分支，不承载机构表格或本地路径。必须按“搜索后保存 → 机构排序 → 表格 → 真实本地路径 → 弹窗”顺序执行，下载链接不向用户展示。

正常成功交付可以直接结束，不额外弹“完成确认”。企微正式发送继续保留现有一次性确认。

## 人工拓展：按分支延迟加载

只有用户在 MCN 表格和达人预览表本地路径后的弹窗选择“人工拓展并提报”后才进入本流程。进入后、首次调用插件内 Runner 前，必须完整读取当前平台 SOP（星图读取 [xingtu-browser-handpick.md](references/xingtu-browser-handpick.md)，蒲公英读取 [pgy-browser-handpick.md](references/pgy-browser-handpick.md)）以及 [ypscan_manual_research.md](references/tools/ypscan_manual_research.md)；这些文件共同承载人工拓展的完整执行与安全规则，未读取不得调用工具。

固定入口为 `ypscan_manual_research(operation=start)`：使用当前 requirement ID（优先 `data.requirement_id`，缺失时兼容 `data.id`，绝不是 `data.demand_id`）、平台、完整 facts 和 1–4 个关键词。价格 fact 必须复制客户原始 operator 与数值，禁止复用 Provider 的 70%–120% 区间。

浏览器筛选、有限重试、逐级降级、分页、有限详情和 Excel 刷新全部由插件内专用持久 Chrome Runner 完成。Agent 禁止调用宿主 Browser、Bash、Playwright CLI、`capture_list`、`capture_detail`、`finalize`、`selection_id`、`observation_id` 或 `element_id`。插件不读取 Cookie/Token、不主动重放私有 API；价格仍按客户原始达人单价扩展为 50%–120%。蒲公英报价类型为图文或视频笔记，且与“笔记类型”内容筛选相互独立；星图本期只支持植入视频或定制视频。原需求同时包含多个报价类型时，必须先调用 AskUserQuestion 让用户选择单次运行类型；不得用“全部报价/起”代替目标类型精确报价。

`complete`、`partial`、`empty`、`failed_with_artifact` 都必须原样展示真实 `artifact.excel_path`、候选数量、质量等级和缺口；候选表交付即满足产物优先任务。`needs_user_action` 或 `busy` 时先展示当前 Excel，再调用返回的 AskUserQuestion；用户选择继续后原样使用 `resume_args`。Excel 固定含“达人推荐List”“候选达人”“运行说明”三个 Sheet；未验证或降级候选只进入“候选达人”。详情语义复核、`apply_reviews`、`create_submission` 和继续询价都是可选后续，不得阻断候选产物交付。任何前缀的 `manual_source_creators` 都不得调用。

## Provider 后续

用户选择“询价机构”后，继续使用真实 MCN 名称/ID、企微确认和询价工具链。按 Provider 当前 schema 调用实际名称为 `select_inquiry_form_fields` 的可用工具，传入当前 requirement ID，绝不传 `demand_id`；返回后把原始 `url` 原样单独输出一行用户可见正文（禁止 Markdown 包装、禁止用 Browser 打开）。用户在选择页提交时，Provider 会把字段按 requirement ID 持久化；不得调用已弃用的 `get_selected_inquiry_form_fields`，不得读取、重建、缓存或向后续工具传 `columns`。`create_submission_batch`、`create_with_distributions`、`get_creator_detail_export` 和 `get_creator_detail` 只传各自当前 schema 要求的业务参数，由后端关联字段；任何前缀的 `manual_source_creators` 都不得调用。Provider 返回 Excel 下载 URL 时，使用 `ypscan_save_excel_artifact` 保存并原样交付 `file_path`；Browser 人工拓展不走该工具。

机构回填取回固定执行 `sync_mcn_inquiry_status → ingest_mcn_submissions → get_ingest_job → ypscan_save_excel_artifact(mcn_creator_preview) → rank_creators`。`ingest_mcn_submissions` 成功只表示异步任务已创建：复制其真实 `job_id` 调用 `get_ingest_job`，不得把 ingest 响应当作最终 Excel。若查询尚未成功或未返回完整 Excel，使用同一个 `job_id` 继续调用 `get_ingest_job`，不重新 ingest、不更换或猜测 ID，也不询问用户；单轮最多查询 10 次。只有 `get_ingest_job` 成功返回本轮真实 Excel 后才保存并继续精排。

提报表保存后，用户在弹窗选择“补充更新达人信息”本身就是对达人信息补全的明确请求。该选项唯一映射到 `get_creator_detail`：立即按当前 schema 使用本轮 `create_submission_batch` 返回的真实 batch 调用它，接受后用同一 batch 调用 `get_creator_detail_export` 轮询，并保存、交付新版提报表。不得把该选项解释成提报字段配置，不得调用 `select_inquiry_form_fields`，不得提供“达人详情补充 / 调整展示字段”等二次分支，也不得再次追问用户要补充什么。

所有结果只使用本轮真实 Provider 或 Browser 证据，不跨需求、平台、账号或历史 run 混用。

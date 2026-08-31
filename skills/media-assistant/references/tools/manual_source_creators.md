# manual_source_creators

手动拓展的默认入口。首次以手动拓展处理新 requirement 时先执行 `select_inquiry_form_fields`；从同一会话已完成或明确停止的询价功能切换而来、且同一 requirement 已提交字段配置时直接复用，不重复选择。随后使用同一真实 `requirement_id` 和用户要求的正整数交付人数 `num` 提交任务，由 Provider 后台全自动完成手动拓展。`demand` 是 live schema 支持时才传的可选字段，只透传当前完整原文，不传解析输出或 `rawMessagesJson`。提交成功后可能同步直接返回 Excel，也可能异步返回抖音任务 `batch_id`；两种路径都只使用该次真实 Provider 响应，不猜测其他返回形态。

调用前先读取当前 `manual_source_creators` 的实际 input schema：如果 schema 明确提供了用于需求原文的可选字段 `demand`，优先把当前完整、未改写的用户原始需求文本放入该字段；只传原文，不传解析输出或 `rawMessagesJson`。如果 schema 没有这个字段，或 Provider 因不支持该可选字段拒绝调用，则只传 `requirement_id` 和 `num`；未知参数导致的失败最多去掉原文字段重试一次，不得改变这两个必填值，也不得用该回退掩盖其他业务错误。不要猜测字段名或强行扩展当前 schema。

若 Provider 返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED`，不得原参数重试；重新进入字段选择步骤。

“手动拓展”“人工拓展”“直接手扒”“手扒”“手捞筛选”都默认指向本 MCP 工具；除“手动拓展”外的旧说法只作为输入别名，用户侧统一称“手动拓展”。

如果提交响应同步直接返回 Excel URL，则立刻把它作为 `ypscan_save_excel_artifact` 的内部参数，使用 `artifact_kind="manual_source"` 和同一 `requirement_id` 保存到当前项目并结束。若提交响应返回异步 `batch_id`，先输出进度提示，再等待 30 秒，用同一 `requirement_id` 和返回的整数 `batch_id` 第 1 次调用 `manual_source_creators_status`（见该工具卡）。轮询成功拿到 Excel URL 后，把它作为 `ypscan_save_excel_artifact` 的内部参数，使用 `artifact_kind="manual_source"` 和同一 `requirement_id` 保存到当前项目。Provider 下载链接不作为最终交付；必须原样展示保存结果中的 `delivery.local_file_link` Markdown 超链接，不得只输出裸 `file_path`。

本地保存成功后，把该 Excel 作为后台搜索、详情抓取和筛选后的最终手动拓展结果展示并结束本次手动拓展。不得调用 `rank_creators`、`create_submission_batch` 或补充达人信息弹窗。不再提供浏览器详细拓展分支。

# manual_source_creators

人工拓展的默认入口。若当前对话已有同一 `requirement_id` 的字段选择链接和用户明确回复提交完成的证据，直接复用 Provider 持久化字段，不得再次调用 `select_inquiry_form_fields`；没有该证据时，先执行 `select_inquiry_form_fields`，原样展示 URL，并等待用户在页面提交字段后回复“好了”。随后使用同一真实 `requirement_id` 和用户要求的正整数交付人数 `size`，由 Provider 后台全自动完成手扒并在同一响应返回 Excel。

调用前先读取当前 `manual_source_creators` 的实际 input schema：如果 schema 明确提供了用于需求原文的可选字段，优先把当前完整、未改写的用户原始需求文本放入该字段；只传原文，不传解析输出或 `rawMessagesJson`。如果 schema 没有这个字段，或 Provider 因不支持该可选字段拒绝调用，则只传 `requirement_id` 和 `size`；未知参数导致的失败最多去掉原文字段重试一次，不得改变这两个必填值，也不得用该回退掩盖其他业务错误。不要猜测字段名或强行扩展当前 schema。

若 Provider 返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED`，不得原参数重试；重新进入字段选择步骤。

“手扒”“手动拓展”“人工拓展”“直接手扒”“手捞筛选”都默认指向本 MCP 工具。

成功后立即把返回的 Excel URL 作为 `ypscan_save_excel_artifact` 的内部参数，使用 `artifact_kind="manual_source"` 和返回的 `batch_id` 保存到当前项目。Provider 下载链接不作为最终交付；必须原样展示保存结果中的 `delivery.local_file_link` Markdown 超链接，不得只输出裸 `file_path`。

本地保存成功后，直接把该本地 Excel 作为人工拓展交付，不再提供浏览器详细手扒分支。

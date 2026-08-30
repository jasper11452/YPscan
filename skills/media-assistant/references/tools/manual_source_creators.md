# manual_source_creators

直接手扒的默认入口。首次以直接手扒处理新 requirement 时先执行 `select_inquiry_form_fields`；从同一会话已完成或明确停止的询价功能切换而来、且同一 requirement 已提交字段配置时直接复用，不重复选择。随后使用同一真实 `requirement_id` 和用户要求的正整数交付人数 `size` 提交任务，由 Provider 后台全自动完成手扒。提交成功只返回任务 `batch_id`，不含 Excel；Excel 必须通过 [manual_source_creators_status](manual_source_creators_status.md) 轮询获取，不得把提交响应当成最终结果。

调用前先读取当前 `manual_source_creators` 的实际 input schema：如果 schema 明确提供了用于需求原文的可选字段，优先把当前完整、未改写的用户原始需求文本放入该字段；只传原文，不传解析输出或 `rawMessagesJson`。如果 schema 没有这个字段，或 Provider 因不支持该可选字段拒绝调用，则只传 `requirement_id` 和 `size`；未知参数导致的失败最多去掉原文字段重试一次，不得改变这两个必填值，也不得用该回退掩盖其他业务错误。不要猜测字段名或强行扩展当前 schema。

若 Provider 返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED`，不得原参数重试；重新进入字段选择步骤。

“手扒”“手动拓展”“人工拓展”“直接手扒”“手捞筛选”都默认指向本 MCP 工具。

提交成功后立即用同一 `requirement_id` 和返回的整数 `batch_id` 调用 `manual_source_creators_status` 轮询（见该工具卡）。轮询成功拿到 Excel URL 后，把它作为 `ypscan_save_excel_artifact` 的内部参数，使用 `artifact_kind="manual_source"` 和同一 `requirement_id` 保存到当前项目。Provider 下载链接不作为最终交付；必须原样展示保存结果中的 `delivery.local_file_link` Markdown 超链接，不得只输出裸 `file_path`。

本地保存成功后，把该 Excel 作为后台搜索、详情抓取和筛选后的最终手扒结果展示并结束本次手扒。不得调用 `rank_creators`、`create_submission_batch` 或补充达人信息弹窗。不再提供浏览器详细手扒分支。

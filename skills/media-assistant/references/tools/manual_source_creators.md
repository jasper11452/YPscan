# manual_source_creators

手动拓展的默认入口。每次开始手动拓展都先解析、复核并创建独立的新 requirement，再使用该 requirement 调用 `select_inquiry_form_fields`；即使从同一会话已完成或明确停止的询价功能切换而来、且业务条件未变，也不得复用询价 requirement 或字段配置。随后使用当前真实 `requirement_id` 和用户要求的正整数交付人数 `num` 提交任务，由 Provider 后台全自动完成手动拓展。`demand` 是 live schema 支持时才传的可选字段，只透传当前完整原文，不传解析输出或 `rawMessagesJson`。提交成功后可能同步返回 links CSV，也可能异步返回抖音任务 `batch_id`；旧 Provider 仍可能返回兼容 Excel，这一分支只作为降级路径。

调用前先读取当前 `manual_source_creators` 的实际 input schema：如果 schema 明确提供了用于需求原文的可选字段 `demand`，优先把当前完整、未改写的用户原始需求文本放入该字段；只传原文，不传解析输出或 `rawMessagesJson`。如果 schema 没有这个字段，或 Provider 因不支持该可选字段拒绝调用，则只传 `requirement_id` 和 `num`；未知参数导致的失败最多去掉原文字段重试一次，不得改变这两个必填值，也不得用该回退掩盖其他业务错误。不要猜测字段名或强行扩展当前 schema。

若 Provider 返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED`，不得原参数重试；重新进入字段选择步骤。

“手动拓展”“人工拓展”“直接手扒”“手扒”“手捞筛选”都默认指向本 MCP 工具；除“手动拓展”外的旧说法只作为输入别名，用户侧统一称“手动拓展”。

如果提交响应同步直接返回 `creator_links_csv_url`，立刻把它作为 `ypscan_save_csv_artifact` 的内部参数，使用 `artifact_kind="manual_creator_links"` 和同一 `requirement_id` 保存到当前项目。若提交响应返回异步 `batch_id`，先输出进度提示，再等待 30 秒，用同一 `requirement_id` 和返回的整数 `batch_id` 第 1 次调用 `manual_source_creators_status`（见该工具卡）。轮询成功拿到 `creator_links_csv_url` 后，同样先保存到当前项目。links CSV 保存成功后，必须原样展示保存结果中的 `delivery.local_file_link` Markdown 超链接，不得只输出裸 `file_path`；然后按平台分 20 个 author 一批调用原生达人补全工具，小红书使用 `get_xhs_author_business_card` 且固定 `page_count=1`，抖音使用 `get_douyin_author_business_card`。每批只信任 `csv_file`、`successful_author_ids`、`failed_author_ids`；全部补全批次完成后执行 `ypscan_merge_creator_csv → ypscan_upload_creator_csv → score_manual_source_csv → 保存最终 Excel`。

当前仓库没有可验证的生产 CSV 暂存端点契约，因此非测试模式下 `ypscan_upload_creator_csv` 会明确返回 `YPSCAN_CREATOR_CSV_UPLOAD_UNAVAILABLE`；不得猜测真实上传接口。

若提交响应只返回兼容 Excel URL，则立刻把它作为 `ypscan_save_excel_artifact` 的内部参数，使用 `artifact_kind="manual_source"` 和同一 `requirement_id` 保存到当前项目，作为旧链路降级结果。该降级路径不进入 CSV 补全/打分链路。

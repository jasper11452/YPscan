# manual_source_creators

手动拓展的默认入口。每次开始手动拓展都先解析、复核并创建独立的新 requirement，再使用该 requirement 调用 `select_inquiry_form_fields`；即使从同一会话已完成或明确停止的询价功能切换而来、且业务条件未变，也不得复用询价 requirement 或字段配置。字段选择 URL 输出后结束本轮，只有用户为这个 requirement 提交字段页并明确回复“好了”后，才使用当前真实 `requirement_id` 提交任务，由 Provider 后台全自动完成手动拓展；用户关于其他 requirement 的“不再选字段”要求不是当前提交证据，不得试调本工具探测 Provider 是否会强制报错。

## Remote arguments

- `requirement_id`：Provider-required string，本轮唯一必传基础参数，只传当前真实 requirement ID。
- `num`：仅当当前环境的 live schema 将其列为 required 时传正整数目标数量；测试基线 `https://test-mcp.eshypdata.com/mcp` 当前不要求该字段，生产环境 schema 若漂移，以 live schema 为准。
- `demand`：可选 string，live schema 支持时才传，只透传当前完整原文，不传解析输出或 `rawMessagesJson`。

`num` 不得靠前台多轮试错探测；只能按当前 live schema 确定性决定是否传入。每批交付数量的业务含义仍由手动拓展目标数量决定。

## 调用

调用前先读取当前 `manual_source_creators` 的实际 input schema：只按 live schema 传参。如果 schema 明确提供了用于需求原文的可选字段 `demand`，优先把当前完整、未改写的用户原始需求文本放入该字段；只传原文，不传解析输出或 `rawMessagesJson`。如果 schema required 含 `num`，则与 `requirement_id` 一并传入；如果 schema 不含 `num`，则不得附带。未知参数导致的失败最多去掉原文字段重试一次，不得改变 `requirement_id`，也不得用该回退掩盖其他业务错误。不要猜测字段名或强行扩展当前 schema。

若 Provider 返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED` 或 `REQUIREMENT_COLUMNS_UNAVAILABLE`，不得原参数重试；使用同一 requirement 重新进入字段选择，原样展示 URL 后结束本轮等待用户回复“好了”。Provider 应在启动本工具时做该校验并立即返回，不应把缺列错误延迟到打分终态；这是 Provider 侧 fail-fast 契约要求，插件不为此新增 columns 缓存或本地账本。

“手动拓展”“人工拓展”“直接手扒”“手扒”“手捞筛选”都默认指向本 MCP 工具；除“手动拓展”外的旧说法只作为输入别名，用户侧统一称“手动拓展”。

## 提交后三态

- 同步 links CSV：提交响应直接返回 `creator_links_csv_url` 时，立刻调用 `ypscan_save_artifact`，使用 `artifact_kind="manual_creator_links"`、同一 `requirement_id` 作为 `artifact_id`，并把该 URL 原样传为 `file_url` 保存到当前项目。原样展示保存结果中的 `delivery.local_file_link` Markdown 超链接（不得只输出裸 `file_path`），再进入原生达人补全。
- 异步 batch：提交响应返回 `batch_id` 时，先输出进度提示，再等待 30 秒，用同一 `requirement_id` 和返回的整数 `batch_id` 第 1 次调用 `manual_source_creators_status`（见该工具卡）。Hook 会额外提供 `MANUAL_SOURCE_TARGET_NUM`；只有当前环境 live schema required `num` 时，才把该值并入状态查询。轮询成功拿到 `creator_links_csv_url` 后，同样先保存到当前项目。
- 兼容 Excel：若提交响应只返回兼容 Excel URL，则立刻调用 `ypscan_save_artifact`，使用 `artifact_kind="manual_source"`、同一 `requirement_id` 作为 `artifact_id`，并把该 URL 原样传为 `file_url` 保存到当前项目，作为旧链路降级结果。该降级路径不进入 CSV 补全/打分链路。

links CSV 保存成功后，按平台分 20 个 author 一批调用原生达人补全工具，小红书使用 `get_xhs_author_business_card` 且固定 `page_count=1`，抖音使用 `get_douyin_author_business_card`。每批只信任 `csv_file`、`successful_author_ids`、`failed_author_ids`；全部补全批次完成后执行 `file_bridge（内部合并并上传）→ score_manual_source_csv → score_manual_source_csv_status → 保存最终 Excel`。

`file_bridge` 会把 merged CSV 上传到 OSS，并返回当前真实可读的未签名 `csv_file_path`。若上传后匿名地址不可读，则停止后续打分，不得自造 URL 或改走其他上传路径。

# manual_source_creators

手动拓展的默认入口。每次开始手动拓展都先解析、复核并创建独立的新 requirement，再使用该 requirement 调用 `select_inquiry_form_fields`；即使从同一会话已完成或明确停止的询价功能切换而来、且业务条件未变，也不得复用询价 requirement 或字段配置。字段选择 URL 输出后结束本轮，只有用户为这个 requirement 提交字段页并明确回复“好了”后，才使用当前真实 `requirement_id` 提交任务，由 Provider 后台全自动完成手动拓展；用户关于其他 requirement 的“不再选字段”要求不是当前提交证据，不得试调本工具探测 Provider 是否会强制报错。

## Remote arguments

- `requirement_id`：Provider-required string，唯一入参，只传当前真实 requirement ID。

不传 `demand`、`num`、解析输出或 `rawMessagesJson`。需求文本由 Provider 从后台读取；首次搜索和放宽重跑均只传 `requirement_id`。完整有效需求、澄清和已确认放宽仍须先解析、复核并通过 `validate_requirement` 保存。

搜索响应若回传实际搜索参数，必须与已确认放宽值逐项核对：不一致时如实报告“放宽未传导到搜索、实际参数仍为 X”，不得把结果归因于放宽或宣称放宽成功。

## 调用

固定调用 `manual_source_creators({requirement_id})`；不添加需求原文或其他参数，不通过增删 `demand` 重试。

若 Provider 返回 `REQUIREMENT_COLUMNS_NOT_CONFIGURED` 或 `REQUIREMENT_COLUMNS_UNAVAILABLE`，不得原参数重试；使用同一 requirement 重新进入字段选择，原样展示 URL 后结束本轮等待用户回复“好了”。Provider 应在启动本工具时做该校验并立即返回，不应把缺列错误延迟到打分终态；这是 Provider 侧 fail-fast 契约要求，插件不为此新增 columns 缓存或本地账本。

“手动拓展”“人工拓展”“直接手扒”“手扒”“手捞筛选”都默认指向本 MCP 工具；除“手动拓展”外的旧说法只作为输入别名，用户侧统一称“手动拓展”。

## 提交后三态

- 同步 links CSV：提交响应直接返回 `creator_links_csv_url` 时，立刻调用 `ypscan_save_artifact`，使用 `artifact_kind="manual_creator_links"`、同一 `requirement_id` 作为 `artifact_id`，并把该 URL 原样传为 `file_url` 保存到当前项目。保存结果中的 CSV 是内部中间产物，不主动展示表格、链接或本地路径；该文件是原始 Provider 下载物（可能只有 url 列），不得直接用于补全或 file_bridge，必须先按下方归一化步骤处理。
- 异步 batch：提交响应返回 `batch_id` 时，先输出进度提示，再等待 30 秒，用同一 `requirement_id` 和返回的整数 `batch_id` 第 1 次调用 `manual_source_creators_status`（见该工具卡）。Hook 会额外提供 `MANUAL_SOURCE_TARGET_NUM`；只有当前环境 live schema required `num` 时，才把该值并入状态查询。轮询成功拿到 `creator_links_csv_url` 后，同样先保存到当前项目并归一化。
- 兼容 Excel：若提交响应只返回兼容 Excel URL，则立刻调用 `ypscan_save_artifact`，使用 `artifact_kind="manual_source"`、同一 `requirement_id` 作为 `artifact_id`，并把该 URL 原样传为 `file_url` 保存到当前项目，作为旧链路降级结果。该降级路径不进入 CSV 补全/打分链路。

links CSV 保存成功后，先调用 `ypscan_save_creator_links({requirement_id, platform, links_csv_path})` 归一化：读取保存的原始 CSV，写出受控三列 links CSV（`source_record_id,creator_id,url`）并登记为当前 requirement 的合法 links 来源；只有 url 列时按平台主页规则推导 creator_id，短链或无法推导时立即失败并停止，不进入原生补全。归一化成功后先调用 `ypscan_summarize_manual_scores({requirement_id})`，再仅按返回的 `next_author_ids` 调用当前平台原生达人补全工具（首批不超过 min(20, 需求人数)，之后每批最多 20 人），小红书使用 `get_xhs_author_business_card` 且固定 `page_count=1`，抖音使用 `get_douyin_author_business_card`。每批只信任 `csv_file`、`successful_author_ids`、`failed_author_ids`；每批完成后执行 `file_bridge（仅当前批 CSV）→ score_manual_source_csv → score_manual_source_csv_status → 保存 manual_score_batch → ypscan_summarize_manual_scores`，推荐人数达标或梯度候选池耗尽后交付汇总 Excel，否则再补全下一批。

`file_bridge` 会把 merged CSV 上传到 OSS，并返回当前真实可读的未签名 `csv_file_path`。若上传后匿名地址不可读，则停止后续打分，不得自造 URL 或改走其他上传路径。

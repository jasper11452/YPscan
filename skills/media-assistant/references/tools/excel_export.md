# excel_export

Risk tier: final delivery. Exports the creator-detail table for the 只扒达人信息 mode only. The inquiry and manual-sourcing modes keep using `ypscan_summarize_manual_scores` and never call this tool.

## When to call

只在「只扒达人信息」模式调用。字段是否已提交不由 agent 提前确认，而是由本工具后端查 `get_creator_detail_run.columns` 校验。完整链路：

1. 用户给平台 + 一批达人 ID 或链接。
2. `select_inquiry_form_fields`（不传 `requirement_id`，传 `platform` + `creator_ids`/`creator_links`）→ 拿到 `field_id` 和字段选择页 URL。
3. 正文单独一行原样展示 URL 让用户去选字段。
4. 平台原生达人补全工具补全这批达人，`file_bridge` 上传补全 CSV 得到 `source_csv_file_link`。
5. 用户上传了自定义表格时，`file_bridge` 上传它得到 `custom_table_oss_url`（可选）。
6. 直接调本工具；后端查表：columns 已生成则导出，未生成则返回「未选择字段」+ URL，等用户提交后重试。

## Arguments

| Parameter            | Type   | Required | Meaning                                                                   |
| -------------------- | ------ | -------- | ------------------------------------------------------------------------- |
| field_id             | string | yes      | 字段选择会话主键，即 `select_inquiry_form_fields` 无需求时返回的 field_id |
| source_csv_file_link | string | yes      | 补全后的达人 CSV 经 file_bridge 上传 OSS 后的链接                         |
| custom_table_oss_url | string | no       | 用户自定义表格的 OSS 链接；不传用固定格式，传了按表格字段插值             |

## Validation and errors

- `field_id` 不存在，或对应 columns 仍为空（字段页未提交）→ 返回「未选择字段」错误并附字段选择 URL；重新单独一行原样展示该 URL 等用户提交后用同一 `field_id` 重试，不得替用户选字段、不得重开字段选择。
- `source_csv_file_link` 无效（无法解析 / 下载失败 / 无有效行）→ 返回明确错误；用 `file_bridge` 重新上传补全 CSV 得到新链接，再用同一 `field_id` 重试，不得复用旧链接。

## Result

- 成功：`data.file_url` 返回达人表下载链接。无 `custom_table_oss_url` 时按用户选中的 columns 生成固定格式表格（样式与 manual-score-summary 一致，列按 columns 裁剪）；有 `custom_table_oss_url` 时下载解析自定义模板字段并插入达人数据。
- 把下载链接作为最终交付单独展示给用户；不展示 `field_id`，不把补全 CSV 或字段页 URL 当成交付物。
- 失败时对应 `get_creator_detail_run.status` 置为 `failed`，成功置为 `exported`（后端行为）。

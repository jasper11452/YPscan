# manual_source_creators_status

默认手扒任务的唯一状态查询与结果获取入口。`manual_source_creators` 提交成功后必须调用本工具轮询，直到拿到 Excel 或达到轮询上限。

## Remote arguments

| Argument | Constraint |
| --- | --- |
| `requirement_id` | Provider-required string；只传本轮 `manual_source_creators` 同一真实 requirement ID |
| `batch_id` | Provider-required integer；只传本轮 `manual_source_creators` 返回的任务 batch ID |

不得传 `size`、平台、达人 ID 或任何猜测字段；`batch_id` 是任务 ID，不需要任何转换或推导。

## Polling

- 首次查询前输出一句进度提示（如“后台手扒耗时较长，您可以先不用管，我会继续轮询。”）。这是进度通知，不是问题或确认：不得调用 `AskUserQuestion`，也不得等待回复。
- 本工具既是就绪查询也是最终结果获取。`manual_source_creators` 提交成功后立即调用一次（计为第 1 次），结果仍是 `BATCH_NOT_READY` 时每 30 秒顺序查询一次，不需要用户请求或确认。
- 单轮最多查询 10 次，期间不得重新提交 `manual_source_creators`，不得调用 `AskUserQuestion`，也不得猜测、推导、枚举或更换 requirement ID 或 batch ID。
- 第 10 次仍是 `BATCH_NOT_READY` 时停止，如实报告后台手扒尚未完成，并保留同一 requirement ID 和 batch ID 供后续轮次继续查询。

## Result

- `BATCH_NOT_READY`（含远端 status `0`）表示任务仍在处理中，是预期中间态，不代表 batch ID 传错；按上面的轮询循环继续。
- 成功要求 `success=true` 且返回 HTTPS `excel_file_url`。拿到后立即调用 `ypscan_save_excel_artifact`，使用 `artifact_kind="manual_source"`、同一 `requirement_id` 和该 URL 保存；保存成功后展示 `delivery.local_file_link`，再按保存指令调用 `rank_creators`。不得打开下载链接、用 Browser 或其他方式下载。
- 其他失败：原样展示原始 code 和 message 后停止，不得换 ID 重试或重新提交任务。

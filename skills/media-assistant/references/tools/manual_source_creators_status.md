# manual_source_creators_status

手动拓展任务的唯一状态查询与结果获取入口。`manual_source_creators` 提交返回异步 `batch_id` 后必须调用本工具轮询，直到拿到 links CSV、兼容 Excel 或达到轮询上限。

## Remote arguments

| Argument         | Constraint                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `requirement_id` | Provider-required string；只传本轮 `manual_source_creators` 同一真实 requirement ID                         |
| `batch_id`       | Provider-required integer；只传本轮 `manual_source_creators` 返回的任务 batch ID                            |
| `num`            | 仅当当前环境 live schema 将其列为 required 时传正整数；表示用户需求人数的 3 倍，即每批应取 links URL 的数量 |

不得传 `size`、平台、达人 ID 或任何猜测字段；`batch_id` 是任务 ID，不需要任何转换或推导。

`num = quantityTotal × 3`，需求 30 人时传 90。Hook 通过 `MANUAL_SOURCE_TARGET_NUM` 提供的已是三倍取数数量，直接使用，不得重复乘三。有当前 requirement 需求记录时始终由该人数计算；缺少记录时沿用上一轮已发送的 `num`。最终交付目标与不足判断仍按用户需求人数，不能按三倍取数数量判断。当前环境 schema 不接受 `num` 时不得附带，避免无效重试。

## Polling

- 首次查询前输出一句进度提示（如“后台手动拓展耗时较长，您可以先不用管，我会继续轮询。”）。这是进度通知，不是问题或确认：不得调用 `AskUserQuestion`，也不得等待回复。
- 本工具既是就绪查询也是最终结果获取。`manual_source_creators` 提交成功后先等待 30 秒再调用第 1 次；结果仍是 `BATCH_NOT_READY` 且未达到上限时，再等待 30 秒顺序查询，不需要用户请求或确认。
- 单轮最多查询 10 次，期间不得重新提交 `manual_source_creators`，不得调用 `AskUserQuestion`，也不得猜测、推导、枚举或更换 requirement ID、batch ID 或当前环境 schema 要求的目标数量参数。
- 第 10 次仍是 `BATCH_NOT_READY` 时停止，如实报告后台手动拓展尚未完成，不得自动查询第 11 次，并保留同一 requirement ID、batch ID 和当前环境 schema 对应参数供用户以后明确要求时继续查询。

## Result

- `BATCH_NOT_READY`（含远端 status `0`）表示任务仍在处理中，是预期中间态，不代表 batch ID 传错；按上面的轮询循环继续。
- 成功优先消费当前 Provider 响应中的 `creator_links_csv_url`。拿到后立即调用 `ypscan_save_artifact`，使用 `artifact_kind="manual_creator_links"`、同一 `requirement_id` 作为 `artifact_id`，并把该 URL 传为 `file_url`；保存后不主动展示该 CSV（原始 Provider 下载物，可能只有 url 列，属内部中间产物），直接调用 `ypscan_save_creator_links({requirement_id, platform, links_csv_path})` 归一化为受控三列 links CSV（短链或无法推导 creator_id 时立即失败并停止，不进入原生补全），然后调用 `ypscan_summarize_manual_scores({requirement_id})`，仅按返回的下一批名单原生补全，并继续 `file_bridge（仅当前批 CSV）→ score_manual_source_csv → score_manual_source_csv_status → 保存 manual_score_batch → 再汇总`，推荐人数达标或最多三倍候选耗尽才交付汇总表，否则下一批。merged CSV 数据行超过 500 时 `file_bridge` 必须跳过上传并停止打分；返回匿名不可读 URL 时同样必须停止打分；两者都不主动展示内部 CSV。
- 若旧 Provider 仅返回 HTTPS `excel_file_url`，则作为兼容降级路径立即调用 `ypscan_save_artifact`，使用 `artifact_kind="manual_source"`、同一 `requirement_id` 作为 `artifact_id`，并把该 URL 传为 `file_url`；保存成功后先展示 `delivery.local_file_link` 作为本轮真实手动拓展结果，不调用 `rank_creators` 或 `create_submission_batch`。
- 成功返回 `completed=true`、`selected_count=0`（且 `success_count` 缺失或为 0），无 CSV/Excel 时，表示搜索完成但未找到达人。停止轮询，不展示通用重试/结束弹窗、不创建空文件。先复核有效需求、解析、提交参数和实际搜索参数；参数偏差按纠错处理，不叫放宽。确认参数正确后，按 Skill 优先替换同主题关键词、减少非核心人设限定；该范围已获明确授权时直接执行，否则等待确认。调整后仍不足再提示其他可放宽条件并等待该项确认，不能让用户选择技术排错方向。
- 其他失败：原样展示原始 code 和 message 后停止，不得换 ID 重试或重新提交任务。

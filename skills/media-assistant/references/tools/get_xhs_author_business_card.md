# get_xhs_author_business_card

Risk tier: automatic host operation.

小红书原生达人补全。本工具由宿主 YP Action 提供，不在 ypscan 插件白名单内：宿主未开放该工具时如实报告工具未开放并停止补全链路，不得改用 Browser 或其他手扒工具代替。

## Arguments

- 手动拓展传入 `ypscan_summarize_manual_scores` 返回的 `next_author_ids`；机构回收传入当前 links CSV 中按20个一批切出的 author 标识（按宿主实际 schema 传参）。
- `page_count` 固定传 `1`，不得传其他值。

## Result

每批只信任这三个输出字段：

- `csv_file`：本批补全结果 CSV 的本地/可读路径；某批缺失时停止后续 `file_bridge` 和打分，并原样报告失败达人。
- `successful_author_ids`：本批补全成功的达人 ID。
- `failed_author_ids`：本批补全失败的达人 ID。

部分成功时保留成功 CSV，不自动重试整批；手动拓展每批完成后只传当前批 CSV 给 `file_bridge`，评分并保存为 `manual_score_batch` 后调用 `ypscan_summarize_manual_scores`，达标停止、不足才处理下一批；机构回收仍全部批次完成后调用一次 `file_bridge`。不得把尚未处理候选当补全失败。

## Flow

宿主会按当前对话业务分支固定 merge flow：手动拓展分支与询价机构回收分支均走 `flow=manual_source`（merge 后通过 `file_bridge` 上传 OSS 再打分排序）。

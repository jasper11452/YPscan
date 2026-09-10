# score_manual_source_csv_status

Risk tier: automatic Provider read.

Poll the scoring job created by `score_manual_source_csv`. Call only after that tool returned a `job_id`.

## Arguments

- `job_id`: Provider-required string; the exact job ID returned by the current `score_manual_source_csv` result. Do not pass a requirement ID, a file path, or a job from another run.

## Polling

- First call 30 seconds after `score_manual_source_csv` succeeded. If the score is not finished and the limit is not reached, wait 30 seconds and call again with the same `job_id`; no user request or confirmation is needed.
- Make at most 10 queries in one run. During polling, do not resubmit `score_manual_source_csv`, do not call `AskUserQuestion`, and do not change or guess the job ID.

## Result

- On success, the response contains the final workbook URL. Save it immediately with `ypscan_save_artifact` using `artifact_kind="manual_score_batch"` for manual sourcing, or `artifact_kind="manual_source"` for inquiry retrieval, with the current `requirement_id` as `artifact_id` and the exact workbook URL as `file_url`. For manual sourcing this is an internal intermediate batch: do not show its table, local link or path; immediately call `ypscan_summarize_manual_scores({requirement_id})` to decide whether to continue or deliver the aggregate workbook. For inquiry retrieval, `manual_source` is the final delivery, so show its local link. Do not route either result into `rank_creators` or any enrichment flow.
- If the score is still incomplete, continue polling with the same `job_id`.
- At the 10th query, if the score is still incomplete, stop and truthfully report that background scoring has not finished. Do not query an 11th time. Keep the same `job_id` for a later explicit user request to continue.

## Recoverable missing-columns failure

If the terminal result is `REQUIREMENT_COLUMNS_NOT_CONFIGURED`, `REQUIREMENT_COLUMNS_UNAVAILABLE`, or includes the exact message `customer demand has no selected inquiry columns`, stop polling and do not treat `success_count` as a successful workbook. Call `select_inquiry_form_fields` for the same requirement and platform using its inheritance rules. On a configured/copied result resume immediately; when the field page is an eligible first selection, confirm submission per [get_inquiry_form_fields_status](get_inquiry_form_fields_status.md) (falling back to an explicit “好了” on timeout, reselection or an environment without that tool). Once configured, submit a new scoring job once: if the failure directive carries `SCORE_MANUAL_SOURCE_CSV_ARGS`, reuse that exact JSON payload without altering the path; otherwise use the same requirement ID and the exact trusted `csv_file_path` returned by the current `file_bridge`. Do not repeat search, native completion, or `file_bridge`.

## Stop conditions

Stop on any other failed envelope, a mismatched job ID, or an outcome-unknown result. Do not resubmit the scoring job automatically.

字段恢复使用 [字段工具规则](select_inquiry_form_fields.md)：可继承时传 source_requirement_id；configured/copied 后直接按原可信参数重提一次，失败时暂停，不自动要求重选。

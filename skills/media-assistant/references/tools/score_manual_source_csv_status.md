# score_manual_source_csv_status

Risk tier: automatic Provider read.

Poll the scoring job created by `score_manual_source_csv`. Call only after that tool returned a `job_id`.

## Arguments

- `job_id`: Provider-required string; the exact job ID returned by the current `score_manual_source_csv` result. Do not pass a requirement ID, a file path, or a job from another run.

## Polling

- First call 30 seconds after `score_manual_source_csv` succeeded. If the score is not finished and the limit is not reached, wait 30 seconds and call again with the same `job_id`; no user request or confirmation is needed.
- Make at most 10 queries in one run. During polling, do not resubmit `score_manual_source_csv`, do not call `AskUserQuestion`, and do not change or guess the job ID.

## Result

- On success, the response contains the final workbook URL. Save it immediately with `ypscan_save_artifact` using `artifact_kind="manual_source"`, the current `requirement_id` as `artifact_id`, and the exact workbook URL as `file_url`, then show `delivery.local_file_link` as the final scored-and-sorted delivery. Do not route it into `rank_creators` or any enrichment flow.
- If the score is still incomplete, continue polling with the same `job_id`.
- At the 10th query, if the score is still incomplete, stop and truthfully report that background scoring has not finished. Do not query an 11th time. Keep the same `job_id` for a later explicit user request to continue.

## Stop conditions

Stop on a failed envelope, a mismatched job ID, or an outcome-unknown result. Do not resubmit the scoring job automatically.

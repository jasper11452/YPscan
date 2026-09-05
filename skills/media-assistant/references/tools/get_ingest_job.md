# get_ingest_job

Risk tier: automatic Provider read.

Call after `ingest_mcn_submissions` succeeds. Pass only the exact `job_id` returned by that current ingest call. Do not use an inquiry ID, requirement ID, trace ID, or a job from another retrieval.

This tool reads an asynchronous result. The terminal success states are `succeeded` and `partially_succeeded`. If the job has not reached one of these terminal states, call it again with the same `job_id`; do not rerun `ingest_mcn_submissions`, change or guess the job ID, or ask the user. Make at most 10 queries in one run.

A terminal result returns the retrieval preview as a single Excel (`excel_file_url` / `excel_file_path` / `excel_columns`). It does not return a links CSV. When terminal, first save the preview Excel with `ypscan_save_artifact(artifact_kind="mcn_creator_preview")`, then ask the user whether to complete the creators.

## After the preview save

When the user chooses to complete and score, continue:

1. `read` the saved local Excel to get creator identifiers (小红书 `kw_uid` or homepage; 抖音星图 ID or homepage).
2. Call `ypscan_save_creator_links` with the extracted `source_record_id` / `creator_id` / `url` rows to save a controlled links CSV.
3. Run platform-native completion in batches of 20.
4. Call `file_bridge` with `flow="manual_source"`, then `score_manual_source_csv` and poll `score_manual_source_csv_status`.
5. Save the scored Excel as the final result.

## partially_succeeded

A `partially_succeeded` job has some institutions that submitted and some still pending (`results[]` entries with `error.code="DISTRIBUTION_NOT_SUBMITTED"`). Report truthfully which are pending and which were backfilled, and let the user choose `补全并打分排序` or `暂不补全`. Do not treat partial success as fully complete.

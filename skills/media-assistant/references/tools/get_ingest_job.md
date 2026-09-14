# get_ingest_job

Risk tier: automatic Provider read.

Call after `ingest_mcn_submissions` succeeds. Pass only the exact `job_id` returned by that current ingest call. Do not use an inquiry ID, requirement ID, trace ID, or a job from another retrieval.

This tool reads an asynchronous result. The terminal success states are `succeeded` and `partially_succeeded`. If the job has not reached one of these terminal states, call it again with the same `job_id`; do not rerun `ingest_mcn_submissions`, change or guess the job ID, or ask the user. Make at most 10 queries in one run.

A terminal result returns the retrieval preview as a single Excel (`excel_file_url` / `excel_file_path` / `excel_columns`). It does not return a links CSV. When terminal, first save the preview Excel with `ypscan_save_artifact(artifact_kind="mcn_creator_preview")`, then ask the user whether to complete the creators.

## After the preview save

When the user chooses to complete and score, continue:

1. Take the current saved preview path and confirmed platform; do not use generic `read` on xlsx.
2. Call `ypscan_save_creator_links({requirement_id, preview_file_path, platform})` to parse it and save controlled links. Original previews are unverified source data.
3. Run platform-native completion in batches of 20.
4. Call `file_bridge` with `flow="manual_source"`, then `score_manual_source_csv` and poll `score_manual_source_csv_status`.
5. Save the scored Excel as the final result.

## partially_succeeded

A `partially_succeeded` job can include pending institutions (`results[]` with `error.code="DISTRIBUTION_NOT_SUBMITTED"`) and real processing failures. Report separately. Without results, per-institution details and causes are unknown; do not infer pending institutions from `failed_count`. Preserve the response summary. Backfilled rows are not a verified unique or qualified creator count. Let the user choose `补全并打分排序` or `暂不补全`; do not treat partial success as complete or automatically rerun inquiries.

When partial success includes the current preview Excel, save and deliver it even if some institutions failed. Report real error messages separately; only describe errors as incorrect filling when the response supports that cause. Do not wait for failed institutions to correct their forms or rerun successful institutions. Valid preview rows can continue to completion and scoring after the existing user choice.

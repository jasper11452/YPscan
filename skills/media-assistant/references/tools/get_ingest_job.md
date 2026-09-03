# get_ingest_job

Risk tier: automatic Provider read.

Call after `ingest_mcn_submissions` succeeds. Pass only the exact `job_id` returned by that current ingest call. Do not use an inquiry ID, requirement ID, trace ID, or a job from another retrieval.

This tool reads an asynchronous result. The terminal success states are `succeeded` and `partially_succeeded`. If the job has not reached one of these terminal states or does not yet contain the complete retrieval artifacts, call it again with the same `job_id`; do not rerun `ingest_mcn_submissions`, change or guess the job ID, or ask the user. Make at most 10 queries in one run.

A terminal `succeeded` or `partially_succeeded` result in the new flow requires all of the following from the same current result:

- the current `requirement_id`
- a trusted preview Excel URL
- a trusted `creator_links_csv_url`

When terminal, first save the preview Excel with `ypscan_save_excel_artifact(artifact_kind="mcn_creator_preview")`, then save the links CSV with `ypscan_save_csv_artifact(artifact_kind="mcn_creator_links")`, and only after both saves succeed ask the user whether to continue with `精排并生成提报表` or `只补全达人信息`. Never skip directly to `rank_creators`.

## Branch

- `精排并生成提报表`: call `rank_creators({requirement_id, inquiry_ids})` with the current requirement ID and this round's `get_workflow_state` inquiry IDs; save the final ranked Excel as `ranked_submission`. This branch no longer goes through native completion, merge, or upload.
- `只补全达人信息`: run the platform-native creator completion in batches of 20, then `ypscan_merge_creator_csv` with `flow="mcn_complete_only"` and deliver the merged CSV as the final result.

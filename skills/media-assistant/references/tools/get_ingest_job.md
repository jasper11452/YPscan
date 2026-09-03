# get_ingest_job

Risk tier: automatic Provider read.

Call after `ingest_mcn_submissions` succeeds. Pass only the exact `job_id` returned by that current ingest call. Do not use an inquiry ID, requirement ID, trace ID, or a job from another retrieval.

This tool reads an asynchronous result. If it has not succeeded or does not yet contain the complete retrieval artifacts, call it again with the same `job_id`; do not rerun `ingest_mcn_submissions`, change or guess the job ID, or ask the user. Make at most 10 queries in one run.

A complete success in the new flow requires all of the following from the same current result:

- the current `requirement_id`
- a trusted preview Excel URL
- a trusted `creator_links_csv_url`

When complete, first save the preview Excel with `ypscan_save_excel_artifact(artifact_kind="mcn_creator_preview")`, then save the links CSV with `ypscan_save_csv_artifact(artifact_kind="mcn_creator_links")`, and only after both saves succeed ask the user whether to continue with `精排并生成提报表` or `只补全达人信息`. Never skip directly to `rank_creators`.

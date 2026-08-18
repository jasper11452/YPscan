# get_ingest_job

Risk tier: automatic Provider read.

Call after `ingest_mcn_submissions` succeeds. Pass only the exact `job_id` returned by that current ingest call. Do not use an inquiry ID, requirement ID, trace ID, or a job from another retrieval.

This tool reads an asynchronous result. If it has not succeeded or does not yet contain the complete Excel result, call it again with the same `job_id`; do not rerun `ingest_mcn_submissions`, change or guess the job ID, or ask the user. Make at most 10 queries in one run.

Only a successful result containing the current requirement ID and a trusted Excel URL is complete. Display the original URL, save it with `ypscan_save_excel_artifact(artifact_kind="mcn_creator_preview")`, then continue to `rank_creators`. Never save a pending response or skip directly to ranking.

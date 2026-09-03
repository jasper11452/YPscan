# rank_creators

Risk tier: automatic Provider operation.

Use only in the current inquiry retrieval's ranking branch after `get_workflow_state` returned non-empty `inquiry_ids`, `ingest_mcn_submissions` succeeded, and `get_ingest_job` reached the terminal `succeeded` or `partially_succeeded` state. Direct-sourcing compatibility Excel is already a final manual result and must not enter this tool.

## Arguments

- `requirement_id`: exact current requirement ID from this inquiry branch.
- `inquiry_ids`: the complete non-empty `inquiry_ids` array from the current `get_workflow_state` result.

Do not pass `csv_file_path`, `submission_batche_page`, or `batch_id`. The ranking input is the current requirement ID plus this round's `get_workflow_state` inquiry IDs only; no uploaded CSV path is accepted.

## Result

Use the real `run_id`, `ranked_count`, and status returned by the Provider when reporting the ranking result. Missing fields remain unknown. A failed or outcome-unknown ranking is not a reason to manufacture an inquiry or blindly repeat a side-effecting upstream call.

A successful result in the current flow must contain the final ranked Excel URL. Save it immediately with `ypscan_save_excel_artifact` using `artifact_kind="ranked_submission"` and the current `requirement_id` as `artifact_id`. Do not call `create_submission_batch`, `get_creator_detail`, or `get_creator_detail_export` in the formal flow.

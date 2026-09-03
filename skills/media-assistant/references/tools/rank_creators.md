# rank_creators

Risk tier: automatic Provider operation.

Use only after the current inquiry retrieval branch has produced a merged creator CSV, `ypscan_upload_creator_csv` has returned a trusted `csv_file_path`, and the user chose the ranking branch. Direct-sourcing compatibility Excel is already a final manual result and must not enter this tool.

## Arguments

- `requirement_id`: exact current requirement ID from this inquiry branch.
- `csv_file_path`: exact uploaded CSV path returned by the current `ypscan_upload_creator_csv` result.

Do not pass `submission_batche_page`, `batch_id`, `inquiry_ids`, local file paths, local CSV content, or a Provider `trace_id`.

## Result

Use the real `run_id`, `ranked_count`, and status returned by the Provider when reporting the ranking result. Missing fields remain unknown. A failed or outcome-unknown ranking is not a reason to manufacture an inquiry or blindly repeat a side-effecting upstream call.

A successful result in the current flow must contain the final ranked Excel URL. Save it immediately with `ypscan_save_excel_artifact` using `artifact_kind="ranked_submission"` and the current `requirement_id` as `artifact_id`. Do not call `create_submission_batch`, `get_creator_detail`, or `get_creator_detail_export` in the formal flow.

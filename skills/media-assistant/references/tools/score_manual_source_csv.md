# score_manual_source_csv

Risk tier: automatic Provider operation.

Submit the current manual-sourcing merged CSV for scoring. Call only after `ypscan_merge_creator_csv` produced a merged CSV with at most 500 data rows and `ypscan_upload_creator_csv` returned a trusted server-side path.

## Arguments

- `requirement_id`: exact current requirement ID from this manual-sourcing run.
- `csv_file_path`: the exact server-process-readable path returned by the current `ypscan_upload_creator_csv` result. Never pass a local file path, local CSV content, a download URL, or a path invented from the file name.

## Result

The response is asynchronous: it returns a `job_id`. Copy the exact `job_id` to `score_manual_source_csv_status` and poll it every 30 seconds, at most 10 queries in one run, until the final workbook URL is returned; then save it immediately with `ypscan_save_excel_artifact` using `artifact_kind="manual_source"` and the current `requirement_id` as `artifact_id`. A `job_id` alone is not a completed score.

If an older Provider synchronously returns the final Excel workbook instead, save it directly as the compatible result; do not poll a status tool in that case.

## Upload availability

`csv_file_path` must come from `ypscan_upload_creator_csv`. The current repository has no verifiable production CSV staging endpoint contract, so in non-test mode `ypscan_upload_creator_csv` returns `YPSCAN_CREATOR_CSV_UPLOAD_UNAVAILABLE`. Do not guess a real upload endpoint or pass any other path into this tool.

## Stop conditions

Stop on a failed envelope, a missing or untrusted `csv_file_path`, or an upload-unavailable result. Do not resubmit the same CSV through a different path.

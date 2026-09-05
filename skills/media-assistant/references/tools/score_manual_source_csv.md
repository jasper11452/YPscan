# score_manual_source_csv

Risk tier: automatic Provider operation.

Submit the current merged creator CSV for scoring and sorting. This is a generic scoring step used by both the manual-sourcing chain and the institutional inquiry-retrieval chain; it carries no manual-sourcing-only relaxation semantics. Call only after `file_bridge` merged at most 500 data rows, uploaded them, and returned a trusted server-side path.

## Arguments

- `requirement_id`: exact current requirement ID from this run.
- `csv_file_path`: the exact server-process-readable path returned by the current `file_bridge` result. Never pass a local file path, local CSV content, a download URL, or a path invented from the file name.

## Result

The response is asynchronous: it returns a `job_id`. Copy the exact `job_id` to `score_manual_source_csv_status` and poll it every 30 seconds, at most 10 queries in one run, until the final workbook URL is returned; then save it immediately with `ypscan_save_artifact` using `artifact_kind="manual_source"`, the current `requirement_id` as `artifact_id`, and the exact workbook URL as `file_url`. A `job_id` alone is not a completed score.

If an older Provider synchronously returns the final Excel workbook instead, save it directly as the compatible result; do not poll a status tool in that case.

## Upload availability

`csv_file_path` must come from `file_bridge`. In the current implementation this is an unsigned OSS URL that `file_bridge` already verified as anonymously readable. Do not guess a different upload endpoint, rebuild the URL from the filename, or pass any other local/remote path into this tool.

## Stop conditions

Stop on a failed envelope, a missing or untrusted `csv_file_path`, or a `YPSCAN_FILE_BRIDGE_PUBLIC_URL_UNREADABLE` result. Do not resubmit the same CSV through a different path.

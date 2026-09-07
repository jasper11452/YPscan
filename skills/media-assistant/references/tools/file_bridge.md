# file_bridge

Risk tier: local merge with conditional network upload.

Call once after all platform-native creator-completion batches finish. This tool replaces the former separate merge step: it merges the current links CSV with all completion CSVs, saves the merged CSV locally, and decides from `flow` whether to upload it.

## Arguments

- `requirement_id`: current requirement only.
- `platform`: `xiaohongshu` or `douyin`.
- `flow`: `manual_source`, `mcn_rank`, or `mcn_complete_only`.
- `links_csv_path`: absolute local path of the current links CSV. In both chains this is the path returned by `ypscan_save_creator_links` (the normalized three-column links CSV derived from the saved Provider links CSV or the read preview Excel). Never pass the raw Provider CSV saved by `ypscan_save_artifact`.
- `completion_csv_paths`: non-empty list containing every successful completion batch CSV from the current requirement and platform.

Input CSV paths must be absolute and have no leading or trailing whitespace; ambiguous whitespace paths are rejected before reading or uploading.

Do not pre-merge files, pass a `merged_csv_path`, mix requirements/platforms, or omit successful batches.

## ID matching

The tool chooses the first available ID column per file. For Douyin the priority is `creator_id → 请求星图ID → 星图ID → xt_id → 请求kw_uid → kw_uid → author_id → authorid → id`; Xiaohongshu keeps `creator_id → 请求kw_uid → kw_uid → xt_id → author_id → authorid → id`. Header matching ignores case and trims whitespace/BOM; IDs remain strings. An existing higher-priority column is not replaced just because its values fail to match. Do not rename columns or repair business CSVs manually.

## Result

`completion_id_columns` reports each completion file's `file_path` and selected `id_column` (trimmed for display). On `YPSCAN_FILE_BRIDGE_EMPTY`, `error.details` retains the merge details, including `data_row_count`, `matched_creator_ids`, `missing_creator_ids`, and `completion_id_columns`. No upload occurs; show the local link and report the mismatch rather than guessing a BOM issue or retrying unchanged inputs.

Always show `delivery.local_file_link` when present.

- `manual_source`: when `data_row_count` is 1–500, use only the returned `data.csv_file_path` in `score_manual_source_csv`. Above 500, `upload_skipped="row_limit_exceeded"`; deliver the local CSV and stop. This flow is the generic merge-and-upload step for scoring in both chains.
- `mcn_complete_only`: the local merged CSV is the final result. Do not upload, score, rank, or save an Excel.
- `mcn_rank`: use the uploaded `data.csv_file_path` only if the live `rank_creators` schema explicitly accepts it. The current test Provider still uses `requirement_id` plus `inquiry_ids` instead.

If merging succeeds but configuration, upload, or anonymous-read verification fails, the error still carries the local merged file link. Show it before offering retry or stop. Never construct a remote path or substitute the local path for `csv_file_path`.
